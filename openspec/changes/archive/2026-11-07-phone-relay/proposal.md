## Why

spekterm's remote access connects the phone directly to the desktop, so away from the desktop's network the
phone needs Tailscale or a port forward, a setup step per person that many people skip (PRD §2.4). Members of a
team already have a server that both their phone and desktop can reach and whose certificate the desktop already
verifies. PRD §8.4 reserved room for a blind relay for exactly this; the user decided on 2026-11-06 that direct
stays the default and that, for members of a team, the relay is an optional second path (PRD §13.1).

## What Changes

- **Relay grants** (on the team connection, `/connect`): a desktop asks for a grant per paired phone
  (`relay.grant`), lists its grants (`relay.grants`) and revokes them (`relay.revoke`). A grant belongs to the
  device that asked for it; the server stores only a hash of its secret; revoking the device, the device
  leaving, or removing the member deletes its grants.
- **Tunnels** (new WebSocket path `/relay`): the phone opens a WebSocket with its grant (`relay.open`); the server
  tells the grant's desktop over its team connection (`relay.incoming` event, with a tunnel id and no address);
  the desktop opens its own WebSocket to `/relay` with its device credential and the tunnel id
  (`relay.accept`), or refuses (`relay.refuse` on `/connect`). The server then splices the two, forwarding
  binary frames verbatim and never terminating the phone's TLS to the desktop.
- **Limits**: tunnels in total and per desktop device, tunnel opens per grant, and throughput per tunnel, with
  flow control between the two legs. Defaults are set from measurements on a two-core ARMv7 NAS (Synology
  DS218j) before they are written into code.
- **Ending**: a tunnel ends when either leg closes, the server shuts down, or its grant or device is revoked.
  Nothing is resumed; the phone reconnects as after any drop.
- **Configuration**: relaying is off unless the operator sets `RELAY=on`; the relay operations are listed in
  `operations` only then. New settings for the limits.
- **Admin command line**: `member list` shows each device's grants and when each was last used.
- **Logs**: each tunnel's open, close, duration and byte counts by id; never a grant secret or content.
- **Protocol stays version 1**: everything above is additive (new operations, event, error codes, close code and
  a new path). `docs/protocol.md` gains the relay sections. Server version 0.4.0.
- **PRD** revised (done with this change's artifacts): relay moved from non-goals into scope (§2.4, G6, §4,
  §5, §7.1, §7.7, §8.4, §8.5, §9, §10, §11 M4, §12, §13.1).
- **Not in this repository**: the desktop's grant handling, tunnel dialing and hand-off to its remote-access
  listener (spekterm), and the phone's choice between direct and relay with two certificate checks
  (spekterm-android). Design D9 and D10 state what each needs; each gets its own change there.

## Capabilities

### New Capabilities

- `phone-relay`: relay grants, the `/relay` endpoint and its handshake, splicing, flow control and limits, how
  tunnels end, and what is logged.

### Modified Capabilities

- `server-connection`: `/relay` joins `/connect` as an accepted WebSocket path; the `operations` list includes
  the relay operations when relaying is on; the protocol document covers the relay.
- `server-operation`: `RELAY` and the relay limit settings; "no outbound connections" also covers tunnels.
- `admin-cli`: `member list` shows relay grants.

(Revoking a device, a device leaving and removing a member also delete the device's grants; that is stated in
`phone-relay`, so `team-membership`'s requirements stay as they are.)

## Impact

- `src/db.ts` (migration 4: `relay_grants`), new `src/relay.ts` (grants) and `src/tunnels.ts` (the `/relay`
  endpoint, splice, limits), `src/server.ts` (second upgrade path, sweep and shutdown cover tunnels),
  `src/protocol.ts` / `src/errors.ts` (operations, event, error and close codes), `src/connection.ts`
  (`relay.incoming` delivery), `src/team.ts` (grant deletion on revoke/leave/remove), `src/config.ts`,
  `src/admin.ts`.
- Tests: new unit and integration tests over real WebSockets; `test/protocol-doc.test.ts` extended to the
  `/relay` operations; the hygiene and no-outbound tests extended.
- A benchmark script (`scripts/relay-bench.mjs`) to measure the relay's cost on the operator's hardware.
- Docs: `docs/protocol.md`, `docs/self-hosting.md`, `docs/PRD.md`, `README.md`.
- No new runtime dependency (`ws` already does both endpoints).
- Clients: spekterm and spekterm-android need their own changes before anyone can use the relay; an older
  client is unaffected.
