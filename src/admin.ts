/**
 * `spekterm-server-admin` (`admin-cli` spec): the team's only management interface in v1. It works on the
 * data directory directly and may run while the server runs.
 */
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ConfigError, loadConfig } from './config.ts'
import { grantsByDevice } from './relay.ts'
import { type Database, SchemaTooNewError, openDataDir } from './db.ts'
import { ProtocolError } from './errors.ts'
import {
  NotFoundError,
  cancelInvite,
  createInvite,
  getTeamName,
  listInvites,
  listMembers,
  removeMember,
  renameMember,
  revokeDevice,
  setTeamName,
} from './team.ts'
import { loadTls } from './tls.ts'

const USAGE = `usage: spekterm-server-admin <command>

  team name [<name>]                     show or set the team name
  invite create [--member <handle>] [--expires <12h|7d>] [--pin]
                                         create an invite (for a new member, or a new device of <handle>)
  invite list                            list invites that can still be redeemed
  invite cancel <invite-id>              cancel an invite
  member list                            list members and their devices
  member rename <handle> <display name>  change a member's display name
  member remove <handle>                 remove a member and revoke all of their devices
  device revoke <device-id>              revoke one device

Configuration comes from the environment: DATA_DIR, PUBLIC_URL, TLS_CERT, TLS_KEY.`

class UsageError extends Error {}

export interface Io {
  out(line: string): void
  err(line: string): void
}

const HOUR = 60 * 60 * 1000

export function parseDuration(text: string): number {
  const match = /^(\d+)([hd])$/.exec(text)
  if (match === null) throw new UsageError(`--expires takes a number of hours or days, such as 12h or 7d; got "${text}"`)
  return Number(match[1]) * (match[2] === 'h' ? HOUR : 24 * HOUR)
}

function iso(ms: number | null): string {
  return ms === null ? 'never' : new Date(ms).toISOString()
}

export function inviteLink(publicUrl: string, code: string, fingerprint: string | null): string {
  const params = new URLSearchParams({ v: '1', s: publicUrl, c: code })
  if (fingerprint !== null) params.set('fp', fingerprint)
  return `spekterm://join?${params.toString()}`
}

function withDatabase<T>(env: Record<string, string | undefined>, fn: (db: Database) => T): T {
  const db = openDataDir(loadConfig(env).dataDir)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function positional(args: string[], count: number, names: string): string[] {
  if (args.length !== count) throw new UsageError(`expected ${names}`)
  return args
}

export function run(argv: string[], env: Record<string, string | undefined>, io: Io, now = Date.now): number {
  try {
    const [group, command, ...rest] = argv
    const key = `${group ?? ''} ${command ?? ''}`.trim()
    switch (key) {
      case 'team name': {
        if (rest.length === 0) {
          io.out(withDatabase(env, getTeamName))
        } else {
          const [name] = positional(rest, 1, 'one team name (quote it if it has spaces)')
          io.out(`team name set to "${withDatabase(env, (db) => setTeamName(db, name))}"`)
        }
        return 0
      }
      case 'invite create': {
        const { values, positionals } = parseArgs({
          args: rest,
          options: { member: { type: 'string' }, expires: { type: 'string' }, pin: { type: 'boolean' } },
          allowPositionals: true,
        })
        if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"`)
        const config = loadConfig(env)
        if (config.publicUrl === null) {
          throw new ConfigError('PUBLIC_URL', 'must be set to the wss:// address clients use, so the invite can tell them where to connect')
        }
        let fingerprint: string | null = null
        if (config.tls !== null) {
          const tls = loadTls(config.tls)
          if (tls.selfSigned || values.pin === true) fingerprint = tls.fingerprint
        } else if (values.pin === true) {
          throw new UsageError('--pin needs the server to serve TLS itself (TLS_CERT and TLS_KEY)')
        }
        const lifetimeMs = values.expires === undefined ? undefined : parseDuration(values.expires)
        const options: { memberHandle?: string; lifetimeMs?: number } = {}
        if (values.member !== undefined) options.memberHandle = values.member
        if (lifetimeMs !== undefined) options.lifetimeMs = lifetimeMs
        const invite = withDatabase(env, (db) => createInvite(db, options, now))
        const what = invite.member === null ? 'a new member' : `a new device of ${invite.member.handle}`
        io.out(inviteLink(config.publicUrl, invite.code, fingerprint))
        io.out(`invite ${invite.id} for ${what}; single use; expires ${iso(invite.expiresAt)}`)
        return 0
      }
      case 'invite list': {
        positional(rest, 0, 'no arguments')
        const invites = withDatabase(env, (db) => listInvites(db, now))
        if (invites.length === 0) io.out('no open invites')
        for (const i of invites) {
          const what = i.kind === 'member' ? 'new member' : `device of ${i.memberHandle}`
          io.out(`${i.id}  ${what}  created ${iso(i.createdAt)}  expires ${iso(i.expiresAt)}`)
        }
        return 0
      }
      case 'invite cancel': {
        const [id] = positional(rest, 1, 'an invite id')
        withDatabase(env, (db) => cancelInvite(db, id!, now))
        io.out(`invite ${id} cancelled`)
        return 0
      }
      case 'member list': {
        positional(rest, 0, 'no arguments')
        const { members, grants } = withDatabase(env, (db) => ({ members: listMembers(db), grants: grantsByDevice(db) }))
        if (members.length === 0) io.out('no members')
        for (const m of members) {
          io.out(`${m.handle}  "${m.displayName}"  ${m.id}  joined ${iso(m.createdAt)}`)
          if (m.devices.length === 0) io.out('    (no devices)')
          for (const d of m.devices) {
            io.out(`    ${d.id}  "${d.name}"  joined ${iso(d.createdAt)}  last seen ${iso(d.lastSeenAt)}`)
            for (const g of grants.get(d.id) ?? []) {
              io.out(`        relay grant ${g.id}  "${g.name}"  created ${iso(g.createdAt)}  last used ${iso(g.lastUsedAt ?? null)}`)
            }
          }
        }
        return 0
      }
      case 'member rename': {
        const [handle, displayName] = positional(rest, 2, 'a handle and a display name')
        const member = withDatabase(env, (db) => renameMember(db, handle!, displayName))
        io.out(`${member.handle} is now "${member.displayName}"`)
        return 0
      }
      case 'member remove': {
        const [handle] = positional(rest, 1, 'a handle')
        const revoked = withDatabase(env, (db) => removeMember(db, handle!, now))
        io.out(`${handle} removed; ${revoked.length} device(s) revoked`)
        return 0
      }
      case 'device revoke': {
        const [id] = positional(rest, 1, 'a device id')
        withDatabase(env, (db) => revokeDevice(db, id!, now))
        io.out(`device ${id} revoked`)
        return 0
      }
      case 'help':
      case '':
        io.out(USAGE)
        return group === 'help' ? 0 : 2
      default:
        throw new UsageError(`unknown command "${argv.join(' ')}"`)
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`spekterm-server-admin: ${error.message}`)
      io.err(USAGE)
      return 2
    }
    if (
      error instanceof NotFoundError ||
      error instanceof ProtocolError ||
      error instanceof ConfigError ||
      error instanceof SchemaTooNewError ||
      error instanceof RangeError ||
      (error instanceof TypeError && (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') === true)
    ) {
      io.err(`spekterm-server-admin: ${error.message}`)
      return 1
    }
    io.err(`spekterm-server-admin: ${(error as Error).message ?? String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = run(process.argv.slice(2), process.env, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  })
}
