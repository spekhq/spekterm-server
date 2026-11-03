/** The server keeps handoff text only while it waits (`handoff-delivery`, design D7). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HANDOFF_LIFETIME_MS } from '../src/handoffs.ts'
import { TestClient } from './helpers/client.ts'
import { runAdmin } from './helpers/process.ts'
import { seedMember, testServer } from './helpers/server.ts'

const P = { protocol: [1] }

function secretText() {
  return { title: `title-${randomBytes(12).toString('hex')}`, body: randomBytes(10_000).toString('hex') }
}

/** Pieces of the text that would survive in a file if any copy of it did. */
function pieces(text: { title: string; body: string }): string[] {
  const out = [text.title]
  for (let i = 0; i + 48 <= text.body.length; i += 997) out.push(text.body.slice(i, i + 48))
  return out
}

function found(dir: string, text: { title: string; body: string }): string[] {
  const hits: string[] = []
  for (const file of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, file))
    for (const piece of pieces(text)) if (bytes.includes(Buffer.from(piece))) hits.push(`${file}: ${piece.slice(0, 12)}…`)
  }
  return hits
}

async function setup(t: Parameters<typeof testServer>[0], options: Parameters<typeof testServer>[1] = {}) {
  const s = await testServer(t, { maintenanceIntervalMs: 3_600_000, ...options })
  const alex = seedMember(s.db, 'alex')
  const sam = seedMember(s.db, 'sam')
  const sender = await TestClient.open(s.url)
  await sender.request('hello', { ...P, deviceId: alex.device.id, deviceSecret: alex.deviceSecret })
  t.after(() => sender.close())
  const text = secretText()
  const sent = await sender.request('handoff.send', { clientId: 'c1', to: 'sam', payload: { enc: 'none', ...text } })
  assert.equal(sent.ok, true, JSON.stringify(sent.e))
  assert.ok(found(s.dir, text).length > 0, 'the text is stored while pending')
  return { ...s, sam, text, id: sent.r.handoff.id as string }
}

test('after delivery and one maintenance step, the text is in no file of the data directory', async (t) => {
  const { url, dir, server, sam, text, id } = await setup(t)
  const desktop = await TestClient.open(url)
  await desktop.request('hello', { ...P, deviceId: sam.device.id, deviceSecret: sam.deviceSecret })
  await desktop.nextEvent('handoff.incoming')
  assert.deepEqual((await desktop.request('handoff.received', { id })).r, {})
  assert.equal(server.maintain().truncated, true)
  assert.deepEqual(found(dir, text), [])
  desktop.close()
})

test('after expiry by time and one maintenance step, the text is in no file', async (t) => {
  let clock = Date.now()
  const { dir, server, text, id } = await setup(t, { now: () => clock })
  clock += HANDOFF_LIFETIME_MS
  const { expired, truncated } = server.maintain()
  assert.deepEqual([expired, truncated], [[id], true])
  assert.deepEqual(found(dir, text), [])
})

test('after the admin command line removed the recipient and one maintenance step, the text is in no file', async (t) => {
  const { dir, server, text } = await setup(t)
  assert.equal((await runAdmin(['member', 'remove', 'sam'], { DATA_DIR: dir })).status, 0)
  assert.equal(server.maintain().truncated, true)
  assert.deepEqual(found(dir, text), [])
})

test('a reader in another connection does not block the step; the next step after it ends clears the text', async (t) => {
  const { url, dir, dbPath, server, sam, text, id } = await setup(t)
  const reader = new DatabaseSync(dbPath)
  reader.exec('BEGIN')
  reader.prepare('SELECT count(*) FROM members').get()
  const desktop = await TestClient.open(url)
  await desktop.request('hello', { ...P, deviceId: sam.device.id, deviceSecret: sam.deviceSecret })
  await desktop.nextEvent('handoff.incoming')
  await desktop.request('handoff.received', { id })
  const started = performance.now()
  const busy = server.maintain()
  assert.ok(performance.now() - started < 100, `blocked for ${performance.now() - started} ms`)
  assert.equal(busy.truncated, false)
  reader.exec('COMMIT')
  reader.close()
  assert.equal(server.maintain().truncated, true)
  assert.deepEqual(found(dir, text), [])
  desktop.close()
})

test('shutting down with a short maintenance interval is clean', async (t) => {
  const logs: string[] = []
  const s = await testServer(t, { maintenanceIntervalMs: 5, log: (m) => logs.push(m) })
  await new Promise((resolve) => setTimeout(resolve, 30))
  await s.server.close()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(logs.filter((l) => /failed/.test(l)).length, 0)
})

// --- reasons, reports and records (handoff-return, design D8) -------------------------------------------

const DAY = 24 * 60 * 60 * 1000

/** Pieces of a text that would survive in a file if any copy of it did. */
function textFound(dir: string, text: string): string[] {
  const hits: string[] = []
  const parts: string[] = []
  for (let i = 0; i + 40 <= text.length; i += 397) parts.push(text.slice(i, i + 40))
  for (const file of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, file))
    for (const part of parts) if (bytes.includes(Buffer.from(part))) hits.push(`${file}: ${part.slice(0, 12)}…`)
  }
  return hits
}

async function reporting(t: Parameters<typeof testServer>[0]) {
  let clock = Date.now()
  const s = await testServer(t, { now: () => clock, maintenanceIntervalMs: 3_600_000 })
  const alex = seedMember(s.db, 'alex')
  const sam = seedMember(s.db, 'sam')
  const sender = await TestClient.open(s.url)
  await sender.request('hello', { ...P, deviceId: alex.device.id, deviceSecret: alex.deviceSecret })
  const desktop = await TestClient.open(s.url)
  await desktop.request('hello', { ...P, deviceId: sam.device.id, deviceSecret: sam.deviceSecret })
  t.after(() => {
    sender.close()
    desktop.close()
  })
  let n = 0
  const delivered = async () => {
    const sent = await sender.request('handoff.send', { clientId: `r${++n}`, to: 'sam', payload: { enc: 'none', title: 't', body: 'b' } })
    const id = sent.r.handoff.id as string
    await desktop.nextEvent('handoff.incoming')
    assert.deepEqual((await desktop.request('handoff.received', { id })).r, {})
    return id
  }
  const update = (id: string, status: string, text?: string) =>
    desktop.request('handoff.update', { id, status, ...(text === undefined ? {} : { payload: { enc: 'none', text } }) })
  const records = async () => (await sender.request('handoff.sync', { after: 0 })).r.records as Array<{ id: string; payload?: unknown }>
  return { ...s, advance: (ms: number) => (clock += ms), delivered, update, records }
}

test('a report and a reason are in no file one maintenance step after their 30 days; the records stay', async (t) => {
  const { dir, server, advance, delivered, update, records } = await reporting(t)
  const report = randomBytes(2000).toString('hex') // 4,000 code units
  const reason = randomBytes(250).toString('hex') // 500 code units
  const done = await delivered()
  assert.equal((await update(done, 'done', report)).ok, true)
  const declined = await delivered()
  assert.equal((await update(declined, 'declined', reason)).ok, true)
  assert.ok(textFound(dir, report).length > 0, 'the report is stored')
  advance(30 * DAY - 1)
  assert.deepEqual(server.maintain().reportsDeleted, [])
  advance(1)
  const step = server.maintain()
  assert.deepEqual([step.reportsDeleted.sort(), step.truncated], [[done, declined].sort(), true])
  assert.deepEqual(textFound(dir, report), [])
  assert.deepEqual(textFound(dir, reason), [])
  const kept = await records()
  assert.deepEqual(kept.map((r) => [r.id, r.payload]).sort(), [[done, undefined], [declined, undefined]].sort())
})

test('a newer report restarts its 30 days', async (t) => {
  const { server, advance, delivered, update, records } = await reporting(t)
  const id = await delivered()
  await update(id, 'done', 'first')
  advance(20 * DAY)
  await update(id, 'done', 'second')
  advance(10 * DAY)
  assert.deepEqual(server.maintain().reportsDeleted, [])
  assert.deepEqual((await records())[0]!.payload, { enc: 'none', text: 'second' })
  advance(20 * DAY)
  assert.deepEqual(server.maintain().reportsDeleted, [id])
})

test('records go 90 days after their last change, done or still taken; a late report is HANDOFF_UNKNOWN', async (t) => {
  const { server, advance, delivered, update, records } = await reporting(t)
  const done = await delivered()
  await update(done, 'done', 'finished')
  const taken = await delivered()
  await update(taken, 'taken')
  advance(90 * DAY - 1)
  assert.deepEqual(server.maintain().recordsDeleted, [])
  advance(1)
  assert.deepEqual(server.maintain().recordsDeleted.sort(), [done, taken].sort())
  assert.deepEqual(await records(), [])
  assert.equal((await update(taken, 'done', 'late')).e?.code, 'HANDOFF_UNKNOWN')
})
