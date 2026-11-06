import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import {
  DATABASE_FILE,
  MIGRATIONS,
  SCHEMA_VERSION,
  SchemaTooNewError,
  latestSeq,
  nextSeq,
  openDataDir,
  openDatabaseFile,
  writeTransaction,
} from '../src/db.ts'

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'spekterm-server-db-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('fresh data directory is created and migrated', (t) => {
  const dir = join(tempDir(t), 'nested', 'data')
  const db = openDataDir(dir)
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
  assert.equal(version.user_version, SCHEMA_VERSION)
  const team = db.prepare('SELECT name FROM team').get() as { name: string }
  assert.equal(team.name, 'Team')
  const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
  assert.equal(mode.journal_mode, 'wal')
  db.close()
})

test('reopening keeps data and does not migrate again', (t) => {
  const dir = tempDir(t)
  const first = openDataDir(dir)
  first.prepare("UPDATE team SET name = 'Billing crew'").run()
  first.close()
  const second = openDataDir(dir)
  assert.equal((second.prepare('SELECT name FROM team').get() as { name: string }).name, 'Billing crew')
  assert.equal((second.prepare('SELECT count(*) AS n FROM team').get() as { n: number }).n, 1)
  second.close()
})

test('two handles opening the same fresh file migrate once', (t) => {
  const path = join(tempDir(t), DATABASE_FILE)
  const a = openDatabaseFile(path)
  const b = openDatabaseFile(path)
  assert.equal((b.prepare('SELECT count(*) AS n FROM team').get() as { n: number }).n, 1)
  a.close()
  b.close()
})

test('two processes opening the same fresh file at once both succeed', async (t) => {
  const path = join(tempDir(t), DATABASE_FILE)
  const script = `import { openDatabaseFile } from ${JSON.stringify(new URL('../src/db.ts', import.meta.url).href)};
    openDatabaseFile(${JSON.stringify(path)}).close();`
  const run = () =>
    new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { stdio: 'inherit' })
      child.on('exit', (code) => resolve(code ?? -1))
    })
  const codes = await Promise.all([run(), run(), run()])
  assert.deepEqual(codes, [0, 0, 0])
  const db = openDatabaseFile(path)
  assert.equal((db.prepare('SELECT count(*) AS n FROM team').get() as { n: number }).n, 1)
  db.close()
})

for (const mode of ['delete', 'wal'] as const) {
  test(`a newer schema is refused and the file is left byte-for-byte unchanged (${mode} journal)`, (t) => {
    const path = join(tempDir(t), DATABASE_FILE)
    const raw = new DatabaseSync(path)
    raw.prepare(`PRAGMA journal_mode = ${mode}`).get()
    raw.exec('CREATE TABLE future (x); PRAGMA user_version = 99')
    if (mode === 'wal') raw.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    raw.close()
    const before = readFileSync(path)
    assert.throws(() => openDatabaseFile(path), (e: unknown) => e instanceof SchemaTooNewError && e.found === 99)
    assert.ok(readFileSync(path).equals(before))
  })
}

test('writeTransaction commits, and rolls back on throw', (t) => {
  const db = openDataDir(tempDir(t))
  writeTransaction(db, () => db.prepare("UPDATE team SET name = 'A'").run())
  assert.throws(() =>
    writeTransaction(db, () => {
      db.prepare("UPDATE team SET name = 'B'").run()
      throw new Error('boom')
    }),
  )
  assert.equal((db.prepare('SELECT name FROM team').get() as { name: string }).name, 'A')
  assert.equal(db.isTransaction, false)
  db.close()
})

test('a version-1 database is upgraded in place, keeping its members', (t) => {
  const path = join(tempDir(t), DATABASE_FILE)
  const raw = new DatabaseSync(path)
  raw.exec(MIGRATIONS[0]!)
  raw.exec("PRAGMA user_version = 1; INSERT INTO members (id, handle, display_name, created_at) VALUES ('m_1', 'sam', 'Sam', 1)")
  raw.close()
  const db = openDatabaseFile(path)
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4)
  assert.equal(SCHEMA_VERSION, 4)
  assert.equal((db.prepare('SELECT handle FROM members').get() as { handle: string }).handle, 'sam')
  assert.equal((db.prepare('SELECT count(*) AS n FROM handoffs').get() as { n: number }).n, 0)
  db.close()
})

test('secure_delete is on', (t) => {
  const db = openDataDir(tempDir(t))
  assert.equal((db.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete, 1)
  db.close()
})

test('a version-2 database with handoffs is upgraded in place, numbered in sending order', (t) => {
  const path = join(tempDir(t), DATABASE_FILE)
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  raw.exec(MIGRATIONS[0]!)
  raw.exec(MIGRATIONS[1]!)
  raw.exec(`PRAGMA user_version = 2;
    INSERT INTO members (id, handle, display_name, created_at) VALUES ('m_a', 'alex', 'Alex', 1), ('m_s', 'sam', 'Sam', 1);
    INSERT INTO devices (id, member_id, name, secret_hash, created_at) VALUES ('d_a', 'm_a', 'desk', x'00', 1), ('d_s', 'm_s', 'desk', x'00', 1);
    INSERT INTO handoffs (id, client_id, sender_member_id, sender_device_id, recipient_member_id, enc, title, body,
        request_hash, status, created_at, expires_at, delivered_at, delivered_device_id, ended_at) VALUES
      ('h_3', 'c3', 'm_a', 'd_a', 'm_s', 'none', 'Waiting title', 'Waiting body', x'01', 'pending', 300, 9000, NULL, NULL, NULL),
      ('h_1', 'c1', 'm_a', 'd_a', 'm_s', 'none', NULL, NULL, x'02', 'delivered', 100, 9000, 150, 'd_s', 150),
      ('h_2', 'c2', 'm_a', 'd_a', 'm_s', 'none', NULL, NULL, x'03', 'expired', 200, 250, NULL, NULL, 250);`)
  raw.close()
  const db = openDatabaseFile(path)
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4)
  const rows = db.prepare('SELECT id, status, title, body, seq, changed_at, report_count FROM handoffs ORDER BY seq').all()
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { id: 'h_1', status: 'delivered', title: null, body: null, seq: 1, changed_at: 150, report_count: 0 },
      { id: 'h_2', status: 'expired', title: null, body: null, seq: 2, changed_at: 250, report_count: 0 },
      { id: 'h_3', status: 'pending', title: 'Waiting title', body: 'Waiting body', seq: 3, changed_at: 300, report_count: 0 },
    ],
  )
  assert.equal((db.prepare("SELECT value FROM counters WHERE name = 'handoff_seq'").get() as { value: number }).value, 3)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  db.close()
})

test('schema 3 keeps every reference and index of the handoffs table', (t) => {
  const db = openDataDir(tempDir(t))
  const fks = (db.prepare('PRAGMA foreign_key_list(handoffs)').all() as Array<{ from: string; table: string; to: string }>)
    .map((f) => `${f.from}->${f.table}.${f.to}`)
    .sort()
  assert.deepEqual(fks, [
    'delivered_device_id->devices.id',
    'recipient_member_id->members.id',
    'sender_device_id->devices.id',
    'sender_member_id->members.id',
  ])
  const indexes = (db.prepare('PRAGMA index_list(handoffs)').all() as Array<{ name: string; unique: number; partial: number }>)
    .map((i) => {
      const columns = (db.prepare(`PRAGMA index_xinfo(${JSON.stringify(i.name)})`).all() as Array<{ name: string | null; key: number }>)
        .filter((c) => c.key === 1)
        .map((c) => c.name)
      return `${i.unique ? 'unique ' : ''}${i.partial ? 'partial ' : ''}(${columns.join(', ')})`
    })
    .sort()
  assert.deepEqual(indexes, [
    '(changed_at)',
    '(recipient_member_id, status, created_at)',
    '(sender_member_id, created_at)',
    '(sender_member_id, seq)',
    'partial (report_at)',
    'unique (id)',
    'unique (sender_member_id, client_id)',
    'unique (seq)',
  ])
  db.close()
})

test('nextSeq counts up from the counter', (t) => {
  const db = openDataDir(tempDir(t))
  assert.equal(latestSeq(db), 0)
  assert.deepEqual([writeTransaction(db, () => nextSeq(db)), writeTransaction(db, () => nextSeq(db))], [1, 2])
  assert.equal(latestSeq(db), 2)
  db.close()
})

test('a version-3 database with handoffs is upgraded in place to relay grants', (t) => {
  const path = join(tempDir(t), DATABASE_FILE)
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  for (const migration of MIGRATIONS.slice(0, 3)) raw.exec(migration)
  raw.exec(`PRAGMA user_version = 3;
    INSERT INTO members (id, handle, display_name, created_at) VALUES ('m_a', 'alex', 'Alex', 1), ('m_s', 'sam', 'Sam', 1);
    INSERT INTO devices (id, member_id, name, secret_hash, created_at) VALUES ('d_a', 'm_a', 'desk', x'00', 1), ('d_s', 'm_s', 'desk', x'00', 1);
    INSERT INTO handoffs (id, client_id, sender_member_id, sender_device_id, recipient_member_id, enc, title, body,
        request_hash, status, created_at, expires_at, seq, changed_at) VALUES
      ('h_1', 'c1', 'm_a', 'd_a', 'm_s', 'none', 'Title', 'Body', x'01', 'pending', 100, 9000, 1, 100);
    UPDATE counters SET value = 1 WHERE name = 'handoff_seq';`)
  raw.close()
  const db = openDatabaseFile(path)
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4)
  assert.deepEqual(
    { ...(db.prepare('SELECT id, status, title, body, seq FROM handoffs').get() as object) },
    { id: 'h_1', status: 'pending', title: 'Title', body: 'Body', seq: 1 },
  )
  assert.equal((db.prepare('SELECT count(*) AS n FROM relay_grants').get() as { n: number }).n, 0)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  db.close()
})

test('schema 4: relay_grants columns, reference and index', (t) => {
  const db = openDataDir(tempDir(t))
  const columns = (db.prepare('PRAGMA table_info(relay_grants)').all() as Array<{ name: string; type: string; notnull: number; pk: number }>)
    .map((c) => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}${c.pk ? ' PK' : ''}`)
  assert.deepEqual(columns, [
    'id TEXT PK',
    'device_id TEXT NOT NULL',
    'name TEXT NOT NULL',
    'secret_hash BLOB NOT NULL',
    'created_at INTEGER NOT NULL',
    'last_used_at INTEGER',
  ])
  const fks = (db.prepare('PRAGMA foreign_key_list(relay_grants)').all() as Array<{ from: string; table: string; to: string }>)
    .map((f) => `${f.from}->${f.table}.${f.to}`)
  assert.deepEqual(fks, ['device_id->devices.id'])
  const indexes = (db.prepare('PRAGMA index_list(relay_grants)').all() as Array<{ name: string; unique: number; origin: string }>)
    .filter((i) => i.origin === 'c')
    .map((i) => {
      const cols = (db.prepare(`PRAGMA index_info(${i.name})`).all() as Array<{ name: string }>).map((c) => c.name)
      return `${i.name}(${cols.join(',')})${i.unique ? ' unique' : ''}`
    })
  assert.deepEqual(indexes, ['relay_grants_device(device_id)'])
  db.close()
})
