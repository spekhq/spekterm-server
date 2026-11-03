## Why

The PRD (docs/PRD.md, approved 2026-11-03) describes a self-hosted server that lets spekterm users hand work
to each other. Nothing exists yet. Every later milestone (M1 send and receive, M2 the way back, M3 directory
and presence) needs the same foundation first: a written wire contract, a team that people can join, a
credential per device, and one authenticated connection per device. This change is milestone M0.

## What Changes

- **`docs/protocol.md`**, the wire contract a client can be built from alone: the invite link, the transport,
  the frame shapes, version negotiation, joining, authenticating, errors and close codes. A test fails when
  the operations it lists and the ones the server accepts differ.
- **A team on one server**: one team per server (PRD §13.1). An admin creates single-use, expiring invites;
  a client can inspect one first (kind, team name, expiry); redeeming one creates a member (handle and display
  name) and that member's first device, or adds a device to an existing member.
- **Device credentials**: one per device, issued at join, stored only as a hash, revocable on its own. A
  device can rename itself and leave; leaving from a member's last device removes the member.
- **The connection**: one WebSocket per device, a first message that either joins or authenticates, explicit
  version negotiation (an incompatible client is told so, not dropped silently), keepalive, a newer
  connection from the same device replacing the older one, and a revoked device's connection closed within
  seconds.
- **Admin command line** inside the container: set the team name, create, list and cancel invites (for a new
  member or a new device of an existing member), list, rename and remove members, revoke a device.
- **Operating**: one process, one data directory (SQLite), one port, a health check, optional TLS served
  directly (for a self-signed certificate pinned through the invite) or plain behind a TLS terminator, a
  container image, and a one-page self-hosting guide. The server makes no outbound connections.
- **PRD record**: two v1 decisions this change makes are added to PRD §13.1 (the admin is whoever runs the
  command line; leaving from the last device removes the member).
- **Repository basics**: `package.json` (Node >= 22.22), MIT `LICENSE`, `README.md`, test and typecheck
  scripts.

Not in this change: anything about handoffs (M1, M2), the team directory and presence (M3), rate limits on
handoffs (M1), and every spekterm-side change (made in the spekterm repository).

## Capabilities

### New Capabilities

- `team-membership`: the team, members, devices, invites and credentials — how one joins, how a device is
  identified, how access ends (leave, revoke, remove).
- `server-connection`: the WebSocket connection between a device and the server — frames, joining and
  authenticating, version negotiation, keepalive, replacement and forced closing, limits, and the protocol
  document held to the server by a test.
- `admin-cli`: the administrator's command line and what each command does.
- `server-operation`: configuration, the data directory and its migrations, TLS modes, the health check,
  the container and the guarantee of no outbound connections.

### Modified Capabilities

(none — this is the first change in the repository)

## Impact

- New code under `src/` (server, storage, protocol, admin CLI), tests under `test/`.
- New runtime dependency: `ws` (Node has a WebSocket client but no server). Dev dependencies: `typescript`,
  `@types/node`, `@types/ws`.
- New files: `docs/protocol.md`, `docs/self-hosting.md`, `Dockerfile`, `LICENSE`, `README.md`.
- spekterm is not changed. Its "Settings → Team" (PRD §10) will be built against `docs/protocol.md` in its own
  change.
