/** Handoffs across a server restart and admin command line removals, with the real processes. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDataDir } from '../src/db.ts'
import { TestClient } from './helpers/client.ts'
import { tempDir } from './helpers/db.ts'
import { runAdmin, spawnServer } from './helpers/process.ts'
import { seedMember } from './helpers/server.ts'

const P = { protocol: [1] }
type Cred = { device: { id: string }; deviceSecret: string; member: { id: string } }

async function connect(port: number, cred: Cred) {
  const client = await TestClient.open(`ws://127.0.0.1:${port}/connect`)
  const answer = await client.request('hello', { ...P, deviceId: cred.device.id, deviceSecret: cred.deviceSecret })
  assert.equal(answer.ok, true, JSON.stringify(answer.e))
  return client
}

function seed(dir: string) {
  const db = openDataDir(dir)
  const alex = seedMember(db, 'alex')
  const sam = seedMember(db, 'sam')
  db.close()
  return { alex, sam }
}

function status(dir: string, id: string): string {
  const db = openDataDir(dir)
  try {
    return (db.prepare('SELECT status FROM handoffs WHERE id = ?').get(id) as { status: string }).status
  } finally {
    db.close()
  }
}

test('a handoff to an offline recipient is held across a restart and offered once on the next hello', async (t) => {
  const dir = tempDir(t)
  const { alex, sam } = seed(dir)
  const first = await spawnServer({ DATA_DIR: dir })
  t.after(() => first.child.kill('SIGKILL'))
  const sender = await connect(first.port, alex)
  const sent = await sender.request('handoff.send', { clientId: 'c1', to: 'sam', payload: { enc: 'none', title: 'T', body: 'B' } })
  assert.equal(sent.ok, true)
  first.child.kill('SIGTERM')
  assert.equal(await first.exited, 0)

  const second = await spawnServer({ DATA_DIR: dir })
  t.after(() => second.child.kill('SIGKILL'))
  const desktop = await connect(second.port, sam)
  const event = await desktop.nextEvent('handoff.incoming')
  assert.equal(event.d.id, sent.r.handoff.id)
  assert.deepEqual((await desktop.request('handoff.received', { id: event.d.id })).r, {})
  assert.equal(await desktop.noEvent('handoff.incoming'), true)
  assert.equal(desktop.events('handoff.incoming').length, 1)
  desktop.close()
  await desktop.closed
  const again = await connect(second.port, sam)
  assert.equal(await again.noEvent('handoff.incoming'), true)
  again.close()
})

test('the admin removing the recipient expires the handoff; a removed sender\'s handoff is still delivered', async (t) => {
  const dir = tempDir(t)
  const { alex, sam } = seed(dir)
  const db = openDataDir(dir)
  const kim = seedMember(db, 'kim')
  db.close()
  const server = await spawnServer({ DATA_DIR: dir })
  t.after(() => server.child.kill('SIGKILL'))
  const env = { DATA_DIR: dir }

  // alex → kim, then kim is removed: the handoff expires and kim can no longer connect.
  const alexClient = await connect(server.port, alex)
  const toKim = await alexClient.request('handoff.send', { clientId: 'k1', to: 'kim', payload: { enc: 'none', title: 'T', body: 'B' } })
  assert.equal((await runAdmin(['member', 'remove', 'kim'], env)).status, 0)
  assert.equal(status(dir, toKim.r.handoff.id), 'expired')
  const kimClient = await TestClient.open(`ws://127.0.0.1:${server.port}/connect`)
  const refused = await kimClient.request('hello', { ...P, deviceId: kim.device.id, deviceSecret: kim.deviceSecret })
  assert.equal(refused.e?.code, 'AUTH_FAILED')

  // alex → sam while sam is offline, then alex is removed: sam still receives it, from alex.
  const toSam = await alexClient.request('handoff.send', { clientId: 's1', to: 'sam', payload: { enc: 'none', title: 'T', body: 'B' } })
  assert.equal((await runAdmin(['member', 'remove', 'alex'], env)).status, 0)
  assert.equal((await alexClient.closed).code, 4004)
  const samClient = await connect(server.port, sam)
  const event = await samClient.nextEvent('handoff.incoming')
  assert.equal(event.d.id, toSam.r.handoff.id)
  assert.deepEqual(event.d.from, { id: alex.member.id, handle: 'alex', displayName: 'ALEX' })
  assert.equal(samClient.events('handoff.incoming').length, 1)
  samClient.close()
})
