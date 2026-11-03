## Context

`server-foundation` (archived 2026-11-03) gives a team, devices, one authenticated WebSocket per device, an
operation registry (`src/protocol.ts`), a revocation sweep every 5 seconds (`src/server.ts`), and a database
written by two processes with `BEGIN IMMEDIATE` (`src/db.ts`). The server is one process; the admin command line
is another that only writes the database. spekterm, the client, keeps a local inbox and today accepts items
into it from Slack and from its own agents (`../spekterm/src/main/intake-schema.ts`: body limits 4,000 and
20,000, measured in UTF-16 code units after normalising). See proposal.md for why.

## Goals / Non-Goals

**Goals:**
- A handoff ends up in exactly one of the recipient's inboxes, even across reconnects, restarts and lost
  answers, in the common cases; the rare case where it cannot be exactly one is detected and the client told.
- The server holds handoff text no longer than it must.
- M2 can add statuses back to the sender as new events on rows that already exist, without reworking
  delivery.

**Non-Goals:**
- Telling the sender anything after the send answer (M2).
- Choosing among a recipient's devices by anything better than "most recently connected" (for example the
  one the user is typing on); spekterm does not report activity.
- A device that keeps its connection open but never acknowledges holds its offers until it disconnects.
  This is a client bug, or a full inbox (see the client rules); the handoff is offered elsewhere as soon as
  that connection ends. A `handoff.release` operation to hand an offer back is left for when a client needs it.
- Event resumption (`hello` carrying the last seen event, PRD §8.2; deferred to M1 by server-foundation). For
  incoming handoffs the lease and re-offer replace it: what a device has not acknowledged is offered again. M2's
  status events to the sender are not rows a recipient acknowledges, so M2 has to give them their own
  guarantee (an acknowledgement or a resume point); nothing here decides it.
- Bounding how long metadata rows are kept (PRD §9). In M1 a row's only end states are `delivered` and
  `expired`, and M2 adds `taken` / `declined` / `done` to the same rows; the retention period for metadata is
  set in M2, once final states exist. Until then rows (without text) stay.

## Decisions

### D1. Offer to one device at a time (a lease), acknowledge after storing

Each pending handoff is **leased** to at most one live connection of the recipient. The device stores the item
in its inbox, then sends `handoff.received`; the first acknowledgement delivers it. If the leased connection
closes without acknowledging, the lease is released and the handoff is offered to the recipient's next
connected device.

*Alternatives:*
- *Send to every connected device; the first acknowledgement wins; the others drop it.* Every device would have
  to hold the item somewhere invisible until its acknowledgement is answered, or show it and then retract it
  (a notification already fired on two machines). With the lease, a device only ever shows what it was
  offered alone.
- *Acknowledge first, store after.* A crash between the answer and the write loses the handoff. Storing first
  turns the same crash into, at worst, a repeat on the same device (acknowledged again without being shown) or, if the lease then moves,
  a second copy elsewhere, which the late acknowledgement reveals with `HANDOFF_DELIVERED_ELSEWHERE`.

Leases are released only when the connection closes, not on a timer: a timer would let two devices hold the
same item while both are alive. A half-open connection is ended by keepalive within 60 seconds.

**The client rules that make this hold** (spec "Receiving rules for clients"): store hidden, acknowledge, show
only after `{}`; on an id already stored, acknowledge again without showing; after reconnecting, acknowledge
again whatever was not answered; delete the copy on `HANDOFF_DELIVERED_ELSEWHERE` / `HANDOFF_EXPIRED`. The
re-acknowledgement matters: a device that silently dropped a repeat would hold the lease without ever
acknowledging, and when it later disconnected the handoff would move to a second device that nobody would
ever tell. Showing only after `{}` means a copy that turns out to be elsewhere is removed before the user saw
it, in almost every case.

Leases live in the server's memory. After a restart there are none, and every pending handoff is offered again
on the next authentication; a device that stored one before the restart acknowledges the repeat again without showing it.

**Which device**: the connection that authenticated most recently, as the best available guess at the machine
in use (PRD §13.1 accepts that it can be wrong). A device that authenticates later does not take over a lease
already held by a live connection.

### D2. Delivery coordination in `src/delivery.ts`

A `Delivery` object owned by `server.ts`:

- `ready: Map<memberId, Connection[]>` — connections whose `join` / `hello` answer has been sent, in the order
  they became ready. A connection that has authenticated but whose answer is not out yet is not in it;
- `leases: Map<handoffId, Connection>`, and on each `Connection` the set of handoff ids offered on it (so a
  handoff is never offered twice on one connection);
- `onReady(connection)` — called by the connection synchronously in the same message handler, right after the
  `#send` of a successful `join` / `hello` answer, **unconditionally** (whether or not the socket could still be
  written) — adds it to `ready` and offers every pending handoff of that member that has no lease on an open
  connection, oldest first. Because the whole path from `hello` to `onReady` runs in one tick, no other
  connection can become ready in between;
- `onSent(handoff)` — offers it to the recipient's most recently ready connection, if any;
- `onClosed(connection, reason)` — removes it from `ready`, releases its leases, and — **unless the reason is
  "replaced"** (4006) or the server is closing — offers every pending handoff of that member without a lease on
  an open connection (not only the ones it released) to the member's most recently ready connection. On
  "replaced" it offers nothing: the newer connection of the same device picks them up in its own `onReady`; and
  should that newer connection close before becoming ready, its own `onClosed` offers them;
- `onAcknowledged(handoffId)` — drops the lease;
- `closing` — set at the start of shutdown; while set, nothing is offered (otherwise closing connections one
  by one would offer each released lease to the next connection about to be closed).

Delivery never lets an exception escape: `onReady`, `onSent`, `onClosed` and the maintenance step run outside
the operation handler's `try` (in socket listeners and timers), where a throw would end the process. Each
handoff is offered inside its own `try`, and a failure is logged and leaves the handoff pending for the next
occasion.

The connection learns its member id at authentication (`Identity.member.id`), which `ready` is keyed by.

The replacement order is the reason for "ready": `hello` on the new connection closes the old one (4006)
synchronously inside the handler, before the answer is sent. If the released leases were offered right
there, they would either reach the new connection before its `hello` answer, or skip to another device.

Offering reads the row again inside the call (status `pending`, not expired) so a CLI removal or an expiry is
never offered. Delivery runs on Node's single thread; with `DatabaseSync` every step is synchronous, so offers,
acknowledgements and closes cannot interleave.

### D3. Events

`Connection` gains `sendEvent(kind, data)` writing `{ "t": "evt", "k", "d" }`. An acknowledgement that arrives
on a connection already closed (replaced, revoked) is dropped unanswered, as any frame there; the device
acknowledges again after reconnecting (client rule). `src/protocol.ts` exports
`EVENT_KINDS = ['handoff.incoming']`, which the protocol document test compares with the document. M2 adds
`handoff.status`.

### D4. Schema version 2

```
handoffs (
  id TEXT PRIMARY KEY,                 -- h_ + 32 hex
  client_id TEXT NOT NULL,
  sender_member_id TEXT NOT NULL REFERENCES members(id),
  sender_device_id TEXT NOT NULL REFERENCES devices(id),
  recipient_member_id TEXT NOT NULL REFERENCES members(id),
  enc TEXT NOT NULL,
  title TEXT,                          -- NULL once delivered or expired
  body TEXT,                           -- NULL once delivered or expired
  request_hash BLOB NOT NULL,          -- recognises a resend
  status TEXT NOT NULL,                -- pending | delivered | expired
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  delivered_device_id TEXT REFERENCES devices(id),
  ended_at INTEGER,                    -- delivered or expired
  UNIQUE (sender_member_id, client_id)
)
INDEX (recipient_member_id, status, created_at)
INDEX (sender_member_id, created_at)
```

`request_hash` is SHA-256 over the canonical JSON of `[to (lowercased), enc, title, body]`, so a resend is
recognised after the text itself is gone. It is not salted: an operator could confirm a guess of a very short
text (a body of "yes") against it. The documentation therefore says the text is deleted, not that nothing about
it remains. M2 adds statuses (`taken`, `declined`, `done`) and the report to this
table.

### D5. Sending in one immediate transaction

`handoff.send` validates parameters first (no database), then in one `BEGIN IMMEDIATE`: looks up an earlier
row with the same `(sender, clientId)` (→ duplicate or `HANDOFF_ID_REUSED`), resolves the recipient
(`RECIPIENT_UNKNOWN` / `RECIPIENT_IS_SELF`), counts the sender's rows created in the last hour
(`RATE_LIMITED`), and inserts. The window at time `t` holds the sender's rows with `created_at > t − 1 h`;
with `n` rows in it and limit `L`, `retryAt` is the `(n − L + 1)`-th oldest row's `created_at` + 1 h (with
`n = L` that is the oldest; with `n > L`, after the limit was lowered, a later one). At exactly `retryAt` that
row has left the window, so the send is accepted. Doing the count and the insert in the
same immediate transaction keeps two devices of one member from both slipping under the limit. The duplicate
check comes first, so a resend is answered even when the member is at the limit.

A duplicate's answer resolves `recipient` by the stored recipient member id, not by the handle sent: a handle
is freed when its member is removed and may belong to someone else by then.

Lengths are `string.length` (UTF-16 code units) on the text as received, the unit spekterm uses. Title and body
may be empty, as on one machine (spekterm defaults a missing title to `""`). Text that is not well-formed
UTF-16 (`String.prototype.isWellFormed()` false) is refused: SQLite would store a lone surrogate as U+FFFD,
which would alter the text (measured). The server
does not normalise: spekterm normalises on the sending side before showing the text for confirmation and again
on the receiving side as third-party text; the server's bound on the raw text is never looser than the
receiver's on normalised text.

### D6. Removing a member expires what waits for them

`removeMemberById` in `src/team.ts` (used by `member remove` and by `device.leave` from the last device) also
sets the member's pending handoffs to `expired` and clears their text, in the same transaction. Pending
handoffs the removed member **sent** are left alone and delivered.

### D7. Text deletion that holds on disk

Clearing the columns is not enough: SQLite keeps old content in free pages and in the write-ahead log.

- `PRAGMA secure_delete = ON` on every connection (server and CLI), so freed pages and cells are zeroed;
- a maintenance step every minute: expire overdue handoffs (`status = 'pending' AND expires_at <= now` →
  `expired`, text cleared), then `PRAGMA wal_checkpoint(TRUNCATE)`, which copies the WAL into the database and
  truncates the WAL file to zero. **The checkpoint runs with `busy_timeout = 0`** (restored afterwards): with
  the usual 5 seconds, a read transaction held by another process made the checkpoint block the whole server
  for 5 seconds and still fail (measured: 5005 ms, `busy: 1`); with 0 it returns busy at once and the next
  minute retries. A process that merely has the database open, without a transaction, does not block it
  (measured). Shutdown clears the maintenance interval together with the revocation sweep, before the
  database is closed.

`secure_delete` is set in `openDatabaseFile`, so the CLI's connections have it too; a recipient removed by the
CLI has their pending text cleared by the CLI's transaction, and the test covers that path. Truncating the WAL
returns its blocks to the file system without overwriting them; the promise is about the files in the data
directory, and the guide says so.

A test sends, acknowledges, runs the maintenance step, and scans every file in the data directory for the
title and body. Bodies of 20,000 characters use overflow pages; the test uses one so that freed overflow
pages are covered.

### D8. Rate configuration

`HANDOFF_RATE_PER_HOUR`, an integer 1–10000, default 30, read in `src/config.ts` and passed to the server. 30 an
hour is far above what a person confirms by hand (each send needs the user's confirmation on the desktop) and
low enough that a looping agent fills no one's inbox. The CLI shares `loadConfig`, so an invalid value stops it
too, with the same message; the CLI does not otherwise use it.

### D9. `team.members`

A read of active members ordered by handle, returning `id`, `handle`, `displayName`. Presence, device lists and
pushes on change are M3; until then spekterm asks again when it needs the list (on connect, before writing its
agent's introduction).

### D10. Logging

Log lines name the handoff id, the sender's and recipient's handles and the device ids: "handoff h_… from alex
to sam stored", "offered to d_…", "delivered to d_…", "expired". Never the title or the body.

## Risks / Trade-offs

- [A device crashes after storing and before acknowledging, and the lease moves] → two inboxes have the item;
  the first device's later acknowledgement is answered `HANDOFF_DELIVERED_ELSEWHERE` and it removes its copy.
  If that device never reconnects, the copy stays there; it is the user's own machine.
- [The most recently connected device is not the one in use] → the item lands on another of the user's
  machines (accepted in PRD §13.1).
- [A client that never acknowledges] → its offers are stuck while its connection lives. Mitigation: documented
  client rule; the lease moves when the connection ends.
- [The WAL truncate keeps failing because a CLI holds the database open] → the CLI's commands are short;
  `member list` and similar take milliseconds.
- [Rate counted per member, not per device] → a member's two agents share one budget, which is the point of a
  flood limit.
- [After a server restart, the first of a member's devices to reconnect takes every pending handoff] →
  "most recently ready" means little right after a restart; accepted.
- [A full inbox on the offered device] → the offer stays with that connection until the client can store it
  (client rule); another device with room does not get it meanwhile.
- [The title is gone from the server once delivered] → M2's sender list shows titles from the sending
  device's own copy; on the sender's other devices, or after reinstalling, a sent handoff appears without its
  title. Accepted for M2 to design around.

## Migration Plan

Schema migration 2 adds the `handoffs` table at startup; a database of version 1 is upgraded in place. An older
server refuses a version-2 database (the downgrade rule). Rollback: restore the backup taken before upgrading.
