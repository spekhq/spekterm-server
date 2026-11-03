/**
 * Pushes `handoff.status` events to the sender's subscribed connections (`handoff-status` spec, design D5).
 *
 * A connection subscribes when its `handoff.sync` answer says `more: false`, with the `seq` it has been given so
 * far as its cursor. `publish()` brings every subscriber up to date with its own query, so a failure for one never
 * makes another skip a record. It runs from socket listeners and timers, outside the operation handler's `try`;
 * nothing here may throw.
 */
import { type Database, latestSeq } from './db.ts'
import { recordsAfter } from './handoffs.ts'
import { isDeviceActive } from './team.ts'

/** What the feed needs of a connection; `Connection` implements it, tests use fakes. */
export interface FeedTarget {
  readonly memberId: string | null
  readonly deviceId: string | null
  sendEvent(kind: string, data: unknown): void
  /** Close the connection because its device was found revoked (4004). */
  closeRevoked(): void
  /** Close the connection because it could not be brought up to date (1011). */
  closeInternal(): void
}

const PAGE = 100

export class Feed {
  readonly #db: Database
  readonly #log: (message: string) => void
  /** Subscribed connections per member, each with the highest `seq` it has been given. */
  readonly #subscribers = new Map<string, Map<FeedTarget, number>>()
  /** The counter at the last `publish()` that left every subscriber up to date. */
  #latestSeen: number
  /** Set at the start of shutdown: nothing is sent any more. */
  closing = false

  constructor(db: Database, log: (message: string) => void) {
    this.#db = db
    this.#log = log
    let latest = 0
    try {
      latest = latestSeq(db)
    } catch (error) {
      log(`could not read the handoff sequence: ${(error as Error).message}`)
    }
    this.#latestSeen = latest
  }

  subscribe(target: FeedTarget, cursor: number): void {
    if (target.memberId === null) return
    const subs = this.#subscribers.get(target.memberId) ?? new Map<FeedTarget, number>()
    subs.set(target, cursor)
    this.#subscribers.set(target.memberId, subs)
  }

  unsubscribe(target: FeedTarget): void {
    if (target.memberId === null) return
    const subs = this.#subscribers.get(target.memberId)
    if (subs === undefined) return
    subs.delete(target)
    if (subs.size === 0) this.#subscribers.delete(target.memberId)
  }

  onClosed(target: FeedTarget): void {
    this.unsubscribe(target)
  }

  /** The cursor of a subscribed connection, or undefined (for tests). */
  cursorOf(target: FeedTarget): number | undefined {
    return target.memberId === null ? undefined : this.#subscribers.get(target.memberId)?.get(target)
  }

  /** Sends every subscriber the records changed since its cursor. */
  publish(): void {
    if (this.closing) return
    let latest: number
    try {
      latest = latestSeq(this.#db)
    } catch (error) {
      this.#log(`could not read the handoff sequence: ${(error as Error).message}`)
      return
    }
    if (latest === this.#latestSeen) return
    let allUpToDate = true
    // Over a copy: closing a connection removes it from the map.
    for (const [memberId, subs] of [...this.#subscribers]) {
      for (const target of [...subs.keys()]) {
        if (this.closing) return
        if (!subs.has(target)) continue
        if (!this.#bringUpToDate(memberId, subs, target)) allUpToDate = false
      }
    }
    if (allUpToDate) this.#latestSeen = latest
  }

  #bringUpToDate(memberId: string, subs: Map<FeedTarget, number>, target: FeedTarget): boolean {
    try {
      if (target.deviceId === null || !isDeviceActive(this.#db, target.deviceId)) {
        this.#log(`device ${target.deviceId} was revoked; closing its connection instead of sending status`)
        this.unsubscribe(target)
        target.closeRevoked()
        return true
      }
      for (;;) {
        const records = recordsAfter(this.#db, memberId, subs.get(target)!, PAGE)
        for (const record of records) {
          target.sendEvent('handoff.status', record)
          subs.set(target, record.seq)
        }
        if (records.length < PAGE) return true
      }
    } catch (error) {
      this.#log(`could not send status to device ${target.deviceId}; closing its connection: ${(error as Error).message}`)
      this.unsubscribe(target)
      try {
        target.closeInternal()
      } catch {
        // Closing a socket does not throw; nothing more to do if it does.
      }
      return false
    }
  }
}
