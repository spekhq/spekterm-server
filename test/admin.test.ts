import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDataDir } from '../src/db.ts'
import { loadTls } from '../src/tls.ts'
import { identityOf, inspectInvite, join as joinTeam, listInvites, listMembers } from '../src/team.ts'
import { ProtocolError } from '../src/errors.ts'
import { makeCaIssued, makeSelfSigned } from './helpers/certs.ts'
import { tempDir } from './helpers/db.ts'
import { runAdmin, spawnServer } from './helpers/process.ts'
import { seedMember } from './helpers/server.ts'
import { TestClient } from './helpers/client.ts'

const PUBLIC_URL = 'wss://team.example.com'

function linkOf(stdout: string): URL {
  const line = stdout.split('\n').find((l) => l.startsWith('spekterm://join?'))
  assert.ok(line, `no link in:\n${stdout}`)
  return new URL(line)
}

function setup(t: Parameters<typeof tempDir>[0]) {
  const dir = tempDir(t)
  const env = { DATA_DIR: dir, PUBLIC_URL }
  const db = () => {
    const handle = openDataDir(dir)
    t.after(() => {
      if (handle.isOpen) handle.close()
    })
    return handle
  }
  return { dir, env, db }
}

test('unknown command and unknown member exit non-zero with a message', async (t) => {
  const { env } = setup(t)
  const unknown = await runAdmin(['frobnicate'], env)
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stderr, /unknown command/)
  const nobody = await runAdmin(['member', 'remove', 'nobody'], env)
  assert.notEqual(nobody.status, 0)
  assert.match(nobody.stderr, /no member "nobody"/)
  assert.equal(nobody.stderr.trim().split('\n').length, 1)
})

test('team name shows and sets the name', async (t) => {
  const { env, db } = setup(t)
  assert.equal((await runAdmin(['team', 'name'], env)).stdout.trim(), 'Team')
  const set = await runAdmin(['team', 'name', 'Billing crew'], env)
  assert.equal(set.status, 0)
  const cred = seedMember(db())
  assert.equal(identityOf(db(), cred.device.id)!.team.name, 'Billing crew')
  const bad = await runAdmin(['team', 'name', 'x'.repeat(65)], env)
  assert.notEqual(bad.status, 0)
})

test('invite create prints a join link with the public address and a 7-day expiry', async (t) => {
  const { env, db } = setup(t)
  const before = Date.now()
  const result = await runAdmin(['invite', 'create'], env)
  assert.equal(result.status, 0, result.stderr)
  const link = linkOf(result.stdout)
  assert.equal(link.protocol, 'spekterm:')
  assert.equal(link.host, 'join')
  assert.equal(link.searchParams.get('v'), '1')
  assert.equal(link.searchParams.get('s'), PUBLIC_URL)
  assert.match(link.searchParams.get('c')!, /^[A-Z2-7]{26}$/)
  assert.equal(link.searchParams.has('fp'), false)
  const inspected = inspectInvite(db(), link.searchParams.get('c'), Date.now)
  assert.equal(inspected.kind, 'member')
  assert.ok(Math.abs(inspected.expiresAt - before - 7 * 24 * 3600_000) < 60_000)
  assert.match(result.stdout, /expires 20\d\d-/)
})

test('invite create --member and --expires', async (t) => {
  const { env, db } = setup(t)
  seedMember(db(), 'sam')
  const result = await runAdmin(['invite', 'create', '--member', 'sam', '--expires', '12h'], env)
  assert.equal(result.status, 0, result.stderr)
  const inspected = inspectInvite(db(), linkOf(result.stdout).searchParams.get('c'), Date.now)
  assert.equal(inspected.kind, 'device')
  assert.equal(inspected.member?.handle, 'sam')
  assert.ok(Math.abs(inspected.expiresAt - Date.now() - 12 * 3600_000) < 60_000)
  assert.notEqual((await runAdmin(['invite', 'create', '--expires', '30m'], env)).status, 0)
  assert.notEqual((await runAdmin(['invite', 'create', '--expires', '31d'], env)).status, 0)
  assert.notEqual((await runAdmin(['invite', 'create', '--member', 'nobody'], env)).status, 0)
})

test('invite create refuses without a public address and creates nothing', async (t) => {
  const { dir, db } = setup(t)
  const result = await runAdmin(['invite', 'create'], { DATA_DIR: dir, PUBLIC_URL: '' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /PUBLIC_URL/)
  assert.equal(listInvites(db(), Date.now).length, 0)
})

test('a self-signed certificate puts its fingerprint in the link', async (t) => {
  const { env, dir } = setup(t)
  const cert = makeSelfSigned(dir)
  const result = await runAdmin(['invite', 'create'], { ...env, TLS_CERT: cert.certPath, TLS_KEY: cert.keyPath })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(linkOf(result.stdout).searchParams.get('fp'), loadTls(cert).fingerprint)
})

test('a certificate from an authority is not pinned unless --pin', async (t) => {
  const { env, dir } = setup(t)
  const cert = makeCaIssued(dir)
  const tlsEnv = { ...env, TLS_CERT: cert.certPath, TLS_KEY: cert.keyPath }
  const plain = await runAdmin(['invite', 'create'], tlsEnv)
  assert.equal(linkOf(plain.stdout).searchParams.has('fp'), false)
  const pinned = await runAdmin(['invite', 'create', '--pin'], tlsEnv)
  assert.equal(linkOf(pinned.stdout).searchParams.get('fp'), loadTls(cert).fingerprint)
  const noTls = await runAdmin(['invite', 'create', '--pin'], env)
  assert.notEqual(noTls.status, 0)
  assert.match(noTls.stderr, /--pin needs the server to serve TLS itself/)
})

test('invite list never shows codes; invite cancel makes an invite unredeemable', async (t) => {
  const { env, db } = setup(t)
  const created = await runAdmin(['invite', 'create'], env)
  const code = linkOf(created.stdout).searchParams.get('c')!
  const listed = await runAdmin(['invite', 'list'], env)
  assert.equal(listed.status, 0)
  assert.match(listed.stdout, /new member/)
  assert.equal(listed.stdout.includes(code), false)
  const id = /^(i_[0-9a-f]{32})/m.exec(listed.stdout)![1]!
  assert.equal((await runAdmin(['invite', 'cancel', id], env)).status, 0)
  assert.throws(
    () => joinTeam(db(), { code, handle: 'sam', displayName: 'Sam', deviceName: 'd' }, Date.now),
    (e: unknown) => e instanceof ProtocolError && e.code === 'INVITE_UNKNOWN',
  )
  assert.match((await runAdmin(['invite', 'list'], env)).stdout, /no open invites/)
})

test('member list shows members with their devices and last-seen times', async (t) => {
  const { env, db } = setup(t)
  const sam = seedMember(db(), 'sam', 'home desktop')
  const invite = (await runAdmin(['invite', 'create', '--member', 'sam'], env)).stdout
  joinTeam(db(), { code: linkOf(invite).searchParams.get('c'), deviceName: 'work laptop' }, Date.now)
  const listed = await runAdmin(['member', 'list'], env)
  assert.equal(listed.status, 0)
  assert.match(listed.stdout, /^sam {2}"SAM" {2}m_/m)
  assert.match(listed.stdout, new RegExp(`${sam.device.id} {2}"home desktop" {2}joined \\S+ {2}last seen 20`))
  assert.match(listed.stdout, /"work laptop"/)
})

test('member rename keeps the id and handle', async (t) => {
  const { env, db } = setup(t)
  const sam = seedMember(db(), 'sam')
  const result = await runAdmin(['member', 'rename', 'sam', 'Sam W.'], env)
  assert.equal(result.status, 0, result.stderr)
  const identity = identityOf(db(), sam.device.id)!
  assert.deepEqual([identity.member.id, identity.member.handle, identity.member.displayName], [sam.member.id, 'sam', 'Sam W.'])
})

test('device revoke takes an id copied from member list', async (t) => {
  const { env, db } = setup(t)
  const sam = seedMember(db(), 'sam')
  const listed = (await runAdmin(['member', 'list'], env)).stdout
  const id = /(d_[0-9a-f]{32})/.exec(listed)![1]!
  assert.equal(id, sam.device.id)
  assert.equal((await runAdmin(['device', 'revoke', id], env)).status, 0)
  assert.deepEqual(listMembers(db())[0]!.devices, [])
  assert.notEqual((await runAdmin(['device', 'revoke', id], env)).status, 0)
})

test('with the server running: a new invite is redeemable at once, and member remove closes connections', async (t) => {
  const { env, dir } = setup(t)
  const server = await spawnServer({ DATA_DIR: dir })
  t.after(() => server.child.kill('SIGKILL'))
  const url = `ws://127.0.0.1:${server.port}/connect`
  const created = await runAdmin(['invite', 'create'], env)
  const client = await TestClient.open(url)
  const joined = await client.request('join', {
    protocol: [1],
    code: linkOf(created.stdout).searchParams.get('c'),
    handle: 'sam',
    displayName: 'Sam',
    deviceName: 'desk',
  })
  assert.equal(joined.ok, true, JSON.stringify(joined.e))
  const started = Date.now()
  assert.equal((await runAdmin(['member', 'remove', 'sam'], env)).status, 0)
  assert.equal((await client.closed).code, 4004)
  assert.ok(Date.now() - started < 10_000)
})

test('member list shows a desktop\'s relay grants, never their secrets', async (t) => {
  const { env, db } = setup(t)
  const handle = db()
  const sam = seedMember(handle, 'sam', 'home desktop')
  const { createGrant, touchGrant } = await import('../src/relay.ts')
  const yesterday = Date.UTC(2026, 10, 5, 9, 0, 0)
  const { grant, secret } = createGrant(handle, sam.device.id, 'Pixel 8', () => yesterday - 3_600_000)
  touchGrant(handle, grant.id, () => yesterday)
  handle.close()
  const listed = await runAdmin(['member', 'list'], env)
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(
    listed.stdout,
    new RegExp(`${sam.device.id}  "home desktop"[^\\n]*\\n        relay grant ${grant.id}  "Pixel 8"  created 2026-11-05T08:00:00.000Z  last used 2026-11-05T09:00:00.000Z`),
  )
  assert.equal(listed.stdout.includes(secret), false)
})
