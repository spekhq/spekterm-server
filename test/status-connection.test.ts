/** Status reports and the sender's feed over real WebSockets (`handoff-status` spec). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HANDOFF_LIFETIME_MS } from '../src/handoffs.ts'
import { createInvite, join as joinTeam } from '../src/team.ts'
import { TestClient } from './helpers/client.ts'
import { runAdmin } from './helpers/process.ts'
import { seedMember, testServer } from './helpers/server.ts'

const P = { protocol: [1] }
type Cred = { device: { id: string }; deviceSecret: string }

async function connect(t: Parameters<typeof testServer>[0], url: string, cred: Cred) {
  const client = await TestClient.open(url)
  t.after(() => client.close())
  const answer = await client.request('hello', { ...P, deviceId: cred.device.id, deviceSecret: cred.deviceSecret })
  assert.equal(answer.ok, true, JSON.stringify(answer.e))
  return client
}

async function sync(client: TestClient, after = 0) {
  const answer = await client.request('handoff.sync', { after })
  assert.equal(answer.ok, true, JSON.stringify(answer.e))
  return answer.r
}

let n = 0
async function send(client: TestClient, to = 'sam') {
  const answer = await client.request('handoff.send', {
    clientId: `c${++n}`,
    to,
    payload: { enc: 'none', title: 'Billing change', body: 'Please add a refund field.' },
  })
  assert.equal(answer.ok, true, JSON.stringify(answer.e))
  return answer.r.handoff.id as string
}

async function team(t: Parameters<typeof testServer>[0], options: Parameters<typeof testServer>[1] = {}) {
  const s = await testServer(t, options)
  const alex = seedMember(s.db, 'alex', 'alex desk')
  const sam = seedMember(s.db, 'sam', 'sam desktop')
  const sender = await connect(t, s.url, alex)
  const desktop = await connect(t, s.url, sam)
  /** Sends a handoff from Alex and has Sam's desktop acknowledge it. */
  const delivered = async () => {
    const id = await send(sender)
    const offered = await desktop.nextEvent('handoff.incoming')
    assert.equal(offered.d.id, id)
    assert.deepEqual((await desktop.request('handoff.received', { id })).r, {})
    return id
  }
  return { ...s, alex, sam, sender, desktop, delivered }
}

test('the delivered-to device reports taken and done; another device of the recipient is refused', async (t) => {
  const { url, db, sender, desktop, delivered } = await team(t)
  await sync(sender)
  const id = await delivered()
  // Connected after the delivery, so it is not the device the handoff was offered to.
  const laptopCred = joinTeam(db, { code: createInvite(db, { memberHandle: 'sam' }, Date.now).code, deviceName: 'laptop' }, Date.now)
  const laptop = await connect(t, url, laptopCred)
  const refused = await laptop.request('handoff.update', { id, status: 'taken' })
  assert.equal(refused.e?.code, 'HANDOFF_DELIVERED_ELSEWHERE')
  assert.deepEqual((await desktop.request('handoff.update', { id, status: 'taken' })).r, { status: 'taken' })
  const done = await desktop.request('handoff.update', { id, status: 'done', payload: { enc: 'none', text: 'Added the field.' } })
  assert.deepEqual(done.r, { status: 'done' })
  const finished = await desktop.request('handoff.update', { id, status: 'declined' })
  assert.deepEqual([finished.e?.code, finished.e?.detail], ['HANDOFF_FINISHED', { status: 'done' }])
  const bad = await desktop.request('handoff.update', { id, status: 'done', payload: { enc: 'none', text: 'x'.repeat(4001) } })
  assert.deepEqual([bad.e?.code, bad.e?.detail], ['BAD_PARAMS', { field: 'payload.text', limit: 4000 }])
  assert.equal(desktop.ws.readyState, desktop.ws.OPEN)
})

test('taken reaches a synced sender within a second, with the record of the change', async (t) => {
  const { sender, desktop, delivered, alex } = await team(t)
  await sync(sender)
  const id = await delivered()
  const started = performance.now()
  await desktop.request('handoff.update', { id, status: 'taken' })
  let event = await sender.nextEvent('handoff.status', 1000)
  while (event.d.id !== id || event.d.status !== 'taken') event = await sender.nextEvent('handoff.status', 1000)
  assert.ok(performance.now() - started < 1000)
  assert.equal(event.d.sentFrom, alex.device.id)
  assert.equal(event.d.to.handle, 'sam')
  assert.equal(event.d.title, undefined)
})

test('both of the sender devices receive the change, each naming the sending device', async (t) => {
  const { url, db, sender, desktop, delivered, alex } = await team(t)
  const laptopCred = joinTeam(db, { code: createInvite(db, { memberHandle: 'alex' }, Date.now).code, deviceName: 'laptop' }, Date.now)
  const laptop = await connect(t, url, laptopCred)
  await sync(sender)
  await sync(laptop)
  const id = await delivered()
  await desktop.request('handoff.update', { id, status: 'done', payload: { enc: 'none', text: 'Added the field.' } })
  for (const client of [sender, laptop]) {
    const done = await (async () => {
      for (;;) {
        const e = await client.nextEvent('handoff.status')
        if (e.d.status === 'done') return e
      }
    })()
    assert.equal(done.d.id, id)
    assert.equal(done.d.sentFrom, alex.device.id)
    assert.deepEqual(done.d.payload, { enc: 'none', text: 'Added the field.' })
    assert.equal(done.d.reports, 1)
  }
})

test("the sender's own send: the answer first, then the pending event", async (t) => {
  const { sender } = await team(t)
  await sync(sender)
  const id = await send(sender)
  const event = await sender.nextEvent('handoff.status')
  assert.deepEqual([event.d.id, event.d.status], [id, 'pending'])
  const answerAt = sender.frames.findIndex((f) => f.t === 'res' && f.ok && (f as { r?: { handoff?: { id: string } } }).r?.handoff?.id === id)
  const eventAt = sender.frames.indexOf(event)
  assert.ok(answerAt !== -1 && answerAt < eventAt, `answer at ${answerAt}, event at ${eventAt}`)
})

test('the admin command line removing the recipient reaches the sender within 10 seconds', async (t) => {
  const { dir, sender, desktop } = await team(t)
  desktop.close()
  await sync(sender)
  const id = await send(sender)
  await sender.nextEvent('handoff.status') // pending
  assert.equal((await runAdmin(['member', 'remove', 'sam'], { DATA_DIR: dir })).status, 0)
  const event = await sender.nextEvent('handoff.status', 10_000)
  assert.deepEqual([event.d.id, event.d.status, event.d.to.removed], [id, 'expired', true])
})

test('expiry by time reaches the sender after the maintenance step', async (t) => {
  let clock = Date.now()
  const { server, sender, desktop } = await team(t, { now: () => clock, maintenanceIntervalMs: 3_600_000 })
  desktop.close()
  await desktop.closed
  await sync(sender)
  const id = await send(sender)
  await sender.nextEvent('handoff.status') // pending
  clock += HANDOFF_LIFETIME_MS
  assert.deepEqual(server.maintain().expired, [id])
  const event = await sender.nextEvent('handoff.status', 1000)
  assert.deepEqual([event.d.id, event.d.status], [id, 'expired'])
})

test('no events before handoff.sync; the next sync returns the change', async (t) => {
  const { sender, desktop, delivered } = await team(t)
  const id = await delivered()
  await desktop.request('handoff.update', { id, status: 'taken' })
  assert.equal(await sender.noEvent('handoff.status', 300), true)
  const r = await sync(sender)
  assert.deepEqual(r.records.map((x: { id: string; status: string }) => [x.id, x.status]), [[id, 'taken']])
  assert.equal(r.more, false)
  // Subscribed from here on.
  await desktop.request('handoff.update', { id, status: 'done', payload: { enc: 'none', text: 'R' } })
  const done = await sender.nextEvent('handoff.status')
  assert.equal(done.d.status, 'done')
  const bad = await sender.request('handoff.sync', { after: -1 })
  assert.deepEqual([bad.e?.code, bad.e?.detail], ['BAD_PARAMS', { field: 'after' }])
})
