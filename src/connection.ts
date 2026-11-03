/**
 * One WebSocket connection's state machine (`server-connection` spec): the authentication window, dispatch
 * through the operation registry, refusal before authentication, keepalive.
 */
import type { WebSocket } from 'ws'
import type { Database } from './db.ts'
import { type ErrorCode, ProtocolError } from './errors.ts'
import { CLOSE_CODES, OPERATIONS, type OperationContext, parseFrame } from './protocol.ts'
import { type Clock, type Identity, touchDevice } from './team.ts'

export interface Timings {
  /** How long a connection may stay unauthenticated. */
  authTimeoutMs: number
  /** How long after an error answer before authentication the connection is closed. */
  refuseDelayMs: number
  /** Interval between pings. */
  pingIntervalMs: number
  /** Minimum time between two writes of a device's last-seen time on pong. */
  lastSeenWriteMs: number
}

export const DEFAULT_TIMINGS: Timings = {
  authTimeoutMs: 10_000,
  refuseDelayMs: 1_000,
  pingIntervalMs: 30_000,
  lastSeenWriteMs: 25_000,
}

export interface ConnectionHost {
  db: Database
  now: Clock
  timings: Timings
  log(message: string): void
  /** The connection authenticated as a device; the host closes any older connection of that device. */
  register(deviceId: string, connection: Connection): void
  /** The connection closed; the host forgets it if it is still the device's current connection. */
  unregister(deviceId: string, connection: Connection): void
}

type State = 'pending' | 'refusing' | 'authenticated' | 'closed'

export class Connection {
  readonly #ws: WebSocket
  readonly #host: ConnectionHost
  #state: State = 'pending'
  #deviceId: string | null = null
  #authTimer: NodeJS.Timeout | undefined
  #pingTimer: NodeJS.Timeout | undefined
  #refuseTimer: NodeJS.Timeout | undefined
  #awaitingPong = false
  #lastSeenWrite = 0

  constructor(ws: WebSocket, host: ConnectionHost) {
    this.#ws = ws
    this.#host = host
    ws.on('error', (error) => host.log(`connection error: ${error.message}`))
    ws.on('message', (data, isBinary) => this.#onMessage(data, isBinary))
    ws.on('pong', () => this.#onPong())
    ws.on('close', () => this.#onClose())
    this.#authTimer = setTimeout(() => this.close(CLOSE_CODES.AUTH_TIMEOUT, 'not authenticated in time'), host.timings.authTimeoutMs)
    this.#pingTimer = setInterval(() => this.#ping(), host.timings.pingIntervalMs)
  }

  get deviceId(): string | null {
    return this.#deviceId
  }

  close(code: number, reason = ''): void {
    if (this.#state === 'closed') return
    this.#stopTimers()
    this.#ws.close(code, reason)
    this.#markClosed()
  }

  /** Ends the connection without a closing handshake (shutdown of a dead peer). */
  terminate(): void {
    this.#stopTimers()
    this.#ws.terminate()
    this.#markClosed()
  }

  #markClosed(): void {
    if (this.#state === 'closed') return
    this.#state = 'closed'
    if (this.#deviceId !== null) this.#host.unregister(this.#deviceId, this)
  }

  #stopTimers(): void {
    clearTimeout(this.#authTimer)
    clearInterval(this.#pingTimer)
    clearTimeout(this.#refuseTimer)
  }

  #onClose(): void {
    this.#stopTimers()
    this.#markClosed()
  }

  #ping(): void {
    if (this.#awaitingPong) {
      this.terminate()
      return
    }
    this.#awaitingPong = true
    this.#ws.ping()
  }

  #onPong(): void {
    this.#awaitingPong = false
    if (this.#state !== 'authenticated' || this.#deviceId === null) return
    const now = this.#host.now()
    if (now - this.#lastSeenWrite < this.#host.timings.lastSeenWriteMs) return
    try {
      touchDevice(this.#host.db, this.#deviceId, this.#host.now)
      this.#lastSeenWrite = now
    } catch (error) {
      this.#host.log(`could not record last seen: ${(error as Error).message}`)
    }
  }

  #send(frame: unknown): void {
    if (this.#ws.readyState === this.#ws.OPEN) this.#ws.send(JSON.stringify(frame))
  }

  #answerError(id: number | string | null, code: ErrorCode, message: string, detail?: Record<string, unknown>): void {
    const e: Record<string, unknown> = { code, message }
    if (detail !== undefined) e.detail = detail
    this.#send({ t: 'res', id, ok: false, e })
    if (this.#state === 'pending') this.#refuse()
  }

  /** Before authentication every error ends the connection, one second later; frames meanwhile are ignored. */
  #refuse(): void {
    this.#state = 'refusing'
    clearTimeout(this.#authTimer)
    this.#refuseTimer = setTimeout(() => this.close(CLOSE_CODES.REFUSED, 'refused'), this.#host.timings.refuseDelayMs)
  }

  #onMessage(data: unknown, isBinary: boolean): void {
    if (this.#state === 'refusing' || this.#state === 'closed') return
    if (isBinary) {
      this.close(CLOSE_CODES.UNSUPPORTED_DATA, 'text frames only')
      return
    }
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')
    const parsed = parseFrame(text)
    if (!parsed.ok) {
      this.#answerError(parsed.id, 'BAD_FRAME', 'not a request frame')
      return
    }
    const { id, m, p } = parsed.request
    const operation = Object.hasOwn(OPERATIONS, m) ? OPERATIONS[m] : undefined
    if (operation === undefined) {
      this.#answerError(id, 'UNKNOWN_OPERATION', `unknown operation "${m}"`)
      return
    }
    if (operation.auth === 'device' && this.#state !== 'authenticated') {
      this.#answerError(id, 'NOT_AUTHENTICATED', 'send join or hello first')
      return
    }
    if (operation.auth === 'none' && this.#state === 'authenticated') {
      this.#answerError(id, 'ALREADY_AUTHENTICATED', 'this connection is already authenticated')
      return
    }
    let closeCode: number | null = null
    const ctx: OperationContext = {
      db: this.#host.db,
      now: this.#host.now,
      deviceId: this.#deviceId,
      authenticateAs: (identity: Identity) => this.#authenticated(identity),
      closeAfterAnswer: (code) => {
        closeCode = code
      },
      log: (message) => this.#host.log(message),
    }
    let result: unknown
    try {
      result = operation.handler(p, ctx)
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.#answerError(id, error.code, error.message, error.detail)
      } else {
        this.#host.log(`operation ${m} failed: ${(error as Error).stack ?? String(error)}`)
        this.#answerError(id, 'INTERNAL', 'the server could not carry out the request')
      }
      return
    }
    this.#send({ t: 'res', id, ok: true, r: result })
    if (closeCode !== null) this.close(closeCode)
  }

  #authenticated(identity: Identity): void {
    clearTimeout(this.#authTimer)
    this.#state = 'authenticated'
    this.#deviceId = identity.device.id
    this.#lastSeenWrite = this.#host.now()
    this.#host.register(identity.device.id, this)
  }
}
