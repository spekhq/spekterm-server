/**
 * The wire protocol (`server-connection` spec, `docs/protocol.md`): versions, close codes, frame parsing and
 * the operation registry. The protocol document test reads `OPERATIONS`, `ERROR_CODES` and `CLOSE_CODES`.
 */
import type { Database } from './db.ts'
import { ProtocolError, badParams } from './errors.ts'
import {
  type Clock,
  type Identity,
  authenticate,
  inspectInvite,
  join,
  leave,
  renameDevice,
} from './team.ts'
import { SERVER_NAME, SERVER_VERSION } from './version.ts'

/** Protocol versions this server speaks. */
export const PROTOCOL_VERSIONS: readonly number[] = [1]

/** Close codes the server uses (`docs/protocol.md`, "Close codes"). */
export const CLOSE_CODES = {
  /** The server is shutting down. */
  GOING_AWAY: 1001,
  /** A binary frame. */
  UNSUPPORTED_DATA: 1003,
  /** A frame over the size limit. */
  TOO_LARGE: 1009,
  /** No successful `join` or `hello` within the authentication window. */
  AUTH_TIMEOUT: 4001,
  /** Refused: sent one second after an error answer before authentication. */
  REFUSED: 4003,
  /** The device was revoked. Do not reconnect with that credential. */
  REVOKED: 4004,
  /** Replaced by a newer connection of the same device. Do not reconnect on its own. */
  REPLACED: 4006,
} as const

export const MAX_FRAME_BYTES = 256 * 1024

export interface Request {
  id: number | string
  m: string
  p: Record<string, unknown>
}

export type ParsedFrame = { ok: true; request: Request } | { ok: false; id: number | string | null }

export function parseFrame(text: string): ParsedFrame {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, id: null }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, id: null }
  const frame = value as Record<string, unknown>
  const id = typeof frame.id === 'number' || typeof frame.id === 'string' ? frame.id : null
  if (frame.t !== 'req' || id === null || typeof frame.m !== 'string') return { ok: false, id }
  const p = frame.p === undefined ? {} : frame.p
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return { ok: false, id }
  return { ok: true, request: { id, m: frame.m, p: p as Record<string, unknown> } }
}

/** Picks the highest version both sides speak; checked before any other parameter. */
export function negotiate(offered: unknown): number {
  if (!Array.isArray(offered) || offered.length === 0 || !offered.every((v) => Number.isInteger(v))) {
    throw badParams('protocol', 'protocol must be a non-empty list of version numbers')
  }
  const common = PROTOCOL_VERSIONS.filter((v) => offered.includes(v))
  if (common.length === 0) {
    throw new ProtocolError('UNSUPPORTED_VERSION', 'the server does not speak any of the offered protocol versions', {
      supported: [...PROTOCOL_VERSIONS],
    })
  }
  return Math.max(...common)
}

/** What an operation can see and do on its connection. */
export interface OperationContext {
  db: Database
  now: Clock
  /** The authenticated device, or null before authentication. */
  deviceId: string | null
  /** Marks the connection as authenticated as this device (closing an older connection of it). */
  authenticateAs(identity: Identity): void
  /** Closes the connection with this code once the answer has been sent. */
  closeAfterAnswer(code: number): void
  log(message: string): void
}

export interface Operation {
  /** `none`: accepted only before authentication. `device`: only after. */
  auth: 'none' | 'device'
  handler(params: Record<string, unknown>, ctx: OperationContext): unknown
}

function server() {
  return { name: SERVER_NAME, version: SERVER_VERSION }
}

function describe(identity: Identity, protocol: number) {
  return {
    protocol,
    server: server(),
    operations: authenticatedOperations(),
    team: identity.team,
    member: identity.member,
    device: identity.device,
  }
}

export const OPERATIONS: Readonly<Record<string, Operation>> = {
  'invite.inspect': {
    auth: 'none',
    handler(p, ctx) {
      const protocol = negotiate(p.protocol)
      return { protocol, ...inspectInvite(ctx.db, p.code, ctx.now) }
    },
  },
  join: {
    auth: 'none',
    handler(p, ctx) {
      const protocol = negotiate(p.protocol)
      const joined = join(ctx.db, { code: p.code, deviceName: p.deviceName, handle: p.handle, displayName: p.displayName }, ctx.now)
      ctx.log(
        `joined: member ${joined.member.handle} (${joined.member.id}), device "${joined.device.name}" (${joined.device.id})`,
      )
      ctx.authenticateAs(joined)
      return { ...describe(joined, protocol), deviceId: joined.device.id, deviceSecret: joined.deviceSecret }
    },
  },
  hello: {
    auth: 'none',
    handler(p, ctx) {
      const protocol = negotiate(p.protocol)
      const identity = authenticate(ctx.db, p.deviceId, p.deviceSecret, ctx.now)
      ctx.authenticateAs(identity)
      return describe(identity, protocol)
    },
  },
  'device.rename': {
    auth: 'device',
    handler(p, ctx) {
      const device = renameDevice(ctx.db, ctx.deviceId!, p.name)
      ctx.log(`device ${device.id} renamed to "${device.name}"`)
      return { device }
    },
  },
  'device.leave': {
    auth: 'device',
    handler(_p, ctx) {
      const result = leave(ctx.db, ctx.deviceId!, ctx.now)
      ctx.log(`device ${ctx.deviceId} left${result.memberRemoved ? '; its member was removed with it' : ''}`)
      ctx.closeAfterAnswer(CLOSE_CODES.REVOKED)
      return result
    },
  },
}

/** Operations accepted after authentication: the `operations` field of `join` and `hello` results. */
export function authenticatedOperations(): string[] {
  return Object.entries(OPERATIONS)
    .filter(([, op]) => op.auth === 'device')
    .map(([name]) => name)
    .sort()
}
