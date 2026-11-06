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
  listTeamMembers,
  renameDevice,
} from './team.ts'
import { acknowledge, sendHandoff, syncSent, updateStatus, validateSend, validateUpdate } from './handoffs.ts'
import { createGrant, listGrants, revokeGrant, validateId } from './relay.ts'
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
  /** The server could not bring this connection's status events up to date. Reconnect with backoff. */
  INTERNAL_ERROR: 1011,
  /** A relay tunnel's other end is gone. Reconnect with backoff (phone-relay). */
  TUNNEL_PEER_GONE: 4010,
} as const

export const MAX_FRAME_BYTES = 256 * 1024

/** Event kinds the server sends (`docs/protocol.md`, "Events"). */
export const EVENT_KINDS = ['handoff.incoming', 'handoff.status', 'relay.incoming'] as const

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
  /** The authenticated device and its member, or null before authentication. */
  deviceId: string | null
  memberId: string | null
  handoffRatePerHour: number
  /** A handoff was stored; offer it. */
  handoffSent(handoffId: string, recipientMemberId: string): void
  /** A handoff was acknowledged; end its lease. */
  handoffAcknowledged(handoffId: string): void
  /** Subscribes this connection to its member's status events from `cursor`, or ends the subscription (null). */
  subscribeStatus(cursor: number | null): void
  /** Marks the connection as authenticated as this device (closing an older connection of it). */
  authenticateAs(identity: Identity): void
  /** Closes the connection with this code once the answer has been sent. */
  closeAfterAnswer(code: number): void
  log(message: string): void
  /** Whether the operator turned relaying on (`RELAY=on`). */
  relayEnabled: boolean
  /** A grant of this device was revoked: end its tunnels. */
  grantRevoked(grantId: string): void
  /** This device refuses a pending tunnel offered to it. */
  refuseTunnel(tunnelId: string): void
  /** This device was revoked: end its tunnels, settling pending ones first. */
  deviceRevoked(): void
}

export interface Operation {
  /** `none`: accepted only before authentication. `device`: only after. */
  auth: 'none' | 'device'
  /** Offered only when relaying is on; otherwise answered `UNKNOWN_OPERATION` (phone-relay, design D7). */
  relay?: boolean
  handler(params: Record<string, unknown>, ctx: OperationContext): unknown
}

function server() {
  return { name: SERVER_NAME, version: SERVER_VERSION }
}

function describe(identity: Identity, protocol: number, relayEnabled: boolean) {
  return {
    protocol,
    server: server(),
    operations: authenticatedOperations(relayEnabled),
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
      return { ...describe(joined, protocol, ctx.relayEnabled), deviceId: joined.device.id, deviceSecret: joined.deviceSecret }
    },
  },
  hello: {
    auth: 'none',
    handler(p, ctx) {
      const protocol = negotiate(p.protocol)
      const identity = authenticate(ctx.db, p.deviceId, p.deviceSecret, ctx.now)
      ctx.authenticateAs(identity)
      return describe(identity, protocol, ctx.relayEnabled)
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
  'team.members': {
    auth: 'device',
    handler(_p, ctx) {
      return { members: listTeamMembers(ctx.db) }
    },
  },
  'handoff.send': {
    auth: 'device',
    handler(p, ctx) {
      const request = validateSend(p)
      const result = sendHandoff(ctx.db, { memberId: ctx.memberId!, deviceId: ctx.deviceId! }, request, ctx.handoffRatePerHour, ctx.now)
      if (result.duplicate) {
        ctx.log(`handoff ${result.handoff.id} resent by device ${ctx.deviceId}; already stored`)
      } else {
        ctx.log(`handoff ${result.handoff.id} from member ${ctx.memberId} to ${result.recipient.handle} stored`)
        ctx.handoffSent(result.handoff.id, result.recipient.id)
      }
      return result
    },
  },
  'handoff.received': {
    auth: 'device',
    handler(p, ctx) {
      acknowledge(ctx.db, p.id, { memberId: ctx.memberId!, deviceId: ctx.deviceId! }, ctx.now)
      ctx.handoffAcknowledged(p.id as string)
      ctx.log(`handoff ${String(p.id)} delivered to device ${ctx.deviceId}`)
      return {}
    },
  },
  'handoff.update': {
    auth: 'device',
    handler(p, ctx) {
      const request = validateUpdate(p)
      const result = updateStatus(ctx.db, request, { memberId: ctx.memberId!, deviceId: ctx.deviceId! }, ctx.now)
      const detail = !result.changed
        ? ' (unchanged)'
        : result.status === 'done'
          ? ` (report ${result.reports})`
          : result.status === 'declined' && request.payload !== null && request.payload.text !== ''
            ? ' (with a reason)'
            : ''
      ctx.log(`handoff ${request.id} ${request.status} by device ${ctx.deviceId}${detail}`)
      return { status: result.status }
    },
  },
  'handoff.sync': {
    auth: 'device',
    handler(p, ctx) {
      const { result, cursor } = syncSent(ctx.db, ctx.memberId!, p.after)
      // Last, once the answer is built: an error answer leaves the subscription as it was (design D5).
      ctx.subscribeStatus(result.more ? null : cursor)
      return result
    },
  },
  'relay.grant': {
    auth: 'device',
    relay: true,
    handler(p, ctx) {
      const result = createGrant(ctx.db, ctx.deviceId!, p.name, ctx.now)
      ctx.log(`relay grant ${result.grant.id} created by device ${ctx.deviceId}`)
      return result
    },
  },
  'relay.grants': {
    auth: 'device',
    relay: true,
    handler(_p, ctx) {
      return { grants: listGrants(ctx.db, ctx.deviceId!) }
    },
  },
  'relay.revoke': {
    auth: 'device',
    relay: true,
    handler(p, ctx) {
      const revoked = revokeGrant(ctx.db, ctx.deviceId!, p.id)
      if (revoked) {
        ctx.log(`relay grant ${String(p.id)} revoked by device ${ctx.deviceId}`)
        ctx.grantRevoked(p.id as string)
      }
      return { revoked }
    },
  },
  'relay.refuse': {
    auth: 'device',
    relay: true,
    handler(p, ctx) {
      ctx.refuseTunnel(validateId(p.tunnel, 'tunnel'))
      return {}
    },
  },
  'device.leave': {
    auth: 'device',
    handler(_p, ctx) {
      const result = leave(ctx.db, ctx.deviceId!, ctx.now)
      ctx.log(`device ${ctx.deviceId} left${result.memberRemoved ? '; its member was removed with it' : ''}`)
      ctx.deviceRevoked()
      ctx.closeAfterAnswer(CLOSE_CODES.REVOKED)
      return result
    },
  },
}

/** Operations accepted after authentication: the `operations` field of `join` and `hello` results. */
export function authenticatedOperations(relayEnabled: boolean): string[] {
  return Object.entries(OPERATIONS)
    .filter(([, op]) => op.auth === 'device' && (relayEnabled || op.relay !== true))
    .map(([name]) => name)
    .sort()
}
