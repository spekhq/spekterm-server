/**
 * Membership rules (`team-membership` spec): the team, members, devices, invites and credentials.
 *
 * Every function that writes runs in `writeTransaction` (BEGIN IMMEDIATE) and makes the reads it decides on
 * inside it, because the admin command line writes the same database from another process.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { type Database, writeTransaction } from './db.ts'
import { ProtocolError, badParams } from './errors.ts'

export type Clock = () => number

export const MAX_NAME_LENGTH = 64
export const DEFAULT_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
export const MIN_INVITE_LIFETIME_MS = 60 * 60 * 1000
export const MAX_INVITE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
const FORBIDDEN_IN_NAMES = /[\p{Cc}\u2028\u2029]/u

/** An error for the admin command line: the named member, device or invite does not exist. */
export class NotFoundError extends Error {}

export interface MemberInfo {
  id: string
  handle: string
  displayName: string
}

export interface DeviceInfo {
  id: string
  name: string
}

/** What a device is told about itself when it joins or authenticates. */
export interface Identity {
  team: { name: string }
  member: MemberInfo & { deviceCount: number }
  device: DeviceInfo
}

export type InviteKind = 'member' | 'device'

// ---------------------------------------------------------------------------------------------------------
// Names and handles

/** Validates a team, display or device name: trimmed, 1–64 code points, no control characters. */
export function validateName(value: unknown, field: string): string {
  if (typeof value !== 'string') throw badParams(field, `${field} must be a string`)
  const trimmed = value.trim()
  const length = [...trimmed].length
  if (length === 0) throw badParams(field, `${field} must not be empty`)
  if (length > MAX_NAME_LENGTH) throw badParams(field, `${field} must be at most ${MAX_NAME_LENGTH} characters`)
  if (FORBIDDEN_IN_NAMES.test(trimmed)) throw badParams(field, `${field} must not contain control characters or line breaks`)
  return trimmed
}

export function validateHandle(value: unknown): string {
  if (typeof value !== 'string') throw badParams('handle', 'handle must be a string')
  const handle = value.toLowerCase()
  if (!HANDLE_PATTERN.test(handle)) {
    throw badParams('handle', 'handle must be 1–32 of a–z, 0–9 and -, starting with a letter or digit')
  }
  return handle
}

// ---------------------------------------------------------------------------------------------------------
// Secrets and ids

/** `m_`, `d_` or `i_` and 32 lower-case hex digits: never starts with `-` (design D11). */
export function newId(kind: 'm' | 'd' | 'i'): string {
  return `${kind}_${randomBytes(16).toString('hex')}`
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 without padding. */
export function base32(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  return out
}

/** 16 random bytes as 26 base32 characters. */
export function newInviteCode(): string {
  return base32(randomBytes(16))
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest()
}

function hashInviteCode(code: string): Buffer {
  return sha256(code.trim().toUpperCase())
}

// ---------------------------------------------------------------------------------------------------------
// Team

export function getTeamName(db: Database): string {
  return (db.prepare('SELECT name FROM team WHERE id = 1').get() as { name: string }).name
}

export function setTeamName(db: Database, value: unknown): string {
  const name = validateName(value, 'name')
  writeTransaction(db, () => db.prepare('UPDATE team SET name = ? WHERE id = 1').run(name))
  return name
}

// ---------------------------------------------------------------------------------------------------------
// Members and devices (reads)

interface MemberRow {
  id: string
  handle: string
  display_name: string
}

function activeMemberByHandle(db: Database, handle: string): MemberRow | undefined {
  return db
    .prepare('SELECT id, handle, display_name FROM members WHERE handle = ? AND removed_at IS NULL')
    .get(handle.toLowerCase()) as MemberRow | undefined
}

function activeMemberById(db: Database, id: string): MemberRow | undefined {
  return db
    .prepare('SELECT id, handle, display_name FROM members WHERE id = ? AND removed_at IS NULL')
    .get(id) as MemberRow | undefined
}

function deviceCount(db: Database, memberId: string): number {
  const row = db
    .prepare('SELECT count(*) AS n FROM devices WHERE member_id = ? AND revoked_at IS NULL')
    .get(memberId) as { n: number }
  return row.n
}

/** The identity of a device that is not revoked, or undefined. */
export function identityOf(db: Database, deviceId: string): Identity | undefined {
  const row = db
    .prepare(
      `SELECT d.id AS device_id, d.name AS device_name, m.id AS member_id, m.handle, m.display_name
       FROM devices d JOIN members m ON m.id = d.member_id
       WHERE d.id = ? AND d.revoked_at IS NULL AND m.removed_at IS NULL`,
    )
    .get(deviceId) as
    | { device_id: string; device_name: string; member_id: string; handle: string; display_name: string }
    | undefined
  if (row === undefined) return undefined
  return {
    team: { name: getTeamName(db) },
    member: {
      id: row.member_id,
      handle: row.handle,
      displayName: row.display_name,
      deviceCount: deviceCount(db, row.member_id),
    },
    device: { id: row.device_id, name: row.device_name },
  }
}

export interface MemberListing extends MemberInfo {
  createdAt: number
  devices: Array<DeviceInfo & { createdAt: number; lastSeenAt: number | null }>
}

export function listMembers(db: Database): MemberListing[] {
  const members = db
    .prepare('SELECT id, handle, display_name, created_at FROM members WHERE removed_at IS NULL ORDER BY handle')
    .all() as unknown as Array<MemberRow & { created_at: number }>
  const devices = db.prepare(
    `SELECT id, name, created_at, last_seen_at FROM devices
     WHERE member_id = ? AND revoked_at IS NULL ORDER BY created_at`,
  )
  return members.map((m) => ({
    id: m.id,
    handle: m.handle,
    displayName: m.display_name,
    createdAt: m.created_at,
    devices: (devices.all(m.id) as Array<{ id: string; name: string; created_at: number; last_seen_at: number | null }>).map(
      (d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at }),
    ),
  }))
}

/** Of the given device ids, those that are now revoked (or unknown). Used by the revocation sweep. */
export function revokedAmong(db: Database, deviceIds: readonly string[]): string[] {
  if (deviceIds.length === 0) return []
  const placeholders = deviceIds.map(() => '?').join(',')
  const live = new Set(
    (
      db
        .prepare(`SELECT id FROM devices WHERE revoked_at IS NULL AND id IN (${placeholders})`)
        .all(...deviceIds) as Array<{ id: string }>
    ).map((r) => r.id),
  )
  return deviceIds.filter((id) => !live.has(id))
}

// ---------------------------------------------------------------------------------------------------------
// Invites

export interface CreatedInvite {
  id: string
  code: string
  kind: InviteKind
  member: MemberInfo | null
  createdAt: number
  expiresAt: number
}

export function createInvite(
  db: Database,
  options: { memberHandle?: string; lifetimeMs?: number },
  now: Clock,
): CreatedInvite {
  const lifetimeMs = options.lifetimeMs ?? DEFAULT_INVITE_LIFETIME_MS
  if (!Number.isFinite(lifetimeMs) || lifetimeMs < MIN_INVITE_LIFETIME_MS || lifetimeMs > MAX_INVITE_LIFETIME_MS) {
    throw new RangeError('an invite lives between 1 hour and 30 days')
  }
  return writeTransaction(db, () => {
    let member: MemberRow | undefined
    if (options.memberHandle !== undefined) {
      member = activeMemberByHandle(db, options.memberHandle)
      if (member === undefined) throw new NotFoundError(`no member "${options.memberHandle}"`)
    }
    const id = newId('i')
    const code = newInviteCode()
    const createdAt = now()
    const expiresAt = createdAt + lifetimeMs
    db.prepare(
      'INSERT INTO invites (id, code_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, hashInviteCode(code), member?.id ?? null, createdAt, expiresAt)
    return {
      id,
      code,
      kind: member === undefined ? 'member' : 'device',
      member: member === undefined ? null : { id: member.id, handle: member.handle, displayName: member.display_name },
      createdAt,
      expiresAt,
    }
  })
}

interface InviteRow {
  id: string
  member_id: string | null
  expires_at: number
  used_at: number | null
  cancelled_at: number | null
}

/** The invite for a code if it is redeemable now; otherwise the matching protocol error. */
function redeemableInvite(db: Database, code: unknown, now: Clock): { invite: InviteRow; member: MemberRow | undefined } {
  if (typeof code !== 'string') throw badParams('code', 'code must be a string')
  const invite = db
    .prepare('SELECT id, member_id, expires_at, used_at, cancelled_at FROM invites WHERE code_hash = ?')
    .get(hashInviteCode(code)) as InviteRow | undefined
  if (invite === undefined || invite.cancelled_at !== null) {
    throw new ProtocolError('INVITE_UNKNOWN', 'this invite does not exist or was cancelled')
  }
  if (invite.used_at !== null) throw new ProtocolError('INVITE_USED', 'this invite was already used')
  if (now() >= invite.expires_at) throw new ProtocolError('INVITE_EXPIRED', 'this invite has expired')
  let member: MemberRow | undefined
  if (invite.member_id !== null) {
    member = activeMemberById(db, invite.member_id)
    if (member === undefined) throw new ProtocolError('INVITE_UNKNOWN', 'the member this invite was for was removed')
  }
  return { invite, member }
}

export interface InviteInspection {
  kind: InviteKind
  team: { name: string }
  expiresAt: number
  member?: { handle: string; displayName: string }
}

export function inspectInvite(db: Database, code: unknown, now: Clock): InviteInspection {
  const { invite, member } = redeemableInvite(db, code, now)
  const result: InviteInspection = {
    kind: member === undefined ? 'member' : 'device',
    team: { name: getTeamName(db) },
    expiresAt: invite.expires_at,
  }
  if (member !== undefined) result.member = { handle: member.handle, displayName: member.display_name }
  return result
}

export interface InviteListing {
  id: string
  kind: InviteKind
  memberHandle: string | null
  createdAt: number
  expiresAt: number
}

/** Invites that are still redeemable; never their codes. */
export function listInvites(db: Database, now: Clock): InviteListing[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.member_id, m.handle, i.created_at, i.expires_at FROM invites i
       LEFT JOIN members m ON m.id = i.member_id
       WHERE i.used_at IS NULL AND i.cancelled_at IS NULL AND i.expires_at > ?
         AND (i.member_id IS NULL OR m.removed_at IS NULL)
       ORDER BY i.created_at`,
    )
    .all(now()) as Array<{ id: string; member_id: string | null; handle: string | null; created_at: number; expires_at: number }>
  return rows.map((r) => ({
    id: r.id,
    kind: r.member_id === null ? 'member' : 'device',
    memberHandle: r.handle,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }))
}

export function cancelInvite(db: Database, id: string, now: Clock): void {
  writeTransaction(db, () => {
    const result = db
      .prepare('UPDATE invites SET cancelled_at = ? WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL')
      .run(now(), id)
    if (result.changes === 0) throw new NotFoundError(`no unused invite "${id}"`)
  })
}

// ---------------------------------------------------------------------------------------------------------
// Joining and authenticating

export interface JoinParams {
  code: unknown
  deviceName: unknown
  handle?: unknown
  displayName?: unknown
}

export interface JoinResult extends Identity {
  deviceSecret: string
}

export function join(db: Database, params: JoinParams, now: Clock): JoinResult {
  return writeTransaction(db, () => {
    const { invite, member: existing } = redeemableInvite(db, params.code, now)
    const deviceName = validateName(params.deviceName, 'deviceName')
    const at = now()
    let memberId: string
    if (existing === undefined) {
      const handle = validateHandle(params.handle)
      const displayName = validateName(params.displayName, 'displayName')
      if (activeMemberByHandle(db, handle) !== undefined) {
        throw new ProtocolError('HANDLE_TAKEN', `the handle "${handle}" is taken`)
      }
      memberId = newId('m')
      db.prepare('INSERT INTO members (id, handle, display_name, created_at) VALUES (?, ?, ?, ?)').run(
        memberId,
        handle,
        displayName,
        at,
      )
    } else {
      memberId = existing.id
    }
    const deviceId = newId('d')
    const deviceSecret = randomBytes(32).toString('base64url')
    db.prepare(
      'INSERT INTO devices (id, member_id, name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(deviceId, memberId, deviceName, sha256(deviceSecret), at, at)
    db.prepare('UPDATE invites SET used_at = ?, used_by_device_id = ? WHERE id = ?').run(at, deviceId, invite.id)
    return { ...identityOf(db, deviceId)!, deviceSecret }
  })
}

/** Checks a device credential and records the device as seen. */
export function authenticate(db: Database, deviceId: unknown, deviceSecret: unknown, now: Clock): Identity {
  const failed = () => new ProtocolError('AUTH_FAILED', 'this device is not on the team')
  if (typeof deviceId !== 'string' || typeof deviceSecret !== 'string') throw failed()
  const row = db
    .prepare(
      `SELECT d.secret_hash FROM devices d JOIN members m ON m.id = d.member_id
       WHERE d.id = ? AND d.revoked_at IS NULL AND m.removed_at IS NULL`,
    )
    .get(deviceId) as { secret_hash: Uint8Array } | undefined
  const presented = sha256(deviceSecret)
  const stored = row === undefined ? Buffer.alloc(presented.length) : Buffer.from(row.secret_hash)
  const matches = stored.length === presented.length && timingSafeEqual(stored, presented)
  if (row === undefined || !matches) throw failed()
  touchDevice(db, deviceId, now)
  return identityOf(db, deviceId)!
}

export function touchDevice(db: Database, deviceId: string, now: Clock): void {
  writeTransaction(db, () => db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now(), deviceId))
}

// ---------------------------------------------------------------------------------------------------------
// Changing and ending access

export function renameDevice(db: Database, deviceId: string, value: unknown): DeviceInfo {
  const name = validateName(value, 'name')
  return writeTransaction(db, () => {
    const result = db.prepare('UPDATE devices SET name = ? WHERE id = ? AND revoked_at IS NULL').run(name, deviceId)
    if (result.changes === 0) throw new ProtocolError('AUTH_FAILED', 'this device is not on the team')
    return { id: deviceId, name }
  })
}

export function renameMember(db: Database, handle: string, value: unknown): MemberInfo {
  const displayName = validateName(value, 'displayName')
  return writeTransaction(db, () => {
    const member = activeMemberByHandle(db, handle)
    if (member === undefined) throw new NotFoundError(`no member "${handle}"`)
    db.prepare('UPDATE members SET display_name = ? WHERE id = ?').run(displayName, member.id)
    return { id: member.id, handle: member.handle, displayName }
  })
}

/** Inside a transaction: marks the member removed, revokes their devices, cancels their device invites. */
function removeMemberById(db: Database, memberId: string, at: number): void {
  db.prepare('UPDATE members SET removed_at = ? WHERE id = ?').run(at, memberId)
  db.prepare('UPDATE devices SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(at, memberId)
  db.prepare(
    'UPDATE invites SET cancelled_at = ? WHERE member_id = ? AND used_at IS NULL AND cancelled_at IS NULL',
  ).run(at, memberId)
}

/** Removes a member; returns the ids of the devices that were revoked by it. */
export function removeMember(db: Database, handle: string, now: Clock): string[] {
  return writeTransaction(db, () => {
    const member = activeMemberByHandle(db, handle)
    if (member === undefined) throw new NotFoundError(`no member "${handle}"`)
    const devices = (
      db.prepare('SELECT id FROM devices WHERE member_id = ? AND revoked_at IS NULL').all(member.id) as Array<{ id: string }>
    ).map((d) => d.id)
    removeMemberById(db, member.id, now())
    return devices
  })
}

/** The admin revokes one device. The member stays, even with no device left. */
export function revokeDevice(db: Database, deviceId: string, now: Clock): void {
  writeTransaction(db, () => {
    const result = db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), deviceId)
    if (result.changes === 0) throw new NotFoundError(`no device "${deviceId}" on the team`)
  })
}

/** A device leaves. When it was its member's last device, the member is removed too. */
export function leave(db: Database, deviceId: string, now: Clock): { memberRemoved: boolean } {
  return writeTransaction(db, () => {
    const row = db
      .prepare('SELECT member_id FROM devices WHERE id = ? AND revoked_at IS NULL')
      .get(deviceId) as { member_id: string } | undefined
    if (row === undefined) throw new ProtocolError('AUTH_FAILED', 'this device is not on the team')
    const at = now()
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(at, deviceId)
    if (deviceCount(db, row.member_id) > 0) return { memberRemoved: false }
    removeMemberById(db, row.member_id, at)
    return { memberRemoved: true }
  })
}
