## 1. Repository setup

- [x] 1.1 Add `package.json` (`"type": "module"`, `engines.node >= 22.22`, dependency `ws` ^8.22, dev dependencies `typescript` ^5.9, `@types/node` ^22, `@types/ws`; scripts `start`, `admin`, `test`, `typecheck`), commit `package-lock.json`, and add `.nvmrc` (22.22.0), `.gitignore`, MIT `LICENSE` and a short `README.md`; verify `npm install` succeeds and the lock file is tracked
- [x] 1.2 Add `tsconfig.json` per design D1 (`nodenext`, `types: ["node"]`, `strict`, `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`); verify `npm run typecheck` passes with a placeholder `src/version.ts` (the server's version constant) importing `node:sqlite` types, and that `node --test` finds `test/*.test.ts`

## 2. Configuration and storage

- [x] 2.1 Implement `src/config.ts` (PORT, DATA_DIR, PUBLIC_URL without path and with trailing `/` dropped, TLS_CERT/TLS_KEY both or neither); verify with unit tests for defaults, a lone TLS variable, a non-`wss` address and an address with a path
- [x] 2.2 Implement `src/db.ts` per design D2 and D11 (read `user_version` before any change, refuse a newer schema, then WAL and busy timeout, migrations in one `BEGIN IMMEDIATE` transaction that re-reads the version, a `writeTransaction` helper that always uses `BEGIN IMMEDIATE`); verify with unit tests for a fresh database, reopening, two handles migrating the same fresh file, and a downgrade refusal that leaves the file byte-for-byte unchanged (including a database in rollback-journal mode)
- [x] 2.3 Implement `src/tls.ts` (load certificate and key, self-signed detection, upper-case SHA-256 fingerprint of the leaf DER); verify with unit tests against a generated self-signed certificate and a generated CA-issued leaf

## 3. Team membership

- [x] 3.1 Implement name and handle validation (trim, 1–64 code points, no Cc / U+2028 / U+2029; handle pattern after lowercasing); verify with unit tests covering every rule and scenario in `team-membership`, including 64 non-BMP emoji
- [x] 3.2 Implement invites in `src/team.ts` (ids per design D11; create both kinds with lifetime 1 h–30 d, code shown once, hash stored; inspect; list of redeemable invites; cancel; redeem with `INVITE_UNKNOWN` / `INVITE_EXPIRED` / `INVITE_USED`); verify with unit tests using an injected clock, including that `BAD_PARAMS` and `HANDLE_TAKEN` leave the invite unused
- [x] 3.3 Implement join as a new member and as a new device of an existing member (one immediate transaction; `HANDLE_TAKEN`; handle reuse after removal; invite for a removed member refused); verify with unit tests for each scenario, plus a race test in which a child process holds a `BEGIN IMMEDIATE` transaction that removes the member and commits after a delay, the join started meanwhile answers `INVITE_UNKNOWN`, and in the reverse order the join succeeds and the removal revokes the new device; never an exception
- [x] 3.4 Implement credentials (issue `deviceId` + `deviceSecret`, hash, authenticate with constant-time compare, last seen), device rename, device leave (count of remaining devices inside the same immediate transaction; removing the member and cancelling their device invites when it was the last; `memberRemoved` in the result), `member.deviceCount` in results, device revoke, member rename and member remove (revoke all devices, cancel device invites, free handle, keep record); verify with unit tests for each scenario, and a test that scans the database file for the secret and the invite code and finds neither

## 4. Connection

- [x] 4.1 Implement `src/protocol.ts` per design D4 and D5 (frame parsing, error codes as a literal union, close codes, registry with `invite.inspect`, `join`, `hello`, `device.rename`, `device.leave`, `protocol` checked first, unknown operation before authentication check); verify with unit tests for `BAD_FRAME`, `UNKNOWN_OPERATION`, `BAD_PARAMS` with `detail.field`, ignored unknown fields and version negotiation including a version-2-shaped `join`, and `ALREADY_AUTHENTICATED` for `invite.inspect` / `join` / `hello` after authentication
- [x] 4.2 Implement `src/connection.ts` and `src/server.ts` with injectable timers (design D12): `/connect` upgrade (404 elsewhere), 256 KiB limit with an `error` listener on every socket, binary frame close, authentication timeout (4001), refusal close one second after an error before authentication (4003) with frames in that second ignored, `server` and `operations` in results, one connection per device (4006), keepalive, `/healthz`, TLS or plain mode; verify with integration tests over a real WebSocket for every `server-connection` scenario, including an oversized frame that leaves another connection and the server working, `UNSUPPORTED_VERSION` leaving an invite unused, and an inspect connection closed with 4001 followed by a successful join on a new connection
- [x] 4.3 Implement the revocation sweep and in-process closing on `device.leave` (4004); verify with integration tests in which a revocation written by a separate database handle closes the live connection with 4004 within the bound, and in which a device replaced by a second connection and then revoked has its second connection closed
- [x] 4.4 Implement graceful shutdown; verify with a test that runs the server as a child process with a connected client, sends SIGTERM, and observes close code 1001 and exit status 0
- [x] 4.5 Implement `/healthz` with an injected check reading the `team` table; verify with an integration test that answers 200, then injects a failing check and gets 503
- [x] 4.6 Verify secrets stay out of logs with a test that captures the server's and the CLI's output across invite creation (excluding the printed link), join, hello and leave, and finds neither the invite code nor the device secret, while the join's log line does name the member and the device
- [x] 4.7 Verify "no outbound connections" with a test that runs the server in a child process subscribed to `diagnostics_channel` `net.client.socket` and `udp.socket`, with an `--import` preload wrapping `dns.lookup` and the `dns` resolve functions, exercises every operation and admin command, and asserts no socket was opened and no lookup made

## 5. Admin command line

- [x] 5.1 Implement `src/admin.ts` with `team name`, `invite create|list|cancel`, `member list|rename|remove`, `device revoke` (exit codes, messages on standard error, `fp` only for a self-signed certificate unless `--pin`, refusal without `PUBLIC_URL`); verify with tests that run the command as a child process against a temporary data directory, covering every `admin-cli` scenario
- [x] 5.2 Verify end to end that an invite created by the CLI while the server runs is redeemable at once, and that `member remove` closes the member's connections with 4004; covered by an integration test

## 6. Protocol document

- [x] 6.1 Write `docs/protocol.md`: invite link, transport and certificate pinning (when `fp` is present and when not), frames, `invite.inspect` / `join` / `hello` / `device.rename` / `device.leave` with parameters and results, error codes with `detail` fields, close codes with what the client does on each (reconnect or not), version negotiation, the differences from spekterm's remote protocol, recovery when a join's answer is lost, and the stability rule of design D15; verify by checking it item by item against the four specs (every operation, field, error code, close code and the client-action table appears)
- [x] 6.2 Add a test that compares the operations, the error codes and the close codes listed in `docs/protocol.md` with the server's registry, error code list and close codes; verify it fails when an operation is added to only one side, then passes

## 7. Operating

- [x] 7.1 Add `src/healthcheck.ts`, `Dockerfile` per design D14 (node:22.22-alpine, `/data` owned by `node` before `VOLUME`, non-root, exec-form `CMD`, health check, `spekterm-server-admin` on the path) and `.dockerignore`; verify `docker build` succeeds and, in a running container with a named volume, `/healthz` answers 200, `docker exec … spekterm-server-admin invite create` prints a link, and `docker stop` exits cleanly
- [x] 7.2 Verify on a Docker network created with `--internal` (no egress) that inspect, join, hello, leave and the admin commands work from a client container on the same network
- [x] 7.3 Verify with a self-signed certificate (`TLS_CERT` / `TLS_KEY`) that the invite link carries the certificate's fingerprint, that a test client pinning it joins over `wss://`, and that the container health check passes in TLS mode
- [x] 7.4 Write `docs/self-hosting.md` (behind a reverse proxy, with a self-signed certificate, first invite, backups, restart after a certificate change, re-joining after replacing a pinned certificate, recovering a device whose join answer was lost, a private authority needs `--pin`, the operator can read handoff contents); verify it covers every item the `server-operation` spec lists for the guide and fits on one page

## 8. Product document

- [x] 8.1 Record in `docs/PRD.md` §13.1 that in v1 the admin is whoever runs the command line (no admin flag on members, design D9) and that leaving from a member's last device removes the member (design D10); verify both appear in §13.1 and §5's "first member is the admin" points to it

## 9. Regression

- [x] 9.1 Run `npm test` and `npm run typecheck` and confirm both pass
