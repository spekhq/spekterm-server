import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDataDir } from '../src/db.ts'
import { TestClient } from './helpers/client.ts'
import { tempDir } from './helpers/db.ts'
import { spawnServer } from './helpers/process.ts'
import { seedMember } from './helpers/server.ts'

test('SIGTERM closes connections with 1001 and exits with status 0', async (t) => {
  const dir = tempDir(t)
  const db = openDataDir(dir)
  const cred = seedMember(db)
  db.close()
  const server = await spawnServer({ DATA_DIR: dir })
  t.after(() => server.child.kill('SIGKILL'))
  const client = await TestClient.open(`ws://127.0.0.1:${server.port}/connect`)
  const hello = await client.request('hello', { protocol: [1], deviceId: cred.device.id, deviceSecret: cred.deviceSecret })
  assert.equal(hello.ok, true)
  server.child.kill('SIGTERM')
  assert.equal((await client.closed).code, 1001)
  assert.equal(await server.exited, 0)
  assert.match(server.output(), /without TLS; a TLS terminator \(reverse proxy\) is expected in front/)
})

test('the server refuses to start on an invalid configuration, naming the variable', async (t) => {
  const dir = tempDir(t)
  await assert.rejects(spawnServer({ DATA_DIR: dir, TLS_CERT: '/nope.pem' }), /TLS_KEY/)
  await assert.rejects(spawnServer({ DATA_DIR: dir, PUBLIC_URL: 'http://example.com' }), /must start with wss:\/\//)
})

test('the server refuses to start on a newer database', async (t) => {
  const dir = tempDir(t)
  const db = openDataDir(dir)
  db.exec('PRAGMA user_version = 99')
  db.close()
  await assert.rejects(spawnServer({ DATA_DIR: dir }), /newer than this server knows/)
})
