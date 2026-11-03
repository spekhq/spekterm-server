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
export const MIGRATIONS: readonly string[] = [
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
  // 2: handoffs (handoff-delivery, design D4). Title and body are cleared once delivered or expired.
  `
  CREATE TABLE handoffs (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    sender_member_id TEXT NOT NULL REFERENCES members (id),
    sender_device_id TEXT NOT NULL REFERENCES devices (id),
    recipient_member_id TEXT NOT NULL REFERENCES members (id),
    enc TEXT NOT NULL,
    title TEXT,
    body TEXT,
    request_hash BLOB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    delivered_at INTEGER,
    delivered_device_id TEXT REFERENCES devices (id),
    ended_at INTEGER,
    UNIQUE (sender_member_id, client_id)
  );
  CREATE INDEX handoffs_recipient_pending ON handoffs (recipient_member_id, status, created_at);
  CREATE INDEX handoffs_sender_created ON handoffs (sender_member_id, created_at);
  `,
  // 3: statuses back to the sender (handoff-return, design D7). SQLite cannot change a CHECK in place, so the
  // table is rebuilt; every column, reference and constraint of schema 2 is kept. Existing rows are numbered in
  // the order they were sent, and the counter starts after them.
  `
  CREATE TABLE handoffs_new (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    sender_member_id TEXT NOT NULL REFERENCES members (id),
    sender_device_id TEXT NOT NULL REFERENCES devices (id),
    recipient_member_id TEXT NOT NULL REFERENCES members (id),
    enc TEXT NOT NULL,
    title TEXT,
    body TEXT,
    request_hash BLOB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'taken', 'declined', 'done', 'expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    delivered_at INTEGER,
    delivered_device_id TEXT REFERENCES devices (id),
    ended_at INTEGER,
    seq INTEGER NOT NULL UNIQUE,
    changed_at INTEGER NOT NULL,
    report_enc TEXT,
    report_text TEXT,
    report_at INTEGER,
    report_hash BLOB,
    report_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE (sender_member_id, client_id)
  );
  INSERT INTO handoffs_new (id, client_id, sender_member_id, sender_device_id, recipient_member_id, enc, title, body,
      request_hash, status, created_at, expires_at, delivered_at, delivered_device_id, ended_at, seq, changed_at)
    SELECT id, client_id, sender_member_id, sender_device_id, recipient_member_id, enc, title, body,
      request_hash, status, created_at, expires_at, delivered_at, delivered_device_id, ended_at,
      row_number() OVER (ORDER BY created_at, id), coalesce(ended_at, created_at)
    FROM handoffs;
  DROP TABLE handoffs;
  ALTER TABLE handoffs_new RENAME TO handoffs;
  CREATE INDEX handoffs_recipient_pending ON handoffs (recipient_member_id, status, created_at);
  CREATE INDEX handoffs_sender_created ON handoffs (sender_member_id, created_at);
  CREATE INDEX handoffs_sender_seq ON handoffs (sender_member_id, seq);
  CREATE INDEX handoffs_changed ON handoffs (changed_at);
  CREATE INDEX handoffs_report_at ON handoffs (report_at) WHERE report_text IS NOT NULL;

  CREATE TABLE counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  INSERT INTO counters (name, value) VALUES ('handoff_seq', (SELECT count(*) FROM handoffs));
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
    // Freed pages and cells are zeroed, so cleared handoff text does not linger in the file (design D7).
    db.exec('PRAGMA secure_delete = ON')
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

export const DEFAULT_BUSY_TIMEOUT_MS = BUSY_TIMEOUT_MS

/**
 * Copies the write-ahead log into the database and truncates it to zero bytes, without waiting for other
 * processes: with another process in a transaction it returns false at once instead of blocking for the busy
 * timeout (design D7).
 */
export function truncateWal(db: Database): boolean {
  db.exec('PRAGMA busy_timeout = 0')
  try {
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }
    return row.busy === 0
  } catch {
    return false
  } finally {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  }
}

/**
 * The next handoff sequence number (handoff-return, design D4). Call only inside a write transaction: values are
 * then taken in the order transactions commit, across both processes, so a reader that sees a number has seen
 * every lower one.
 */
export function nextSeq(db: Database): number {
  const row = db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'handoff_seq' RETURNING value").get() as {
    value: number
  }
  return row.value
}

/** The highest handoff sequence number given so far. */
export function latestSeq(db: Database): number {
  return (db.prepare("SELECT value FROM counters WHERE name = 'handoff_seq'").get() as { value: number }).value
}

/** Runs `fn` inside one deferred read transaction, so every statement in it sees the same snapshot. */
export function readTransaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN')
  try {
    return fn()
  } finally {
    if (db.isTransaction) db.exec('COMMIT')
  }
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
