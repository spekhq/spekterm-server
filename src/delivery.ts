/**
 * Offers pending handoffs to one of the recipient's connections at a time (`handoff-delivery` spec, design
 * D1–D2). A handoff is leased to a connection when it is offered there; the lease ends when the handoff is
 * acknowledged or the connection closes.
 *
 * Every entry point runs from a socket listener or a timer, outside the operation handler's `try`; nothing
 * here may throw, so each handoff is offered inside its own `try`.
 */
import type { Database } from './db.ts'
import { type Offer, offerable, pendingIdsFor } from './handoffs.ts'
import { type Clock, isDeviceActive } from './team.ts'

/** What delivery needs of a connection; `Connection` implements it, tests use fakes. */
export interface DeliveryTarget {
  readonly memberId: string | null
  readonly deviceId: string | null
  /** Handoff ids already offered on this connection. */
  readonly offered: Set<string>
  sendEvent(kind: string, data: unknown): void
  /** Close the connection because its device was found revoked (4004). */
  closeRevoked(): void
}

export type CloseReason = 'replaced' | 'other'

export function incomingEvent(offer: Offer) {
  return { id: offer.id, from: offer.from, payload: offer.payload, sentAt: offer.sentAt, expiresAt: offer.expiresAt }
}

export class Delivery {
  readonly #db: Database
  readonly #now: Clock
  readonly #log: (message: string) => void
  /** Ready connections per member, in the order they became ready. */
  readonly #ready = new Map<string, DeliveryTarget[]>()
  readonly #leases = new Map<string, DeliveryTarget>()
  /** Set at the start of shutdown: nothing is offered any more. */
  closing = false

  constructor(db: Database, now: Clock, log: (message: string) => void) {
    this.#db = db
    this.#now = now
    this.#log = log
  }

  /** The connection's join or hello answer has been sent. */
  onReady(target: DeliveryTarget): void {
    const memberId = target.memberId
    if (memberId === null) return
    const list = this.#ready.get(memberId) ?? []
    list.push(target)
    this.#ready.set(memberId, list)
    this.#offerUnleased(memberId, target)
  }

  /** A handoff was stored. */
  onSent(handoffId: string, recipientMemberId: string): void {
    const target = this.#mostRecent(recipientMemberId)
    if (target !== undefined) this.#offer(handoffId, target)
  }

  /** A handoff was acknowledged, by any device. */
  onAcknowledged(handoffId: string): void {
    this.#leases.delete(handoffId)
  }

  /** A connection closed. Its leases are released and, unless it was replaced, offered again. */
  onClosed(target: DeliveryTarget, reason: CloseReason): void {
    const memberId = target.memberId
    if (memberId !== null) {
      const list = this.#ready.get(memberId)
      if (list !== undefined) {
        const rest = list.filter((t) => t !== target)
        if (rest.length === 0) this.#ready.delete(memberId)
        else this.#ready.set(memberId, rest)
      }
    }
    for (const [handoffId, holder] of this.#leases) {
      if (holder === target) this.#leases.delete(handoffId)
    }
    // A replaced connection's handoffs wait for the newer connection of the same device to become ready.
    if (reason === 'replaced' || memberId === null) return
    const next = this.#mostRecent(memberId)
    if (next !== undefined) this.#offerUnleased(memberId, next)
  }

  /** The handoff ids leased now, with the device they are leased to (for tests and logs). */
  leases(): Map<string, string | null> {
    return new Map([...this.#leases].map(([id, t]) => [id, t.deviceId]))
  }

  #mostRecent(memberId: string): DeliveryTarget | undefined {
    const list = this.#ready.get(memberId)
    return list === undefined ? undefined : list[list.length - 1]
  }

  #offerUnleased(memberId: string, target: DeliveryTarget): void {
    if (this.closing) return
    let ids: string[]
    try {
      ids = pendingIdsFor(this.#db, memberId, this.#now)
    } catch (error) {
      this.#log(`could not list pending handoffs for member ${memberId}: ${(error as Error).message}`)
      return
    }
    for (const id of ids) {
      if (!this.#leases.has(id)) this.#offer(id, target)
    }
  }

  #offer(handoffId: string, target: DeliveryTarget): void {
    if (this.closing || this.#leases.has(handoffId) || target.offered.has(handoffId)) return
    try {
      if (target.deviceId === null || !isDeviceActive(this.#db, target.deviceId)) {
        // Revoked by another process before the sweep noticed: never push text there. Closing it runs
        // onClosed, which offers what it held, and this handoff, to the member's next ready connection.
        this.#log(`device ${target.deviceId} was revoked; closing its connection instead of offering`)
        target.closeRevoked()
        return
      }
      const offer = offerable(this.#db, handoffId, this.#now)
      if (offer === undefined || offer.recipientMemberId !== target.memberId) return
      this.#leases.set(handoffId, target)
      target.offered.add(handoffId)
      target.sendEvent('handoff.incoming', incomingEvent(offer))
      this.#log(`handoff ${handoffId} offered to device ${target.deviceId}`)
    } catch (error) {
      this.#leases.delete(handoffId)
      this.#log(`could not offer handoff ${handoffId}: ${(error as Error).message}`)
    }
  }
}
