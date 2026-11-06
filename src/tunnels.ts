/**
 * The `/relay` endpoint (`phone-relay` spec, design D3–D7): the phone's and the desktop's legs of a tunnel, their
 * one-request handshake, the splice with flow control and the throughput cap, the liveness of each leg, the
 * limits, and how tunnels end. The server never looks inside the relayed bytes: they are the phone's TLS to the
 * desktop.
 */
import type { WebSocket } from 'ws'
import type { Database } from './db.ts'
import { type ErrorCode, ProtocolError, RELAY_ERROR_CODES, badParams } from './errors.ts'
import { CLOSE_CODES, negotiate, parseFrame } from './protocol.ts'
import { touchGrant, validateId, verifyGrant } from './relay.ts'
import { type Clock, authenticate, newId } from './team.ts'

/** The operations of `/relay`; the protocol document test compares them with section 13. */
export const RELAY_OPERATIONS = ['relay.open', 'relay.accept'] as const

/** Tunnels at once, open or pending, per desktop device (design D5). */
export const MAX_TUNNELS_PER_DEVICE = 4
/** `relay.incoming` sent per grant within OPEN_WINDOW_MS (design D5). */
export const MAX_OPENS_PER_GRANT = 20
export const OPEN_WINDOW_MS = 10 * 60 * 1000
/** Flow-control window on a leg's unsent bytes (design D4). */
export const FLOW_HIGH = 64 * 1024
export const FLOW_LOW = 16 * 1024
/** How often the throughput buckets are refilled. */
const REFILL_MS = 100

export interface RelaySettings {
  enabled: boolean
  maxTunnels: number
  /** KiB per second per direction; 0 means no cap. */
  kibPerSecond: number
}

export interface RelayTimings {
  /** How long a `/relay` connection may wait before sending its request. */
  authTimeoutMs: number
  /** How long after an error answer before the connection is closed with 4003. */
  refuseDelayMs: number
  pingIntervalMs: number
  /** How long a phone waits for its desktop to accept. */
  pendingTimeoutMs: number
  /** How long a leg with unsent data may go without a pong or progress. */
  stallMs: number
}

export const DEFAULT_RELAY_TIMINGS: RelayTimings = {
  authTimeoutMs: 10_000,
  refuseDelayMs: 1_000,
  pingIntervalMs: 30_000,
  pendingTimeoutMs: 10_000,
  stallMs: 120_000,
}

/** A desktop's `/connect` connection, as far as the relay needs it. */
export interface DesktopConnection {
  readonly ready: boolean
  sendEvent(kind: string, data: unknown): void
}

export interface RelayHost {
  db: Database
  now: Clock
  log(message: string): void
  /** The device's current `/connect` connection, if any. */
  desktopConnection(deviceId: string): DesktopConnection | undefined
}

type LegState = 'pending' | 'waiting' | 'refusing' | 'spliced' | 'closed'

/** One `/relay` WebSocket: before its request, waiting for its answer, or one side of an open tunnel. */
class Leg {
  readonly ws: WebSocket
  readonly #relay: Relay
  state: LegState = 'pending'
  role: 'phone' | 'desktop' | null = null
  tunnel: Tunnel | null = null
  requestId: number | string | null = null
  /** The server stopped reading from this leg (flow control or the cap). */
  paused = false
  #authTimer: NodeJS.Timeout | undefined
  #pingTimer: NodeJS.Timeout | undefined
  #refuseTimer: NodeJS.Timeout | undefined
  #awaitingPong = false
  #lastProgressAt = Date.now()
  /** Bytes forwarded to this leg, and how many of them had left the server at the last ping. */
  sent = 0
  #lastDelivered = 0
  /** Bytes were forwarded to this leg since its last pong: a late pong may be queued behind them. */
  #sentSincePong = false

  constructor(ws: WebSocket, relay: Relay) {
    this.ws = ws
    this.#relay = relay
    ws.on('error', (error) => relay.host.log(`relay connection error: ${error.message}`))
    ws.on('message', (data, isBinary) => this.#onMessage(data as Buffer | ArrayBuffer | Buffer[], isBinary))
    ws.on('pong', () => {
      this.#awaitingPong = false
      this.#sentSincePong = false
      this.#lastProgressAt = Date.now()
    })
    ws.on('close', () => this.#onClose())
    const t = relay.timings
    this.#authTimer = setTimeout(() => {
      if (this.state === 'pending') this.close(CLOSE_CODES.AUTH_TIMEOUT, 'no request in time')
    }, t.authTimeoutMs)
    this.#pingTimer = setInterval(() => this.#tick(), t.pingIntervalMs)
  }

  /** Unsent bytes on this leg: what `ws` holds plus the socket's write buffer. */
  get buffered(): number {
    return this.ws.bufferedAmount
  }

  /** Bytes forwarded to this leg that have left the server's buffers (into the kernel, on their way). */
  get delivered(): number {
    return this.sent - this.buffered
  }

  /** Records bytes forwarded to this leg. */
  forwarded(bytes: number): void {
    this.sent += bytes
    this.#sentSincePong = true
  }

  /**
   * Liveness (design D4). Before the splice, the `/connect` rule: a missed pong ends the leg. After it, a leg is
   * alive if it answered the last ping, if more of the bytes forwarded to it left the server since the last ping
   * (its peer's TCP is accepting them, so it is reading), or while the server has it paused (it cannot read the
   * pong then). A leg whose pong may be queued behind bytes forwarded to it gets `stallMs` without progress
   * before it is ended; one with nothing forwarded since its last pong is ended at the first missed pong.
   */
  #tick(): void {
    if (this.state === 'closed' || this.state === 'refusing') return
    const now = Date.now()
    if (this.state !== 'spliced') {
      if (this.#awaitingPong) return this.terminate()
    } else if (this.paused) {
      this.#awaitingPong = false
      this.#lastProgressAt = now
    } else if (this.#awaitingPong) {
      if (this.delivered > this.#lastDelivered) this.#lastProgressAt = now
      else if (!this.#sentSincePong || now - this.#lastProgressAt >= this.#relay.timings.stallMs) return this.terminate()
    }
    this.#lastDelivered = this.delivered
    this.#awaitingPong = true
    this.ws.ping()
  }

  /** The server stops reading from this leg. */
  pause(): void {
    if (this.paused || this.state !== 'spliced') return
    this.paused = true
    this.ws.pause()
  }

  /** The server reads from this leg again; its ping state starts afresh. */
  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.#awaitingPong = false
    this.#lastProgressAt = Date.now()
    this.ws.resume()
  }

  answer(result: unknown): void {
    this.#send({ t: 'res', id: this.requestId, ok: true, r: result })
  }

  /** An error answer, then close 4003 after the refusal delay; frames meanwhile are ignored. */
  refuse(id: number | string | null, code: ErrorCode, message: string, detail?: Record<string, unknown>): void {
    if (this.state === 'closed' || this.state === 'refusing') return
    const e: Record<string, unknown> = { code, message }
    if (detail !== undefined) e.detail = detail
    this.#send({ t: 'res', id, ok: false, e })
    this.state = 'refusing'
    clearTimeout(this.#authTimer)
    this.#refuseTimer = setTimeout(() => this.close(CLOSE_CODES.REFUSED, 'refused'), this.#relay.timings.refuseDelayMs)
  }

  close(code: number, reason = ''): void {
    if (this.state === 'closed') return
    this.#stopTimers()
    this.state = 'closed'
    this.ws.close(code, reason)
    this.#relay.legClosed(this, `closed with ${code}`)
  }

  terminate(): void {
    if (this.state === 'closed') return
    this.#stopTimers()
    this.state = 'closed'
    this.ws.terminate()
    this.#relay.legClosed(this, 'missed keepalive')
  }

  #stopTimers(): void {
    clearTimeout(this.#authTimer)
    clearInterval(this.#pingTimer)
    clearTimeout(this.#refuseTimer)
  }

  #onClose(): void {
    if (this.state === 'closed') return
    this.#stopTimers()
    this.state = 'closed'
    this.#relay.legClosed(this, `${this.role ?? 'connection'} closed`)
  }

  #send(frame: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(frame))
  }

  #onMessage(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (this.state === 'refusing' || this.state === 'closed') return
    if (this.state === 'spliced') {
      if (!isBinary) {
        this.tunnel?.end('text frame in the tunnel', this, CLOSE_CODES.UNSUPPORTED_DATA)
        return
      }
      this.tunnel?.forward(this, data as Buffer)
      return
    }
    // Before the answer: one text request, and nothing else (design D3).
    if (isBinary || this.state === 'waiting') {
      this.close(CLOSE_CODES.UNSUPPORTED_DATA, 'one request, then wait for the answer')
      return
    }
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8')
    const parsed = parseFrame(text)
    if (!parsed.ok) {
      this.refuse(parsed.id, 'BAD_FRAME', 'not a request frame')
      return
    }
    const { id, m, p } = parsed.request
    if (!(RELAY_OPERATIONS as readonly string[]).includes(m)) {
      this.refuse(id, 'UNKNOWN_OPERATION', `"${m}" is not an operation of /relay`)
      return
    }
    clearTimeout(this.#authTimer)
    this.state = 'waiting'
    this.requestId = id
    try {
      if (m === 'relay.open') this.#relay.openTunnel(this, p)
      else this.#relay.acceptTunnel(this, p)
    } catch (error) {
      const known = error instanceof ProtocolError && RELAY_ERROR_CODES.includes(error.code)
      if (!known) this.#relay.host.log(`${m} failed: ${(error as Error).stack ?? String(error)}`)
      const code: ErrorCode = known ? (error as ProtocolError).code : 'INTERNAL'
      const subject = m === 'relay.open' ? `grant ${idOrQuestion(p.grant)}` : `tunnel ${idOrQuestion(p.tunnel)}`
      this.#relay.host.log(`${m} refused: ${code} (${subject})`)
      this.refuse(
        id,
        code,
        known ? (error as ProtocolError).message : 'the server could not carry out the request',
        known ? (error as ProtocolError).detail : undefined,
      )
    }
  }
}

function idOrQuestion(value: unknown): string {
  try {
    return validateId(value, 'id')
  } catch {
    return '?'
  }
}

/** A token bucket for one direction of a tunnel (design D4): one second's worth, overdraft allowed. */
class Bucket {
  readonly capacity: number
  tokens: number
  constructor(bytesPerSecond: number) {
    this.capacity = bytesPerSecond
    this.tokens = bytesPerSecond
  }
  refill(): void {
    this.tokens = Math.min(this.capacity, this.tokens + this.capacity / (1000 / REFILL_MS))
  }
}

/** A tunnel: pending (the phone waits for its desktop) or open (spliced). */
class Tunnel {
  readonly id: string
  readonly grantId: string
  readonly deviceId: string
  readonly phone: Leg
  desktop: Leg | null = null
  readonly offeredTo: DesktopConnection
  readonly protocol: number
  state: 'pending' | 'open' | 'ended' = 'pending'
  openedAt = 0
  toDesktop = 0
  toPhone = 0
  pendingTimer: NodeJS.Timeout | undefined
  #refill: NodeJS.Timeout | undefined
  #toDesktopBucket: Bucket | null = null
  #toPhoneBucket: Bucket | null = null
  readonly #relay: Relay

  constructor(relay: Relay, phone: Leg, grantId: string, deviceId: string, offeredTo: DesktopConnection, protocol: number) {
    this.#relay = relay
    this.id = newId('t')
    this.phone = phone
    this.grantId = grantId
    this.deviceId = deviceId
    this.offeredTo = offeredTo
    this.protocol = protocol
  }

  open(desktop: Leg): void {
    clearTimeout(this.pendingTimer)
    this.desktop = desktop
    this.state = 'open'
    this.openedAt = Date.now()
    const cap = this.#relay.settings.kibPerSecond * 1024
    if (cap > 0) {
      this.#toDesktopBucket = new Bucket(cap)
      this.#toPhoneBucket = new Bucket(cap)
    }
    this.#refill = setInterval(() => {
      this.#toDesktopBucket?.refill()
      this.#toPhoneBucket?.refill()
      this.#settle()
    }, REFILL_MS)
    for (const leg of [this.phone, desktop]) {
      // `ws` has no drain event; its socket does (the unsent bytes `bufferedAmount` counts are the socket's).
      const socket = (leg.ws as unknown as { _socket?: NodeJS.EventEmitter })._socket
      socket?.on('drain', () => this.#settle())
    }
  }

  /** Forwards one binary message to the other leg, then applies flow control and the cap. */
  forward(from: Leg, data: Buffer): void {
    if (this.state !== 'open' || this.desktop === null) return
    const to = from === this.phone ? this.desktop : this.phone
    if (to.state !== 'spliced') return
    to.ws.send(data, { binary: true })
    to.forwarded(data.length)
    const bucket = from === this.phone ? this.#toDesktopBucket : this.#toPhoneBucket
    if (from === this.phone) this.toDesktop += data.length
    else this.toPhone += data.length
    if (bucket !== null) bucket.tokens -= data.length
    if (to.buffered > FLOW_HIGH || (bucket !== null && bucket.tokens < 0)) from.pause()
  }

  /** Resumes each paused leg whose peer has drained and whose bucket is not overdrawn. */
  #settle(): void {
    if (this.state !== 'open' || this.desktop === null) return
    const directions: Array<[Leg, Leg, Bucket | null]> = [
      [this.phone, this.desktop, this.#toDesktopBucket],
      [this.desktop, this.phone, this.#toPhoneBucket],
    ]
    for (const [from, to, bucket] of directions) {
      if (from.paused && to.buffered < FLOW_LOW && (bucket === null || bucket.tokens >= 0)) from.resume()
    }
  }

  /**
   * Ends an open tunnel: `cause` (if given) is closed with `causeCode`, the phone leg with `phoneCode` and the
   * desktop leg with `desktopCode` otherwise.
   */
  end(
    reason: string,
    cause: Leg | null = null,
    causeCode: number = CLOSE_CODES.TUNNEL_PEER_GONE,
    phoneCode: number = CLOSE_CODES.TUNNEL_PEER_GONE,
    desktopCode: number = CLOSE_CODES.TUNNEL_PEER_GONE,
  ): void {
    if (this.state === 'ended') return
    const wasOpen = this.state === 'open'
    this.state = 'ended'
    clearTimeout(this.pendingTimer)
    clearInterval(this.#refill)
    this.#relay.forget(this)
    if (cause !== null) cause.close(causeCode)
    this.phone.close(phoneCode)
    this.desktop?.close(desktopCode)
    if (wasOpen) {
      const seconds = Math.round((Date.now() - this.openedAt) / 1000)
      this.#relay.host.log(
        `tunnel ${this.id} closed after ${seconds} s: ${this.toDesktop} bytes to the desktop, ${this.toPhone} bytes to the phone (${reason})`,
      )
    }
  }
}

/** The relay: every `/relay` connection and tunnel of the server. */
export class Relay {
  readonly host: RelayHost
  readonly settings: RelaySettings
  readonly timings: RelayTimings
  readonly #legs = new Set<Leg>()
  readonly #tunnels = new Map<string, Tunnel>()
  /** When `relay.incoming` was sent, per grant, within the window (design D5). */
  readonly #opens = new Map<string, number[]>()
  closing = false

  constructor(host: RelayHost, settings: RelaySettings, timings: Partial<RelayTimings> = {}) {
    this.host = host
    this.settings = settings
    this.timings = { ...DEFAULT_RELAY_TIMINGS, ...timings }
  }

  /** A new `/relay` WebSocket. */
  attach(ws: WebSocket): void {
    if (this.closing) {
      ws.close(CLOSE_CODES.GOING_AWAY, 'server shutting down')
      return
    }
    this.#legs.add(new Leg(ws, this))
  }

  /** Tunnels open or pending. */
  get size(): number {
    return this.#tunnels.size
  }

  /** The open tunnels' counters and unsent bytes, for tests and diagnosis. */
  stats(): Array<{ id: string; toDesktop: number; toPhone: number; phoneBuffered: number; desktopBuffered: number }> {
    return [...this.#tunnels.values()]
      .filter((t) => t.state === 'open' && t.desktop !== null)
      .map((t) => ({
        id: t.id,
        toDesktop: t.toDesktop,
        toPhone: t.toPhone,
        phoneBuffered: t.phone.buffered,
        desktopBuffered: t.desktop!.buffered,
      }))
  }

  /** The desktop devices that have tunnels, open or pending; the revocation sweep checks them too (design D6). */
  deviceIds(): string[] {
    return [...new Set([...this.#tunnels.values()].map((t) => t.deviceId))]
  }

  openTunnel(leg: Leg, p: Record<string, unknown>): void {
    const protocol = negotiate(p.protocol)
    if (!this.settings.enabled) throw new ProtocolError('RELAY_DISABLED', 'this server does not relay')
    const grant = validateId(p.grant, 'grant')
    if (typeof p.secret !== 'string') throw badParams('secret', 'secret must be a string')
    const { deviceId } = verifyGrant(this.host.db, grant, p.secret)
    const now = this.host.now()
    const recent = (this.#opens.get(grant) ?? []).filter((at) => at > now - OPEN_WINDOW_MS)
    this.#opens.set(grant, recent)
    if (recent.length >= MAX_OPENS_PER_GRANT) {
      throw new ProtocolError('RATE_LIMITED', 'this grant opened too many tunnels recently', {
        retryAt: recent[0]! + OPEN_WINDOW_MS,
      })
    }
    if (this.#tunnels.size >= this.settings.maxTunnels) {
      throw new ProtocolError('RELAY_BUSY', 'the server relays as many tunnels as it allows', { limit: 'server' })
    }
    const ofDevice = [...this.#tunnels.values()].filter((t) => t.deviceId === deviceId).length
    if (ofDevice >= MAX_TUNNELS_PER_DEVICE) {
      throw new ProtocolError('RELAY_BUSY', 'this desktop has as many tunnels as it may', { limit: 'device' })
    }
    const desktop = this.host.desktopConnection(deviceId)
    if (desktop === undefined || !desktop.ready) {
      throw new ProtocolError('DESKTOP_UNAVAILABLE', 'the desktop is not connected to the server')
    }
    recent.push(now)
    touchGrant(this.host.db, grant, this.host.now)
    const tunnel = new Tunnel(this, leg, grant, deviceId, desktop, protocol)
    leg.role = 'phone'
    leg.tunnel = tunnel
    this.#tunnels.set(tunnel.id, tunnel)
    tunnel.pendingTimer = setTimeout(
      () => this.#failPending(tunnel, 'DESKTOP_UNAVAILABLE', 'the desktop did not accept in time'),
      this.timings.pendingTimeoutMs,
    )
    desktop.sendEvent('relay.incoming', { tunnel: tunnel.id, grant, expiresAt: now + this.timings.pendingTimeoutMs })
    this.host.log(`tunnel ${tunnel.id} requested: device ${deviceId}, grant ${grant}`)
  }

  acceptTunnel(leg: Leg, p: Record<string, unknown>): void {
    const protocol = negotiate(p.protocol)
    if (!this.settings.enabled) throw new ProtocolError('RELAY_DISABLED', 'this server does not relay')
    if (typeof p.deviceId !== 'string') throw badParams('deviceId', 'deviceId must be a string')
    if (typeof p.deviceSecret !== 'string') throw badParams('deviceSecret', 'deviceSecret must be a string')
    const tunnelId = validateId(p.tunnel, 'tunnel')
    authenticate(this.host.db, p.deviceId, p.deviceSecret, this.host.now)
    const tunnel = this.#tunnels.get(tunnelId)
    if (tunnel === undefined || tunnel.state !== 'pending' || tunnel.deviceId !== p.deviceId) {
      throw new ProtocolError('TUNNEL_UNKNOWN', 'no such tunnel is waiting for this device')
    }
    leg.role = 'desktop'
    leg.tunnel = tunnel
    leg.answer({ protocol })
    tunnel.phone.answer({ protocol: tunnel.protocol, tunnel: tunnel.id })
    leg.state = 'spliced'
    tunnel.phone.state = 'spliced'
    tunnel.open(leg)
    this.host.log(`tunnel ${tunnel.id} opened: device ${tunnel.deviceId}, grant ${tunnel.grantId}`)
  }

  /** `relay.refuse` from the desktop the tunnel was offered to; anything else is ignored. */
  refuse(deviceId: string, tunnelId: string): void {
    const tunnel = this.#tunnels.get(tunnelId)
    if (tunnel === undefined || tunnel.state !== 'pending' || tunnel.deviceId !== deviceId) return
    this.#failPending(tunnel, 'DESKTOP_REFUSED', 'the desktop refused the tunnel')
  }

  /** A desktop's `/connect` connection closed: its pending tunnels fail (design D3). */
  desktopClosed(connection: DesktopConnection): void {
    if (this.closing) return
    for (const tunnel of [...this.#tunnels.values()]) {
      if (tunnel.state === 'pending' && tunnel.offeredTo === connection) {
        this.#failPending(tunnel, 'DESKTOP_UNAVAILABLE', 'the desktop disconnected')
      }
    }
  }

  /** A grant was revoked: pending phones get `GRANT_INVALID`, open tunnels end 4004 / 4010 (design D6). */
  grantRevoked(grantId: string): void {
    for (const tunnel of [...this.#tunnels.values()]) {
      if (tunnel.grantId !== grantId) continue
      if (tunnel.state === 'pending') this.#failPending(tunnel, 'GRANT_INVALID', 'this grant was revoked')
      else tunnel.end('grant revoked', null, CLOSE_CODES.REVOKED, CLOSE_CODES.REVOKED, CLOSE_CODES.TUNNEL_PEER_GONE)
    }
    this.#opens.delete(grantId)
  }

  /** A desktop device was revoked: its pending phones get `GRANT_INVALID`, open tunnels end 4004 on both legs. */
  deviceRevoked(deviceId: string): void {
    for (const tunnel of [...this.#tunnels.values()]) {
      if (tunnel.deviceId !== deviceId) continue
      if (tunnel.state === 'pending') this.#failPending(tunnel, 'GRANT_INVALID', 'this grant is no longer valid')
      else tunnel.end('device revoked', null, CLOSE_CODES.REVOKED, CLOSE_CODES.REVOKED, CLOSE_CODES.REVOKED)
    }
  }

  #failPending(tunnel: Tunnel, code: ErrorCode, message: string): void {
    if (tunnel.state !== 'pending') return
    tunnel.state = 'ended'
    clearTimeout(tunnel.pendingTimer)
    this.#tunnels.delete(tunnel.id)
    this.host.log(`relay.open refused: ${code} (grant ${tunnel.grantId}, tunnel ${tunnel.id})`)
    tunnel.phone.refuse(tunnel.phone.requestId, code, message)
  }

  /** Called by a tunnel as it ends. */
  forget(tunnel: Tunnel): void {
    this.#tunnels.delete(tunnel.id)
  }

  /** Called by a leg as it closes, for any reason. */
  legClosed(leg: Leg, reason: string): void {
    this.#legs.delete(leg)
    const tunnel = leg.tunnel
    if (tunnel === null) return
    if (tunnel.state === 'pending' && leg === tunnel.phone) {
      // The phone gave up while waiting: drop the tunnel; a later accept is TUNNEL_UNKNOWN.
      tunnel.state = 'ended'
      clearTimeout(tunnel.pendingTimer)
      this.#tunnels.delete(tunnel.id)
      this.host.log(`tunnel ${tunnel.id} dropped: the phone left before the desktop accepted`)
      return
    }
    if (tunnel.state === 'open') tunnel.end(reason)
  }

  /** Shutdown: every leg, pending phones included, is closed with 1001 and no answer. */
  close(): void {
    this.closing = true
    for (const tunnel of [...this.#tunnels.values()]) {
      if (tunnel.state === 'open') tunnel.end('server shutting down', null, 0, CLOSE_CODES.GOING_AWAY, CLOSE_CODES.GOING_AWAY)
      else {
        tunnel.state = 'ended'
        clearTimeout(tunnel.pendingTimer)
      }
    }
    this.#tunnels.clear()
    for (const leg of [...this.#legs]) leg.close(CLOSE_CODES.GOING_AWAY, 'server shutting down')
  }
}
