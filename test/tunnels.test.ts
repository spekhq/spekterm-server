/** The `/relay` endpoint, opening and accepting tunnels, and splicing (`phone-relay` spec). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { TLSSocket, connect as tlsConnect } from 'node:tls'
import { WebSocket } from 'ws'
import { TestClient } from './helpers/client.ts'
import { makeSelfSigned } from './helpers/certs.ts'
import { legStream, openTunnel, phoneOpens, RelayClient, relaySetup } from './helpers/relay.ts'
import { seedMember, testServer } from './helpers/server.ts'
import { tempDir } from './helpers/db.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------------------------------------
// The relay endpoint

test('relay path is accepted, also with relaying off; other paths stay 404', async (t) => {
  const s = await testServer(t)
  const relayUrl = s.url.replace(/\/connect$/, '/relay')
  const phone = await RelayClient.open(relayUrl)
  const answer = await phone.request('relay.open', { protocol: [1], grant: 'g_x', secret: 'x' })
  assert.equal(answer.e?.code, 'RELAY_DISABLED')
  assert.equal((await phone.closed).code, 4003)
  const wrong = new WebSocket(s.url.replace(/\/connect$/, '/ws'))
  wrong.on('error', () => {})
  const [, response] = (await once(wrong, 'unexpected-response')) as [unknown, { statusCode: number }]
  assert.equal(response.statusCode, 404)
})

test('version is negotiated before relaying is checked', async (t) => {
  const s = await testServer(t)
  const phone = await RelayClient.open(s.url.replace(/\/connect$/, '/relay'))
  const answer = await phone.request('relay.open', { protocol: [9] })
  assert.equal(answer.e?.code, 'UNSUPPORTED_VERSION')
})

test('silent connection is closed with 4001', async (t) => {
  const s = await relaySetup(t)
  const leg = await RelayClient.open(s.relayUrl)
  assert.equal((await leg.closed).code, 4001)
})

test('a handoff operation on the relay endpoint is unknown', async (t) => {
  const s = await relaySetup(t)
  const leg = await RelayClient.open(s.relayUrl)
  const answer = await leg.request('hello', { protocol: [1], deviceId: s.credential.deviceId, deviceSecret: s.credential.deviceSecret })
  assert.equal(answer.e?.code, 'UNKNOWN_OPERATION')
  assert.equal((await leg.closed).code, 4003)
})

test('a text frame that is not a request is BAD_FRAME', async (t) => {
  const s = await relaySetup(t)
  const leg = await RelayClient.open(s.relayUrl)
  const answered = new Promise<string>((resolve) => leg.ws.once('message', (d) => resolve(String(d))))
  leg.ws.send('hello')
  assert.equal(JSON.parse(await answered).e.code, 'BAD_FRAME')
  assert.equal((await leg.closed).code, 4003)
})

test('bytes before the answer close the connection and leave nothing pending', async (t) => {
  const s = await relaySetup(t)
  const { phone } = await phoneOpens(s)
  const incoming = await s.desktop.nextEvent('relay.incoming')
  phone.ws.send(Buffer.from([1, 2, 3]))
  assert.equal((await phone.closed).code, 1003)
  const leg = await RelayClient.open(s.relayUrl)
  const accepted = await leg.request('relay.accept', {
    protocol: [1],
    deviceId: s.credential.deviceId,
    deviceSecret: s.credential.deviceSecret,
    tunnel: incoming.d.tunnel,
  })
  assert.equal(accepted.e?.code, 'TUNNEL_UNKNOWN')
  assert.equal(s.server.relay.size, 0)
})

test('a binary frame as the first message closes with 1003', async (t) => {
  const s = await relaySetup(t)
  const leg = await RelayClient.open(s.relayUrl)
  leg.ws.send(Buffer.from('x'))
  assert.equal((await leg.closed).code, 1003)
})

// ---------------------------------------------------------------------------------------------------------
// Opening, accepting, refusing

test('desktop connected and willing: event, then the desktop answer, then the phone answer', async (t) => {
  const s = await relaySetup(t)
  const tunnel = await openTunnel(s)
  assert.match(tunnel.tunnel, /^t_[0-9a-f]{32}$/)
  assert.equal(tunnel.incoming.d.grant, s.grant.id)
  assert.equal(typeof tunnel.incoming.d.expiresAt, 'number')
  assert.deepEqual(tunnel.accepted.r, { protocol: 1 })
  assert.deepEqual(tunnel.phoneAnswer.r, { protocol: 1, tunnel: tunnel.tunnel })
  const lastUsed = (await s.desktop.request('relay.grants')).r.grants[0].lastUsedAt
  assert.equal(typeof lastUsed, 'number')
  assert.ok(s.logs.some((l) => l.includes(`tunnel ${tunnel.tunnel} opened: device ${s.credential.deviceId}, grant ${s.grant.id}`)))
})

test('desktop not connected: DESKTOP_UNAVAILABLE at once, no event', async (t) => {
  const s = await relaySetup(t)
  s.desktop.close()
  await s.desktop.closed
  await wait(50)
  const { phone, answer } = await phoneOpens(s)
  assert.equal((await answer).e?.code, 'DESKTOP_UNAVAILABLE')
  assert.equal((await phone.closed).code, 4003)
})

test('desktop does not answer: DESKTOP_UNAVAILABLE after the wait, then TUNNEL_UNKNOWN', async (t) => {
  const s = await relaySetup(t, { relayTimings: { pendingTimeoutMs: 300 } })
  const started = Date.now()
  const { answer } = await phoneOpens(s)
  const incoming = await s.desktop.nextEvent('relay.incoming')
  assert.equal((await answer).e?.code, 'DESKTOP_UNAVAILABLE')
  assert.ok(Date.now() - started >= 280)
  const leg = await RelayClient.open(s.relayUrl)
  const late = await leg.request('relay.accept', {
    protocol: [1],
    deviceId: s.credential.deviceId,
    deviceSecret: s.credential.deviceSecret,
    tunnel: incoming.d.tunnel,
  })
  assert.equal(late.e?.code, 'TUNNEL_UNKNOWN')
})

test('wrong secret: GRANT_INVALID and nothing reaches the desktop', async (t) => {
  const s = await relaySetup(t)
  const { answer } = await phoneOpens(s, { id: s.grant.id, secret: 'not the secret' })
  assert.equal((await answer).e?.code, 'GRANT_INVALID')
  assert.equal(await s.desktop.noEvent('relay.incoming', 200), true)
  assert.ok(s.logs.some((l) => l.includes(`relay.open refused: GRANT_INVALID (grant ${s.grant.id})`)))
})

test('bad parameters name the field', async (t) => {
  const s = await relaySetup(t)
  const phone = await RelayClient.open(s.relayUrl)
  const answer = await phone.request('relay.open', { protocol: [1], grant: s.grant.id })
  assert.equal(answer.e?.code, 'BAD_PARAMS')
  assert.equal(answer.e?.detail.field, 'secret')
})

test('refused: the phone gets DESKTOP_REFUSED and the tunnel is gone', async (t) => {
  const s = await relaySetup(t)
  const { answer } = await phoneOpens(s)
  const incoming = await s.desktop.nextEvent('relay.incoming')
  assert.deepEqual((await s.desktop.request('relay.refuse', { tunnel: incoming.d.tunnel })).r, {})
  assert.equal((await answer).e?.code, 'DESKTOP_REFUSED')
  assert.equal(s.server.relay.size, 0)
  assert.deepEqual((await s.desktop.request('relay.refuse', { tunnel: 't_unknown' })).r, {})
})

test('another device accepts: TUNNEL_UNKNOWN, and the first can still accept', async (t) => {
  const s = await relaySetup(t)
  const other = seedMember(s.db, 'kim', 'laptop')
  const { answer } = await phoneOpens(s)
  const incoming = await s.desktop.nextEvent('relay.incoming')
  const intruder = await RelayClient.open(s.relayUrl)
  const refused = await intruder.request('relay.accept', {
    protocol: [1],
    deviceId: other.device.id,
    deviceSecret: other.deviceSecret,
    tunnel: incoming.d.tunnel,
  })
  assert.equal(refused.e?.code, 'TUNNEL_UNKNOWN')
  const leg = await RelayClient.open(s.relayUrl)
  const accepted = await leg.request('relay.accept', {
    protocol: [1],
    deviceId: s.credential.deviceId,
    deviceSecret: s.credential.deviceSecret,
    tunnel: incoming.d.tunnel,
  })
  assert.equal(accepted.ok, true)
  assert.equal((await answer).ok, true)
})

test('accept with a wrong device secret is AUTH_FAILED', async (t) => {
  const s = await relaySetup(t)
  await phoneOpens(s)
  const incoming = await s.desktop.nextEvent('relay.incoming')
  const leg = await RelayClient.open(s.relayUrl)
  const refused = await leg.request('relay.accept', {
    protocol: [1],
    deviceId: s.credential.deviceId,
    deviceSecret: 'wrong',
    tunnel: incoming.d.tunnel,
  })
  assert.equal(refused.e?.code, 'AUTH_FAILED')
})

test('accepting does not replace the team connection (no 4006)', async (t) => {
  const s = await relaySetup(t)
  await openTunnel(s)
  const members = await s.desktop.request('team.members')
  assert.equal(members.ok, true)
  assert.equal(s.server.devices.get(s.credential.deviceId) !== undefined, true)
})

test('phone gives up while waiting: the tunnel is dropped', async (t) => {
  const s = await relaySetup(t)
  const { phone } = await phoneOpens(s)
  const incoming = await s.desktop.nextEvent('relay.incoming')
  phone.close()
  await phone.closed
  await wait(50)
  const leg = await RelayClient.open(s.relayUrl)
  const accepted = await leg.request('relay.accept', {
    protocol: [1],
    deviceId: s.credential.deviceId,
    deviceSecret: s.credential.deviceSecret,
    tunnel: incoming.d.tunnel,
  })
  assert.equal(accepted.e?.code, 'TUNNEL_UNKNOWN')
})

test('pending tunnel whose desktop connection is replaced: DESKTOP_UNAVAILABLE', async (t) => {
  const s = await relaySetup(t)
  const { answer } = await phoneOpens(s)
  await s.desktop.nextEvent('relay.incoming')
  const second = await TestClient.open(s.url)
  t.after(() => second.close())
  await second.request('hello', { protocol: [1], deviceId: s.credential.deviceId, deviceSecret: s.credential.deviceSecret })
  assert.equal((await answer).e?.code, 'DESKTOP_UNAVAILABLE')
  assert.equal((await s.desktop.closed).code, 4006)
})

test('revoked while the phone waits: GRANT_INVALID, then TUNNEL_UNKNOWN', async (t) => {
  const s = await relaySetup(t)
  const { phone, answer } = await phoneOpens(s)
  const incoming = await s.desktop.nextEvent('relay.incoming')
  await s.desktop.request('relay.revoke', { id: s.grant.id })
  assert.equal((await answer).e?.code, 'GRANT_INVALID')
  assert.equal((await phone.closed).code, 4003)
  const leg = await RelayClient.open(s.relayUrl)
  const accepted = await leg.request('relay.accept', {
    protocol: [1],
    deviceId: s.credential.deviceId,
    deviceSecret: s.credential.deviceSecret,
    tunnel: incoming.d.tunnel,
  })
  assert.equal(accepted.e?.code, 'TUNNEL_UNKNOWN')
})

// ---------------------------------------------------------------------------------------------------------
// Splicing

test('bytes cross unchanged, in the same messages and order, both ways', async (t) => {
  const s = await relaySetup(t, { relay: { enabled: true, kibPerSecond: 0 } })
  const { phone, desktop } = await openTunnel(s)
  const sizes = [1, 7, 1000, 16_384, 65_536, 200_000, 3, 262_000]
  const sent: Buffer[] = []
  let total = 0
  while (total < 1024 * 1024) {
    const size = sizes[sent.length % sizes.length]!
    const message = randomBytes(size)
    sent.push(message)
    total += size
  }
  for (const m of sent) phone.ws.send(m)
  for (const m of sent) desktop.ws.send(m)
  await desktop.until(total)
  await phone.until(total)
  assert.deepEqual(desktop.messages.map((m) => m.length), sent.map((m) => m.length))
  assert.ok(desktop.messages.every((m, i) => m.equals(sent[i]!)))
  assert.ok(phone.messages.every((m, i) => m.equals(sent[i]!)))
})

test('a text frame after the splice closes that leg with 1003 and the other with 4010', async (t) => {
  const s = await relaySetup(t)
  const { phone, desktop } = await openTunnel(s)
  phone.ws.send('{"t":"req"}')
  assert.equal((await phone.closed).code, 1003)
  assert.equal((await desktop.closed).code, 4010)
})

/** Runs TLS through a tunnel: the desktop serves a self-signed certificate, the phone pins it. */
async function tlsThroughTunnel(t: Parameters<typeof relaySetup>[0], cut: number | null, bytes: number) {
  const s = await relaySetup(t, { relay: { enabled: true, kibPerSecond: 0 } })
  const { phone, desktop } = await openTunnel(s)
  phone.keep = false
  desktop.keep = false
  const { certPath, keyPath } = makeSelfSigned(tempDir(t), 'desk')
  const cert = readFileSync(certPath)
  const pin = createHash('sha256').update(new (await import('node:crypto')).X509Certificate(cert).raw).digest('hex')
  const server = new TLSSocket(legStream(desktop.ws, cut), { isServer: true, cert, key: readFileSync(keyPath) })
  server.on('error', () => {})
  const client = tlsConnect({
    socket: legStream(phone.ws, cut),
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  })
  client.on('error', () => {})
  await once(client, 'secureConnect')
  const presented = createHash('sha256').update(client.getPeerCertificate().raw).digest('hex')
  assert.equal(presented, pin)
  const payload = randomBytes(bytes)
  const collect = (socket: TLSSocket, n: number) =>
    new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = []
      let got = 0
      socket.on('data', (d: Buffer) => {
        parts.push(d)
        got += d.length
        if (got >= n) resolve(Buffer.concat(parts))
      })
    })
  return { s, phone, desktop, server, client, payload, collect }
}

test('TLS through the tunnel: a pinned session carries one 2 MiB write each way intact', async (t) => {
  const { phone, desktop, server, client, payload, collect } = await tlsThroughTunnel(t, 64 * 1024, 2 * 1024 * 1024)
  const atDesktop = collect(server, payload.length)
  client.write(payload)
  assert.ok((await atDesktop).equals(payload))
  const atPhone = collect(client, payload.length)
  server.write(payload)
  assert.ok((await atPhone).equals(payload))
  assert.equal(phone.ws.readyState, WebSocket.OPEN)
  assert.equal(desktop.ws.readyState, WebSocket.OPEN)
  client.destroy()
  server.destroy()
})

test('the same 2 MiB write without cutting closes the leg with 1009', async (t) => {
  const { phone, desktop, client, payload } = await tlsThroughTunnel(t, null, 2 * 1024 * 1024)
  client.write(payload)
  assert.equal((await phone.closed).code, 1009)
  assert.equal((await desktop.closed).code, 4010)
})
