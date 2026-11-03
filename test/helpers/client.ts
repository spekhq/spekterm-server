/** A minimal protocol client for tests. */
import { WebSocket } from 'ws'
import { once } from 'node:events'

export interface Answer {
  t: 'res'
  id: number | string | null
  ok: boolean
  r?: any
  e?: { code: string; message: string; detail?: any }
}

export class TestClient {
  readonly ws: WebSocket
  readonly answers: Answer[] = []
  readonly closed: Promise<{ code: number; reason: string }>
  #nextId = 1
  #waiters = new Map<number | string | null, (a: Answer) => void>()

  constructor(url: string, options: ConstructorParameters<typeof WebSocket>[2] = {}) {
    this.ws = new WebSocket(url, options)
    this.ws.on('error', () => {})
    this.ws.on('message', (data) => {
      const answer = JSON.parse(String(data)) as Answer
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

  close(): void {
    this.ws.close()
  }
}
