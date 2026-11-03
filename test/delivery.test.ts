import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Delivery, type DeliveryTarget } from '../src/delivery.ts'
import { HANDOFF_LIFETIME_MS, sendHandoff, validateSend } from '../src/handoffs.ts'
import { createInvite, join as joinTeam } from '../src/team.ts'
import { TestClient } from './helpers/client.ts'
import { manualClock, tempDatabase } from './helpers/db.ts'
import { seedMember, testServer } from './helpers/server.ts'

const P = { protocol: [1] }
type Cred = { device: { id: string }; deviceSecret: string }

async function connect(url: string, cred: Cred) {
  const client = await TestClient.open(url)
  const answer = await client.request('hello', { ...P, deviceId: cred.device.id, deviceSecret: cred.deviceSecret })
  assert.equal(answer.ok, true, JSON.stringify(answer.e))
  return client
}

function addDevice(db: Parameters<typeof createInvite>[0], handle: string, name: string): Cred {
  return joinTeam(db, { code: createInvite(db, { memberHandle: handle }, Date.now).code, deviceName: name }, Date.now)
}

let n = 0
function send(client: TestClient, to = 'sam', body = 'Please add a refund field.', clientId = `c${++n}`) {
  return client.request('handoff.send', { clientId, to, payload: { enc: 'none', title: 'Billing change', body } })
}

async function team(t: Parameters<typeof testServer>[0], options: Parameters<typeof testServer>[1] = {}) {
  const s = await testServer(t, options)
  const alex = seedMember(s.db, 'alex', 'alex desk')
  const sam = seedMember(s.db, 'sam', 'sam desktop')
  const sender = await connect(s.url, alex)
  t.after(() => sender.close())
  return { ...s, alex, sam, sender }
}

// --- sending over the connection ------------------------------------------------------------------------

test('handoff.send answers with the stored handoff and the recipient', async (t) => {
  const { sender, sam } = await team(t)
  const answer = await send(sender)
  assert.equal(answer.ok, true, JSON.stringify(answer.e))
  assert.match(answer.r.handoff.id, /^h_/)
  assert.equal(answer.r.handoff.status, 'pending')
  assert.equal(answer.r.handoff.expiresAt - answer.r.handoff.sentAt, HANDOFF_LIFETIME_MS)
  assert.deepEqual(answer.r.recipient, { id: answer.r.recipient.id, handle: 'sam', displayName: 'SAM', deviceCount: 1 })
  assert.equal(answer.r.recipient.id, sam.member.id)
  assert.equal(answer.r.duplicate, false)
})

test('handoff.send errors reach the client with their detail', async (t) => {
  const { sender } = await team(t, { handoffRatePerHour: 1 })
  assert.equal((await send(sender, 'nobody')).e?.code, 'RECIPIENT_UNKNOWN')
  assert.equal((await send(sender, 'alex')).e?.code, 'RECIPIENT_IS_SELF')
  const tooLong = await send(sender, 'sam', 'x'.repeat(20_001))
  assert.deepEqual([tooLong.e?.code, tooLong.e?.detail], ['BAD_PARAMS', { field: 'payload.body', limit: 20000 }])
  assert.equal((await send(sender)).ok, true)
  const limited = await send(sender)
  assert.equal(limited.e?.code, 'RATE_LIMITED')
  assert.equal(typeof limited.e?.detail.retryAt, 'number')
  assert.equal(sender.ws.readyState, sender.ws.OPEN)
})

test('team.members lists active members by handle with id, handle and display name only', async (t) => {
  const { sender } = await team(t)
  const answer = await sender.request('team.members')
  assert.deepEqual(answer.r.members.map((m: { handle: string }) => m.handle), ['alex', 'sam'])
  assert.deepEqual(Object.keys(answer.r.members[0]).sort(), ['displayName', 'handle', 'id'])
})

// --- offering -------------------------------------------------------------------------------------------

test('a connected recipient receives the handoff at once', async (t) => {
  const { url, sam, sender, alex } = await team(t)
  const desktop = await connect(url, sam)
  const sent = await send(sender)
  const event = await desktop.nextEvent('handoff.incoming', 1000)
  assert.deepEqual(event.d, {
    id: sent.r.handoff.id,
    from: { id: alex.member.id, handle: 'alex', displayName: 'ALEX' },
    payload: { enc: 'none', title: 'Billing change', body: 'Please add a refund field.' },
    sentAt: sent.r.handoff.sentAt,
    expiresAt: sent.r.handoff.expiresAt,
  })
  desktop.close()
})

test('an offline recipient receives it after the hello answer', async (t) => {
  const { url, sam, sender } = await team(t)
  const sent = await send(sender)
  const desktop = await connect(url, sam)
  const event = await desktop.nextEvent('handoff.incoming')
  assert.equal(event.d.id, sent.r.handoff.id)
  const helloIndex = desktop.frames.findIndex((f) => f.t === 'res')
  const eventIndex = desktop.frames.findIndex((f) => f.t === 'evt')
  assert.ok(helloIndex < eventIndex, 'event before the hello answer')
  desktop.close()
})

test('with two devices connected, only the one that became ready last is offered it', async (t) => {
  const { url, db, sam, sender } = await team(t)
  const laptopCred = addDevice(db, 'sam', 'sam laptop')
  const desktop = await connect(url, sam)
  const laptop = await connect(url, laptopCred)
  await send(sender)
  await laptop.nextEvent('handoff.incoming')
  assert.equal(await desktop.noEvent('handoff.incoming'), true)
  desktop.close()
  laptop.close()
})

test('when the offered device goes away unacknowledged, the other device is offered it', async (t) => {
  const { url, db, sam, sender } = await team(t)
  const laptopCred = addDevice(db, 'sam', 'sam laptop')
  const desktop = await connect(url, sam)
  const laptop = await connect(url, laptopCred)
  const sent = await send(sender)
  await laptop.nextEvent('handoff.incoming')
  laptop.close()
  const event = await desktop.nextEvent('handoff.incoming')
  assert.equal(event.d.id, sent.r.handoff.id)
  desktop.close()
})

test('a leased device that reconnects keeps the handoff; the other device is not offered it', async (t) => {
  const { url, db, sam, sender } = await team(t)
  const laptopCred = addDevice(db, 'sam', 'sam laptop')
  const desktop = await connect(url, sam)
  const laptop = await connect(url, laptopCred)
  const sent = await send(sender)
  await laptop.nextEvent('handoff.incoming')
  const laptopAgain = await connect(url, laptopCred)
  assert.equal((await laptop.closed).code, 4006)
  const event = await laptopAgain.nextEvent('handoff.incoming')
  assert.equal(event.d.id, sent.r.handoff.id)
  const helloIndex = laptopAgain.frames.findIndex((f) => f.t === 'res')
  assert.ok(helloIndex < laptopAgain.frames.findIndex((f) => f.t === 'evt'))
  assert.equal(await desktop.noEvent('handoff.incoming'), true)
  desktop.close()
  laptopAgain.close()
})

// --- acknowledging --------------------------------------------------------------------------------------

test('an acknowledged handoff is answered {} and offered to no device again', async (t) => {
  const { url, db, sam, sender } = await team(t)
  const laptopCred = addDevice(db, 'sam', 'sam laptop')
  const desktop = await connect(url, sam)
  const sent = await send(sender)
  await desktop.nextEvent('handoff.incoming')
  const ack = await desktop.request('handoff.received', { id: sent.r.handoff.id })
  assert.deepEqual([ack.ok, ack.r], [true, {}])
  assert.deepEqual((await desktop.request('handoff.received', { id: sent.r.handoff.id })).r, {})
  desktop.close()
  await desktop.closed
  const laptop = await connect(url, laptopCred)
  const desktopAgain = await connect(url, sam)
  assert.equal(await laptop.noEvent('handoff.incoming', 200), true)
  assert.equal(await desktopAgain.noEvent('handoff.incoming', 100), true)
  laptop.close()
  desktopAgain.close()
})

test('an acknowledgement lost on the way: offered again to the same device, which acknowledges', async (t) => {
  const { url, db, sam, sender } = await team(t)
  const laptopCred = addDevice(db, 'sam', 'sam laptop')
  const desktop = await connect(url, sam)
  const sent = await send(sender)
  await desktop.nextEvent('handoff.incoming')
  desktop.ws.terminate()
  await desktop.closed
  const again = await connect(url, sam)
  assert.equal((await again.nextEvent('handoff.incoming')).d.id, sent.r.handoff.id)
  assert.deepEqual((await again.request('handoff.received', { id: sent.r.handoff.id })).r, {})
  const laptop = await connect(url, laptopCred)
  assert.equal(await laptop.noEvent('handoff.incoming'), true)
  again.close()
  laptop.close()
})

test('a late acknowledgement after the lease moved is answered HANDOFF_DELIVERED_ELSEWHERE', async (t) => {
  const { url, db, sam, sender } = await team(t)
  const laptopCred = addDevice(db, 'sam', 'sam laptop')
  const desktop = await connect(url, sam)
  const laptop = await connect(url, laptopCred)
  const sent = await send(sender)
  await laptop.nextEvent('handoff.incoming')
  laptop.ws.terminate()
  await laptop.closed
  await desktop.nextEvent('handoff.incoming')
  assert.deepEqual((await desktop.request('handoff.received', { id: sent.r.handoff.id })).r, {})
  const laptopAgain = await connect(url, laptopCred)
  const late = await laptopAgain.request('handoff.received', { id: sent.r.handoff.id })
  assert.equal(late.e?.code, 'HANDOFF_DELIVERED_ELSEWHERE')
  desktop.close()
  laptopAgain.close()
})

test('acknowledging an overdue handoff says HANDOFF_EXPIRED; someone else gets HANDOFF_UNKNOWN', async (t) => {
  let clock = Date.now()
  const { url, sam, sender } = await team(t, { now: () => clock })
  const desktop = await connect(url, sam)
  const sent = await send(sender)
  await desktop.nextEvent('handoff.incoming')
  assert.equal((await sender.request('handoff.received', { id: sent.r.handoff.id })).e?.code, 'HANDOFF_UNKNOWN')
  clock += HANDOFF_LIFETIME_MS
  assert.equal((await desktop.request('handoff.received', { id: sent.r.handoff.id })).e?.code, 'HANDOFF_EXPIRED')
  desktop.close()
})

test('during shutdown a released lease is not offered to another connection', async (t) => {
  const { url, db, sam, sender, server } = await team(t)
  const laptopCred = addDevice(db, 'sam', 'sam laptop')
  // The leased laptop connects first, so it is closed before the desktop.
  const laptop = await connect(url, laptopCred)
  await send(sender)
  await laptop.nextEvent('handoff.incoming')
  const desktop = await connect(url, sam)
  assert.equal(desktop.events('handoff.incoming').length, 0)
  await server.close()
  await desktop.closed
  assert.equal(desktop.events('handoff.incoming').length, 0)
})

// --- Delivery with fake connections ---------------------------------------------------------------------

function fake(memberId: string, deviceId: string): DeliveryTarget & { sent: Array<{ kind: string; data: any }> } {
  const sent: Array<{ kind: string; data: any }> = []
  return { memberId, deviceId, offered: new Set(), sent, sendEvent: (kind, data) => sent.push({ kind, data }) }
}

test('a replacing connection that closes before becoming ready: the other ready device is offered it', (t) => {
  const { db } = tempDatabase(t)
  const clock = manualClock()
  const alex = seedMember(db, 'alex')
  const sam = seedMember(db, 'sam')
  const samLaptop = addDevice(db, 'sam', 'laptop')
  const delivery = new Delivery(db, clock.now, () => {})
  const desktop = fake(sam.member.id, sam.device.id)
  const laptop1 = fake(sam.member.id, samLaptop.device.id)
  delivery.onReady(desktop)
  delivery.onReady(laptop1)
  const { handoff } = sendHandoff(db, { memberId: alex.member.id, deviceId: alex.device.id }, validateSend({ clientId: 'c', to: 'sam', payload: { enc: 'none', title: 't', body: 'b' } }), 30, clock.now)
  delivery.onSent(handoff.id, sam.member.id)
  assert.equal(laptop1.sent.length, 1)
  const laptop2 = fake(sam.member.id, samLaptop.device.id)
  delivery.onClosed(laptop1, 'replaced')
  assert.equal(desktop.sent.length, 0, 'waits for the replacing connection')
  delivery.onClosed(laptop2, 'other')
  assert.deepEqual(desktop.sent.map((s) => s.data.id), [handoff.id])
})

test('an offer whose database read fails is logged and does not throw', (t) => {
  const { db } = tempDatabase(t)
  const alex = seedMember(db, 'alex')
  const sam = seedMember(db, 'sam')
  const closed = new DatabaseSync(':memory:')
  closed.close()
  const logs: string[] = []
  const delivery = new Delivery(closed, Date.now, (m) => logs.push(m))
  const desktop = fake(sam.member.id, sam.device.id)
  delivery.onReady(desktop)
  delivery.onSent('h_x', sam.member.id)
  delivery.onClosed(desktop, 'other')
  assert.equal(desktop.sent.length, 0)
  assert.ok(logs.some((l) => l.startsWith('could not')))
  void alex
})
