## 1. Server

- [x] 1.1 Add `isDeviceActive` and check it before every authenticated operation; answer `AUTH_FAILED` and close with 4004 otherwise (design D1); verify with integration tests on a server started with `sweepIntervalMs: 60_000` (so the sweep cannot interfere) in which a device revoked by a separate database handle sends `handoff.send` (nothing stored), `handoff.received` (the handoff stays `pending` and the member's other connection is offered it at once) and `device.rename`, each answered `AUTH_FAILED` followed by close 4004
- [x] 1.2 Check `isDeviceActive` in `Delivery` before offering on a connection; close a revoked one with 4004 and offer to the next ready connection; verify with an integration test (sweep at 60 s) in which the CLI-side revocation of Sam's laptop is followed by Alex's send: the laptop gets no event and is closed with 4004, the desktop gets the event
- [x] 1.3 Add `deviceCount` to each member in `team.members` (and to the member type); update the existing `team.members` test that asserts three keys; verify with a test that the count reflects a revocation made after `hello`
- [x] 1.4 Verify with a test that member, device, invite and handoff ids match `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$`
- [x] 1.5 Bump the server version to 0.2.1 (`package.json`, `src/version.ts`, the test that checks `server.version`); verify the version test passes

## 2. Documents

- [x] 2.1 Update `docs/protocol.md`: the id format (case-sensitive); `AUTH_FAILED` after authentication with close 4004 in §5, the error table, the Errors lines of `handoff.send` and `handoff.received`, and §7 "Losing access"; `deviceCount` in `team.members` and its use before `device.leave` (the `hello` count is a snapshot); no offers to a revoked device; §11 rule 6 (show, marked, instead of remove); the `join` sentence on storing the credential (spekterm never hands it to a terminal or an agent; programs running as the same user can read the file it is in); verify each against the modified specs
- [x] 2.2 Update `docs/PRD.md` §7.4 (where the device secret lives, same wording as the protocol, and a §13.1 entry recording the decision), §7.5 (only `wss`), §10 (the introduction points to a teammates file) and the §12 risk row about teammates in the introduction; verify all of them changed

## 3. Regression

- [x] 3.1 Run `npm test` and `npm run typecheck` and confirm both pass
