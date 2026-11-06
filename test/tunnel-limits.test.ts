/** Relay limits and how tunnels end (`phone-relay` spec: "Relay limits", "How a tunnel ends", "Grants end with their device"). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TestClient } from './helpers/client.ts'
import { manualClock } from './helpers/db.ts'
import { openTunnel, phoneOpens, RelayClient, relaySetup } from './helpers/relay.ts'
import { runAdmin } from './helpers/process.ts'
import { seedMember } from './helpers/server.ts'
import { openDatabaseFile } from '../src/db.ts'
import { revokeDevice } from '../src/team.ts'
import { OPEN_WINDOW_MS } from '../src/tunnels.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------------------------------------
// Limits

test('fifth tunnel to one desktop is RELAY_BUSY (device)', async (t) => {
  const s = await relaySetup(t)
  for (let i = 0; i < 4; i++) await phoneOpens(s)
  const { answer } = await phoneOpens(s)
  const refused = await answer
  assert.equal(refused.e?.code, 'RELAY_BUSY')
  assert.deepEqual(refused.e?.detail, { limit: 'device' })
})

test('server full: RELAY_BUSY (server) until a tunnel closes', async (t) => {
  const s = await relaySetup(t, { relay: { enabled: true, maxTunnels: 2 } })
  const kim = seedMember(s.db, 'kim', 'desk')
  const kimDesktop = await TestClient.open(s.url)
  t.after(() => kimDesktop.close())
  await kimDesktop.request('hello', { protocol: [1], deviceId: kim.device.id, deviceSecret: kim.deviceSecret })
  const kimGrant = (await kimDesktop.request('relay.grant', { name: 'Kim phone' })).r
  const first = await openTunnel(s)
  const second = await phoneOpens(s, { id: kimGrant.grant.id, secret: kimGrant.secret })
  await kimDesktop.nextEvent('relay.incoming')
  const third = await phoneOpens(s)
  const refused = await third.answer
  assert.equal(refused.e?.code, 'RELAY_BUSY')
  assert.deepEqual(refused.e?.detail, { limit: 'server' })
  first.phone.close()
  await first.desktop.closed
  const fourth = await phoneOpens(s)
  await s.desktop.nextEvent('relay.incoming')
  assert.equal(s.server.relay.size, 2)
  second.phone.close()
  fourth.phone.close()
})

test('phone closes early, again and again: the 21st is RATE_LIMITED and the desktop saw exactly 20', async (t) => {
  const s = await relaySetup(t)
  for (let i = 0; i < 20; i++) {
    const { phone } = await phoneOpens(s)
    await s.desktop.nextEvent('relay.incoming')
    phone.close()
    await phone.closed
  }
  const { answer } = await phoneOpens(s)
  assert.equal((await answer).e?.code, 'RATE_LIMITED')
  assert.equal(s.desktop.events('relay.incoming').length, 20)
})

test('desktop off for a while: unavailable answers do not count', async (t) => {
  const s = await relaySetup(t)
  s.desktop.close()
  await s.desktop.closed
  await wait(50)
  for (let i = 0; i < 30; i++) {
    const { answer } = await phoneOpens(s)
    assert.equal((await answer).e?.code, 'DESKTOP_UNAVAILABLE')
  }
  const desktop = await TestClient.open(s.url)
  t.after(() => desktop.close())
  await desktop.request('hello', { protocol: [1], deviceId: s.credential.deviceId, deviceSecret: s.credential.deviceSecret })
  await phoneOpens(s)
  assert.equal((await desktop.nextEvent('relay.incoming')).d.grant, s.grant.id)
})

test('a looping phone: retryAt is no later than 10 minutes after the first open', async (t) => {
  const clock = manualClock()
  const s = await relaySetup(t, { now: clock.now })
  const firstAt = clock.now()
  for (let i = 0; i < 20; i++) {
    const tunnel = await openTunnel(s)
    tunnel.phone.close()
    await tunnel.desktop.closed
    clock.advance(1000)
  }
  const { answer } = await phoneOpens(s)
  const refused = await answer
  assert.equal(refused.e?.code, 'RATE_LIMITED')
  assert.equal(refused.e?.detail.retryAt, firstAt + OPEN_WINDOW_MS)
  assert.equal(await s.desktop.noEvent('relay.incoming', 200), true)
  clock.advance(OPEN_WINDOW_MS)
  await phoneOpens(s)
  await s.desktop.nextEvent('relay.incoming')
})

// ---------------------------------------------------------------------------------------------------------
// How a tunnel ends

test('revoking a grant in use: phone 4004, desktop 4010, then GRANT_INVALID', async (t) => {
  const s = await relaySetup(t)
  const { phone, desktop } = await openTunnel(s)
  assert.deepEqual((await s.desktop.request('relay.revoke', { id: s.grant.id })).r, { revoked: true })
  assert.equal((await phone.closed).code, 4004)
  assert.equal((await desktop.closed).code, 4010)
  const { answer } = await phoneOpens(s)
  assert.equal((await answer).e?.code, 'GRANT_INVALID')
})

test('desktop leaves the team: both grants gone, both legs 4004', async (t) => {
  const s = await relaySetup(t)
  const second = (await s.desktop.request('relay.grant', { name: 'Tablet' })).r
  const { phone, desktop } = await openTunnel(s)
  await s.desktop.request('device.leave')
  assert.equal((await phone.closed).code, 4004)
  assert.equal((await desktop.closed).code, 4004)
  for (const grant of [s.grant, { id: second.grant.id, secret: second.secret }]) {
    const { answer } = await phoneOpens(s, grant)
    assert.equal((await answer).e?.code, 'GRANT_INVALID')
  }
})

test('admin revokes the desktop from the command line: both legs 4004 within 10 seconds', async (t) => {
  const s = await relaySetup(t)
  const { phone, desktop } = await openTunnel(s)
  const started = Date.now()
  const result = await runAdmin(['device', 'revoke', s.credential.deviceId], { DATA_DIR: s.dir })
  assert.equal(result.status, 0, result.stderr)
  assert.equal((await phone.closed).code, 4004)
  assert.equal((await desktop.closed).code, 4004)
  assert.ok(Date.now() - started < 10_000)
})

test('admin revokes the desktop while its team connection is down: both legs 4004', async (t) => {
  const s = await relaySetup(t)
  const { phone, desktop } = await openTunnel(s)
  s.desktop.close()
  await s.desktop.closed
  await wait(100)
  const other = openDatabaseFile(s.dbPath)
  revokeDevice(other, s.credential.deviceId, Date.now)
  other.close()
  assert.equal((await phone.closed).code, 4004)
  assert.equal((await desktop.closed).code, 4004)
})

test('admin revokes the desktop while the phone waits: GRANT_INVALID, and /connect 4004', async (t) => {
  const s = await relaySetup(t)
  const { phone, answer } = await phoneOpens(s)
  await s.desktop.nextEvent('relay.incoming')
  const other = openDatabaseFile(s.dbPath)
  revokeDevice(other, s.credential.deviceId, Date.now)
  other.close()
  assert.equal((await answer).e?.code, 'GRANT_INVALID')
  assert.equal((await phone.closed).code, 4003)
  assert.equal((await s.desktop.closed).code, 4004)
})

test("desktop's team connection reconnects: the tunnel keeps carrying bytes", async (t) => {
  const s = await relaySetup(t)
  const { phone, desktop } = await openTunnel(s)
  s.desktop.close()
  await s.desktop.closed
  const again = await TestClient.open(s.url)
  t.after(() => again.close())
  await again.request('hello', { protocol: [1], deviceId: s.credential.deviceId, deviceSecret: s.credential.deviceSecret })
  phone.ws.send(Buffer.from('still here'))
  await desktop.until(10)
  assert.equal(desktop.messages[0]!.toString(), 'still here')
})

test('phone goes away: the desktop leg is closed with 4010', async (t) => {
  const s = await relaySetup(t)
  const { phone, desktop } = await openTunnel(s)
  phone.ws.terminate()
  assert.equal((await desktop.closed).code, 4010)
  assert.ok(s.logs.some((l) => /tunnel t_[0-9a-f]+ closed after \d+ s: 0 bytes to the desktop, 0 bytes to the phone/.test(l)))
})

test('missing pongs on an idle leg end the tunnel', async (t) => {
  const s = await relaySetup(t, { relayTimings: { pingIntervalMs: 100 } })
  const { phone, desktop } = await openTunnel(s)
  // Stop answering pings: the phone's socket is no longer read.
  ;(phone.ws as unknown as { _socket: { pause(): void } })._socket.pause()
  assert.equal((await desktop.closed).code, 4010)
})

test('server shutdown: both legs and a pending phone are closed with 1001', async (t) => {
  const s = await relaySetup(t)
  const { phone, desktop } = await openTunnel(s)
  const pending = await phoneOpens(s)
  await s.desktop.nextEvent('relay.incoming')
  await s.server.close()
  assert.equal((await phone.closed).code, 1001)
  assert.equal((await desktop.closed).code, 1001)
  assert.equal((await pending.phone.closed).code, 1001)
  assert.equal(pending.phone.answers.length, 0)
})

test('a late /relay connection during shutdown is turned away', async (t) => {
  const s = await relaySetup(t)
  const leg = await RelayClient.open(s.relayUrl)
  await s.server.close()
  assert.equal((await leg.closed).code, 1001)
})
