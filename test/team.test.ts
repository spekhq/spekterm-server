import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { ProtocolError } from '../src/errors.ts'
import {
  NotFoundError,
  authenticate,
  base32,
  cancelInvite,
  createInvite,
  getTeamName,
  identityOf,
  inspectInvite,
  join as joinTeam,
  leave,
  listInvites,
  listMembers,
  newId,
  removeMember,
  renameDevice,
  renameMember,
  revokeDevice,
  revokedAmong,
  setTeamName,
  validateHandle,
  validateName,
} from '../src/team.ts'
import { manualClock, tempDatabase } from './helpers/db.ts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function rejects(fn: () => unknown, code: string, field?: string): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof ProtocolError, `expected ProtocolError, got ${String(e)}`)
    assert.equal(e.code, code)
    if (field !== undefined) assert.equal(e.detail?.field, field)
    return true
  })
}

function newMember(db: Parameters<typeof joinTeam>[0], now: () => number, handle = 'sam', deviceName = 'home desktop') {
  const invite = createInvite(db, {}, now)
  return joinTeam(db, { code: invite.code, handle, displayName: handle.toUpperCase(), deviceName }, now)
}

// --- names and handles --------------------------------------------------------------------------------

test('names are trimmed', () => {
  assert.equal(validateName('  work laptop ', 'deviceName'), 'work laptop')
})

test('names are 1 to 64 code points', () => {
  assert.equal(validateName('x'.repeat(64), 'displayName'), 'x'.repeat(64))
  rejects(() => validateName('x'.repeat(65), 'displayName'), 'BAD_PARAMS', 'displayName')
  rejects(() => validateName('   ', 'displayName'), 'BAD_PARAMS', 'displayName')
  const emoji = '😀'.repeat(64)
  assert.equal(emoji.length, 128)
  assert.equal(validateName(emoji, 'displayName'), emoji)
})

test('names refuse control characters and line separators', () => {
  for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 'a\u2028b', 'a\u2029b', 'a\u007fb']) {
    rejects(() => validateName(bad, 'deviceName'), 'BAD_PARAMS', 'deviceName')
  }
})

test('names must be strings', () => {
  rejects(() => validateName(5, 'name'), 'BAD_PARAMS', 'name')
})

test('handles are lowercased and must match the pattern', () => {
  assert.equal(validateHandle('Sam'), 'sam')
  assert.equal(validateHandle('a'.repeat(32)), 'a'.repeat(32))
  for (const bad of ['sam_w', '-sam', '', 'a'.repeat(33), 'sam w', 'säm', 7]) {
    rejects(() => validateHandle(bad), 'BAD_PARAMS', 'handle')
  }
})

test('ids never start with "-"', () => {
  for (let i = 0; i < 1000; i++) assert.match(newId('d'), /^d_[0-9a-f]{32}$/)
})

test('base32 follows RFC 4648', () => {
  assert.equal(base32(Buffer.from('foobar')), 'MZXW6YTBOI')
  assert.equal(base32(new Uint8Array(16)).length, 26)
})

// --- team -----------------------------------------------------------------------------------------------

test('team name defaults to "Team" and can be set', (t) => {
  const { db } = tempDatabase(t)
  assert.equal(getTeamName(db), 'Team')
  setTeamName(db, ' Billing crew ')
  assert.equal(getTeamName(db), 'Billing crew')
  rejects(() => setTeamName(db, ''), 'BAD_PARAMS', 'name')
})

// --- invites --------------------------------------------------------------------------------------------

test('invite lifetime defaults to 7 days and is bounded', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  const invite = createInvite(db, {}, now)
  assert.equal(invite.expiresAt - invite.createdAt, 7 * DAY)
  assert.match(invite.code, /^[A-Z2-7]{26}$/)
  assert.equal(createInvite(db, { lifetimeMs: HOUR }, now).expiresAt - now(), HOUR)
  assert.equal(createInvite(db, { lifetimeMs: 30 * DAY }, now).expiresAt - now(), 30 * DAY)
  assert.throws(() => createInvite(db, { lifetimeMs: HOUR - 1 }, now), RangeError)
  assert.throws(() => createInvite(db, { lifetimeMs: 30 * DAY + 1 }, now), RangeError)
})

test('device invite for an unknown member is refused', (t) => {
  const { db } = tempDatabase(t)
  assert.throws(() => createInvite(db, { memberHandle: 'nobody' }, manualClock().now), NotFoundError)
})

test('an invite is redeemable once', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  const invite = createInvite(db, {}, now)
  joinTeam(db, { code: invite.code, handle: 'sam', displayName: 'Sam', deviceName: 'desk' }, now)
  rejects(() => joinTeam(db, { code: invite.code, handle: 'alex', displayName: 'Alex', deviceName: 'desk' }, now), 'INVITE_USED')
})

test('an expired invite is refused', (t) => {
  const { db } = tempDatabase(t)
  const clock = manualClock()
  const invite = createInvite(db, { lifetimeMs: DAY }, clock.now)
  clock.advance(25 * HOUR)
  rejects(() => joinTeam(db, { code: invite.code, handle: 'sam', displayName: 'Sam', deviceName: 'desk' }, clock.now), 'INVITE_EXPIRED')
  rejects(() => inspectInvite(db, invite.code, clock.now), 'INVITE_EXPIRED')
})

test('an unknown or cancelled code is refused', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  rejects(() => joinTeam(db, { code: 'AAAAAAAAAAAAAAAAAAAAAAAAAA', handle: 'sam', displayName: 'Sam', deviceName: 'd' }, now), 'INVITE_UNKNOWN')
  const invite = createInvite(db, {}, now)
  cancelInvite(db, invite.id, now)
  rejects(() => joinTeam(db, { code: invite.code, handle: 'sam', displayName: 'Sam', deviceName: 'd' }, now), 'INVITE_UNKNOWN')
  assert.throws(() => cancelInvite(db, invite.id, now), NotFoundError)
})

test('codes are compared case-insensitively', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  const invite = createInvite(db, {}, now)
  const result = joinTeam(db, { code: invite.code.toLowerCase(), handle: 'sam', displayName: 'Sam', deviceName: 'd' }, now)
  assert.equal(result.member.handle, 'sam')
})

test('a failed join does not consume the invite', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  newMember(db, now, 'sam')
  const invite = createInvite(db, {}, now)
  rejects(() => joinTeam(db, { code: invite.code, handle: 'Sam', displayName: 'Sam', deviceName: 'd' }, now), 'HANDLE_TAKEN')
  rejects(() => joinTeam(db, { code: invite.code, handle: 'alex', displayName: 'x'.repeat(65), deviceName: 'd' }, now), 'BAD_PARAMS', 'displayName')
  rejects(() => joinTeam(db, { code: invite.code, handle: 'sam_w', displayName: 'Sam', deviceName: 'd' }, now), 'BAD_PARAMS', 'handle')
  rejects(() => joinTeam(db, { code: invite.code, handle: 'alex', displayName: 'Alex', deviceName: '' }, now), 'BAD_PARAMS', 'deviceName')
  const ok = joinTeam(db, { code: invite.code, handle: 'alex', displayName: 'Alex', deviceName: 'd' }, now)
  assert.equal(ok.member.handle, 'alex')
})

test('inspect describes the invite without redeeming it', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  setTeamName(db, 'Billing crew')
  const memberInvite = createInvite(db, {}, now)
  assert.deepEqual(inspectInvite(db, memberInvite.code, now), {
    kind: 'member',
    team: { name: 'Billing crew' },
    expiresAt: memberInvite.expiresAt,
  })
  newMember(db, now, 'sam')
  const deviceInvite = createInvite(db, { memberHandle: 'sam' }, now)
  assert.deepEqual(inspectInvite(db, deviceInvite.code, now), {
    kind: 'device',
    team: { name: 'Billing crew' },
    expiresAt: deviceInvite.expiresAt,
    member: { handle: 'sam', displayName: 'SAM' },
  })
  assert.equal(listInvites(db, now).length, 2)
})

test('invite list shows only redeemable invites and never codes', (t) => {
  const { db } = tempDatabase(t)
  const clock = manualClock()
  const used = createInvite(db, {}, clock.now)
  joinTeam(db, { code: used.code, handle: 'sam', displayName: 'Sam', deviceName: 'd' }, clock.now)
  const cancelled = createInvite(db, {}, clock.now)
  cancelInvite(db, cancelled.id, clock.now)
  createInvite(db, { lifetimeMs: HOUR }, clock.now)
  const live = createInvite(db, { memberHandle: 'sam' }, clock.now)
  clock.advance(2 * HOUR)
  const listed = listInvites(db, clock.now)
  assert.deepEqual(listed.map((i) => i.id), [live.id])
  assert.equal(listed[0]!.kind, 'device')
  assert.equal(listed[0]!.memberHandle, 'sam')
  assert.ok(!JSON.stringify(listed).includes(live.code))
})

// --- joining --------------------------------------------------------------------------------------------

test('first join creates the member and the device', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  const invite = createInvite(db, {}, now)
  const result = joinTeam(db, { code: invite.code, handle: 'sam', displayName: 'Sam', deviceName: '  home desktop ' }, now)
  assert.equal(result.member.handle, 'sam')
  assert.equal(result.member.displayName, 'Sam')
  assert.equal(result.member.deviceCount, 1)
  assert.equal(result.device.name, 'home desktop')
  assert.equal(result.team.name, 'Team')
  assert.match(result.member.id, /^m_/)
  assert.match(result.device.id, /^d_/)
  assert.match(result.deviceSecret, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(listMembers(db).map((m) => [m.handle, m.devices.map((d) => d.name)]), [['sam', ['home desktop']]])
})

test('a device invite adds a device and ignores handle and display name', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  const first = newMember(db, now, 'sam')
  const invite = createInvite(db, { memberHandle: 'sam' }, now)
  const second = joinTeam(db, { code: invite.code, handle: 'other', displayName: 'Other', deviceName: 'work laptop' }, now)
  assert.equal(second.member.id, first.member.id)
  assert.equal(second.member.handle, 'sam')
  assert.equal(second.member.deviceCount, 2)
  authenticate(db, first.device.id, first.deviceSecret, now)
})

test('a device invite for a removed member is refused', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  newMember(db, now, 'sam')
  const invite = createInvite(db, { memberHandle: 'sam' }, now)
  removeMember(db, 'sam', now)
  rejects(() => joinTeam(db, { code: invite.code, deviceName: 'laptop' }, now), 'INVITE_UNKNOWN')
})

test('a removed member frees the handle; the new member gets a new id', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  const old = newMember(db, now, 'sam')
  removeMember(db, 'sam', now)
  const again = newMember(db, now, 'sam')
  assert.notEqual(again.member.id, old.member.id)
})

test('removal racing a redemption: the join answers INVITE_UNKNOWN, never an exception', async (t) => {
  const { db, path } = tempDatabase(t)
  const { now } = manualClock()
  newMember(db, now, 'sam')
  const invite = createInvite(db, { memberHandle: 'sam' }, now)
  // A second process takes the write lock, removes sam, and commits 500 ms later.
  const script = `
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(${JSON.stringify(path)})
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('BEGIN IMMEDIATE')
    db.prepare("UPDATE members SET removed_at = 1 WHERE handle = 'sam'").run()
    db.prepare("UPDATE devices SET revoked_at = 1").run()
    db.prepare("UPDATE invites SET cancelled_at = 1 WHERE member_id IS NOT NULL AND used_at IS NULL").run()
    process.stdout.write('locked\\n')
    setTimeout(() => { db.exec('COMMIT'); db.close() }, 500)
  `
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await once(child.stdout!, 'data')
  rejects(() => joinTeam(db, { code: invite.code, deviceName: 'laptop' }, now), 'INVITE_UNKNOWN')
  await once(child, 'exit')
})

test('redemption before removal: the removal revokes the new device', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  newMember(db, now, 'sam')
  const invite = createInvite(db, { memberHandle: 'sam' }, now)
  const joined = joinTeam(db, { code: invite.code, deviceName: 'laptop' }, now)
  const revoked = removeMember(db, 'sam', now)
  assert.ok(revoked.includes(joined.device.id))
  rejects(() => authenticate(db, joined.device.id, joined.deviceSecret, now), 'AUTH_FAILED')
})

// --- credentials ----------------------------------------------------------------------------------------

test('authenticate checks the secret and records last seen', (t) => {
  const { db } = tempDatabase(t)
  const clock = manualClock()
  const joined = newMember(db, clock.now)
  clock.advance(HOUR)
  const identity = authenticate(db, joined.device.id, joined.deviceSecret, clock.now)
  assert.equal(identity.member.handle, 'sam')
  assert.equal(listMembers(db)[0]!.devices[0]!.lastSeenAt, clock.now())
  rejects(() => authenticate(db, joined.device.id, joined.deviceSecret + 'x', clock.now), 'AUTH_FAILED')
  rejects(() => authenticate(db, 'd_unknown', joined.deviceSecret, clock.now), 'AUTH_FAILED')
  rejects(() => authenticate(db, joined.device.id, undefined, clock.now), 'AUTH_FAILED')
  rejects(() => authenticate(db, 5, joined.deviceSecret, clock.now), 'AUTH_FAILED')
})

test('neither the secret nor the invite code is stored in clear', (t) => {
  const { db, dir } = tempDatabase(t)
  const { now } = manualClock()
  const invite = createInvite(db, {}, now)
  const joined = joinTeam(db, { code: invite.code, handle: 'sam', displayName: 'Sam', deviceName: 'd' }, now)
  db.close()
  for (const file of readdirSync(dir)) {
    const bytes = readFileSync(join(dir, file))
    for (const secret of [joined.deviceSecret, invite.code, invite.code.toLowerCase()]) {
      assert.equal(bytes.includes(Buffer.from(secret)), false, `${file} contains a secret`)
    }
  }
})

test('revoking one device leaves the other working', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  const first = newMember(db, now, 'sam')
  const second = joinTeam(db, { code: createInvite(db, { memberHandle: 'sam' }, now).code, deviceName: 'laptop' }, now)
  revokeDevice(db, first.device.id, now)
  rejects(() => authenticate(db, first.device.id, first.deviceSecret, now), 'AUTH_FAILED')
  assert.equal(authenticate(db, second.device.id, second.deviceSecret, now).member.deviceCount, 1)
  assert.deepEqual(revokedAmong(db, [first.device.id, second.device.id]), [first.device.id])
  assert.throws(() => revokeDevice(db, first.device.id, now), NotFoundError)
})

test('the admin revoking the last device keeps the member', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  const joined = newMember(db, now, 'sam')
  revokeDevice(db, joined.device.id, now)
  assert.deepEqual(listMembers(db).map((m) => [m.handle, m.devices.length]), [['sam', 0]])
  createInvite(db, { memberHandle: 'sam' }, now)
})

// --- renaming, leaving, removing ------------------------------------------------------------------------

test('renaming a device and a member', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  const joined = newMember(db, now, 'sam')
  assert.deepEqual(renameDevice(db, joined.device.id, ' work laptop '), { id: joined.device.id, name: 'work laptop' })
  rejects(() => renameDevice(db, joined.device.id, 5), 'BAD_PARAMS', 'name')
  const renamed = renameMember(db, 'sam', 'Sam W.')
  assert.equal(renamed.id, joined.member.id)
  assert.equal(identityOf(db, joined.device.id)!.member.displayName, 'Sam W.')
  assert.equal(listMembers(db)[0]!.devices[0]!.name, 'work laptop')
  assert.throws(() => renameMember(db, 'nobody', 'X'), NotFoundError)
})

test('leaving from one of two devices keeps the member', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  const first = newMember(db, now, 'sam')
  const second = joinTeam(db, { code: createInvite(db, { memberHandle: 'sam' }, now).code, deviceName: 'laptop' }, now)
  assert.deepEqual(leave(db, first.device.id, now), { memberRemoved: false })
  rejects(() => authenticate(db, first.device.id, first.deviceSecret, now), 'AUTH_FAILED')
  authenticate(db, second.device.id, second.deviceSecret, now)
  assert.equal(listMembers(db).length, 1)
})

test('leaving from the last device removes the member and cancels device invites', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  const joined = newMember(db, now, 'sam')
  const pending = createInvite(db, { memberHandle: 'sam' }, now)
  assert.deepEqual(leave(db, joined.device.id, now), { memberRemoved: true })
  assert.equal(listMembers(db).length, 0)
  rejects(() => joinTeam(db, { code: pending.code, deviceName: 'new laptop' }, now), 'INVITE_UNKNOWN')
  rejects(() => leave(db, joined.device.id, now), 'AUTH_FAILED')
})

test('removing a member revokes devices, cancels invites and hides the member', (t) => {
  const { db } = tempDatabase(t)
  const { now } = manualClock()
  const first = newMember(db, now, 'sam')
  const second = joinTeam(db, { code: createInvite(db, { memberHandle: 'sam' }, now).code, deviceName: 'laptop' }, now)
  const pending = createInvite(db, { memberHandle: 'sam' }, now)
  const revoked = removeMember(db, 'sam', now)
  assert.deepEqual(revoked.sort(), [first.device.id, second.device.id].sort())
  for (const d of [first, second]) rejects(() => authenticate(db, d.device.id, d.deviceSecret, now), 'AUTH_FAILED')
  rejects(() => joinTeam(db, { code: pending.code, deviceName: 'x' }, now), 'INVITE_UNKNOWN')
  assert.equal(listMembers(db).length, 0)
  const kept = db.prepare('SELECT handle, removed_at FROM members').all() as Array<{ handle: string; removed_at: number }>
  assert.equal(kept.length, 1)
  assert.equal(kept[0]!.removed_at, now())
  assert.throws(() => removeMember(db, 'sam', now), NotFoundError)
})
