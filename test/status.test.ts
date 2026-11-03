/** Status reports, sequence numbers and the sender's sync (`handoff-status` spec), as functions over a database. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestSeq } from '../src/db.ts'
import { ProtocolError } from '../src/errors.ts'
import {
  HANDOFF_LIFETIME_MS,
  REPORT_RETENTION_MS,
  acknowledge,
  deleteOldRecords,
  deleteOldReports,
  expireOverdue,
  handoffStatus,
  sendHandoff,
  syncSent,
  updateStatus,
  validateSend,
  validateUpdate,
} from '../src/handoffs.ts'
import { createInvite, join as joinTeam, leave, removeMember } from '../src/team.ts'
import { manualClock, tempDatabase } from './helpers/db.ts'

const DAY = 24 * 60 * 60 * 1000
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
  return { memberId: j.member.id, deviceId: j.device.id }
}

function setup(t: Parameters<typeof tempDatabase>[0]) {
  const { db } = tempDatabase(t)
  const clock = manualClock()
  const alex = member(db, clock.now, 'alex')
  const sam = member(db, clock.now, 'sam')
  let n = 0
  const send = (to = 'sam', from = alex) =>
    sendHandoff(
      db,
      from,
      validateSend({ clientId: `c${++n}`, to, payload: { enc: 'none', title: 'Billing change', body: 'Add a refund field.' } }),
      1000,
      clock.now,
    ).handoff.id
  /** A handoff sent by Alex and delivered to Sam's desktop. */
  const delivered = () => {
    const id = send()
    acknowledge(db, id, sam, clock.now)
    return id
  }
  const report = (id: string, status: string, payload?: unknown, device = sam) =>
    updateStatus(db, validateUpdate({ id, status, ...(payload === undefined ? {} : { payload }) }), device, clock.now)
  const seqOf = (id: string) => (db.prepare('SELECT seq FROM handoffs WHERE id = ?').get(id) as { seq: number }).seq
  const text = (t: string) => ({ enc: 'none', text: t })
  return { db, clock, alex, sam, send, delivered, report, seqOf, text }
}

// --- sequence numbers (task 1.2) ------------------------------------------------------------------------

test('every change takes a new, increasing sequence number', (t) => {
  const { db, clock, sam, send, seqOf } = setup(t)
  const id = send()
  const sent = seqOf(id)
  acknowledge(db, id, sam, clock.now)
  const delivered = seqOf(id)
  acknowledge(db, id, sam, clock.now) // a repeat changes nothing
  assert.equal(seqOf(id), delivered)
  const other = send()
  clock.advance(HANDOFF_LIFETIME_MS)
  expireOverdue(db, clock.now)
  assert.ok(sent < delivered && delivered < seqOf(other))
  assert.equal(seqOf(other), latestSeq(db))
  // Expired at acknowledgement.
  const third = send()
  clock.advance(HANDOFF_LIFETIME_MS)
  const before = latestSeq(db)
  rejects(() => acknowledge(db, third, sam, clock.now), 'HANDOFF_EXPIRED')
  assert.equal(seqOf(third), before + 1)
})

test('removing the recipient gives every handoff addressed to them a new seq, expiring only the pending ones', (t) => {
  const { db, clock, send, delivered, report, seqOf } = setup(t)
  const pending1 = send()
  const pending2 = send()
  const taken = delivered()
  report(taken, 'taken')
  const done = delivered()
  report(done, 'done', { enc: 'none', text: 'Added the field.' })
  const before = latestSeq(db)
  removeMember(db, 'sam', clock.now)
  const seqs = [pending1, pending2, taken, done].map(seqOf)
  assert.equal(new Set(seqs).size, 4)
  assert.ok(seqs.every((s) => s > before))
  assert.deepEqual([pending1, pending2, taken, done].map((id) => handoffStatus(db, id)), ['expired', 'expired', 'taken', 'done'])
})

test('leaving from the last device takes the same path', (t) => {
  const { db, clock, sam, delivered, seqOf } = setup(t)
  const id = delivered()
  const before = seqOf(id)
  assert.deepEqual(leave(db, sam.deviceId, clock.now), { memberRemoved: true })
  assert.ok(seqOf(id) > before)
  assert.equal(handoffStatus(db, id), 'delivered')
})

test('a resend after the handoff was taken answers its current status', (t) => {
  const { db, clock, alex, sam, report } = setup(t)
  const request = validateSend({ clientId: 'again', to: 'sam', payload: { enc: 'none', title: 't', body: 'b' } })
  const first = sendHandoff(db, alex, request, 30, clock.now)
  acknowledge(db, first.handoff.id, sam, clock.now)
  report(first.handoff.id, 'taken')
  const again = sendHandoff(db, alex, request, 30, clock.now)
  assert.equal(again.duplicate, true)
  assert.equal(again.handoff.id, first.handoff.id)
  assert.equal(again.handoff.status, 'taken')
  // The answer carries the handoff's current seq: the new one's, then the latest change's.
  const record = syncSent(db, alex.memberId, 0).result.records.find((r) => r.id === first.handoff.id)!
  assert.ok(first.handoff.seq < again.handoff.seq)
  assert.equal(again.handoff.seq, record.seq)
})

// --- validation (task 2.1) ------------------------------------------------------------------------------

test('validation of reports', () => {
  const v = (p: Record<string, unknown>) => validateUpdate({ id: 'h_1', ...p })
  const text = (t: string) => ({ enc: 'none', text: t })
  rejects(() => validateUpdate({ status: 'taken' }), 'BAD_PARAMS', { field: 'id' })
  rejects(() => v({ status: 'dismissed' }), 'BAD_PARAMS', { field: 'status' })
  assert.deepEqual(v({ status: 'taken', payload: 'ignored' }), { id: 'h_1', status: 'taken', payload: null })
  assert.deepEqual(v({ status: 'declined' }).payload, null)
  assert.deepEqual(v({ status: 'declined', payload: text('') }).payload, { enc: 'none', text: '' })
  v({ status: 'declined', payload: text('r'.repeat(500)) })
  rejects(() => v({ status: 'declined', payload: text('r'.repeat(501)) }), 'BAD_PARAMS', { field: 'payload.text', limit: 500 })
  v({ status: 'done', payload: text('r'.repeat(4000)) })
  rejects(() => v({ status: 'done', payload: text('r'.repeat(4001)) }), 'BAD_PARAMS', { field: 'payload.text', limit: 4000 })
  rejects(() => v({ status: 'done', payload: text('  \n\t ') }), 'BAD_PARAMS', { field: 'payload.text' })
  rejects(() => v({ status: 'done', payload: text('') }), 'BAD_PARAMS', { field: 'payload.text' })
  rejects(() => v({ status: 'done', payload: text('done \ud800 ok') }), 'BAD_PARAMS', { field: 'payload.text' })
  rejects(() => v({ status: 'done' }), 'BAD_PARAMS', { field: 'payload' })
  rejects(() => v({ status: 'done', payload: 'x' }), 'BAD_PARAMS', { field: 'payload' })
  rejects(() => v({ status: 'done', payload: { enc: 'x25519', text: 'r' } }), 'BAD_PARAMS', { field: 'payload.enc' })
  rejects(() => v({ status: 'done', payload: { enc: 'none', text: 5 } }), 'BAD_PARAMS', { field: 'payload.text' })
})

// --- the state machine (task 2.2) -----------------------------------------------------------------------

test('taken then done', (t) => {
  const { db, delivered, report, text } = setup(t)
  const id = delivered()
  assert.equal(handoffStatus(db, id), 'delivered')
  assert.deepEqual(report(id, 'taken'), { status: 'taken', changed: true, reports: 0 })
  assert.deepEqual(report(id, 'done', text('Added the field.')), { status: 'done', changed: true, reports: 1 })
  assert.equal(handoffStatus(db, id), 'done')
})

test('a delivered handoff does not expire, and can be reported after 31 days', (t) => {
  const { db, clock, delivered, report, text } = setup(t)
  const id = delivered()
  clock.advance(31 * DAY)
  assert.deepEqual(expireOverdue(db, clock.now), [])
  assert.equal(handoffStatus(db, id), 'delivered')
  assert.equal(report(id, 'done', text('Finally done.')).status, 'done')
})

test('declined with a reason, and taken then declined', (t) => {
  const { db, delivered, report, text } = setup(t)
  const a = delivered()
  assert.equal(report(a, 'declined', text('Kim owns billing now')).status, 'declined')
  assert.equal((db.prepare('SELECT report_text FROM handoffs WHERE id = ?').get(a) as { report_text: string }).report_text, 'Kim owns billing now')
  const b = delivered()
  report(b, 'taken')
  assert.equal(report(b, 'declined', text('Not feasible')).status, 'declined')
})

test('who may report, checked in order', (t) => {
  const { db, clock, alex, sam, send, delivered, report, seqOf } = setup(t)
  // A second device of Sam's.
  const samLaptop = {
    memberId: sam.memberId,
    deviceId: joinTeam(db, { code: createInvite(db, { memberHandle: 'sam' }, clock.now).code, deviceName: 'laptop' }, clock.now).device.id,
  }
  rejects(() => report('h_nope', 'taken'), 'HANDOFF_UNKNOWN')
  const id = delivered()
  rejects(() => report(id, 'done', { enc: 'none', text: 'r' }, alex), 'HANDOFF_UNKNOWN')
  rejects(() => report(id, 'taken', undefined, samLaptop), 'HANDOFF_DELIVERED_ELSEWHERE')
  assert.equal(handoffStatus(db, id), 'delivered')
  const waiting = send()
  const before = seqOf(waiting)
  rejects(() => report(waiting, 'taken'), 'HANDOFF_NOT_DELIVERED')
  assert.equal(seqOf(waiting), before)
  // Pending past its expiry: expired and committed, then refused.
  clock.advance(HANDOFF_LIFETIME_MS)
  rejects(() => report(waiting, 'taken'), 'HANDOFF_EXPIRED')
  assert.equal(handoffStatus(db, waiting), 'expired')
  assert.ok(seqOf(waiting) > before)
  rejects(() => report(waiting, 'taken'), 'HANDOFF_EXPIRED')
})

test('repeats change nothing and take no seq', (t) => {
  const { db, delivered, report, seqOf, text } = setup(t)
  const id = delivered()
  report(id, 'taken')
  const s = seqOf(id)
  assert.deepEqual(report(id, 'taken'), { status: 'taken', changed: false, reports: 0 })
  report(id, 'done', text('R'))
  const s2 = seqOf(id)
  assert.ok(s2 > s)
  assert.deepEqual(report(id, 'done', text('R')), { status: 'done', changed: false, reports: 1 })
  assert.deepEqual(report(id, 'taken'), { status: 'done', changed: false, reports: 1 })
  assert.equal(seqOf(id), s2)
  assert.equal(latestSeq(db), s2)
})

test('a newer report replaces the old one, up to 10', (t) => {
  const { db, delivered, report, seqOf, text } = setup(t)
  const id = delivered()
  for (let i = 1; i <= 10; i++) assert.deepEqual(report(id, 'done', text(`R${i}`)), { status: 'done', changed: true, reports: i })
  const s = seqOf(id)
  rejects(() => report(id, 'done', text('R11')), 'TOO_MANY_REPORTS', { limit: 10 })
  assert.equal((db.prepare('SELECT report_text FROM handoffs WHERE id = ?').get(id) as { report_text: string }).report_text, 'R10')
  // Resending the 10th is still a no-op.
  assert.deepEqual(report(id, 'done', text('R10')), { status: 'done', changed: false, reports: 10 })
  assert.equal(seqOf(id), s)
})

test('finished handoffs refuse what contradicts them', (t) => {
  const { delivered, report, text } = setup(t)
  const declined = delivered()
  report(declined, 'declined', text('busy'))
  rejects(() => report(declined, 'done', text('R')), 'HANDOFF_FINISHED', { status: 'declined' })
  rejects(() => report(declined, 'taken'), 'HANDOFF_FINISHED', { status: 'declined' })
  rejects(() => report(declined, 'declined', text('other')), 'HANDOFF_FINISHED', { status: 'declined' })
  assert.equal(report(declined, 'declined', text('busy')).changed, false)
  const done = delivered()
  report(done, 'done', text('R'))
  rejects(() => report(done, 'declined'), 'HANDOFF_FINISHED', { status: 'done' })
})

test('an absent reason and an empty one are the same', (t) => {
  const { db, clock, delivered, report, text } = setup(t)
  const a = delivered()
  report(a, 'declined')
  assert.equal(report(a, 'declined', text('')).changed, false)
  const b = delivered()
  report(b, 'declined', text(''))
  assert.equal(report(b, 'declined').changed, false)
  clock.advance(REPORT_RETENTION_MS)
  deleteOldReports(db, clock.now)
  assert.equal(report(a, 'declined', text('')).changed, false)
  assert.equal(report(b, 'declined').changed, false)
})

test('resends are recognised after the text was deleted', (t) => {
  const { db, clock, delivered, report, seqOf, text } = setup(t)
  const done = delivered()
  report(done, 'done', text('R'))
  const declined = delivered()
  report(declined, 'declined', text('busy'))
  clock.advance(REPORT_RETENTION_MS)
  assert.deepEqual(deleteOldReports(db, clock.now).sort(), [done, declined].sort())
  const [s1, s2] = [seqOf(done), seqOf(declined)]
  assert.deepEqual(report(done, 'done', text('R')), { status: 'done', changed: false, reports: 1 })
  assert.equal(report(declined, 'declined', text('busy')).changed, false)
  assert.deepEqual([seqOf(done), seqOf(declined)], [s1, s2])
})

// --- acknowledgements in later statuses (task 2.3) ------------------------------------------------------

test('acknowledging again in every later status', (t) => {
  const { db, clock, sam, delivered, report, text } = setup(t)
  const samLaptop = {
    memberId: sam.memberId,
    deviceId: joinTeam(db, { code: createInvite(db, { memberHandle: 'sam' }, clock.now).code, deviceName: 'laptop' }, clock.now).device.id,
  }
  const taken = delivered()
  report(taken, 'taken')
  const declined = delivered()
  report(declined, 'declined')
  const done = delivered()
  report(done, 'done', text('R'))
  for (const id of [taken, declined, done]) {
    const before = handoffStatus(db, id)
    acknowledge(db, id, sam, clock.now)
    assert.equal(handoffStatus(db, id), before)
    rejects(() => acknowledge(db, id, samLaptop, clock.now), 'HANDOFF_DELIVERED_ELSEWHERE')
  }
  clock.advance(31 * DAY)
  acknowledge(db, taken, sam, clock.now)
  assert.equal(handoffStatus(db, taken), 'taken')
})

// --- records and sync (task 3.1) ------------------------------------------------------------------------

test('a record describes the current state without the title', (t) => {
  const { db, alex, sam, delivered, report, text } = setup(t)
  const id = delivered()
  report(id, 'done', text('Added the field.'))
  const { result } = syncSent(db, alex.memberId, 0)
  assert.equal(result.records.length, 1)
  const r = result.records[0]!
  assert.deepEqual(Object.keys(r).sort(), [
    'changedAt', 'clientId', 'deliveredAt', 'expiresAt', 'id', 'payload', 'reports', 'sentAt', 'sentFrom', 'seq', 'status', 'to',
  ])
  assert.equal(r.id, id)
  assert.equal(r.status, 'done')
  assert.deepEqual(r.to, { id: sam.memberId, handle: 'sam', displayName: 'SAM', removed: false })
  assert.equal(r.sentFrom, alex.deviceId)
  assert.equal(r.reports, 1)
  assert.deepEqual(r.payload, { enc: 'none', text: 'Added the field.' })
  assert.doesNotMatch(JSON.stringify(r), /Billing change|refund/)
  // Sam sees none of Alex's sent handoffs.
  assert.deepEqual(syncSent(db, sam.memberId, 0).result.records, [])
})

test('payload only for a declined reason or a report', (t) => {
  const { db, alex, send, delivered, report, text } = setup(t)
  const pending = send()
  const taken = delivered()
  report(taken, 'taken')
  const silent = delivered()
  report(silent, 'declined')
  const reasoned = delivered()
  report(reasoned, 'declined', text('busy'))
  const byId = new Map(syncSent(db, alex.memberId, 0).result.records.map((r) => [r.id, r]))
  assert.equal(byId.get(pending)!.payload, undefined)
  assert.equal(byId.get(pending)!.deliveredAt, undefined)
  assert.equal(byId.get(taken)!.payload, undefined)
  assert.equal(byId.get(taken)!.reports, undefined)
  assert.equal(byId.get(silent)!.payload, undefined)
  assert.deepEqual(byId.get(reasoned)!.payload, { enc: 'none', text: 'busy' })
})

test('sync returns changes after a seq, once, in order; and the cursor', (t) => {
  const { db, alex, delivered, report, text } = setup(t)
  const a = delivered()
  const b = delivered()
  const first = syncSent(db, alex.memberId, undefined)
  assert.deepEqual(first.result.records.map((r) => r.id), [a, b])
  assert.equal(first.result.more, false)
  assert.equal(first.result.reset, false)
  assert.equal(first.result.latest, latestSeq(db))
  assert.equal(first.cursor, first.result.records[1]!.seq)
  report(a, 'taken')
  report(a, 'done', text('R'))
  const next = syncSent(db, alex.memberId, first.cursor)
  assert.deepEqual(next.result.records.map((r) => [r.id, r.status]), [[a, 'done']])
  // Nothing new: the cursor stays at `after`.
  const none = syncSent(db, alex.memberId, next.cursor)
  assert.deepEqual(none.result.records, [])
  assert.equal(none.cursor, next.cursor)
  for (const after of [-1, 1.5, '3', null]) rejects(() => syncSent(db, alex.memberId, after), 'BAD_PARAMS', { field: 'after' })
})

test('paged by count: 250 records as 100, 100, 50', (t) => {
  const { db, alex, send } = setup(t)
  for (let i = 0; i < 250; i++) send()
  const sizes: number[] = []
  let after = 0
  for (;;) {
    const { result } = syncSent(db, alex.memberId, after)
    sizes.push(result.records.length)
    after = result.records.at(-1)!.seq
    if (!result.more) break
  }
  assert.deepEqual(sizes, [100, 100, 50])
})

for (const [label, char] of [['control characters', '\u0001'], ['CJK characters', '交']] as const) {
  test(`paged by size: 4,000-unit reports of ${label}`, (t) => {
    const { db, alex, delivered, report } = setup(t)
    const ids: string[] = []
    for (let i = 0; i < 50; i++) {
      const id = delivered()
      report(id, 'done', { enc: 'none', text: `${i} ` + char.repeat(3996) })
      ids.push(id)
    }
    const seen: string[] = []
    let after = 0
    for (;;) {
      const { result } = syncSent(db, alex.memberId, after)
      const frame = JSON.stringify({ t: 'res', id: 1, ok: true, r: result })
      assert.ok(Buffer.byteLength(frame, 'utf8') < 256 * 1024, `frame of ${Buffer.byteLength(frame, 'utf8')} bytes`)
      const recordBytes = result.records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r), 'utf8'), 0)
      assert.ok(recordBytes <= 200 * 1024)
      seen.push(...result.records.map((r) => r.id))
      after = result.records.at(-1)!.seq
      if (!result.more) break
    }
    assert.deepEqual(seen, ids)
  })
}

test('a record of a removed recipient', (t) => {
  const { db, clock, alex, delivered } = setup(t)
  const id = delivered()
  const before = syncSent(db, alex.memberId, 0)
  removeMember(db, 'sam', clock.now)
  const after = syncSent(db, alex.memberId, before.cursor)
  assert.deepEqual(after.result.records.map((r) => [r.id, r.status, r.to.removed, r.to.handle]), [[id, 'delivered', true, 'sam']])
})

test('a cursor ahead of the server resets to the beginning', (t) => {
  const { db, alex, send } = setup(t)
  const a = send()
  const { result, cursor } = syncSent(db, alex.memberId, 500)
  assert.equal(result.reset, true)
  assert.deepEqual(result.records.map((r) => r.id), [a])
  assert.equal(cursor, result.records[0]!.seq)
  const empty = setup(t)
  const r2 = syncSent(empty.db, empty.alex.memberId, 7)
  assert.equal(r2.result.reset, true)
  assert.equal(r2.cursor, 0)
})

// --- retention (unit part of task 4.1) ------------------------------------------------------------------

test('reports go after 30 days, records after 90 days of no change', (t) => {
  const { db, clock, alex, delivered, report, text } = setup(t)
  const done = delivered()
  report(done, 'done', text('R1'))
  const taken = delivered()
  report(taken, 'taken')
  clock.advance(20 * DAY)
  report(done, 'done', text('R2')) // restarts its 30 days
  clock.advance(10 * DAY)
  assert.deepEqual(deleteOldReports(db, clock.now), [])
  clock.advance(20 * DAY)
  assert.deepEqual(deleteOldReports(db, clock.now), [done])
  const record = syncSent(db, alex.memberId, 0).result.records.find((r) => r.id === done)!
  assert.equal(record.status, 'done')
  assert.equal(record.payload, undefined)
  // 90 days after the last change: taken (day 0) goes at day 90, done (day 20) at day 110.
  clock.advance(40 * DAY)
  assert.deepEqual(deleteOldRecords(db, clock.now), [taken])
  rejects(() => report(taken, 'done', text('late')), 'HANDOFF_UNKNOWN')
  clock.advance(20 * DAY)
  assert.deepEqual(deleteOldRecords(db, clock.now), [done])
  assert.deepEqual(syncSent(db, alex.memberId, 0).result.records, [])
})
