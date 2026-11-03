## Context

See proposal.md. The protocol is a draft (no spekterm release speaks it), so the protocol version stays 1. The
server software version goes to 0.2.1: spekterm's open changes were written against 0.2.0's behaviour, and
`server.version` is how a client under development tells the two apart.

## Decisions

### D1. Check revocation per authenticated request

`Connection` reads whether its device is still on the team (`isDeviceActive`: one indexed query on `devices`)
before every operation with `auth: 'device'`. On failure it answers `AUTH_FAILED` and closes with 4004 after the
answer. The same check runs in `Delivery` before offering on a connection: a revoked device's connection is
closed with 4004 instead, and its `onClosed` offers the handoff to the member's next ready connection. Without
it, a handoff sent moments after the admin revoked a lost laptop would be pushed, text and all, to that laptop.
The 5-second sweep stays for connections that send nothing.

The check runs outside the operation's own transaction, so a revocation committed in the microseconds between
the check and, say, `sendHandoff` still lets that one request through; accepted, as the sweep closes the
connection moments later. *Alternative:* only document the window — rejected, because `handoff.send` from a
revoked device would otherwise still be stored.

### D2. `deviceCount` in `team.members`, not a "leave preview" operation

The client asks `team.members` right before showing the leave confirmation. A dedicated preview operation
would answer the same question with one more operation to maintain. A race remains (a device revoked between
the list and the leave); the `device.leave` answer's `memberRemoved` tells the truth afterwards.

### D3. Show, not delete, on a discarded credential

After revocation the server cannot tell the client what happened to its unanswered acknowledgements. If the
acknowledgement arrived, the server counts the handoff as delivered to this device and offers it nowhere
else: deleting loses it. If it did not arrive, the server offers it to another device of the member, and showing
makes a duplicate; or, if the member was removed, the server expired it, and showing presents something the
sender will (in M2) see as expired. A duplicate on the user's own machine is the lesser
harm; marking it lets the user judge.

### D4. Id format stated, not changed

Ids are case-sensitive; current ids are lower case only, so case-insensitive file systems are not a problem today,
but the document does not promise file-name safety.

Current ids are a letter, `_`, and 32 hex digits, already inside the stated format. Stating a wider format keeps
room to change their shape later without breaking clients.
