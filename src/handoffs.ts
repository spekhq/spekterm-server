/**
 * Handoff rules (`handoff-delivery` and `handoff-status` specs): validating, sending, acknowledging, listing what
 * waits for a member, expiring, the recipient's status reports, the sender's change feed, and retention.
 * Offering to connections lives in `delivery.ts`, pushing status records in `feed.ts`.
 *
 * The server keeps a handoff's title and body only while it is pending; they are cleared when it is
 * delivered or expires (handoff-delivery design D7). Every write that changes a handoff gives it a new sequence
 * number (handoff-return design D3, D4).
 */
import { createHash } from 'node:crypto'
import { type Database, latestSeq, nextSeq, readTransaction, writeTransaction } from './db.ts'
import { ProtocolError, badParams } from './errors.ts'
import { type Clock, newHandoffId } from './team.ts'

export const MAX_TITLE_LENGTH = 200
export const MAX_BODY_LENGTH = 20_000
export const HANDOFF_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_REASON_LENGTH = 500
export const MAX_REPORT_LENGTH = 4_000
export const MAX_REPORTS = 10
const DAY_MS = 24 * 60 * 60 * 1000
export const REPORT_RETENTION_MS = 30 * DAY_MS
export const RECORD_RETENTION_MS = 90 * DAY_MS
export const SYNC_PAGE_RECORDS = 100
export const SYNC_PAGE_BYTES = 200 * 1024
const HOUR_MS = 60 * 60 * 1000
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export type HandoffStatus = 'pending' | 'delivered' | 'taken' | 'declined' | 'done' | 'expired'
export type ReportStatus = 'taken' | 'declined' | 'done'

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
  handoff: { id: string; status: HandoffStatus; sentAt: number; expiresAt: number; seq: number }
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
        `SELECT id, status, created_at, expires_at, recipient_member_id, request_hash, seq FROM handoffs
         WHERE sender_member_id = ? AND client_id = ?`,
      )
      .get(sender.memberId, request.clientId) as
      | {
          id: string
          status: HandoffStatus
          created_at: number
          expires_at: number
          recipient_member_id: string
          request_hash: Uint8Array
          seq: number
        }
      | undefined
    if (earlier !== undefined) {
      if (!Buffer.from(earlier.request_hash).equals(hash)) {
        throw new ProtocolError('HANDOFF_ID_REUSED', 'this clientId was used for a different handoff')
      }
      return {
        handoff: { id: earlier.id, status: earlier.status, sentAt: earlier.created_at, expiresAt: earlier.expires_at, seq: earlier.seq },
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
    const seq = nextSeq(db)
    db.prepare(
      `INSERT INTO handoffs (id, client_id, sender_member_id, sender_device_id, recipient_member_id, enc, title, body,
         request_hash, status, created_at, expires_at, seq, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
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
      seq,
      at,
    )
    return {
      handoff: { id, status: 'pending', sentAt: at, expiresAt, seq },
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
    // Delivered, and perhaps taken, declined or done since: repeats from that device change nothing. Checked
    // before the expiry, which applies only to pending handoffs.
    if (row.delivered_device_id !== null) {
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
         title = NULL, body = NULL, seq = ?, changed_at = ? WHERE id = ?`,
    ).run(at, device.deviceId, at, nextSeq(db), at, handoffId)
    return 'ok'
  })
  if (outcome === 'expired') throw new ProtocolError('HANDOFF_EXPIRED', 'this handoff expired')
}

/** Inside a write transaction: expires one pending handoff, clearing its text, with a new sequence number. */
function expire(db: Database, handoffId: string, at: number): void {
  db.prepare(
    `UPDATE handoffs SET status = 'expired', ended_at = ?, title = NULL, body = NULL, seq = ?, changed_at = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(at, nextSeq(db), at, handoffId)
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

// ---------------------------------------------------------------------------------------------------------
// Status reports from the recipient (`handoff-status` spec, design D1–D2)

export interface ReportPayload {
  enc: 'none'
  text: string
}

export interface UpdateRequest {
  id: string
  status: ReportStatus
  /** The reason or the report; null for `taken` and for a decline without `payload`. */
  payload: ReportPayload | null
}

const REPORT_STATUSES: readonly string[] = ['taken', 'declined', 'done'] satisfies ReportStatus[]

function reportPayload(value: unknown, limit: number): ReportPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badParams('payload', 'payload must be an object')
  }
  const { enc, text: raw } = value as Record<string, unknown>
  if (enc !== 'none') throw badParams('payload.enc', 'payload.enc must be "none"')
  return { enc: 'none', text: text(raw, 'payload.text', limit) }
}

export function validateUpdate(p: Record<string, unknown>): UpdateRequest {
  if (typeof p.id !== 'string' || p.id === '') throw badParams('id', 'id must be a handoff id')
  if (typeof p.status !== 'string' || !REPORT_STATUSES.includes(p.status)) {
    throw badParams('status', 'status must be "taken", "declined" or "done"')
  }
  const status = p.status as ReportStatus
  if (status === 'taken') return { id: p.id, status, payload: null }
  if (status === 'declined') {
    return { id: p.id, status, payload: p.payload === undefined ? null : reportPayload(p.payload, MAX_REASON_LENGTH) }
  }
  if (p.payload === undefined) throw badParams('payload', 'a done report needs payload')
  const payload = reportPayload(p.payload, MAX_REPORT_LENGTH)
  if (!/\S/u.test(payload.text)) throw badParams('payload.text', 'the report must not be empty')
  return { id: p.id, status, payload }
}

/** Recognises a resent reason or report, also after its text was deleted (design D1). */
function reportHash(status: 'declined' | 'done', payload: ReportPayload | null): Buffer {
  return createHash('sha256')
    .update(JSON.stringify([status, payload?.enc ?? 'none', payload?.text ?? '']), 'utf8')
    .digest()
}

export interface UpdateResult {
  status: HandoffStatus
  /** False when the report repeated what was stored and nothing changed. */
  changed: boolean
  /** How many reports were accepted (for the log). */
  reports: number
}

/** Records a status report from the device the handoff was delivered to (design D1). */
export function updateStatus(
  db: Database,
  request: UpdateRequest,
  device: { memberId: string; deviceId: string },
  now: Clock,
): UpdateResult {
  // An overdue pending handoff is expired and committed before the error is raised, as in `acknowledge`.
  const outcome = writeTransaction(db, (): UpdateResult | 'expired' => {
    const row = db
      .prepare(
        `SELECT recipient_member_id, status, expires_at, delivered_device_id, report_hash, report_count
         FROM handoffs WHERE id = ?`,
      )
      .get(request.id) as
      | {
          recipient_member_id: string
          status: HandoffStatus
          expires_at: number
          delivered_device_id: string | null
          report_hash: Uint8Array | null
          report_count: number
        }
      | undefined
    if (row === undefined || row.recipient_member_id !== device.memberId) {
      throw new ProtocolError('HANDOFF_UNKNOWN', 'no such handoff for this member')
    }
    const at = now()
    if (row.status === 'expired') return 'expired'
    if (row.status === 'pending') {
      if (row.expires_at <= at) {
        expire(db, request.id, at)
        return 'expired'
      }
      throw new ProtocolError('HANDOFF_NOT_DELIVERED', 'acknowledge this handoff with handoff.received first')
    }
    if (row.delivered_device_id !== device.deviceId) {
      throw new ProtocolError('HANDOFF_DELIVERED_ELSEWHERE', 'this handoff was delivered to another device of this member')
    }
    const current = row.status
    const unchanged = (): UpdateResult => ({ status: current, changed: false, reports: row.report_count })
    const finished = (): ProtocolError =>
      new ProtocolError('HANDOFF_FINISHED', `this handoff is already ${current}`, { status: current })
    const same = (hash: Buffer) => row.report_hash !== null && Buffer.from(row.report_hash).equals(hash)

    if (request.status === 'taken') {
      if (current === 'declined') throw finished()
      if (current !== 'delivered') return unchanged()
      db.prepare(`UPDATE handoffs SET status = 'taken', seq = ?, changed_at = ? WHERE id = ?`).run(nextSeq(db), at, request.id)
      return { status: 'taken', changed: true, reports: row.report_count }
    }

    const hash = reportHash(request.status, request.payload)
    if (request.status === 'declined') {
      if (current === 'declined') {
        if (same(hash)) return unchanged()
        throw finished()
      }
      if (current === 'done') throw finished()
    } else {
      if (current === 'declined') throw finished()
      if (current === 'done' && same(hash)) return unchanged()
      if (row.report_count >= MAX_REPORTS) {
        throw new ProtocolError('TOO_MANY_REPORTS', `at most ${MAX_REPORTS} reports for one handoff`, { limit: MAX_REPORTS })
      }
    }
    const text = request.payload === null || request.payload.text === '' ? null : request.payload.text
    const reports = request.status === 'done' ? row.report_count + 1 : row.report_count
    db.prepare(
      `UPDATE handoffs SET status = ?, seq = ?, changed_at = ?, report_enc = ?, report_text = ?, report_at = ?,
         report_hash = ?, report_count = ? WHERE id = ?`,
    ).run(request.status, nextSeq(db), at, text === null ? null : 'none', text, at, hash, reports, request.id)
    return { status: request.status, changed: true, reports }
  })
  if (outcome === 'expired') throw new ProtocolError('HANDOFF_EXPIRED', 'this handoff expired')
  return outcome
}

// ---------------------------------------------------------------------------------------------------------
// The sender's change feed (design D3, D5, D6)

export interface StatusRecord {
  seq: number
  id: string
  clientId: string
  to: { id: string; handle: string; displayName: string; removed: boolean }
  sentFrom: string
  status: HandoffStatus
  sentAt: number
  expiresAt: number
  changedAt: number
  deliveredAt?: number
  reports?: number
  payload?: ReportPayload
}

interface RecordRow {
  seq: number
  id: string
  client_id: string
  sender_device_id: string
  status: HandoffStatus
  created_at: number
  expires_at: number
  changed_at: number
  delivered_at: number | null
  report_count: number
  report_text: string | null
  to_id: string
  to_handle: string
  to_display_name: string
  to_removed_at: number | null
}

function toRecord(r: RecordRow): StatusRecord {
  const record: StatusRecord = {
    seq: r.seq,
    id: r.id,
    clientId: r.client_id,
    to: { id: r.to_id, handle: r.to_handle, displayName: r.to_display_name, removed: r.to_removed_at !== null },
    sentFrom: r.sender_device_id,
    status: r.status,
    sentAt: r.created_at,
    expiresAt: r.expires_at,
    changedAt: r.changed_at,
  }
  if (r.delivered_at !== null) record.deliveredAt = r.delivered_at
  if (r.status === 'done') record.reports = r.report_count
  if ((r.status === 'declined' || r.status === 'done') && r.report_text !== null) {
    record.payload = { enc: 'none', text: r.report_text }
  }
  return record
}

/** The member's sent handoffs with `seq > after`, in `seq` order, at most `limit`. One statement. */
export function recordsAfter(db: Database, senderMemberId: string, after: number, limit: number): StatusRecord[] {
  const rows = db
    .prepare(
      `SELECT h.seq, h.id, h.client_id, h.sender_device_id, h.status, h.created_at, h.expires_at, h.changed_at,
         h.delivered_at, h.report_count, h.report_text,
         m.id AS to_id, m.handle AS to_handle, m.display_name AS to_display_name, m.removed_at AS to_removed_at
       FROM handoffs h JOIN members m ON m.id = h.recipient_member_id
       WHERE h.sender_member_id = ? AND h.seq > ? ORDER BY h.seq LIMIT ?`,
    )
    .all(senderMemberId, after, limit) as unknown as RecordRow[]
  return rows.map(toRecord)
}

export interface SyncResult {
  records: StatusRecord[]
  more: boolean
  latest: number
  reset: boolean
}

/** A `handoff.sync` answer, and the cursor a subscription starts from. */
export function syncSent(db: Database, senderMemberId: string, afterParam: unknown): { result: SyncResult; cursor: number } {
  const after = afterParam === undefined ? 0 : afterParam
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) {
    throw badParams('after', 'after must be a non-negative integer')
  }
  // Records and latest from one snapshot: another process may commit in between (design D5).
  return readTransaction(db, () => {
    const latest = latestSeq(db)
    const reset = after > latest
    const from = reset ? 0 : after
    const candidates = recordsAfter(db, senderMemberId, from, SYNC_PAGE_RECORDS + 1)
    const records: StatusRecord[] = []
    let bytes = 0
    for (const record of candidates.slice(0, SYNC_PAGE_RECORDS)) {
      const size = Buffer.byteLength(JSON.stringify(record), 'utf8')
      if (records.length > 0 && bytes + size > SYNC_PAGE_BYTES) break
      records.push(record)
      bytes += size
    }
    const more = candidates.length > records.length
    const cursor = records.length > 0 ? records[records.length - 1]!.seq : from
    return { result: { records, more, latest, reset }, cursor }
  })
}

// ---------------------------------------------------------------------------------------------------------
// Retention (design D8)

/** Deletes reasons and reports written at least 30 days ago; returns the handoff ids. */
export function deleteOldReports(db: Database, now: Clock): string[] {
  return writeTransaction(db, () =>
    (
      db
        .prepare(
          `UPDATE handoffs SET report_text = NULL, report_enc = NULL
           WHERE report_text IS NOT NULL AND report_at <= ? RETURNING id`,
        )
        .all(now() - REPORT_RETENTION_MS) as Array<{ id: string }>
    ).map((r) => r.id),
  )
}

/** Deletes the records of handoffs whose last change was at least 90 days ago; returns their ids. */
export function deleteOldRecords(db: Database, now: Clock): string[] {
  return writeTransaction(db, () =>
    (
      db
        .prepare(`DELETE FROM handoffs WHERE changed_at <= ? AND status != 'pending' RETURNING id`)
        .all(now() - RECORD_RETENTION_MS) as Array<{ id: string }>
    ).map((r) => r.id),
  )
}
