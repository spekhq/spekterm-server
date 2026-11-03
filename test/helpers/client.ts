/** A minimal protocol client for tests. */
import { WebSocket } from 'ws'
import { once } from 'node:events'

export interface Event {
  t: 'evt'
  k: string
  d: any
}

export interface Answer {
  t: 'res'
  id: number | string | null
  ok: boolean
  r?: any
  e?: { code: string; message: string; detail?: any }
}

export class TestClient {
  readonly ws: WebSocket
  /** Answers only (kept for existing tests). */
  readonly answers: Answer[] = []
  /** Answers and events, in arrival order. */
  readonly frames: Array<Answer | Event> = []
  #eventWaiters: Array<{ kind: string; resolve: (e: Event) => void }> = []
  readonly closed: Promise<{ code: number; reason: string }>
  #nextId = 1
  #waiters = new Map<number | string | null, (a: Answer) => void>()

  constructor(url: string, options: ConstructorParameters<typeof WebSocket>[2] = {}) {
    this.ws = new WebSocket(url, options)
    this.ws.on('error', () => {})
    this.ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Answer | Event
      this.frames.push(frame)
      if (frame.t === 'evt') {
        const waiter = this.#eventWaiters.find((w) => w.kind === frame.k)
        if (waiter !== undefined) {
          this.#eventWaiters.splice(this.#eventWaiters.indexOf(waiter), 1)
          waiter.resolve(frame)
        }
        return
      }
      const answer = frame
      this.answers.push(answer)
      const waiter = this.#waiters.get(answer.id)
      if (waiter !== undefined) {
        this.#waiters.delete(answer.id)
        waiter(answer)
      }
    })
    this.closed = new Promise((resolve) => {
      this.ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }))
    })
  }

  static async open(url: string, options?: ConstructorParameters<typeof WebSocket>[2]): Promise<TestClient> {
    const client = new TestClient(url, options)
    await once(client.ws, 'open')
    return client
  }

  /** Sends a request and waits for its answer. */
  request(m: string, p: Record<string, unknown> = {}): Promise<Answer> {
    const id = this.#nextId++
    const answered = this.answerTo(id)
    this.ws.send(JSON.stringify({ t: 'req', id, m, p }))
    return answered
  }

  /** Sends raw text and waits for the answer with this id. */
  raw(text: string, id: number | string | null = null): Promise<Answer> {
    const answered = this.answerTo(id)
    this.ws.send(text)
    return answered
  }

  answerTo(id: number | string | null): Promise<Answer> {
    return new Promise((resolve) => this.#waiters.set(id, resolve))
  }

  /** Events of a kind received so far. */
  events(kind: string): Event[] {
    return this.frames.filter((f): f is Event => f.t === 'evt' && f.k === kind)
  }

  /** The next event of a kind that has not been returned by an earlier call; resolves at once if one waits. */
  #consumed = new Map<string, number>()
  nextEvent(kind: string, timeoutMs = 2000): Promise<Event> {
    const used = this.#consumed.get(kind) ?? 0
    const already = this.events(kind)[used]
    this.#consumed.set(kind, used + 1)
    if (already !== undefined) return Promise.resolve(already)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${kind} event within ${timeoutMs} ms`)), timeoutMs)
      this.#eventWaiters.push({ kind, resolve: (e) => (clearTimeout(timer), resolve(e)) })
    })
  }

  /** Resolves false if an event of the kind arrives within the time, true otherwise. */
  async noEvent(kind: string, ms = 300): Promise<boolean> {
    const before = this.events(kind).length
    await new Promise((resolve) => setTimeout(resolve, ms))
    return this.events(kind).length === before
  }

  close(): void {
    this.ws.close()
  }
}
