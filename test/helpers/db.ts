import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Database, DATABASE_FILE, openDataDir } from '../../src/db.ts'

export function tempDir(t: { after: (fn: () => void) => void }, prefix = 'spekterm-server-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function tempDatabase(t: { after: (fn: () => void) => void }): { db: Database; dir: string; path: string } {
  const dir = tempDir(t)
  const db = openDataDir(dir)
  t.after(() => {
    if (db.isOpen) db.close()
  })
  return { db, dir, path: join(dir, DATABASE_FILE) }
}

/** A clock the test moves by hand. */
export function manualClock(start = Date.UTC(2026, 10, 3)): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms) => (current += ms) }
}
