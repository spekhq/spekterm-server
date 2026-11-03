/**
 * Handoff rules (`handoff-delivery` spec): validating, sending, acknowledging, listing what waits for a
 * member, and expiring. Offering to connections lives in `delivery.ts`.
 *
 * The server keeps a handoff's title and body only while it is pending; they are cleared when it is
 * delivered or expires (design D7).
 */
import { createHash } from 'node:crypto'
import { type Database, writeTransaction } from './db.ts'
import { ProtocolError, badParams } from './errors.ts'
import { type Clock, newHandoffId } from './team.ts'

export const MAX_TITLE_LENGTH = 200
export const MAX_BODY_LENGTH = 20_000
export const HANDOFF_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export type HandoffStatus = 'pending' | 'delivered' | 'expired'

export interface Payload {
  enc: 'none'
  title: string
  body: string
}

export interface SendRequest {
  clientId: string
  to: string
  payload: Payload
}

export interface SendResult {
  handoff: { id: string; status: HandoffStatus; sentAt: number; expiresAt: number }
  recipient: { id: string; handle: string; displayName: string; deviceCount: number }
  duplicate: boolean
}

/** What a recipient's device is sent in a `handoff.incoming` event. */
export interface Offer {
  id: string
  recipientMemberId: string
  from: { id: string; handle: string; displayName: string }
  payload: Payload
  sentAt: number
  expiresAt: number
}

// ---------------------------------------------------------------------------------------------------------
// Validation

function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string') throw badParams(field, `${field} must be a string`)
  if (value.length > limit) {
    throw new ProtocolError('BAD_PARAMS', `${field} must be at most ${limit} UTF-16 code units`, { field, limit })
  }
  if (!value.isWellFormed()) throw badParams(field, `${field} must be well-formed UTF-16`)
  return value
}

export function validateSend(p: Record<string, unknown>): SendRequest {
  if (typeof p.clientId !== 'string' || !CLIENT_ID_PATTERN.test(p.clientId)) {
    throw badParams('clientId', 'clientId must be 1–64 of A–Z, a–z, 0–9, _ and -')
  }
  if (typeof p.to !== 'string' || p.to === '') throw badParams('to', 'to must be a handle')
  const payload = p.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw badParams('payload', 'payload must be an object')
  }
  const { enc, title, body } = payload as Record<string, unknown>
  if (enc !== 'none') throw badParams('payload.enc', 'payload.enc must be "none"')
  return {
    clientId: p.clientId,
    to: p.to,
    payload: {
      enc: 'none',
      title: text(title, 'payload.title', MAX_TITLE_LENGTH),
      body: text(body, 'payload.body', MAX_BODY_LENGTH),
    },
  }
}

function requestHash(request: SendRequest): Buffer {
  const { to, payload } = request
  return createHash('sha256')
    .update(JSON.stringify([to.toLowerCase(), payload.enc, payload.title, payload.body]), 'utf8')
    .digest()
}

// ---------------------------------------------------------------------------------------------------------
// Sending

interface RecipientRow {
  id: string
  handle: string
  display_name: string
}

function recipientById(db: Database, memberId: string): SendResult['recipient'] {
  const m = db.prepare('SELECT id, handle, display_name FROM members WHERE id = ?').get(memberId) as unknown as RecipientRow
  const devices = db
    .prepare('SELECT count(*) AS n FROM devices WHERE member_id = ? AND revoked_at IS NULL')
    .get(memberId) as { n: number }
  return { id: m.id, handle: m.handle, displayName: m.display_name, deviceCount: devices.n }
}

/**
 * Stores a handoff, or recognises a resend. One immediate transaction: the duplicate check, the recipient,
 * the rate count and the insert (design D5).
 */
export function sendHandoff(
  db: Database,
  sender: { memberId: string; deviceId: string },
  request: SendRequest,
  ratePerHour: number,
  now: Clock,
): SendResult {
  const hash = requestHash(request)
  return writeTransaction(db, () => {
    const earlier = db
      .prepare(
        `SELECT id, status, created_at, expires_at, recipient_member_id, request_hash FROM handoffs
         WHERE sender_member_id = ? AND client_id = ?`,
      )
      .get(sender.memberId, request.clientId) as
      | { id: string; status: HandoffStatus; created_at: number; expires_at: number; recipient_member_id: string; request_hash: Uint8Array }
      | undefined
    if (earlier !== undefined) {
      if (!Buffer.from(earlier.request_hash).equals(hash)) {
        throw new ProtocolError('HANDOFF_ID_REUSED', 'this clientId was used for a different handoff')
      }
      return {
        handoff: { id: earlier.id, status: earlier.status, sentAt: earlier.created_at, expiresAt: earlier.expires_at },
        recipient: recipientById(db, earlier.recipient_member_id),
        duplicate: true,
      }
    }

    const recipient = db
      .prepare('SELECT id FROM members WHERE handle = ? AND removed_at IS NULL')
      .get(request.to.toLowerCase()) as { id: string } | undefined
    if (recipient === undefined) throw new ProtocolError('RECIPIENT_UNKNOWN', `no member "${request.to}" on the team`)
    if (recipient.id === sender.memberId) throw new ProtocolError('RECIPIENT_IS_SELF', 'a handoff goes to someone else')

    const at = now()
    const inWindow = (
      db
        .prepare('SELECT created_at FROM handoffs WHERE sender_member_id = ? AND created_at > ? ORDER BY created_at')
        .all(sender.memberId, at - HOUR_MS) as Array<{ created_at: number }>
    ).map((r) => r.created_at)
    if (inWindow.length >= ratePerHour) {
      // The (n − L + 1)-th oldest must leave the window before one more fits.
      const retryAt = inWindow[inWindow.length - ratePerHour]! + HOUR_MS
      throw new ProtocolError('RATE_LIMITED', `at most ${ratePerHour} handoffs an hour`, { retryAt })
    }

    const id = newHandoffId()
    const expiresAt = at + HANDOFF_LIFETIME_MS
    db.prepare(
      `INSERT INTO handoffs (id, client_id, sender_member_id, sender_device_id, recipient_member_id, enc, title, body,
         request_hash, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      id,
      request.clientId,
      sender.memberId,
      sender.deviceId,
      recipient.id,
      request.payload.enc,
      request.payload.title,
      request.payload.body,
      hash,
      at,
      expiresAt,
    )
    return {
      handoff: { id, status: 'pending', sentAt: at, expiresAt },
      recipient: recipientById(db, recipient.id),
      duplicate: false,
    }
  })
}

// ---------------------------------------------------------------------------------------------------------
// Offering and acknowledging

const OFFER_COLUMNS = `h.id, h.recipient_member_id, h.enc, h.title, h.body, h.created_at, h.expires_at,
  m.id AS from_id, m.handle AS from_handle, m.display_name AS from_display_name`

interface OfferRow {
  id: string
  recipient_member_id: string
  enc: 'none'
  title: string
  body: string
  created_at: number
  expires_at: number
  from_id: string
  from_handle: string
  from_display_name: string
}

function toOffer(r: OfferRow): Offer {
  return {
    id: r.id,
    recipientMemberId: r.recipient_member_id,
    from: { id: r.from_id, handle: r.from_handle, displayName: r.from_display_name },
    payload: { enc: r.enc, title: r.title, body: r.body },
    sentAt: r.created_at,
    expiresAt: r.expires_at,
  }
}

/** The handoff if it can be offered now: pending and not past its expiry. */
export function offerable(db: Database, handoffId: string, now: Clock): Offer | undefined {
  const row = db
    .prepare(
      `SELECT ${OFFER_COLUMNS} FROM handoffs h JOIN members m ON m.id = h.sender_member_id
       WHERE h.id = ? AND h.status = 'pending' AND h.expires_at > ?`,
    )
    .get(handoffId, now()) as OfferRow | undefined
  return row === undefined ? undefined : toOffer(row)
}

/** Ids of the handoffs waiting for a member, oldest first. */
export function pendingIdsFor(db: Database, memberId: string, now: Clock): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM handoffs WHERE recipient_member_id = ? AND status = 'pending' AND expires_at > ?
         ORDER BY created_at, id`,
      )
      .all(memberId, now()) as Array<{ id: string }>
  ).map((r) => r.id)
}

/** Records a device's acknowledgement (requirement "Acknowledging delivery"). */
export function acknowledge(
  db: Database,
  handoffId: unknown,
  device: { memberId: string; deviceId: string },
  now: Clock,
): void {
  if (typeof handoffId !== 'string') throw badParams('id', 'id must be a handoff id')
  // An overdue handoff is expired and committed before the error is raised (a throw inside the transaction
  // would roll the expiry back).
  const outcome = writeTransaction(db, (): 'ok' | 'expired' => {
    const row = db
      .prepare('SELECT recipient_member_id, status, expires_at, delivered_device_id FROM handoffs WHERE id = ?')
      .get(handoffId) as
      | { recipient_member_id: string; status: HandoffStatus; expires_at: number; delivered_device_id: string | null }
      | undefined
    if (row === undefined || row.recipient_member_id !== device.memberId) {
      throw new ProtocolError('HANDOFF_UNKNOWN', 'no such handoff for this member')
    }
    if (row.status === 'delivered') {
      if (row.delivered_device_id === device.deviceId) return 'ok'
      throw new ProtocolError('HANDOFF_DELIVERED_ELSEWHERE', 'this handoff was delivered to another device of this member')
    }
    const at = now()
    if (row.status === 'expired' || row.expires_at <= at) {
      if (row.status === 'pending') expire(db, handoffId, at)
      return 'expired'
    }
    db.prepare(
      `UPDATE handoffs SET status = 'delivered', delivered_at = ?, delivered_device_id = ?, ended_at = ?,
         title = NULL, body = NULL WHERE id = ?`,
    ).run(at, device.deviceId, at, handoffId)
    return 'ok'
  })
  if (outcome === 'expired') throw new ProtocolError('HANDOFF_EXPIRED', 'this handoff expired')
}

function expire(db: Database, handoffId: string, at: number): void {
  db.prepare(
    `UPDATE handoffs SET status = 'expired', ended_at = ?, title = NULL, body = NULL WHERE id = ? AND status = 'pending'`,
  ).run(at, handoffId)
}

/** Expires every pending handoff past its expiry; returns their ids. */
export function expireOverdue(db: Database, now: Clock): string[] {
  return writeTransaction(db, () => {
    const at = now()
    const ids = (
      db.prepare(`SELECT id FROM handoffs WHERE status = 'pending' AND expires_at <= ?`).all(at) as Array<{ id: string }>
    ).map((r) => r.id)
    for (const id of ids) expire(db, id, at)
    return ids
  })
}

export function handoffStatus(db: Database, handoffId: string): HandoffStatus | undefined {
  const row = db.prepare('SELECT status FROM handoffs WHERE id = ?').get(handoffId) as { status: HandoffStatus } | undefined
  return row?.status
}
