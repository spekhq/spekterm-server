// Relay cost benchmark (phone-relay design D8): a WSS server process that splices binary messages between
// paired connections, as the relay does, with its flow control. Each scenario runs in a fresh server process;
// only the server process is measured. Clients run on the same machine and listen on 127.0.0.1 only.
//
// Run from a checkout:  node scripts/relay-bench.mjs node_modules/ws <cert.pem> <key.pem> [chacha]
// One scenario:         ONLY=<tunnels>,<KiB/s>,<message bytes>,<seconds> node scripts/relay-bench.mjs …
// Slow readers only:    SLOW=<tunnels> node scripts/relay-bench.mjs …   (prints the kernel's TCP memory)
// A throwaway certificate: openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
//                            -days 2 -keyout key.pem -out cert.pem -subj /CN=bench
import { fork } from 'node:child_process'
import { createServer } from 'node:https'
import { DEFAULT_CIPHERS } from 'node:tls'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'

const [, , wsDir, certPath, keyPath, mode] = process.argv
if (wsDir === undefined || certPath === undefined || keyPath === undefined) {
  process.stderr.write('usage: node scripts/relay-bench.mjs <ws module dir> <cert> <key> [chacha]\n')
  process.exit(2)
}
const require = createRequire(resolve(wsDir) + '/')
const HIGH = 64 * 1024
const LOW = 16 * 1024
const { WebSocketServer, WebSocket } = require('ws')

if (mode === 'server') {
  const chacha = process.argv[6] === 'chacha'
  const https = createServer({
    cert: readFileSync(certPath), key: readFileSync(keyPath), minVersion: 'TLSv1.2',
    ...(chacha ? { ciphers: 'TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:' + DEFAULT_CIPHERS, honorCipherOrder: true } : {}),
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  let waiting = null
  https.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (waiting === null) { waiting = ws; return }
      const a = waiting, b = ws
      waiting = null
      const pipe = (from, to) => from.on('message', (data) => {
        to.send(data, { binary: true })
        if (to.bufferedAmount > HIGH && !from.isPaused) {
          from.pause()
          const t = setInterval(() => { if (to.bufferedAmount < LOW) { clearInterval(t); from.resume() } }, 5)
        }
      })
      pipe(a, b); pipe(b, a)
    })
  })
  // ping every 30 s like the real server
  setInterval(() => { for (const c of wss.clients) c.ping() }, 30_000)
  https.listen(0, '127.0.0.1', () => process.send({ port: https.address().port, cipher: chacha ? 'chacha' : 'default' }))
  let last = process.cpuUsage(), lastT = process.hrtime.bigint()
  process.on('message', (m) => {
    if (m === 'sample') {
      const now = process.hrtime.bigint(), cpu = process.cpuUsage(last)
      process.send({ cpu: (cpu.user + cpu.system) / (Number(now - lastT) / 1000), rss: process.memoryUsage().rss })
      last = process.cpuUsage(); lastT = now
    }
    if (m === 'exit') process.exit(0)
  })
} else {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const sockstat = () => (existsSync('/proc/net/sockstat') ? readFileSync('/proc/net/sockstat', 'utf8').split('\n').find((l) => l.startsWith('TCP:')) : 'n/a')
  const scenario = async (label, { pairs: nPairs, active = 0, rate = 0, chunk = 1024, seconds = 10, opens = false, readKiB = 0 }) => {
    const server = fork(new URL(import.meta.url).pathname, [wsDir, certPath, keyPath, 'server', mode ?? ''])
    const { port, cipher } = await new Promise((r) => server.once('message', r))
    const sample = () => new Promise((r) => { server.once('message', r); server.send('sample') })
    const open = () => new Promise((res, rej) => {
      const ws = new WebSocket(`wss://127.0.0.1:${port}/relay`, { rejectUnauthorized: false })
      ws.once('open', () => { negotiated = ws._socket.getCipher().standardName; res(ws) }); ws.once('error', rej)
    })
    let negotiated = '?'
    await sleep(300)
    const base = await sample()
    const pairs = []
    if (opens) {
      const t0 = Date.now(); let n = 0
      while (Date.now() - t0 < seconds * 1000) { const a = await open(); const b = await open(); a.terminate(); b.terminate(); n++ }
      const s = await sample()
      console.log(`${label.padEnd(40)} ${(n / seconds).toFixed(1)} tunnels opened/s, server CPU ${(s.cpu * 100).toFixed(1)}% [${negotiated}]`)
      server.send('exit'); await sleep(300); return
    }
    for (let i = 0; i < nPairs; i++) { const a = await open(); const b = await open(); b.received = 0; b.on('message', (d) => { b.received += d.length }); pairs.push([a, b]) }
    let reader
    if (readKiB > 0) {
      // A slow phone: each reading side takes at most readKiB per second, pausing its socket when ahead.
      const start = Date.now()
      reader = setInterval(() => {
        const allowed = ((Date.now() - start) / 1000) * readKiB * 1024
        for (const [, b] of pairs) { if (b.received > allowed) b.pause(); else b.resume() }
      }, 20)
    }
    await sleep(1000)
    const afterOpen = await sample()
    const buf = randomBytes(chunk)
    const tickMs = 20
    const perTick = rate === Infinity ? Infinity : (rate * tickMs) / 1000
    let credit = 0
    const t = setInterval(() => {
      credit += perTick
      for (const [a] of pairs.slice(0, active)) {
        if (perTick === Infinity) { while (a.bufferedAmount < 2 << 20) a.send(buf); continue }
        let c = credit
        while (c >= chunk) { a.send(buf); c -= chunk }
      }
      if (perTick !== Infinity) credit %= chunk
    }, tickMs)
    await sleep(seconds * 1000)
    clearInterval(t)
    if (reader !== undefined) clearInterval(reader)
    const s = await sample()
    if (readKiB > 0) console.log(`  kernel ${sockstat()}`)
    const got = pairs.slice(0, active).reduce((n, [, b]) => n + b.received, 0)
    const perTunnel = nPairs > 0 ? ((afterOpen.rss - base.rss) / nPairs / 1024).toFixed(0) + ' KiB/tunnel' : ''
    console.log(`${label.padEnd(40)} relayed ${(got / seconds / 1024).toFixed(0).padStart(6)} KiB/s  CPU ${(s.cpu * 100).toFixed(1).padStart(5)}%  rss ${(base.rss / 1048576).toFixed(0)}→${(s.rss / 1048576).toFixed(0)} MiB ${perTunnel} [${negotiated}]`)
    server.send('exit')
    for (const [a, b] of pairs) { a.terminate(); b.terminate() }
    await sleep(300)
  }
  if (process.env.SLOW) {
    const tunnels = Number(process.env.SLOW)
    console.log(`  kernel before ${sockstat()}`)
    await scenario(`slow readers: ${tunnels} paced phones behind unbounded senders`, { pairs: tunnels, active: tunnels, rate: Infinity, chunk: 16384, readKiB: 10, seconds: 30 })
    process.exit(0)
  }
  if (process.env.ONLY) {
    const [tunnels, kib, chunk, seconds] = process.env.ONLY.split(',').map(Number)
    await scenario(`${tunnels} tunnels ${kib} KiB/s each, ${chunk} B messages`, { pairs: tunnels, active: tunnels, rate: kib << 10, chunk, seconds })
    process.exit(0)
  }
  await scenario('20 tunnels idle, 70 s (2 pings)', { pairs: 20, seconds: 70 })
  await scenario('1 tunnel 16 KiB/s, 256 B messages', { pairs: 1, active: 1, rate: 16 << 10, chunk: 256 })
  await scenario('1 tunnel 64 KiB/s, 256 B messages', { pairs: 1, active: 1, rate: 64 << 10, chunk: 256 })
  await scenario('1 tunnel 64 KiB/s, 1 KiB messages', { pairs: 1, active: 1, rate: 64 << 10, chunk: 1024 })
  await scenario('1 tunnel 128 KiB/s, 1 KiB messages', { pairs: 1, active: 1, rate: 128 << 10, chunk: 1024 })
  await scenario('1 tunnel 256 KiB/s, 1 KiB messages', { pairs: 1, active: 1, rate: 256 << 10, chunk: 1024 })
  await scenario('1 tunnel 512 KiB/s, 1 KiB messages', { pairs: 1, active: 1, rate: 512 << 10, chunk: 1024 })
  await scenario('1 tunnel 1 MiB/s, 16 KiB messages', { pairs: 1, active: 1, rate: 1 << 20, chunk: 16384 })
  await scenario('1 tunnel unbounded, 16 KiB messages', { pairs: 1, active: 1, rate: Infinity, chunk: 16384 })
  await scenario('4 tunnels 64 KiB/s each, 1 KiB messages', { pairs: 4, active: 4, rate: 64 << 10, chunk: 1024 })
  await scenario('slow reader: paced phone behind unbounded', { pairs: 1, active: 1, rate: Infinity, chunk: 16384, readKiB: 10, seconds: 30 })
  await scenario('tunnel opens (both legs, TLS + upgrade)', { opens: true, seconds: 10 })
  process.exit(0)
}
