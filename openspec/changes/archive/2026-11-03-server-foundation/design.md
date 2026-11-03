## Context

The repository holds only `docs/PRD.md`. This change builds the foundation that M1–M3 extend (see
proposal.md). spekterm already defines a request/answer/event WebSocket protocol, as the server, for its
phone app (`../spekterm/docs/remote-protocol.md`), and pins self-signed certificates by SHA-256 fingerprint.
In this product spekterm is the client, so no client code is reused, but whoever writes spekterm's side
already knows that protocol's conventions; matching them avoids two sets of habits that disagree. spekterm
requires Node >= 22.22.

## Goals / Non-Goals

**Goals:**
- A server a team can start with one container and no build step, whose only management interface is a
  command line run next to it.
- A protocol document precise enough to build spekterm's "Settings → Team" against without reading server
  code.
- An internal shape that M1 can extend with handoff operations by adding to a registry, not by reworking the
  connection.

**Non-Goals:**
- Event resumption (`hello` carrying the last seen event), message ids and duplicate dropping: they arrive with
  the first events in M1. `hello` ignores unknown fields, so adding them stays within version 1.
- Rate limits and per-address throttling. Invite codes (128 bits) and secrets (256 bits) cannot be guessed,
  and behind a reverse proxy the peer address is the proxy's. The cost left is resources (connections and
  attempts are not capped); accepted for a server whose address only the team knows.
- Admin operations over the connection, and any web interface.
- What M1 does with handoffs addressed to a member who has no device left (they are held until expiry, PRD
  §8.3); decided in M1.

## Decisions

### D1. TypeScript run by Node's type stripping, no build step

Source is `.ts`, run directly with `node src/server.ts` (type stripping is on by default from Node 22.18;
verified on 22.22.0 with no flag and no warning). `package.json` sets `"type": "module"`. `tsc --noEmit` checks
types with `typescript` pinned to `^5.9` (as spekterm; TypeScript 7 changes defaults such as `types: []` and is
a separate decision). `tsconfig.json`: `module` / `moduleResolution` `nodenext`, `types: ["node"]`, `strict`,
`noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`. Code uses erasable syntax
only (no `enum`, no parameter properties, no namespaces) and imports carry the `.ts` extension.
`package-lock.json` is committed (the image uses `npm ci`).

*Alternatives:* plain JavaScript with JSDoc (weaker checking, unlike spekterm); a `tsc` build (a `dist/` to
keep in step and ship, for no runtime gain).

### D2. `node:sqlite` for storage, with immediate write transactions

The built-in `DatabaseSync` needs no native module, so the image needs no compiler and no prebuilt binary. It
is still marked experimental in Node 22 and prints one `ExperimentalWarning`; all of it is behind one module
(`src/db.ts`), so an API change touches one file.

The server and the admin command line are two processes writing one database in WAL mode with a 5-second
busy timeout. **Every transaction that writes starts with `BEGIN IMMEDIATE`, and the reads it decides on are
made inside it.** A deferred transaction that read before another process committed fails at its first write
with `SQLITE_BUSY_SNAPSHOT` at once, without waiting for the busy timeout (measured: a join racing a member
removal got error 517 after 0 ms). With immediate transactions the second writer waits, then reads the
committed state, so a join racing a removal answers `INVITE_UNKNOWN` instead of `INTERNAL`.

*Alternatives:* `better-sqlite3` (a native build per Node version and platform, the class of trouble
spekterm's `native-module-toolchain` spec exists for); a JSON file (no safe concurrent writer for the CLI).

### D3. `ws` is the only runtime dependency

Node has a WebSocket client but no server. `ws` (^8.22, as spekterm) is the standard server and has no
dependencies of its own. `maxPayload` is 256 KiB, which closes an oversized frame with 1009 (measured on
8.22.0). Every socket gets an `error` listener: without one, an oversized frame raises an unhandled `error`
event that ends the process (measured). A body of 20,000 characters (PRD §7.2) is at most about 120 KB as
escaped JSON, inside the limit.

### D4. Names, frames, error and close codes follow spekterm's remote protocol

Frame shapes are those of `../spekterm/docs/remote-protocol.md` §3. Parameter and code names match it:
`protocol` (versions offered, and the version chosen), `detail.supported`, `BAD_FRAME`, `BAD_PARAMS`,
`UNKNOWN_OPERATION`, `UNSUPPORTED_VERSION`, `NOT_AUTHENTICATED`, `AUTH_FAILED`, `INTERNAL`; the credential is
`deviceId` + `deviceSecret`; results of `join` / `hello` carry `server` (`name`, `version`) and `operations`.

Close codes keep spekterm's meanings: 4001 no authentication within 10 seconds; 4003 refused, one second after
an error answer before authentication; 4004 the device was revoked, do not reconnect with that credential.
4003 alone does not tell the client what to do: the error code before it does, and the spec gives a table
(`AUTH_FAILED` is how an offline-revoked device learns it, so it means "discard the credential", never
"retry"; without throttling, a "retry on 4003" rule would let a revoked device reconnect every second
forever). This server adds 4006 replaced by a newer connection of the same device
(4005 is spekterm's "remote access turned off"), on which the client does not reconnect on its own.

Differences, listed so nobody assumes otherwise: there is no `THROTTLED` / `TOO_MANY_CONNECTIONS` (see
Non-Goals); `PAIRING_FAILED` has no equivalent, because joining distinguishes `INVITE_UNKNOWN`,
`INVITE_EXPIRED` and `INVITE_USED`; `BAD_PARAMS` carries `detail.field`; there is no `addresses` field;
`UNKNOWN_OPERATION` before authentication is followed by 4003 like every other error there (spekterm keeps
that connection open).
Server-specific codes: `ALREADY_AUTHENTICATED`, `HANDLE_TAKEN`.

Version negotiation lives in the first request, not in the URL path, so that a client the server does not
speak to still gets an answer (`UNSUPPORTED_VERSION` with the server's list) instead of a 404 it cannot tell
apart from a wrong address. `protocol` is checked before any other parameter, so a newer client's differently
shaped parameters still produce `UNSUPPORTED_VERSION`.

### D5. Operation registry

`src/protocol.ts` exports one table: operation name → `{ auth: 'none' | 'device', handler }`. This change has
`invite.inspect`, `join`, `hello` (auth `none`) and `device.rename`, `device.leave` (auth `device`). The
connection loop dispatches through it, `operations` in results is derived from it, and the protocol-document
test reads it. Error codes are a string-literal union and the answer helper accepts only that type, so `tsc`
keeps every code the server can send inside the list the document test compares; close codes are a constant
object compared the same way. M1 adds `handoff.*` rows.

### D6. Invite link and `invite.inspect`

```
spekterm://join?v=1&s=<server address>&c=<code>[&fp=<fingerprint>]
```

`s` is `PUBLIC_URL` (`wss://host[:port]`, no path), URL-encoded; the client connects to `<s>/connect`. `c` is
26 characters of RFC 4648 base32 encoding 16 random bytes (128 bits), compared case-insensitively. `fp` is
the SHA-256 of the leaf certificate in DER as 64 upper-case hex digits (spekterm's pairing link uses the same
format), present only when the server serves a self-signed certificate; clients compare it case-insensitively.

"Self-signed" is detected from `TLS_CERT`: the leaf's issuer equals its subject and its signature verifies
with its own public key (`X509Certificate.checkIssued` + `verify`). A certificate from an authority (for
example ACME, renewed every 60–90 days) is never pinned: a pin would lock every device out at the first
renewal, and the system trust store already covers it.

The link carries no kind and no team name. Instead `invite.inspect` (before authentication) tells the client
the kind, the team name, the expiry and, for a device invite, whose device it will be, so Settings → Team asks
for a handle and a display name only on a new-member invite and shows what the user is joining before they
commit. It also checks the invite before the user types anything. Typing takes longer than the 10-second
authentication window, so inspect normally runs on a connection of its own and `join` on a later one.

`invite create --pin` forces `fp` for a certificate from a private authority (mkcert, step-ca) that members'
systems do not trust; detection alone would leave such a team unable to connect.

The `spekterm://` scheme matches the pairing link (`spekterm://pair?…`); the desktop does not register it as a
URL handler, so the link is pasted into Settings → Team, and `join` keeps it apart from a pairing link.

### D7. Credentials and codes are hashed with SHA-256, not a password hash

`deviceSecret` is 32 random bytes in base64url; the server looks the device up by `deviceId` and compares the
SHA-256 of the secret with `crypto.timingSafeEqual`. An invite code is stored as SHA-256 of its upper-cased
form. Both secrets are machine-generated with 128+ bits of entropy, so a slow password hash would add cost
without adding protection.

### D8. Revocations made by the CLI reach the server by polling

The admin command line is a separate process writing the same database. Every 5 seconds the server reads,
for the devices it has connections for, which ones are now revoked, and closes those with 4004. That meets
the 10-second bound in the spec with one indexed query, needs no second listening socket, and is skipped when
no device is connected. `device.leave` is handled in-process and closes at once. Invites need no signal: they
are read from the database when redeemed. The connection map is keyed by device id; a replaced connection's
close handler removes its entry only if the entry is still that connection, so the sweep still finds the
newer one.

*Alternative:* a local admin socket the CLI calls into (a second listener to secure, and the CLI would fail
whenever the server is down, while writing the database works either way).

### D9. The admin is whoever runs the CLI; no admin flag on members

PRD §5 says "the first member is the admin". In v1 there is no admin operation over the connection, so a flag
on a member would grant nothing; access to `docker exec` is the real control. No admin flag is stored. When a
later version adds admin operations to spekterm, it adds the flag and a migration that marks the earliest
member. This narrowing is recorded in PRD §13.1.

### D10. Leaving and the member's last device

`device.leave` revokes the device, and removes the member when no other device is left; the count is taken
inside the same immediate transaction. `hello` / `join` results carry `member.deviceCount` and the
`device.leave` result carries `memberRemoved`, so Settings → Team can warn "this will remove you from the
team" before, and say what happened after. An orphan device (a join whose answer was lost) counts as a device
until the admin revokes it. PRD §10 calls the
spekterm action "leave the team"; with this rule it is true for the common case of one device, and no member
without devices is left behind to keep receiving handoffs in M1. The admin's `device revoke` does not remove
the member, because the admin may be replacing a lost machine and will issue a device invite next. Recorded
in PRD §13.1.

### D11. Schema and migrations

`PRAGMA user_version` holds the schema version; `src/db.ts` holds an ordered list of migrations. On open it
sets the busy timeout (a connection setting that writes nothing), then reads `user_version` **without
changing anything**, and stops the process if it is above the list's length (the downgrade case). Only then it
sets WAL, and applies the missing migrations
inside one `BEGIN IMMEDIATE` transaction, re-reading `user_version` inside it, so that the server and the CLI
opening a fresh directory at the same time migrate once. Without the busy timeout set first, both the
version read and the switch to WAL fail at once with "database is locked" while another process is opening
the same fresh file (measured, both). Setting WAL first would rewrite the file header of a
newer database (measured: header bytes 18–19 changed from 1 to 2).

Tables in version 1:

- `team` (single row): `name`.
- `members`: `id`, `handle`, `display_name`, `created_at`, `removed_at`; a partial unique index on `handle`
  where `removed_at IS NULL`.
- `devices`: `id`, `member_id`, `name`, `secret_hash`, `created_at`, `last_seen_at`, `revoked_at`.
- `invites`: `id`, `code_hash` (unique), `member_id` (null for new-member invites), `created_at`, `expires_at`,
  `used_at`, `used_by_device_id`, `cancelled_at`.

Ids are a one-letter kind and an underscore followed by 32 lower-case hex digits of 16 random bytes (`m_…`,
`d_…`, `i_…`): random so that ids reveal nothing about team size, and never starting with `-`, which the CLI's
argument parser would read as an option (with base64url about 1.6% of ids would). Times are integer
milliseconds since the epoch.

### D12. Time and timers are injected

Domain functions take a `now()` function, so expiry and last-seen behaviour is tested without waiting. The
server takes its authentication timeout (10 s), ping interval (30 s), sweep interval (5 s) and refusal close
delay (1 s) as options with those defaults, so integration tests run them in milliseconds. `last_seen_at` is
written on authentication and then on a pong when at least 25 seconds have passed since the last write, so
with 30-second pings it is never more than about a minute old.

`/healthz` calls an injected check, by default a read of the `team` table (not `SELECT 1`, which an open
handle answers even after the file is gone; measured), so a test can make it fail.

### D13. Module layout

```
src/config.ts       environment → validated config
src/db.ts           open, migrate, transactions; the only importer of node:sqlite
src/team.ts         membership rules (inspect, join, authenticate, rename, leave, revoke, remove, invites)
src/protocol.ts     operation registry, error codes, close codes, frame parsing
src/connection.ts   one connection's state machine (auth timeout, dispatch, keepalive)
src/server.ts       HTTP(S) server, /healthz, /connect upgrade, revocation sweep, shutdown
src/tls.ts          certificate loading, self-signed detection, fingerprint
src/admin.ts        spekterm-server-admin
src/healthcheck.ts  container health probe (works in both TLS modes)
```

Tests in `test/` with `node:test`: unit tests for `team.ts` and `db.ts` against temporary databases;
integration tests that start the server on port 0 and talk to it with `ws` as a client; CLI tests that run
`src/admin.ts` as a child process. The "no outbound connections" test subscribes to `diagnostics_channel`'s
`net.client.socket` and `udp.socket` in a child process running the server, and wraps `dns.lookup` and the
`dns` resolve functions through an `--import` preload (DNS lookups trigger no diagnostics channel; measured),
and asserts none is used.

### D14. Container

`node:22.22-alpine` (pinned minor; spekterm's `engines` floor; tag verified), `npm ci --omit=dev`, `/data`
created and owned by `node` before `VOLUME /data`, `USER node`, `EXPOSE 8080`, `CMD ["node", "src/server.ts"]`
in exec form so that the process receives SIGTERM, `HEALTHCHECK` running `src/healthcheck.ts` (HTTPS without
verification when TLS is served directly, since it only checks liveness on localhost). A wrapper script puts
`spekterm-server-admin` on the path. `NODE_OPTIONS=--disable-warning=ExperimentalWarning` keeps the
`node:sqlite` warning out of every CLI invocation (verified on 22.22).

### D15. Protocol stability

Version 1 stays a draft that may change, additively or not, until a spekterm release ships a client for it.
From then on, version 1 changes only additively (new operations, new optional fields, new event kinds, new
error codes), and anything else is version 2. `docs/protocol.md` states this.

## Risks / Trade-offs

- [`node:sqlite` changes its API in a Node release] → confined to `src/db.ts`; the image pins the Node minor.
- [Node 22 leaves LTS in April 2027] → moving to Node 24 is a later change; nothing here depends on 22-only
  behaviour.
- [A device's secret leaks from its machine] → it is revocable on its own; nothing else on the server is
  reachable with it in this change.
- [A join commits but its answer is lost (connection drops)] → the invite is used and the secret is gone.
  Recovery is documented: the admin sees the orphan device in `member list`, revokes it and issues a new
  invite (a device invite when the member exists).
- [Replacing a pinned self-signed certificate] → every device must join again. The guide says so and
  recommends a long-lived certificate for that mode, or a CA certificate.
- [Plain mode is started without a terminator in front by mistake] → startup logs it; spekterm refuses
  non-`wss` addresses (PRD §7.5), so a client cannot talk to it in the clear.

## Migration Plan

First release; nothing to migrate. Rollback is stopping the container; the data directory is untouched by
anything but the server and the CLI.
