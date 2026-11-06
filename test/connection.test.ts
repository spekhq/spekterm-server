import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { WebSocket } from 'ws'
import { openDatabaseFile } from '../src/db.ts'
import { createInvite, listMembers, removeMember, revokeDevice } from '../src/team.ts'
import { TestClient } from './helpers/client.ts'
import { delay, seedMember, testServer } from './helpers/server.ts'

const P = { protocol: [1] }

async function hello(url: string, cred: { device: { id: string }; deviceSecret: string }) {
  const client = await TestClient.open(url)
  const answer = await client.request('hello', { ...P, deviceId: cred.device.id, deviceSecret: cred.deviceSecret })
  assert.equal(answer.ok, true, JSON.stringify(answer.e))
  return { client, answer }
}

// --- endpoint and frames --------------------------------------------------------------------------------

test('a WebSocket upgrade on another path is refused with 404', async (t) => {
  const { server } = await testServer(t)
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
  ws.on('error', () => {})
  const status = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)))
  assert.equal(status, 404)
})

test('an oversized frame closes that connection with 1009 only', async (t) => {
  const { url, db } = await testServer(t)
  const a = await hello(url, seedMember(db, 'sam'))
  const b = await hello(url, seedMember(db, 'alex'))
  a.client.ws.send('x'.repeat(300 * 1024))
  assert.equal((await a.client.closed).code, 1009)
  const answer = await b.client.request('device.rename', { name: 'still here' })
  assert.equal(answer.ok, true)
  b.client.close()
})

test('a binary frame closes the connection with 1003', async (t) => {
  const { url, db } = await testServer(t)
  const { client } = await hello(url, seedMember(db))
  client.ws.send(Buffer.from([1, 2, 3]))
  assert.equal((await client.closed).code, 1003)
})

test('after authenticating: bad frames, unknown operations and bad parameters keep the connection open', async (t) => {
  const { url, db } = await testServer(t)
  const { client } = await hello(url, seedMember(db))
  const notJson = await client.raw('hello', null)
  assert.deepEqual([notJson.ok, notJson.e?.code, notJson.id], [false, 'BAD_FRAME', null])
  const unknown = await client.raw(JSON.stringify({ t: 'req', id: 7, m: 'presence.set', p: {} }), 7)
  assert.equal(unknown.e?.code, 'UNKNOWN_OPERATION')
  const bad = await client.request('device.rename', { name: 5 })
  assert.equal(bad.e?.code, 'BAD_PARAMS')
  assert.deepEqual(bad.e?.detail, { field: 'name' })
  for (const m of ['invite.inspect', 'join', 'hello']) {
    const again = await client.request(m, { ...P })
    assert.equal(again.e?.code, 'ALREADY_AUTHENTICATED')
  }
  const still = await client.request('device.rename', { name: 'ok' })
  assert.equal(still.ok, true)
  client.close()
})

// --- before authentication ------------------------------------------------------------------------------

test('a silent client is closed with 4001', async (t) => {
  const { url } = await testServer(t)
  const client = await TestClient.open(url)
  assert.equal((await client.closed).code, 4001)
})

test('an operation before authenticating is refused and closed with 4003', async (t) => {
  const { url } = await testServer(t)
  const client = await TestClient.open(url)
  const answer = await client.request('device.leave')
  assert.equal(answer.e?.code, 'NOT_AUTHENTICATED')
  assert.equal((await client.closed).code, 4003)
})

test('unknown operation and bad frame before authenticating are followed by 4003', async (t) => {
  const { url } = await testServer(t)
  const a = await TestClient.open(url)
  assert.equal((await a.request('nope')).e?.code, 'UNKNOWN_OPERATION')
  assert.equal((await a.closed).code, 4003)
  const b = await TestClient.open(url)
  assert.equal((await b.raw('garbage')).e?.code, 'BAD_FRAME')
  assert.equal((await b.closed).code, 4003)
})

test('a failed join closes with 4003 and leaves the invite redeemable', async (t) => {
  const { url, db } = await testServer(t)
  seedMember(db, 'sam')
  const invite = createInvite(db, {}, Date.now)
  const first = await TestClient.open(url)
  const taken = await first.request('join', { ...P, code: invite.code, handle: 'Sam', displayName: 'Sam', deviceName: 'd' })
  assert.equal(taken.e?.code, 'HANDLE_TAKEN')
  assert.equal((await first.closed).code, 4003)
  const second = await TestClient.open(url)
  const ok = await second.request('join', { ...P, code: invite.code, handle: 'sam2', displayName: 'Sam', deviceName: 'd' })
  assert.equal(ok.ok, true)
  second.close()
})

test('frames in the second after a refusal are ignored', async (t) => {
  const { url, db } = await testServer(t)
  const cred = seedMember(db)
  const client = await TestClient.open(url)
  const refused = await client.request('join', { ...P, code: 'AAAAAAAAAAAAAAAAAAAAAAAAAA', handle: 'x', displayName: 'x', deviceName: 'x' })
  assert.equal(refused.e?.code, 'INVITE_UNKNOWN')
  client.ws.send(JSON.stringify({ t: 'req', id: 99, m: 'hello', p: { ...P, deviceId: cred.device.id, deviceSecret: cred.deviceSecret } }))
  assert.equal((await client.closed).code, 4003)
  assert.equal(client.answers.some((a) => a.id === 99), false)
})

test('a device revoked while offline gets AUTH_FAILED and 4003', async (t) => {
  const { url, db } = await testServer(t)
  const cred = seedMember(db)
  revokeDevice(db, cred.device.id, Date.now)
  const client = await TestClient.open(url)
  const answer = await client.request('hello', { ...P, deviceId: cred.device.id, deviceSecret: cred.deviceSecret })
  assert.equal(answer.e?.code, 'AUTH_FAILED')
  assert.equal((await client.closed).code, 4003)
})

test('hello without a credential is AUTH_FAILED', async (t) => {
  const { url } = await testServer(t)
  const client = await TestClient.open(url)
  assert.equal((await client.request('hello', { ...P })).e?.code, 'AUTH_FAILED')
})

// --- versions -------------------------------------------------------------------------------------------

test('version negotiation picks the common version', async (t) => {
  const { url, db } = await testServer(t)
  const cred = seedMember(db)
  const client = await TestClient.open(url)
  const answer = await client.request('hello', { protocol: [1, 2], deviceId: cred.device.id, deviceSecret: cred.deviceSecret })
  assert.equal(answer.r.protocol, 1)
  client.close()
})

test('no common version: UNSUPPORTED_VERSION before parameter checks, invite left unused', async (t) => {
  const { url, db } = await testServer(t)
  const invite = createInvite(db, {}, Date.now)
  const client = await TestClient.open(url)
  const answer = await client.request('join', { protocol: [2], invitation: { code: invite.code } })
  assert.equal(answer.e?.code, 'UNSUPPORTED_VERSION')
  assert.deepEqual(answer.e?.detail, { supported: [1] })
  assert.equal((await client.closed).code, 4003)
  const retry = await TestClient.open(url)
  assert.equal((await retry.request('invite.inspect', { ...P, code: invite.code })).ok, true)
  retry.close()
})

// --- inspect, join, hello -------------------------------------------------------------------------------

test('inspect, 4001, then join on a new connection', async (t) => {
  const { url, db } = await testServer(t)
  seedMember(db, 'sam')
  const invite = createInvite(db, { memberHandle: 'sam' }, Date.now)
  const inspecting = await TestClient.open(url)
  const inspected = await inspecting.request('invite.inspect', { ...P, code: invite.code })
  assert.deepEqual(inspected.r, {
    protocol: 1,
    kind: 'device',
    team: { name: 'Team' },
    expiresAt: invite.expiresAt,
    member: { handle: 'sam', displayName: 'SAM' },
  })
  assert.equal((await inspecting.closed).code, 4001)
  const joining = await TestClient.open(url)
  const joined = await joining.request('join', { ...P, code: invite.code, deviceName: 'work laptop' })
  assert.equal(joined.ok, true)
  assert.equal(joined.r.member.deviceCount, 2)
  joining.close()
})

test('join returns the identity and credential and authenticates the connection', async (t) => {
  const { url, db } = await testServer(t)
  const invite = createInvite(db, {}, Date.now)
  const client = await TestClient.open(url)
  const answer = await client.request('join', { ...P, code: invite.code, handle: 'sam', displayName: 'Sam', deviceName: 'home desktop' })
  const r = answer.r
  assert.equal(r.protocol, 1)
  assert.deepEqual(r.server, { name: 'spekterm-server', version: '0.4.0' })
  assert.deepEqual(r.operations, ['device.leave', 'device.rename', 'handoff.received', 'handoff.send', 'handoff.sync', 'handoff.update', 'team.members'])
  assert.deepEqual(r.team, { name: 'Team' })
  assert.deepEqual(Object.keys(r.member).sort(), ['deviceCount', 'displayName', 'handle', 'id'])
  assert.equal(r.member.deviceCount, 1)
  assert.equal(r.deviceId, r.device.id)
  assert.match(r.deviceSecret, /^[A-Za-z0-9_-]{43}$/)
  const renamed = await client.request('device.rename', { name: ' laptop ' })
  assert.deepEqual(renamed.r, { device: { id: r.device.id, name: 'laptop' } })
  client.close()
})

test('hello returns the identity without the credential and ignores unknown fields', async (t) => {
  const { url, db } = await testServer(t)
  const cred = seedMember(db)
  const client = await TestClient.open(url)
  const answer = await client.request('hello', { ...P, deviceId: cred.device.id, deviceSecret: cred.deviceSecret, resume: 42 })
  assert.equal(answer.ok, true)
  assert.equal(answer.r.deviceSecret, undefined)
  assert.equal(answer.r.deviceId, undefined)
  assert.deepEqual(answer.r.operations, ['device.leave', 'device.rename', 'handoff.received', 'handoff.send', 'handoff.sync', 'handoff.update', 'team.members'])
  assert.equal(answer.r.member.handle, 'sam')
  client.close()
})

// --- one connection per device, revocation --------------------------------------------------------------

test('a newer connection of the same device replaces the older one with 4006', async (t) => {
  const { url, db } = await testServer(t)
  const cred = seedMember(db)
  const first = await hello(url, cred)
  const second = await hello(url, cred)
  assert.equal((await first.client.closed).code, 4006)
  assert.equal((await second.client.request('device.rename', { name: 'x' })).ok, true)
  second.client.close()
})

test('a revocation by another process closes the live connection with 4004', async (t) => {
  const { url, db, dbPath } = await testServer(t)
  const cred = seedMember(db)
  const { client } = await hello(url, cred)
  const other = openDatabaseFile(dbPath)
  const started = Date.now()
  revokeDevice(other, cred.device.id, Date.now)
  other.close()
  assert.equal((await client.closed).code, 4004)
  assert.ok(Date.now() - started < 1000)
})

test('replaced then revoked: the newer connection is closed with 4004', async (t) => {
  const { url, db, dbPath } = await testServer(t)
  const cred = seedMember(db)
  const first = await hello(url, cred)
  const second = await hello(url, cred)
  assert.equal((await first.client.closed).code, 4006)
  const other = openDatabaseFile(dbPath)
  revokeDevice(other, cred.device.id, Date.now)
  other.close()
  assert.equal((await second.client.closed).code, 4004)
})

test('removing a member closes all of their connections with 4004', async (t) => {
  const { url, db, dbPath } = await testServer(t)
  const cred = seedMember(db)
  const { client } = await hello(url, cred)
  const other = openDatabaseFile(dbPath)
  removeMember(other, 'sam', Date.now)
  other.close()
  assert.equal((await client.closed).code, 4004)
})

test('device.leave answers memberRemoved and closes with 4004', async (t) => {
  const { url, db } = await testServer(t)
  const cred = seedMember(db)
  const { client } = await hello(url, cred)
  const answer = await client.request('device.leave')
  assert.deepEqual(answer.r, { memberRemoved: true })
  assert.equal((await client.closed).code, 4004)
  assert.equal(listMembers(db).length, 0)
})

// --- keepalive ------------------------------------------------------------------------------------------

test('a peer that stops answering pings is terminated', async (t) => {
  const { url, db } = await testServer(t, { timings: { pingIntervalMs: 100 } })
  const cred = seedMember(db)
  const client = await TestClient.open(url, { autoPong: false })
  await client.request('hello', { ...P, deviceId: cred.device.id, deviceSecret: cred.deviceSecret })
  const started = Date.now()
  const { code } = await client.closed
  assert.equal(code, 1006)
  assert.ok(Date.now() - started < 500)
})

test('a peer that answers pings stays connected and its last-seen time advances', async (t) => {
  let clock = Date.now()
  const { url, db } = await testServer(t, { now: () => clock, timings: { pingIntervalMs: 50, lastSeenWriteMs: 25_000 } })
  const cred = seedMember(db)
  const { client } = await hello(url, cred)
  clock += 30_000
  await delay(200)
  assert.equal(client.ws.readyState, WebSocket.OPEN)
  assert.equal(listMembers(db)[0]!.devices[0]!.lastSeenAt, clock)
  client.close()
})

// --- health ---------------------------------------------------------------------------------------------

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    httpRequest({ host: '127.0.0.1', port, path }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
      .on('error', reject)
      .end()
  })
}

test('/healthz answers 200, other paths 404', async (t) => {
  const { server } = await testServer(t)
  assert.equal(await get(server.port, '/healthz'), 200)
  assert.equal(await get(server.port, '/'), 404)
  assert.equal(await get(server.port, '/connect'), 404)
})

test('/healthz answers 503 when the check fails', async (t) => {
  let healthy = true
  const { server } = await testServer(t, {
    healthCheck: () => {
      if (!healthy) throw new Error('database unreadable')
    },
  })
  assert.equal(await get(server.port, '/healthz'), 200)
  healthy = false
  assert.equal(await get(server.port, '/healthz'), 503)
})
