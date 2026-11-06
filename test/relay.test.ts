/** Relay grants over `/connect` (`phone-relay` spec: "Relaying is the operator's choice", "Grants", "Revoking a grant"). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TestClient } from './helpers/client.ts'
import { relaySetup, RelayClient } from './helpers/relay.ts'
import { seedMember, testServer } from './helpers/server.ts'
import { tempDatabase } from './helpers/db.ts'
import { openDataDir } from '../src/db.ts'
import { startServer } from '../src/server.ts'
import { createGrant, listGrants, verifyGrant } from '../src/relay.ts'
import { leave, removeMember, revokeDevice } from '../src/team.ts'

const HANDOFF_OPERATIONS = ['device.leave', 'device.rename', 'handoff.received', 'handoff.send', 'handoff.sync', 'handoff.update', 'team.members']

async function hello(url: string, deviceId: string, deviceSecret: string) {
  const client = await TestClient.open(url)
  const answer = await client.request('hello', { protocol: [1], deviceId, deviceSecret })
  return { client, answer }
}

test('off by default: relay operations are unknown and not listed', async (t) => {
  const s = await testServer(t)
  const joined = seedMember(s.db)
  const { client, answer } = await hello(s.url, joined.device.id, joined.deviceSecret)
  t.after(() => client.close())
  assert.deepEqual(answer.r.operations, HANDOFF_OPERATIONS)
  for (const m of ['relay.grant', 'relay.grants', 'relay.revoke', 'relay.refuse']) {
    const refused = await client.request(m, { name: 'x', id: 'g_x', tunnel: 't_x' })
    assert.equal(refused.e?.code, 'UNKNOWN_OPERATION', m)
  }
})

test('operations with relaying on', async (t) => {
  const s = await testServer(t, { relay: { enabled: true } })
  const joined = seedMember(s.db)
  const { client, answer } = await hello(s.url, joined.device.id, joined.deviceSecret)
  t.after(() => client.close())
  assert.deepEqual(answer.r.operations, [
    'device.leave',
    'device.rename',
    'handoff.received',
    'handoff.send',
    'handoff.sync',
    'handoff.update',
    'relay.grant',
    'relay.grants',
    'relay.refuse',
    'relay.revoke',
    'team.members',
  ])
})

test('creating a grant: id, secret once, only a hash stored', async (t) => {
  const s = await relaySetup(t)
  assert.match(s.grant.id, /^g_[0-9a-f]{32}$/)
  assert.ok(s.grant.secret.length >= 43)
  const listed = await s.desktop.request('relay.grants')
  assert.deepEqual(listed.r.grants.map((g: { id: string; name: string }) => [g.id, g.name]), [[s.grant.id, 'Pixel 8']])
  assert.equal('secret' in listed.r.grants[0], false)
  s.db.close()
  for (const file of readdirSync(s.dir)) {
    assert.equal(readFileSync(join(s.dir, file)).includes(Buffer.from(s.grant.secret)), false, file)
  }
})

test('grant names follow the naming rules', async (t) => {
  const s = await relaySetup(t)
  const answer = await s.desktop.request('relay.grant', { name: '   ' })
  assert.equal(answer.e?.code, 'BAD_PARAMS')
  assert.equal(answer.e?.detail.field, 'name')
})

test('seventeenth grant is refused', async (t) => {
  const s = await relaySetup(t)
  for (let i = 2; i <= 16; i++) assert.equal((await s.desktop.request('relay.grant', { name: `phone ${i}` })).ok, true)
  const refused = await s.desktop.request('relay.grant', { name: 'phone 17' })
  assert.equal(refused.e?.code, 'TOO_MANY_GRANTS')
  assert.deepEqual(refused.e?.detail, { limit: 16 })
  assert.equal((await s.desktop.request('relay.grants')).r.grants.length, 16)
})

test('only one\'s own grants are listed, and another device\'s grant cannot be revoked', async (t) => {
  const s = await relaySetup(t)
  const laptop = seedMember(s.db, 'kim', 'laptop')
  const { client, answer } = await hello(s.url, laptop.device.id, laptop.deviceSecret)
  t.after(() => client.close())
  assert.equal(answer.ok, true)
  const own = await client.request('relay.grant', { name: 'Kim phone' })
  assert.deepEqual((await client.request('relay.grants')).r.grants.map((g: { id: string }) => g.id), [own.r.grant.id])
  assert.deepEqual(await client.request('relay.revoke', { id: s.grant.id }).then((a) => a.r), { revoked: false })
  assert.deepEqual(verifyGrant(s.db, s.grant.id, s.grant.secret).deviceId, s.credential.deviceId)
})

test('revoking twice: the second answer is revoked: false', async (t) => {
  const s = await relaySetup(t)
  assert.deepEqual((await s.desktop.request('relay.revoke', { id: s.grant.id })).r, { revoked: true })
  assert.deepEqual((await s.desktop.request('relay.revoke', { id: s.grant.id })).r, { revoked: false })
  assert.equal((await s.desktop.request('relay.revoke', { id: 5 })).e?.code, 'BAD_PARAMS')
  const phone = await RelayClient.open(s.relayUrl)
  const refused = await phone.request('relay.open', { protocol: [1], grant: s.grant.id, secret: s.grant.secret })
  assert.equal(refused.e?.code, 'GRANT_INVALID')
})

test('grants end with their device: revoke, leave, member removal; other devices untouched', (t) => {
  const { db } = tempDatabase(t)
  const now = () => 1_000
  const a = seedMember(db, 'alex', 'desk')
  const b = seedMember(db, 'sam', 'desk')
  const grantOf = (deviceId: string) => createGrant(db, deviceId, 'phone', now).grant.id
  grantOf(a.device.id)
  grantOf(b.device.id)
  revokeDevice(db, a.device.id, now)
  assert.equal(listGrants(db, a.device.id).length, 0)
  assert.equal(listGrants(db, b.device.id).length, 1)

  const c = seedMember(db, 'kim', 'desk')
  grantOf(c.device.id)
  leave(db, c.device.id, now)
  assert.equal(listGrants(db, c.device.id).length, 0)

  removeMember(db, 'sam', now)
  assert.equal(listGrants(db, b.device.id).length, 0)
  assert.equal((db.prepare('SELECT count(*) AS n FROM relay_grants').get() as { n: number }).n, 0)
})

test('turned off and on again: the grant opens tunnels without being created anew', async (t) => {
  const s = await relaySetup(t)
  s.desktop.close()
  await s.server.close()
  const dbOff = openDataDir(s.dir)
  const off = await startServer(0, { db: dbOff, relay: { enabled: false }, log: () => {} })
  const offUrl = `ws://127.0.0.1:${off.port}/relay`
  const phoneOff = await RelayClient.open(offUrl)
  const disabled = await phoneOff.request('relay.open', { protocol: [1], grant: s.grant.id, secret: s.grant.secret })
  assert.equal(disabled.e?.code, 'RELAY_DISABLED')
  await off.close()

  const dbOn = openDataDir(s.dir)
  const on = await startServer(0, { db: dbOn, relay: { enabled: true }, log: () => {} })
  t.after(() => on.close())
  const base = `ws://127.0.0.1:${on.port}`
  const { client: desktop } = await hello(`${base}/connect`, s.credential.deviceId, s.credential.deviceSecret)
  t.after(() => desktop.close())
  const phone = await RelayClient.open(`${base}/relay`)
  const answer = phone.request('relay.open', { protocol: [1], grant: s.grant.id, secret: s.grant.secret })
  const incoming = await desktop.nextEvent('relay.incoming')
  assert.equal(incoming.d.grant, s.grant.id)
  await desktop.request('relay.refuse', { tunnel: incoming.d.tunnel })
  assert.equal((await answer).e?.code, 'DESKTOP_REFUSED')
})
