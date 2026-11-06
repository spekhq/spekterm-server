import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestClient } from './helpers/client.ts'
import { RelayClient } from './helpers/relay.ts'
import { tempDir } from './helpers/db.ts'
import { runAdmin, spawnServer } from './helpers/process.ts'

const PROBE = fileURLToPath(new URL('./helpers/outbound-probe.mjs', import.meta.url))

/** Runs every operation and admin command against a real server process; returns all output and secrets. */
async function exercise(t: Parameters<typeof tempDir>[0], extraEnv: Record<string, string> = {}) {
  const dir = tempDir(t)
  const env = { DATA_DIR: dir, PUBLIC_URL: 'wss://team.example.com', RELAY: 'on', ...extraEnv }
  const server = await spawnServer(env)
  t.after(() => server.child.kill('SIGKILL'))
  const url = `ws://127.0.0.1:${server.port}/connect`
  const cliOutput: string[] = []
  const admin = async (...args: string[]) => {
    const result = await runAdmin(args, env)
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
    return result
  }
  const keep = (r: { stdout: string; stderr: string }) => cliOutput.push(r.stdout, r.stderr)

  keep(await admin('team', 'name', 'Billing crew'))
  const created = await admin('invite', 'create')
  const [link, ...afterLink] = created.stdout.split('\n')
  cliOutput.push(afterLink.join('\n'), created.stderr)
  const code = new URL(link!).searchParams.get('c')!
  keep(await admin('invite', 'list'))

  const inspecting = await TestClient.open(url)
  assert.equal((await inspecting.request('invite.inspect', { protocol: [1], code })).ok, true)
  inspecting.close()

  const joining = await TestClient.open(url)
  const joined = await joining.request('join', { protocol: [1], code, handle: 'sam', displayName: 'Sam', deviceName: 'home desktop' })
  assert.equal(joined.ok, true)
  const { deviceId, deviceSecret } = joined.r
  joining.close()

  const helloing = await TestClient.open(url)
  assert.equal((await helloing.request('hello', { protocol: [1], deviceId, deviceSecret })).ok, true)
  assert.equal((await helloing.request('device.rename', { name: 'desk' })).ok, true)

  // Sam's phone reaches the desktop through a tunnel that carries a marker each way, then the grant is revoked.
  const granted = (await helloing.request('relay.grant', { name: 'Pixel 8' })).r
  const relayUrl = url.replace(/\/connect$/, '/relay')
  const phone = await RelayClient.open(relayUrl)
  const opening = phone.request('relay.open', { protocol: [1], grant: granted.grant.id, secret: granted.secret })
  const relayIncoming = await helloing.nextEvent('relay.incoming')
  const desktopLeg = await RelayClient.open(relayUrl)
  const accepted = await desktopLeg.request('relay.accept', { protocol: [1], deviceId, deviceSecret, tunnel: relayIncoming.d.tunnel })
  assert.equal(accepted.ok, true)
  assert.equal((await opening).ok, true)
  const relayMarker = 'relayed-marker-5e7d0b'
  phone.ws.send(Buffer.from(relayMarker))
  desktopLeg.ws.send(Buffer.from(relayMarker))
  await desktopLeg.until(relayMarker.length)
  await phone.until(relayMarker.length)
  const listed = await admin('member', 'list')
  keep(listed)
  assert.match(listed.stdout, new RegExp(`relay grant ${granted.grant.id}  "Pixel 8"  created \\S+  last used \\d{4}-`))
  assert.deepEqual((await helloing.request('relay.revoke', { id: granted.grant.id })).r, { revoked: true })
  assert.equal((await phone.closed).code, 4004)
  assert.equal((await desktopLeg.closed).code, 4010)

  // A second member hands work to sam; sam's connected device receives and acknowledges it.
  const kimInvite = await admin('invite', 'create')
  cliOutput.push(kimInvite.stdout.split('\n').slice(1).join('\n'))
  const kim = await TestClient.open(url)
  const kimJoined = await kim.request('join', {
    protocol: [1], code: new URL(kimInvite.stdout.split('\n')[0]!).searchParams.get('c'), handle: 'kim', displayName: 'Kim', deviceName: 'k',
  })
  assert.equal(kimJoined.ok, true)
  assert.equal((await kim.request('team.members')).r.members.length, 2)
  const handoffText = { title: 'secret-title-7f3a9c', body: 'secret-body-' + 'q'.repeat(5000) + '-e1d2' }
  const sent = await kim.request('handoff.send', { clientId: 'h1', to: 'sam', payload: { enc: 'none', ...handoffText } })
  assert.equal(sent.ok, true)
  const incoming = await helloing.nextEvent('handoff.incoming')
  assert.deepEqual((await helloing.request('handoff.received', { id: incoming.d.id })).r, {})
  // Kim follows the statuses; Sam takes the first and finishes it, and declines a second with a reason.
  assert.equal((await kim.request('handoff.sync', { after: 0 })).ok, true)
  const reason = 'secret-reason-4b8d21'
  const report = 'secret-report-' + 'r'.repeat(3000) + '-9c0e'
  assert.deepEqual((await helloing.request('handoff.update', { id: incoming.d.id, status: 'taken' })).r, { status: 'taken' })
  const done = await helloing.request('handoff.update', { id: incoming.d.id, status: 'done', payload: { enc: 'none', text: report } })
  assert.deepEqual(done.r, { status: 'done' })
  const declinedSend = await kim.request('handoff.send', { clientId: 'h2', to: 'sam', payload: { enc: 'none', title: 't2', body: 'b2' } })
  const offered = await helloing.nextEvent('handoff.incoming')
  assert.deepEqual((await helloing.request('handoff.received', { id: offered.d.id })).r, {})
  const declined = await helloing.request('handoff.update', { id: offered.d.id, status: 'declined', payload: { enc: 'none', text: reason } })
  assert.deepEqual(declined.r, { status: 'declined' })
  for (;;) {
    const e = await kim.nextEvent('handoff.status')
    if (e.d.id === declinedSend.r.handoff.id && e.d.status === 'declined') break
  }
  kim.close()

  const second = await admin('invite', 'create', '--member', 'sam')
  cliOutput.push(second.stdout.split('\n').slice(1).join('\n'), second.stderr)
  const secondCode = new URL(second.stdout.split('\n')[0]!).searchParams.get('c')!
  keep(await admin('member', 'list'))
  keep(await admin('member', 'rename', 'sam', 'Sam W.'))
  const laptop = await TestClient.open(url)
  const laptopJoin = await laptop.request('join', { protocol: [1], code: secondCode, deviceName: 'laptop' })
  assert.equal(laptopJoin.ok, true)
  keep(await admin('device', 'revoke', laptopJoin.r.deviceId))
  assert.equal((await laptop.closed).code, 4004)

  const left = await helloing.request('device.leave')
  assert.deepEqual(left.r, { memberRemoved: true })
  await helloing.closed

  const third = await admin('invite', 'create')
  const thirdId = /invite (i_[0-9a-f]{32})/.exec(third.stdout)![1]!
  keep(await admin('invite', 'cancel', thirdId))
  const fourth = await admin('invite', 'create')
  cliOutput.push(fourth.stdout.split('\n').slice(1).join('\n'))
  const joining2 = await TestClient.open(url)
  await joining2.request('join', { protocol: [1], code: new URL(fourth.stdout.split('\n')[0]!).searchParams.get('c'), handle: 'alex', displayName: 'Alex', deviceName: 'd' })
  joining2.close()
  keep(await admin('member', 'remove', 'alex'))

  server.child.kill('SIGTERM')
  await server.exited
  return {
    serverOutput: server.output(),
    cliOutput: cliOutput.join('\n'),
    secrets: [code, code.toLowerCase(), secondCode, deviceSecret, laptopJoin.r.deviceSecret, kimJoined.r.deviceSecret,
      handoffText.title, 'secret-body-', reason, 'secret-report-', granted.secret, relayMarker],
    handoffId: sent.r.handoff.id as string,
    grantId: granted.grant.id as string,
    tunnelId: relayIncoming.d.tunnel as string,
    declinedId: declinedSend.r.handoff.id as string,
  }
}

test('secrets stay out of the server log and the CLI output; joins are logged by name', async (t) => {
  const { serverOutput, cliOutput, secrets, handoffId, declinedId, grantId, tunnelId } = await exercise(t)
  for (const secret of secrets) {
    assert.equal(serverOutput.includes(secret), false, 'server log contains a secret')
    assert.equal(cliOutput.includes(secret), false, 'CLI output contains a secret')
  }
  assert.match(serverOutput, new RegExp(`handoff ${handoffId} from member m_[0-9a-f]{32} to sam stored`))
  assert.match(serverOutput, new RegExp(`handoff ${handoffId} offered to device d_[0-9a-f]{32}`))
  assert.match(serverOutput, new RegExp(`handoff ${handoffId} delivered to device d_[0-9a-f]{32}`))
  assert.match(serverOutput, new RegExp(`handoff ${handoffId} done by device d_[0-9a-f]{32} \\(report 1\\)`))
  assert.match(serverOutput, new RegExp(`handoff ${declinedId} declined by device d_[0-9a-f]{32} \\(with a reason\\)`))
  assert.match(serverOutput, new RegExp(`tunnel ${tunnelId} opened: device d_[0-9a-f]{32}, grant ${grantId}`))
  assert.match(serverOutput, new RegExp(`tunnel ${tunnelId} closed after \\d+ s: 21 bytes to the desktop, 21 bytes to the phone \\(grant revoked\\)`))
  assert.match(serverOutput, /relaying phones: at most 32 tunnels, 512 KiB\/s per tunnel and direction/)
  assert.match(serverOutput, /joined: member sam \(m_[0-9a-f]{32}\), device "home desktop" \(d_[0-9a-f]{32}\)/)
})

test('neither the server nor the CLI opens an outbound socket or makes a DNS lookup', async (t) => {
  const logFile = join(tempDir(t), 'outbound.log')
  writeFileSync(logFile, '')
  await exercise(t, { NODE_OPTIONS: `--import=${PROBE}`, OUTBOUND_LOG: logFile })
  const lines = readFileSync(logFile, 'utf8').trim().split('\n')
  const loaded = lines.filter((l) => l.endsWith('probe loaded'))
  assert.ok(loaded.length >= 10, `probe loaded in ${loaded.length} processes`)
  assert.deepEqual(lines.filter((l) => !l.endsWith('probe loaded')), [])
})

test('the outbound probe records lookups and sockets', async (t) => {
  const logFile = join(tempDir(t), 'outbound.log')
  writeFileSync(logFile, '')
  const { spawnSync } = await import('node:child_process')
  const script = `const dns = require('node:dns'); const net = require('node:net');
    dns.lookup('localhost', () => { const s = net.connect(9, '127.0.0.1'); s.on('error', () => {}); setTimeout(() => process.exit(0), 50) })`
  spawnSync(process.execPath, [`--import=${PROBE}`, '-e', script], { env: { ...process.env, OUTBOUND_LOG: logFile } })
  const log = readFileSync(logFile, 'utf8')
  assert.match(log, /dns\.lookup\(localhost\)/)
  assert.match(log, /net\.client\.socket/)
})
