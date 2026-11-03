/** The status feed (`handoff-status` spec "Status events", design D5) with fake connections. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type Database, openDatabaseFile } from '../src/db.ts'
import { Feed, type FeedTarget } from '../src/feed.ts'
import { type StatusRecord, acknowledge, sendHandoff, syncSent, updateStatus, validateSend, validateUpdate } from '../src/handoffs.ts'
import { createInvite, join as joinTeam, revokeDevice } from '../src/team.ts'
import { manualClock, tempDatabase } from './helpers/db.ts'

interface Fake extends FeedTarget {
  events: StatusRecord[]
  revoked: number
  internal: number
}

function fake(memberId: string, deviceId: string, sendEvent?: () => void): Fake {
  const target: Fake = {
    memberId,
    deviceId,
    events: [],
    revoked: 0,
    internal: 0,
    sendEvent(kind, data) {
      assert.equal(kind, 'handoff.status')
      sendEvent?.()
      target.events.push(data as StatusRecord)
    },
    closeRevoked() {
      target.revoked++
    },
    closeInternal() {
      target.internal++
    },
  }
  return target
}

function setup(t: Parameters<typeof tempDatabase>[0]) {
  const { db, path } = tempDatabase(t)
  const clock = manualClock()
  const join = (handle: string, deviceName = 'desk') => {
    const j = joinTeam(db, { code: createInvite(db, {}, clock.now).code, handle, displayName: handle, deviceName }, clock.now)
    return { memberId: j.member.id, deviceId: j.device.id }
  }
  const alex = join('alex')
  const sam = join('sam')
  const alexLaptop = {
    memberId: alex.memberId,
    deviceId: joinTeam(db, { code: createInvite(db, { memberHandle: 'alex' }, clock.now).code, deviceName: 'laptop' }, clock.now).device.id,
  }
  let n = 0
  const send = (on: Database = db) =>
    sendHandoff(on, alex, validateSend({ clientId: `c${++n}`, to: 'sam', payload: { enc: 'none', title: 't', body: 'b' } }), 1000, clock.now)
      .handoff.id
  const take = (id: string, on: Database = db) => {
    acknowledge(on, id, sam, clock.now)
    updateStatus(on, validateUpdate({ id, status: 'taken' }), sam, clock.now)
  }
  const logs: string[] = []
  /** A second connection to the same file, as the admin command line (or any other writer) would hold. */
  const other = () => {
    const o = openDatabaseFile(path)
    t.after(() => o.close())
    return o
  }
  return { db, clock, alex, alexLaptop, sam, send, take, logs, other, feed: (on: Database = db) => new Feed(on, (m) => logs.push(m)) }
}

/** Subscribes a target as the `handoff.sync` handler does, from `after`. */
function syncAndSubscribe(db: Database, feed: Feed, target: FeedTarget, after = 0) {
  const { result, cursor } = syncSent(db, target.memberId!, after)
  assert.equal(result.more, false)
  feed.subscribe(target, cursor)
  return result
}

test('the cursor of a subscription: last record, after, or 0 on reset', (t) => {
  const { db, alex, send } = setup(t)
  const feed = new Feed(db, () => {})
  const a = fake(alex.memberId, alex.deviceId)
  send()
  const result = syncAndSubscribe(db, feed, a)
  assert.equal(feed.cursorOf(a), result.records[0]!.seq)
  const b = fake(alex.memberId, alex.deviceId)
  syncAndSubscribe(db, feed, b, result.latest)
  assert.equal(feed.cursorOf(b), result.latest)
  const c = fake(alex.memberId, alex.deviceId)
  const reset = syncAndSubscribe(db, feed, c, 999)
  assert.equal(reset.reset, true)
  assert.equal(feed.cursorOf(c), reset.records.at(-1)!.seq)
})

test('subscribers get later changes once, in seq order, and every device of the member gets them', (t) => {
  const { db, alex, alexLaptop, sam, send, take } = setup(t)
  const feed = new Feed(db, () => {})
  const desk = fake(alex.memberId, alex.deviceId)
  const laptop = fake(alexLaptop.memberId, alexLaptop.deviceId)
  const samDesk = fake(sam.memberId, sam.deviceId)
  syncAndSubscribe(db, feed, desk)
  syncAndSubscribe(db, feed, laptop)
  syncAndSubscribe(db, feed, samDesk)
  const a = send()
  const b = send()
  feed.publish()
  take(a)
  feed.publish()
  feed.publish()
  for (const target of [desk, laptop]) {
    assert.deepEqual(target.events.map((e) => [e.id, e.status]), [[a, 'pending'], [b, 'pending'], [a, 'taken']])
    const seqs = target.events.map((e) => e.seq)
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y))
    assert.ok(target.events.every((e) => e.sentFrom === alex.deviceId))
  }
  assert.deepEqual(samDesk.events, [])
})

test('a change already in the sync answer is not pushed again', (t) => {
  const { db, alex, send, other } = setup(t)
  const feed = new Feed(db, () => {})
  const writer = other()
  const id = send(writer) // committed by another connection, not yet published by this one
  const desk = fake(alex.memberId, alex.deviceId)
  const result = syncAndSubscribe(db, feed, desk)
  assert.deepEqual(result.records.map((r) => r.id), [id])
  feed.publish()
  assert.deepEqual(desk.events, [])
})

test('a change committed by another connection between the sync reads reaches the subscriber exactly once', (t) => {
  const { db, alex, send, other } = setup(t)
  const feed = new Feed(db, () => {})
  const writer = other()
  send()
  let injected = undefined as string | undefined
  // Commit from the other connection right before the records are read, after `latest` was read.
  const proxied = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (injected === undefined && sql.includes('FROM handoffs h JOIN members')) injected = send(writer)
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Database
  const desk = fake(alex.memberId, alex.deviceId)
  const result = syncAndSubscribe(proxied, feed, desk)
  assert.ok(injected !== undefined)
  const inAnswer = result.records.filter((r) => r.id === injected).length
  feed.publish()
  const pushed = desk.events.filter((e) => e.id === injected).length
  assert.equal(inAnswer + pushed, 1)
})

test('a subscriber whose send fails is closed with 1011; the others still get the event', (t) => {
  const { db, alex, alexLaptop, send, logs } = setup(t)
  const feed = new Feed(db, (m) => logs.push(m))
  const broken = fake(alex.memberId, alex.deviceId, () => {
    throw new Error('socket gone')
  })
  const laptop = fake(alexLaptop.memberId, alexLaptop.deviceId)
  syncAndSubscribe(db, feed, broken)
  syncAndSubscribe(db, feed, laptop)
  const id = send()
  assert.doesNotThrow(() => feed.publish())
  assert.equal(broken.internal, 1)
  assert.equal(feed.cursorOf(broken), undefined)
  assert.deepEqual(laptop.events.map((e) => e.id), [id])
  assert.ok(logs.some((l) => /could not send status/.test(l)))
})

test('a failed call is tried again even when the counter has not moved since', (t) => {
  const { db, alex, send, logs } = setup(t)
  let failCounter = false
  const proxied = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (failCounter && sql.includes('FROM counters')) throw new Error('database is locked')
          return target.prepare(sql)
        }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Database
  const feed = new Feed(proxied, (m) => logs.push(m))
  const desk = fake(alex.memberId, alex.deviceId)
  syncAndSubscribe(db, feed, desk)
  const id = send()
  failCounter = true
  assert.doesNotThrow(() => feed.publish())
  assert.equal(desk.events.length, 0)
  failCounter = false
  feed.publish() // nothing changed since the failed call
  assert.deepEqual(desk.events.map((e) => e.id), [id])
})

test('a revoked subscriber is closed with 4004 and sent nothing', (t) => {
  const { db, clock, alex, send } = setup(t)
  const feed = new Feed(db, () => {})
  const desk = fake(alex.memberId, alex.deviceId)
  syncAndSubscribe(db, feed, desk)
  revokeDevice(db, alex.deviceId, clock.now)
  send()
  feed.publish()
  assert.equal(desk.revoked, 1)
  assert.deepEqual(desk.events, [])
})

test('unsubscribed and closing feeds send nothing', (t) => {
  const { db, alex, send } = setup(t)
  const feed = new Feed(db, () => {})
  const desk = fake(alex.memberId, alex.deviceId)
  syncAndSubscribe(db, feed, desk)
  feed.unsubscribe(desk)
  send()
  feed.publish()
  assert.deepEqual(desk.events, [])
  syncAndSubscribe(db, feed, desk)
  feed.closing = true
  send()
  feed.publish()
  assert.deepEqual(desk.events, [])
})
