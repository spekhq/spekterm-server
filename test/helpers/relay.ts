/** Helpers for relay tests: a `/relay` client and a desktop with a grant. */
import { WebSocket } from 'ws'
import { once } from 'node:events'
import { Duplex, Transform } from 'node:stream'
import { createWebSocketStream } from 'ws'
import type { Answer } from './client.ts'
import { TestClient } from './client.ts'
import { seedMember, type TestServer, testServer } from './server.ts'
import type { ServerOptions } from '../../src/server.ts'

/** One leg on `/relay`: a single request, then binary messages. */
export class RelayClient {
  readonly ws: WebSocket
  readonly answers: Answer[] = []
  /** Binary messages received, in order. */
  readonly messages: Buffer[] = []
  received = 0
  readonly closed: Promise<{ code: number; reason: string }>
  #answer: ((a: Answer) => void) | null = null

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.on('error', () => {})
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buffer = data as Buffer
        this.received += buffer.length
        if (this.keep) this.messages.push(buffer)
        return
      }
      const answer = JSON.parse(String(data)) as Answer
      this.answers.push(answer)
      this.#answer?.(answer)
      this.#answer = null
    })
    this.closed = new Promise((resolve) => this.ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })))
  }

  /** Whether to keep received messages (off for bulk tests). */
  keep = true

  static async open(url: string): Promise<RelayClient> {
    const client = new RelayClient(url)
    await once(client.ws, 'open')
    return client
  }

  /** Sends the request and resolves with its answer (the phone's arrives once the desktop accepted). */
  request(m: string, p: Record<string, unknown>, id: number | string = 1): Promise<Answer> {
    const answered = new Promise<Answer>((resolve) => (this.#answer = resolve))
    this.ws.send(JSON.stringify({ t: 'req', id, m, p }))
    return answered
  }

  /** Sends the request without waiting. */
  send(m: string, p: Record<string, unknown>, id: number | string = 1): Promise<Answer> {
    return this.request(m, p, id)
  }

  /** Resolves when at least `bytes` have arrived. */
  async until(bytes: number, timeoutMs = 10_000): Promise<void> {
    const start = Date.now()
    while (this.received < bytes) {
      if (Date.now() - start > timeoutMs) throw new Error(`only ${this.received} of ${bytes} bytes within ${timeoutMs} ms`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  close(code?: number): void {
    this.ws.close(code)
  }
}

export interface RelaySetup extends TestServer {
  relayUrl: string
  desktop: TestClient
  credential: { deviceId: string; deviceSecret: string; memberId: string }
  grant: { id: string; secret: string }
}

/** A relaying server with one member whose desktop is connected and holds one grant. */
export async function relaySetup(
  t: { after: (fn: () => Promise<void> | void) => void },
  options: Partial<ServerOptions> = {},
): Promise<RelaySetup> {
  const ts = await testServer(t, { ...options, relay: { enabled: true, ...options.relay } })
  const joined = seedMember(ts.db, 'sam', 'home desktop')
  const desktop = await TestClient.open(ts.url)
  t.after(() => desktop.close())
  const hello = await desktop.request('hello', { protocol: [1], deviceId: joined.device.id, deviceSecret: joined.deviceSecret })
  if (!hello.ok) throw new Error(`hello failed: ${JSON.stringify(hello)}`)
  const granted = await desktop.request('relay.grant', { name: 'Pixel 8' })
  if (!granted.ok) throw new Error(`relay.grant failed: ${JSON.stringify(granted)}`)
  return {
    ...ts,
    relayUrl: ts.url.replace(/\/connect$/, '/relay'),
    desktop,
    credential: { deviceId: joined.device.id, deviceSecret: joined.deviceSecret, memberId: joined.member.id },
    grant: { id: granted.r.grant.id, secret: granted.r.secret },
  }
}

/** The phone opens a tunnel; resolves with the phone leg and the pending answer. */
export async function phoneOpens(s: RelaySetup, grant = s.grant) {
  const phone = await RelayClient.open(s.relayUrl)
  const answer = phone.request('relay.open', { protocol: [1], grant: grant.id, secret: grant.secret })
  return { phone, answer }
}

/** Opens a whole tunnel: the phone asks, the desktop accepts. */
export async function openTunnel(s: RelaySetup, grant = s.grant) {
  const { phone, answer } = await phoneOpens(s, grant)
  const incoming = await s.desktop.nextEvent('relay.incoming')
  const desktopLeg = await RelayClient.open(s.relayUrl)
  const accepted = await desktopLeg.request('relay.accept', {
    protocol: [1],
    deviceId: s.credential.deviceId,
    deviceSecret: s.credential.deviceSecret,
    tunnel: incoming.d.tunnel,
  })
  const phoneAnswer = await answer
  if (!accepted.ok || !phoneAnswer.ok) throw new Error(`tunnel not opened: ${JSON.stringify([accepted, phoneAnswer])}`)
  return { phone, desktop: desktopLeg, tunnel: incoming.d.tunnel as string, incoming, accepted, phoneAnswer }
}

/** Cuts writes into binary messages of at most `max` bytes, as clients must (design D4). */
export function chunked(max = 64 * 1024): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      for (let i = 0; i < chunk.length; i += max) this.push(chunk.subarray(i, i + max))
      done()
    },
  })
}

/**
 * A byte stream over a spliced leg: reads are the leg's binary messages, writes become binary messages, cut to
 * at most `max` bytes when `max` is given.
 */
export function legStream(ws: WebSocket, max: number | null): Duplex {
  const raw = createWebSocketStream(ws)
  if (max === null) return raw
  const cutter = chunked(max)
  cutter.pipe(raw)
  return Duplex.from({ writable: cutter, readable: raw })
}
