/**
 * Relay grants (`phone-relay` spec, design D2): a desktop device asks for one grant per paired phone; the phone
 * uses it to ask for tunnels to that desktop. Only a hash of each grant's secret is stored. Grants are deleted
 * with their device (`team.ts`).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { type Database, writeTransaction } from './db.ts'
import { ProtocolError, badParams } from './errors.ts'
import { type Clock, newId, sha256, validateName } from './team.ts'

/** The most grants one device may hold (spekterm's listener allows 16 authenticated connections). */
export const MAX_GRANTS_PER_DEVICE = 16

const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

export interface Grant {
  id: string
  name: string
  createdAt: number
  lastUsedAt?: number
}

interface GrantRow {
  id: string
  name: string
  created_at: number
  last_used_at: number | null
}

function toGrant(row: GrantRow): Grant {
  const grant: Grant = { id: row.id, name: row.name, createdAt: row.created_at }
  if (row.last_used_at !== null) grant.lastUsedAt = row.last_used_at
  return grant
}

/** Creates a grant for the device; the secret is returned only here. */
export function createGrant(db: Database, deviceId: string, name: unknown, now: Clock): { grant: Grant; secret: string } {
  const validName = validateName(name, 'name')
  return writeTransaction(db, () => {
    const { n } = db.prepare('SELECT count(*) AS n FROM relay_grants WHERE device_id = ?').get(deviceId) as { n: number }
    if (n >= MAX_GRANTS_PER_DEVICE) {
      throw new ProtocolError('TOO_MANY_GRANTS', `a device may hold at most ${MAX_GRANTS_PER_DEVICE} grants`, {
        limit: MAX_GRANTS_PER_DEVICE,
      })
    }
    const id = newId('g')
    const secret = randomBytes(32).toString('base64url')
    const at = now()
    db.prepare('INSERT INTO relay_grants (id, device_id, name, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      deviceId,
      validName,
      sha256(secret),
      at,
    )
    return { grant: { id, name: validName, createdAt: at }, secret }
  })
}

/** The device's grants, oldest first. */
export function listGrants(db: Database, deviceId: string): Grant[] {
  return (
    db
      .prepare('SELECT id, name, created_at, last_used_at FROM relay_grants WHERE device_id = ? ORDER BY created_at, id')
      .all(deviceId) as unknown as GrantRow[]
  ).map(toGrant)
}

/** Every device's grants, for the admin command line. */
export function grantsByDevice(db: Database): Map<string, Grant[]> {
  const rows = db
    .prepare('SELECT id, device_id, name, created_at, last_used_at FROM relay_grants ORDER BY created_at, id')
    .all() as unknown as Array<GrantRow & { device_id: string }>
  const byDevice = new Map<string, Grant[]>()
  for (const row of rows) {
    const list = byDevice.get(row.device_id) ?? []
    list.push(toGrant(row))
    byDevice.set(row.device_id, list)
  }
  return byDevice
}

/** Deletes one of the device's grants; false when the device holds no such grant. */
export function revokeGrant(db: Database, deviceId: string, id: unknown): boolean {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw badParams('id', 'id must be a grant id')
  return writeTransaction(db, () => {
    return db.prepare('DELETE FROM relay_grants WHERE id = ? AND device_id = ?').run(id, deviceId).changes > 0
  })
}

/**
 * Checks a grant and its secret in constant time; returns the grant's desktop device. The device must still be
 * on the team (its grants are deleted with it, so this holds unless the database was edited by hand).
 */
export function verifyGrant(db: Database, grantId: string, secret: string): { grantId: string; deviceId: string } {
  const row = db
    .prepare(
      `SELECT g.device_id, g.secret_hash FROM relay_grants g
       JOIN devices d ON d.id = g.device_id JOIN members m ON m.id = d.member_id
       WHERE g.id = ? AND d.revoked_at IS NULL AND m.removed_at IS NULL`,
    )
    .get(grantId) as { device_id: string; secret_hash: Uint8Array } | undefined
  const presented = sha256(secret)
  const stored = row === undefined ? Buffer.alloc(presented.length) : Buffer.from(row.secret_hash)
  const matches = stored.length === presented.length && timingSafeEqual(stored, presented)
  if (row === undefined || !matches) throw new ProtocolError('GRANT_INVALID', 'this grant is not valid')
  return { grantId, deviceId: row.device_id }
}

/** Whether the grant still exists (it is deleted when revoked or with its device). */
export function grantExists(db: Database, grantId: string): boolean {
  return db.prepare('SELECT 1 AS ok FROM relay_grants WHERE id = ?').get(grantId) !== undefined
}

export function touchGrant(db: Database, grantId: string, now: Clock): void {
  writeTransaction(db, () => db.prepare('UPDATE relay_grants SET last_used_at = ? WHERE id = ?').run(now(), grantId))
}

/** Validates an id parameter of the relay operations. */
export function validateId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw badParams(field, `${field} must be an id`)
  return value
}
