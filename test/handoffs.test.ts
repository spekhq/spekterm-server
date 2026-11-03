import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProtocolError } from '../src/errors.ts'
import {
  HANDOFF_LIFETIME_MS,
  acknowledge,
  expireOverdue,
  handoffStatus,
  offerable,
  pendingIdsFor,
  sendHandoff,
  validateSend,
} from '../src/handoffs.ts'
import { createInvite, join as joinTeam, leave, removeMember, revokeDevice } from '../src/team.ts'
import { manualClock, tempDatabase } from './helpers/db.ts'

const HOUR = 60 * 60 * 1000
type Db = Parameters<typeof sendHandoff>[0]

function rejects(fn: () => unknown, code: string, detail?: Record<string, unknown>): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof ProtocolError, `expected ProtocolError, got ${String(e)}`)
    assert.equal(e.code, code)
    if (detail !== undefined) for (const [k, v] of Object.entries(detail)) assert.deepEqual(e.detail?.[k], v)
    return true
  })
}

function member(db: Db, now: () => number, handle: string, deviceName = 'desk') {
  const j = joinTeam(db, { code: createInvite(db, {}, now).code, handle, displayName: handle.toUpperCase(), deviceName }, now)
  return { memberId: j.member.id, deviceId: j.device.id, secret: j.deviceSecret }
}

function request(clientId: string, to = 'sam', title = 'Billing change', body = 'Please add a refund field.') {
  return validateSend({ clientId, to, payload: { enc: 'none', title, body } })
}

function setup(t: Parameters<typeof tempDatabase>[0]) {
  const { db, ...rest } = tempDatabase(t)
  const clock = manualClock()
  const alex = member(db, clock.now, 'alex')
  const sam = member(db, clock.now, 'sam')
  return { db, clock, alex, sam, ...rest }
}

// --- validation -----------------------------------------------------------------------------------------

test('validation: clientId, to, enc', () => {
  const ok = { clientId: 'c1', to: 'sam', payload: { enc: 'none', title: 't', body: 'b' } }
  assert.deepEqual(validateSend(ok), { clientId: 'c1', to: 'sam', payload: { enc: 'none', title: 't', body: 'b' } })
  for (const clientId of ['', 'a'.repeat(65), 'has space', 'é', 7]) {
    rejects(() => validateSend({ ...ok, clientId }), 'BAD_PARAMS', { field: 'clientId' })
  }
  validateSend({ ...ok, clientId: 'a'.repeat(64) })
  validateSend({ ...ok, clientId: '3f2a-uuid_like-ID' })
  rejects(() => validateSend({ ...ok, to: 5 }), 'BAD_PARAMS', { field: 'to' })
  rejects(() => validateSend({ ...ok, payload: 'x' }), 'BAD_PARAMS', { field: 'payload' })
  rejects(() => validateSend({ ...ok, payload: { enc: 'x25519', title: 't', body: 'b' } }), 'BAD_PARAMS', { field: 'payload.enc' })
})

test('validation: lengths in UTF-16 code units, empty allowed, well-formed only', () => {
  const send = (title: string, body: string) => validateSend({ clientId: 'c', to: 'sam', payload: { enc: 'none', title, body } })
  send('', '')
  send('t'.repeat(200), 'b'.repeat(20_000))
  rejects(() => send('t'.repeat(201), 'b'), 'BAD_PARAMS', { field: 'payload.title', limit: 200 })
  rejects(() => send('t', 'b'.repeat(20_001)), 'BAD_PARAMS', { field: 'payload.body', limit: 20_000 })
  send('t', '😀'.repeat(10_000))
  rejects(() => send('t', '😀'.repeat(10_000) + 'x'), 'BAD_PARAMS', { field: 'payload.body' })
  rejects(() => send('a\ud800b', 'b'), 'BAD_PARAMS', { field: 'payload.title' })
  rejects(() => send('t', 'x\udc00'), 'BAD_PARAMS', { field: 'payload.body' })
})

// --- sending --------------------------------------------------------------------------------------------

test('send stores a pending handoff and describes the recipient', (t) => {
  const { db, clock, alex, sam } = setup(t)
  const result = sendHandoff(db, alex, request('c1'), 30, clock.now)
  assert.match(result.handoff.id, /^h_[0-9a-f]{32}$/)
  assert.equal(result.handoff.status, 'pending')
  assert.equal(result.handoff.sentAt, clock.now())
  assert.equal(result.handoff.expiresAt, clock.now() + HANDOFF_LIFETIME_MS)
  assert.deepEqual(result.recipient, { id: sam.memberId, handle: 'sam', displayName: 'SAM', deviceCount: 1 })
  assert.equal(result.duplicate, false)
  assert.deepEqual(pendingIdsFor(db, sam.memberId, clock.now), [result.handoff.id])
  const offer = offerable(db, result.handoff.id, clock.now)!
  assert.deepEqual(offer.from, { id: alex.memberId, handle: 'alex', displayName: 'ALEX' })
  assert.deepEqual(offer.payload, { enc: 'none', title: 'Billing change', body: 'Please add a refund field.' })
})

test('recipients: case-insensitive, unknown, removed, self, no devices', (t) => {
  const { db, clock, alex, sam } = setup(t)
  assert.equal(sendHandoff(db, alex, request('c1', 'SAM'), 30, clock.now).recipient.handle, 'sam')
  rejects(() => sendHandoff(db, alex, request('c2', 'nobody'), 30, clock.now), 'RECIPIENT_UNKNOWN')
  rejects(() => sendHandoff(db, alex, request('c3', 'alex'), 30, clock.now), 'RECIPIENT_IS_SELF')
  revokeDevice(db, sam.deviceId, clock.now)
  assert.equal(sendHandoff(db, alex, request('c4'), 30, clock.now).recipient.deviceCount, 0)
  removeMember(db, 'sam', clock.now)
  rejects(() => sendHandoff(db, alex, request('c5'), 30, clock.now), 'RECIPIENT_UNKNOWN')
})

test('a resend with the same clientId is recognised, also after delivery and at the limit', (t) => {
  const { db, clock, alex, sam } = setup(t)
  const first = sendHandoff(db, alex, request('c1'), 1, clock.now)
  const again = sendHandoff(db, alex, request('c1'), 1, clock.now)
  assert.equal(again.duplicate, true)
  assert.equal(again.handoff.id, first.handoff.id)
  assert.deepEqual(pendingIdsFor(db, sam.memberId, clock.now), [first.handoff.id])
  acknowledge(db, first.handoff.id, sam, clock.now)
  const afterDelivery = sendHandoff(db, alex, request('c1'), 1, clock.now)
  assert.deepEqual([afterDelivery.duplicate, afterDelivery.handoff.status], [true, 'delivered'])
  rejects(() => sendHandoff(db, alex, request('c1', 'sam', 'Billing change', 'different'), 30, clock.now), 'HANDOFF_ID_REUSED')
  rejects(() => sendHandoff(db, alex, request('c1', 'kim'), 30, clock.now), 'HANDOFF_ID_REUSED')
})

test('a duplicate names the recipient it was stored for, even after the handle changed hands', (t) => {
  const { db, clock, alex, sam } = setup(t)
  sendHandoff(db, alex, request('c1'), 30, clock.now)
  removeMember(db, 'sam', clock.now)
  member(db, clock.now, 'sam')
  const again = sendHandoff(db, alex, request('c1'), 30, clock.now)
  assert.equal(again.recipient.id, sam.memberId)
})

test('rate: at most N an hour per member, across devices; retryAt is exact', (t) => {
  const { db, clock, alex, sam } = setup(t)
  const second = { memberId: alex.memberId, deviceId: joinTeam(db, { code: createInvite(db, { memberHandle: 'alex' }, clock.now).code, deviceName: 'laptop' }, clock.now).device.id }
  const firstAt = clock.now()
  for (let i = 0; i < 3; i++) {
    sendHandoff(db, i % 2 === 0 ? alex : second, request(`c${i}`), 3, clock.now)
    clock.advance(60_000)
  }
  rejects(() => sendHandoff(db, alex, request('c3'), 3, clock.now), 'RATE_LIMITED', { retryAt: firstAt + HOUR })
  assert.equal(pendingIdsFor(db, sam.memberId, clock.now).length, 3)
  // A duplicate at the limit is still answered and does not count.
  assert.equal(sendHandoff(db, alex, request('c0'), 3, clock.now).duplicate, true)
  clock.advance(firstAt + HOUR - 1 - clock.now())
  rejects(() => sendHandoff(db, alex, request('c3'), 3, clock.now), 'RATE_LIMITED')
  clock.advance(1)
  assert.equal(sendHandoff(db, alex, request('c3'), 3, clock.now).duplicate, false)
})

test('rate: a lowered limit gives the (n − L + 1)-th oldest + 1 h', (t) => {
  const { db, clock, alex } = setup(t)
  const times: number[] = []
  for (let i = 0; i < 30; i++) {
    times.push(clock.now())
    sendHandoff(db, alex, request(`c${i}`), 30, clock.now)
    clock.advance(60_000)
  }
  // 30 in the window, limit 10: the 21st-newest (= index 20 from the oldest) must leave.
  rejects(() => sendHandoff(db, alex, request('x'), 10, clock.now), 'RATE_LIMITED', { retryAt: times[20]! + HOUR })
})

// --- acknowledging and expiry ---------------------------------------------------------------------------

test('acknowledgement: first wins, same device ok, other device elsewhere, text cleared', (t) => {
  const { db, clock, alex, sam } = setup(t)
  const laptop = { memberId: sam.memberId, deviceId: joinTeam(db, { code: createInvite(db, { memberHandle: 'sam' }, clock.now).code, deviceName: 'laptop' }, clock.now).device.id }
  const { handoff } = sendHandoff(db, alex, request('c1'), 30, clock.now)
  acknowledge(db, handoff.id, sam, clock.now)
  acknowledge(db, handoff.id, sam, clock.now)
  rejects(() => acknowledge(db, handoff.id, laptop, clock.now), 'HANDOFF_DELIVERED_ELSEWHERE')
  assert.equal(handoffStatus(db, handoff.id), 'delivered')
  const row = db.prepare('SELECT title, body, delivered_device_id FROM handoffs WHERE id = ?').get(handoff.id) as Record<string, unknown>
  assert.deepEqual({ ...row }, { title: null, body: null, delivered_device_id: sam.deviceId })
  assert.equal(offerable(db, handoff.id, clock.now), undefined)
  assert.deepEqual(pendingIdsFor(db, sam.memberId, clock.now), [])
})

test('acknowledgement: unknown, someone else, bad id', (t) => {
  const { db, clock, alex, sam } = setup(t)
  const { handoff } = sendHandoff(db, alex, request('c1'), 30, clock.now)
  rejects(() => acknowledge(db, 'h_nope', sam, clock.now), 'HANDOFF_UNKNOWN')
  rejects(() => acknowledge(db, handoff.id, alex, clock.now), 'HANDOFF_UNKNOWN')
  rejects(() => acknowledge(db, 5, sam, clock.now), 'BAD_PARAMS')
})

test('expiry: overdue handoffs are not offered, and acknowledging one says expired even before the sweep', (t) => {
  const { db, clock, alex, sam } = setup(t)
  const { handoff } = sendHandoff(db, alex, request('c1'), 30, clock.now)
  const other = sendHandoff(db, alex, request('c2'), 30, clock.now).handoff
  clock.advance(HANDOFF_LIFETIME_MS)
  assert.deepEqual(pendingIdsFor(db, sam.memberId, clock.now), [])
  assert.equal(offerable(db, handoff.id, clock.now), undefined)
  rejects(() => acknowledge(db, handoff.id, sam, clock.now), 'HANDOFF_EXPIRED')
  assert.equal(handoffStatus(db, handoff.id), 'expired')
  assert.deepEqual(expireOverdue(db, clock.now), [other.id])
  rejects(() => acknowledge(db, other.id, sam, clock.now), 'HANDOFF_EXPIRED')
  const row = db.prepare('SELECT title, body FROM handoffs WHERE id = ?').get(other.id) as Record<string, unknown>
  assert.deepEqual({ ...row }, { title: null, body: null })
})

test('pending list is oldest first', (t) => {
  const { db, clock, alex, sam } = setup(t)
  const ids: string[] = []
  for (let i = 0; i < 3; i++) {
    ids.push(sendHandoff(db, alex, request(`c${i}`), 30, clock.now).handoff.id)
    clock.advance(1000)
  }
  assert.deepEqual(pendingIdsFor(db, sam.memberId, clock.now), ids)
})

// --- removal --------------------------------------------------------------------------------------------

test('removing the recipient expires what waits for them; what they sent stays pending', (t) => {
  const { db, clock, alex, sam } = setup(t)
  const toSam = sendHandoff(db, alex, request('c1'), 30, clock.now).handoff.id
  const fromSam = sendHandoff(db, sam, request('s1', 'alex'), 30, clock.now).handoff.id
  removeMember(db, 'sam', clock.now)
  assert.equal(handoffStatus(db, toSam), 'expired')
  assert.equal(handoffStatus(db, fromSam), 'pending')
  assert.equal(offerable(db, fromSam, clock.now)?.from.handle, 'sam')
})

test('leaving from the last device expires what waits for the member', (t) => {
  const { db, clock, alex, sam } = setup(t)
  const toSam = sendHandoff(db, alex, request('c1'), 30, clock.now).handoff.id
  assert.deepEqual(leave(db, sam.deviceId, clock.now), { memberRemoved: true })
  assert.equal(handoffStatus(db, toSam), 'expired')
})
