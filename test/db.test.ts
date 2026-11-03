import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { DATABASE_FILE, MIGRATIONS, SCHEMA_VERSION, SchemaTooNewError, openDataDir, openDatabaseFile, writeTransaction } from '../src/db.ts'

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
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2)
  assert.equal(SCHEMA_VERSION, 2)
  assert.equal((db.prepare('SELECT handle FROM members').get() as { handle: string }).handle, 'sam')
  assert.equal((db.prepare('SELECT count(*) AS n FROM handoffs').get() as { n: number }).n, 0)
  db.close()
})

test('secure_delete is on', (t) => {
  const db = openDataDir(tempDir(t))
  assert.equal((db.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete, 1)
  db.close()
})
