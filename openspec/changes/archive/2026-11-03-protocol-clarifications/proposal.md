## Why

Building the spekterm side of M1 (in the spekterm repository, changes `team-membership` and
`teammate-handoff`) turned up six gaps in the protocol and PRD while the protocol is still a draft and can
change freely: ids without a stated format, an undocumented error after authentication, a device count that can
be stale in the dangerous direction, a receiving rule that can lose a delivered handoff, and two PRD sentences
that no longer match.

## What Changes

- **Id format**: member, device, handoff and invite ids are guaranteed to be 1–64 characters of
  `A`–`Z`, `a`–`z`, `0`–`9`, `_`, `-`, not starting with `-`, case-sensitive, so a client can use them as keys.
- **Revoked device on a live connection**: every authenticated request first checks that the device is still
  on the team; if not, it is answered `AUTH_FAILED` and the connection is closed with 4004 at once, instead of
  waiting for the 5-second sweep. Today `device.rename` / `device.leave` already answer `AUTH_FAILED` in that
  window (undocumented) while `handoff.send` and `handoff.received` still succeed. The server also stops
  **offering** handoffs to such a connection: today a device revoked moments ago could still be sent a new
  handoff's text.
- **`team.members` carries `deviceCount`** per member, so a client can tell the user, just before leaving,
  whether leaving removes them from the team (the count from `hello` may be stale and errs towards "only this
  device").
- **Receiving rule 6 changes**: when a client discards its credential, it **shows** (flagged as possibly also
  delivered elsewhere) the handoffs it stored but never had answered, instead of deleting them. The
  acknowledgement may have reached the server, which then counts the handoff as delivered to this device;
  deleting would lose it. A duplicate is the lesser harm.
- **Where the device secret lives** (decided by the user for spekterm: the existing `secrets.json`, mode 0600,
  as for its Slack token, not the OS keyring): protocol §5 `join` and PRD §7.4 no longer promise "never in a file
  an agent can read"; they say spekterm never hands the secret to a terminal or an agent, and that programs
  running as the same user can read the file it is in. Recorded in PRD §13.1.
- **PRD**: §7.5 says spekterm accepts only `wss` (the protocol never had `https`); §10 says the agent's
  introduction points to a teammates file (spekterm's design) instead of listing teammates inline.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `server-connection`: authenticated requests from a revoked device; the id format; `deviceCount` in the
  authentication result is a snapshot.
- `handoff-delivery` (also): no offer to a revoked device's connection.
- `team-directory`: `deviceCount` per member.
- `handoff-delivery`: receiving rule for a discarded credential.

## Impact

- `src/connection.ts` (revocation check before authenticated operations), `src/delivery.ts` (revocation check
  before offering), `src/team.ts` (`isDeviceActive`, `listTeamMembers`).
- Server version 0.2.1, so a dogfooding client can tell this server from 0.2.0.
- `docs/protocol.md` (§5 errors after authentication, id format, `team.members`, §11 rule 6), `docs/PRD.md`.
- spekterm's two open changes follow the updated `docs/protocol.md`.
