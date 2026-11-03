/**
 * The only module that imports `node:sqlite` (design D2, D11).
 *
 * Two processes write the database: the server and the admin command line. Every transaction that writes
 * starts with `BEGIN IMMEDIATE` and makes the reads it decides on inside it. A deferred transaction that read
 * before the other process committed fails at its first write with SQLITE_BUSY_SNAPSHOT at once, without
 * waiting for the busy timeout.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type Database = DatabaseSync

export const DATABASE_FILE = 'spekterm-server.db'

const BUSY_TIMEOUT_MS = 5000

/** Ordered schema migrations; index + 1 is the schema version each one produces. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE team (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL
  );
  INSERT INTO team (id, name) VALUES (1, 'Team');

  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    removed_at INTEGER
  );
  CREATE UNIQUE INDEX members_handle_active ON members (handle) WHERE removed_at IS NULL;

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL REFERENCES members (id),
    name TEXT NOT NULL,
    secret_hash BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX devices_member ON devices (member_id);

  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    code_hash BLOB NOT NULL UNIQUE,
    member_id TEXT REFERENCES members (id),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by_device_id TEXT REFERENCES devices (id),
    cancelled_at INTEGER
  );
  `,
]

export const SCHEMA_VERSION = MIGRATIONS.length

export class SchemaTooNewError extends Error {
  readonly found: number
  constructor(found: number) {
    super(
      `the database has schema version ${found}, newer than this server knows (${SCHEMA_VERSION}); ` +
        'it was written by a newer spekterm-server and has been left unchanged',
    )
    this.found = found
  }
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

/**
 * Opens (creating if needed) and migrates a database file. Refuses, without changing the file, a database
 * whose schema is newer than this code knows.
 */
export function openDatabaseFile(path: string): Database {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  try {
    // The busy timeout first: it changes nothing on disk, and without it reading the version or switching to
    // WAL while another process holds a lock fails at once.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    // Read before changing anything: setting WAL first would rewrite a newer database's header.
    const found = userVersion(db)
    if (found > SCHEMA_VERSION) throw new SchemaTooNewError(found)
    if (path !== ':memory:') db.prepare('PRAGMA journal_mode = WAL').get()
    migrate(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** Opens the database inside a data directory, creating the directory if needed. */
export function openDataDir(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true })
  return openDatabaseFile(join(dataDir, DATABASE_FILE))
}

function migrate(db: DatabaseSync): void {
  writeTransaction(db, () => {
    // Re-read inside the transaction: the server and the CLI may open a fresh directory at the same time.
    const current = userVersion(db)
    if (current > SCHEMA_VERSION) throw new SchemaTooNewError(current)
    for (let version = current; version < SCHEMA_VERSION; version++) {
      db.exec(MIGRATIONS[version]!)
    }
    if (current !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })
}

/** Runs `fn` inside `BEGIN IMMEDIATE … COMMIT`, rolling back if it throws. */
export function writeTransaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}
