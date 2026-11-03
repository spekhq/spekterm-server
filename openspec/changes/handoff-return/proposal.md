## Why

M1 (`handoff-delivery`) gets a handoff into a teammate's inbox, but the sender learns nothing after the send
answer: not that it arrived, not that it was taken, not the result. PRD §2.2 names "the sender cannot tell
which of these happened" as the failure M2 exists to fix (§11: "M2 is what addresses 'the sender cannot
tell'"). M1 also left four design questions for M2: a delivery guarantee for status events, a bound on
metadata rows, titles that are gone from the server once delivered, and PRD §13 open question 1 (how the
sender's agent learns the outcome).

## What Changes

- **`handoff.update`** (recipient → server): the device a handoff was delivered to reports `taken` (accepted
  into a session), `declined` (with an optional reason of at most 500 UTF-16 code units) or `done` (with the
  recipient agent's report, 1–4,000 UTF-16 code units, the same limit as spekterm's completion report). A
  resend of the current state is answered with the status (`{status}`) and changes nothing, so a lost answer can be retried. `done` can
  be sent again with a newer report, which replaces the earlier one (as a same-machine child reports after each
  later request), at most 10 reports per handoff. Dismissing without declining sends nothing (PRD §13.1).
- **A change feed for the sender**: every change to a handoff (sent, delivered, taken, declined, done,
  expired, its recipient removed from the team) gives the handoff a new, increasing sequence number. `handoff.sync { after }` returns, page by page,
  the current state of every handoff the member sent that changed after `after`; once a page says
  `more: false`, the connection also receives each later change as a **`handoff.status`** event. The client
  keeps the last sequence number it stored and syncs from it after every `hello`, so nothing is missed across
  disconnects, restarts and the sender's several devices. This is the "resume from the last seen event" of PRD
  §8.2, as its own operation instead of a `hello` field.
- **The sender's Sent list** is built from those records: recipient, times, status, the device it was sent
  from, whether the recipient has since left the team, and the decline reason or report. **Titles are not
  kept**: the server still deletes title and body on
  delivery (M1 behaviour, protocol §8), so a sent handoff appears without its title on the sender's other
  devices or after reinstalling; the sending device keeps its own copy.
- **Expiry reaches the sender**: a handoff that expires (30 days, or its recipient was removed) shows up in the
  feed as `expired` (PRD §8.3), including when the admin command line removed the recipient.
- **Retention**: a decline reason or report is deleted 30 days after it was written; a handoff's whole record is
  deleted 90 days after its last change. As with handoff text, deleted text is gone from the data directory's
  files within a minute.
- **`handoff.received`** keeps answering `{}` to the device a handoff was delivered to after it was taken,
  declined or done (today it only does while `delivered`).
- **PRD**: §8.2's message table gains `handoff.sync`; §13 open question 1 is decided (the sending session's
  relations file shows the status; the teammate's report is third-party text and reaches the agent only through
  the user); the title trade-off is recorded in §13.1.
- Server version 0.3.0. Protocol stays version 1 (still a draft).

## Capabilities

### New Capabilities

- `handoff-status`: the recipient's status reports (`handoff.update`), the sender's change feed
  (`handoff.sync`, the `handoff.status` event), and how long reports and handoff records are kept.

### Modified Capabilities

- `handoff-delivery`: `handoff.send` may answer a resend with any status, and recognises a resend only until the
  record is deleted; `handoff.received` answers `{}` to the delivered-to device in every later status; what the
  server keeps of a handoff and for how long.
- `server-connection`: the `operations` list gains `handoff.sync` and `handoff.update`; the protocol document
  also states the rules a sending client follows to keep its Sent list.

## Impact

- `src/db.ts` (schema migration 3: new statuses, sequence numbers, report columns; a sequence counter),
  `src/handoffs.ts` (update, sync, retention; every status change takes a sequence number), new
  `src/feed.ts` (pushing `handoff.status` to subscribed connections), `src/team.ts` (expiry on member removal
  takes sequence numbers), `src/protocol.ts`, `src/errors.ts`, `src/connection.ts`, `src/server.ts`
  (publishing after requests, in the sweep and in maintenance; retention in maintenance).
- `docs/protocol.md`, `docs/self-hosting.md`, `docs/PRD.md`, `test/protocol-doc.test.ts` and new tests.
- spekterm: the M2 client (Sent list, decline, sending the report back, the sending session's relations
  entry) is a separate handoff to the spekterm repository after this protocol is settled.
