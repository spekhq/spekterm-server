## Why

The server can now hold a team, but nothing moves through it. PRD milestone M1 is the first thing a team can
use: a handoff confirmed on one person's desktop arrives in a teammate's inbox — within seconds when the
teammate is connected, and on their next connection when not. That alone addresses "it was not seen" (PRD
§2.2, §11). The way back (taken, declined, done, the sender's list) is M2.

## What Changes

- **Sending**: a new authenticated operation `handoff.send` carries a handoff (title and body) from a device to
  one teammate, addressed by handle. The sending desktop calls it only after its user confirmed the text (PRD
  §7.3, spekterm's side). The server checks the recipient, the limits (title 200, body 20,000, as on one
  machine; PRD §7.2) and a per-member hourly rate (PRD §7.6), stores it, and answers. A resent request with the
  same client id does not make a second handoff.
- **Receiving**: the server offers each pending handoff to **one** of the recipient's connected devices at a
  time as a `handoff.incoming` event — the first event in the protocol. The device acknowledges with
  `handoff.received` once the item is safely in its inbox; only then is it delivered. A device that
  disconnects without acknowledging gives the handoff back, and it is offered again (PRD §8.3).
- **Holding and expiring**: a handoff waits on the server until a device acknowledges it, for at most 30 days
  (PRD §8.3, §9). The server keeps a handoff's title and body **only while it waits**: they are deleted when it
  is delivered or expires; only metadata stays.
- **Removed recipients**: removing a member (by the admin, or by leaving from the last device) expires the
  handoffs waiting for them.
- **Team members list**: a new operation `team.members` lists the team's members (handle, display name), so
  that spekterm can tell its agent whom it can hand work to (PRD §6.2, §10). Presence and live updates of the
  list stay in M3.
- **Payload marker**: the handoff text travels in a payload object with `enc: "none"`, the room reserved for
  end-to-end encryption (PRD §8.4, §13.1).
- **Protocol document**: `docs/protocol.md` gains the operations, the event, the new error codes and the
  delivery rules; its test also holds the event kinds to the server.
- **Configuration**: `HANDOFF_RATE_PER_HOUR` (default 30).
- **Client rules**: the protocol states how a receiving client stores, acknowledges, re-acknowledges and
  drops handoffs; the delivery guarantees depend on them, and spekterm implements them.
- **Version**: the server's version becomes 0.2.0.

Not in this change: statuses back to the sender (`delivered`, `taken`, `declined`, `done`, `expired`), the
report, the sender's list and notifications (M2); presence and directory updates (M3); every spekterm-side
change (its own changes in the spekterm repository).

## Capabilities

### New Capabilities

- `handoff-delivery`: sending a handoff to a teammate, holding it, offering it to one device, acknowledging,
  expiring, and what the server keeps of it.
- `team-directory`: the list of the team's members a device can ask for.

### Modified Capabilities

- `server-connection`: the operations list grows; the protocol document also covers events and is held to
  the server's event kinds.
- `server-operation`: a new configuration variable for the handoff rate.

## Impact

- `src/`: new `handoffs.ts` (storage and rules), delivery coordination in `server.ts` / `connection.ts`
  (offering, leases, pushing events), new operations and error codes in `protocol.ts` / `errors.ts`, a schema
  migration (version 2) in `db.ts`, `config.ts` for the rate.
- `docs/protocol.md`, `docs/self-hosting.md` (rate setting; what the server keeps).
- No new dependencies.
- spekterm: its outbox, send confirmation, inbox source "teammate" and Settings → Team are built against the
  updated `docs/protocol.md`, in the spekterm repository.
