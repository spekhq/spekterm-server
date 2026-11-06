/** Flow control, the throughput cap and the liveness of tunnel legs (`phone-relay` spec). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { openTunnel, relaySetup } from './helpers/relay.ts'
import { FLOW_HIGH } from '../src/tunnels.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Sends `size`-byte messages on `ws` as fast as its own buffer allows until `stop()` returns true. */
function flood(ws: WebSocket, size: number): { stop: () => void; sent: () => number } {
  const message = Buffer.alloc(size, 7)
  let sent = 0
  let running = true
  const pump = () => {
    if (!running || ws.readyState !== WebSocket.OPEN) return
    while (ws.bufferedAmount < 512 * 1024) {
      ws.send(message)
      sent += size
    }
    setTimeout(pump, 5)
  }
  pump()
  return { stop: () => (running = false), sent: () => sent }
}

test('slow phone: the server holds about one window for it, and every byte arrives once it reads', async (t) => {
  const s = await relaySetup(t, { relay: { enabled: true, kibPerSecond: 0 } })
  const { phone, desktop } = await openTunnel(s)
  phone.keep = false
  phone.ws.pause()
  const sender = flood(desktop.ws, 16 * 1024)
  await wait(1500)
  sender.stop()
  const [first] = s.server.relay.stats()
  await wait(500)
  const [stats] = s.server.relay.stats()
  // The window plus what one socket read had already brought in when reading stopped (`ws` still delivers
  // frames it has read), whatever the kernel took; and it no longer grows.
  assert.ok(stats!.phoneBuffered <= FLOW_HIGH + 64 * 1024 + 16 * 1024, `phone leg holds ${stats!.phoneBuffered} bytes`)
  assert.equal(stats!.toPhone, first!.toPhone)
  phone.ws.resume()
  await phone.until(sender.sent(), 20_000)
  assert.equal(phone.received, sender.sent())
})

test('slow phone outlasts the keepalive', async (t) => {
  const s = await relaySetup(t, {
    relay: { enabled: true, kibPerSecond: 0 },
    relayTimings: { pingIntervalMs: 100, stallMs: 600 },
  })
  const { phone, desktop } = await openTunnel(s)
  phone.keep = false
  // The phone reads in short bursts: paused most of the time, as a slow link would look.
  let reading = true
  const pacer = setInterval(() => {
    if (reading) phone.ws.pause()
    else phone.ws.resume()
    reading = !reading
  }, 150)
  const sender = flood(desktop.ws, 16 * 1024)
  const samples: number[] = []
  for (let i = 0; i < 20; i++) {
    await wait(150)
    samples.push(phone.received)
  }
  clearInterval(pacer)
  sender.stop()
  assert.equal(phone.ws.readyState, WebSocket.OPEN)
  assert.equal(desktop.ws.readyState, WebSocket.OPEN)
  // Data kept arriving over the whole run, not only at its start.
  assert.ok(samples[19]! > samples[10]!, `received ${samples.join(', ')}`)
})

test('stuck phone: both legs end once the phone has made no progress for the stall time', async (t) => {
  const s = await relaySetup(t, {
    relay: { enabled: true, kibPerSecond: 0 },
    relayTimings: { pingIntervalMs: 100, stallMs: 600 },
  })
  const { phone, desktop } = await openTunnel(s)
  phone.keep = false
  phone.ws.pause()
  // Stop the phone's socket entirely, so it neither reads data nor answers pings.
  ;(phone.ws as unknown as { _socket: { pause(): void } })._socket.pause()
  const sender = flood(desktop.ws, 16 * 1024)
  const started = Date.now()
  const closed = await desktop.closed
  sender.stop()
  assert.equal(closed.code, 4010)
  assert.ok(Date.now() - started >= 600, `closed after ${Date.now() - started} ms`)
  assert.equal(s.server.relay.size, 0)
})

test('throughput cap: 64 KiB/s in 1 KiB messages for 10 seconds', async (t) => {
  const s = await relaySetup(t, { relay: { enabled: true, kibPerSecond: 64 } })
  const { phone, desktop } = await openTunnel(s)
  phone.keep = false
  const sender = flood(desktop.ws, 1024)
  await wait(10_000)
  const received = phone.received
  sender.stop()
  assert.ok(received >= 576 * 1024, `received ${received / 1024} KiB`)
  assert.ok(received <= 800 * 1024, `received ${received / 1024} KiB`)
})

test('a message larger than the bucket passes whole, and the next waits for the overdraft', async (t) => {
  const s = await relaySetup(t, { relay: { enabled: true, kibPerSecond: 16 } })
  const { phone, desktop } = await openTunnel(s)
  desktop.ws.send(Buffer.alloc(200 * 1024, 1))
  await phone.until(200 * 1024)
  const firstAt = Date.now()
  desktop.ws.send(Buffer.alloc(1024, 2))
  await phone.until(201 * 1024, 20_000)
  const waited = Date.now() - firstAt
  assert.equal(phone.messages[0]!.length, 200 * 1024)
  assert.ok(waited >= 9_000 && waited <= 15_000, `waited ${waited} ms`)
})
