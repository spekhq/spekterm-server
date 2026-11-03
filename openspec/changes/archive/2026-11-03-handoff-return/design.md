## Context

M1 (`handoff-delivery`, archived 2026-11-03) stores a handoff, leases it to one of the recipient's connections,
records the acknowledgement (`delivered`) and expires what waits 30 days; title and body are cleared on
delivery or expiry and leave the data directory's files within a minute (`secure_delete` + WAL truncate, M1
design D7). The `handoffs` table (schema 2, `src/db.ts`) allows only `pending | delivered | expired` in a
`CHECK`. Two processes write the database (server, admin command line), each write in `BEGIN IMMEDIATE`.
`Delivery` (`src/delivery.ts`) pushes `handoff.incoming`; a revocation sweep runs every 5 seconds and a
maintenance step every minute (`src/server.ts`).

M1's design left four questions to M2: a delivery guarantee for status events (they are not rows a recipient
acknowledges, so the lease does not apply), a bound on metadata rows, titles being gone after delivery, and PRD
§13 open question 1. spekterm's completion report is at most 4,000 UTF-16 code units
(`spekterm/src/main/handoff-delivery.ts`, `MAX_REPORT_LENGTH`), and a handed-off session there may report again
after each later request.

## Goals / Non-Goals

**Goals:**
- Every device of the sender ends up with the current status of every handoff the member sent, across
  disconnects, server restarts, lost answers and changes made by the admin command line, without the server
  keeping per-device state.
- A recipient's lost answer can always be retried by resending the same report.
- Reports and records are kept for a bounded, documented time, and deleted text leaves the files.

**Non-Goals:**
- Telling the recipient anything about the sender (a removed sender, a sender who read the report).
- Every intermediate transition: a sender offline through `taken` and `done` sees only `done` (it is the state
  that matters; `changedAt` and `deliveredAt` say when).
- Keeping titles on the server for the sender's other devices (D9).
- Presence, directory pushes (M3), push notifications (PRD §4).
- Any spekterm-side behaviour beyond what the protocol document's client rules state; the spekterm M2 client is
  its own change in that repository.

## Decisions

### D1. Reports are a small state machine on the existing row

`handoff.update { id, status, payload? }` moves a row along `delivered → taken → done`, `delivered | taken →
declined`, `delivered → done`, and `done → done` (a newer report). Only the device in `delivered_device_id` may
report: that is where the session runs. Checks in order, inside one `BEGIN IMMEDIATE`: row exists and is
addressed to the member (`HANDOFF_UNKNOWN`); `expired`, or `pending` past `expiresAt` → `HANDOFF_EXPIRED` (the
overdue one is marked `expired`, with a `seq`, and committed before the error is raised, exactly as
`acknowledge` does; the publish after the answer then tells the sender); still `pending` →
`HANDOFF_NOT_DELIVERED`; another device → `HANDOFF_DELIVERED_ELSEWHERE`; then the transition table of the spec.
The expiry test applies only to `pending`: a delivered or taken handoff past its `expiresAt` is reported as
usual (and `acknowledge`, widened to the later statuses, keeps its "same device → `{}`" branch before the
expiry test).

- **Resend is a no-op**: the same status with the same text answers `{status}` and takes no sequence number, so a
  lost answer is retried by sending the same request. No `clientId` is needed: the request is identified by its
  content, and the client rule (one report at a time, in order) rules out an old report arriving after a newer
  one. `taken` on a `done` handoff is also answered without change: it can only be a stale resend.
- **Sameness is compared by hash**: `report_hash` is SHA-256 over the canonical JSON of `[status, enc, text]`, a
  `declined` without `payload` hashed as `["declined", "none", ""]`, so it equals one with an empty reason;
  sameness is decided before the 10-report cap, so resending the 10th report is still a no-op. The hash is kept until the record is deleted, so a resend after the text was deleted for retention
  (D8) is still recognised instead of counting as a new report (or, for a reason, `HANDOFF_FINISHED`). The same
  trade-off as M1's `request_hash`: unsalted, so the operator could confirm a guess of a very short reason; the
  operator could read it for its 30 days anyway, and the guide says a hash stays.
- **`done` may repeat with a different report**, which replaces the stored one: the same-machine handoff
  sends a report after each later request, and the sender's view should match. At most 10 per handoff
  (`report_count`), `TOO_MANY_REPORTS` beyond, so a looping agent cannot notify the sender without bound. Ten is
  far above a normal session (one report, perhaps a follow-up or two).
- **`taken → declined` is allowed**: the recipient may look at the work in a session and then decide not to do it,
  and saying so is what the sender needs. `declined` and `done` are otherwise final for each other
  (`HANDOFF_FINISHED`, `detail.status`).
- **The answer carries the status now** (`{status}`), so a client whose `taken` came after `done` learns it.

*Alternatives:* `done` final after the first report — simpler, but a follow-up report would have to be dropped
by the client silently; per-update `clientId` like `handoff.send` — not needed when the content identifies the
request; treating a report on a pending handoff as an implicit acknowledgement — a report can only follow a
shown item, which needs the acknowledgement answered first (receiving rule 1), so it would only hide a client
bug.

### D2. Text of reports

`payload: { enc: "none", text }`, as `handoff.send`'s payload, so end-to-end encryption later (PRD §8.4) is a new
`enc` value here too. Reason ≤ 500 UTF-16 code units (PRD: "a sentence of reason"; generous for one sentence,
short enough to read in a notification), may be empty or absent (both mean "no reason"). Report 1–4,000 code
units with at least one non-white-space character (`/\S/u`), the unit and limit of spekterm's completion report,
so a report spekterm accepts is never refused here. Well-formed UTF-16 required, text not altered — same rules
and reasons as M1 design D5. spekterm measures its 4,000 after normalising and the server measures the text as
sent, which is the normalised text, so lengths agree; but spekterm's normalisation iterates by code point and
keeps a lone surrogate, which the server refuses. The client rule therefore says to make the text well-formed
(`toWellFormed()`) before checking its limits, and the spekterm handoff carries that.

### D3. A change feed: one sequence number per row, not an event log

Every write that changes a handoff sets its `seq` to the next value of one server-wide counter and its
`changed_at` to now. `handoff.sync { after }` returns the member's sent rows with `seq > after` in `seq` order,
each as its **current** state. The client stores the last `seq` it stored; after every `hello` it syncs from
it. A row that changed twice while the client was away appears once, with its latest `seq`.

This gives each of the sender's devices its own resume point without the server keeping anything per device, and
needs no acknowledgement. A record can still reach a client twice (it changed between two pages, or a sync answer
and an event overlap); the client rule "ignore a record whose `seq` is not greater than the one stored for that
`id`" makes that harmless. The data is the `handoffs` table itself, so retention of
records (D8) is retention of the feed.

*Alternatives:*
- *Acknowledged events, like `handoff.received`* — the server would keep one queue per sender device; a device
  added later, or reinstalled, would have nothing to start from; and acknowledgement plus lease is the machinery
  for "exactly one device", which is not what statuses need (every device of the sender may show them).
- *An append-only event table* — every intermediate transition, but a second table to bound and to scan for
  text, for transitions no client needs.
- *`hello` carrying the resume point* (PRD §8.2's outline) — the answer could grow to a member's whole history
  (frame limits, a slow `hello`), and a device that only receives would pay for it. A separate operation can be
  paged and called when the client is ready. PRD §8.2 is updated.

### D4. The counter and why the order holds across processes

`CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)` with one row `handoff_seq`.
`nextSeq(db)` is `UPDATE counters SET value = value + 1 WHERE name = 'handoff_seq' RETURNING value`, in `db.ts`
(both `handoffs.ts` and `team.ts` call it; putting it in either would make them import each other). Each changed
row takes its own value, also in multi-row changes (expiry, member removal), so no two rows share a `seq`
(a client storing one of two rows with the same `seq` and then crashing would skip the other).

Every value is taken inside a `BEGIN IMMEDIATE` transaction, and those are serialised across both processes:
when any process reads `seq > x`, every lower value has been committed or rolled back (a rolled-back value is a
harmless gap). A reader therefore never sees `seq` 12 before 11 is visible, which is what makes "the last
stored `seq`" a correct resume point. `seq` has a unique index, which makes `seq > x` cheap.

### D5. Pushing changes: `src/feed.ts`

A `Feed` object owned by `server.ts`, beside `Delivery`:

- `#subscribers: Map<memberId, Map<FeedTarget, cursor>>` — subscribed connections, each with the highest `seq`
  it has been given;
- `subscribe(target, cursor)` / `unsubscribe(target)` — called by the `handoff.sync` handler as its last step,
  after the answer has been built, so an error answer leaves the subscription as it was: `more: false`
  subscribes with **cursor = the `seq` of the answer's last record, or the effective `after` when it has none**
  (the `after` sent, or 0 on `reset: true`); `more: true` unsubscribes, so a client that pages again gets events
  only after its last page. Never `latest`: a row of this member committed by another process between the read
  and `latest` would then be skipped for good;
- `#latestSeen` — the counter value at the last successful `publish()`, initialised at startup, used only to skip
  work when nothing changed;
- `publish()` — reads the counter; if it equals `#latestSeen`, returns. Otherwise, **for each subscriber**, reads
  `sender_member_id = ? AND seq > cursor ORDER BY seq` (the `(sender_member_id, seq)` index) and sends each row
  as a `handoff.status` event, raising that subscriber's cursor after each send. Before sending to a connection it
  checks `isDeviceActive` and closes a revoked one with 4004 instead (a record carries third-party text).
  `#latestSeen` advances to the counter value read at the start only if every subscriber still connected was
  handled without an error; otherwise the next call tries again, and each subscriber resumes from its own cursor,
  so nothing is skipped. A subscriber whose read or send throws is logged and **closed with 1011** (a new close
  code: "internal error, reconnect with backoff"): a fault that repeats (a row that cannot be turned into a
  record) would otherwise hold that connection behind it for good, re-queried and re-logged on every request.
  After reconnecting, the client syncs from its stored `seq` and gets an `INTERNAL` answer it can see. The loop
  runs over a copy of the subscribers, since closing a connection removes it from the map;
- `onClosed(target)` — forgets it.

Every query that decides what a subscriber gets is one statement, so it sees one snapshot; by D4, every `seq`
below the highest it sees is already committed. Cursors only rise after a send, so nothing below a cursor was
skipped.

`publish()` runs after the answer to every authenticated request has been sent (success or error — a refused
acknowledgement or report can commit an expiry), at the end of each revocation sweep (every 5 s; this is how
changes made by the admin command line arrive, within 10 s), and after each maintenance step. Running after the
answer keeps the sender's own `pending` event behind its `handoff.send` answer. Like `Delivery`, it never throws.

**The sync answer reads `records` and `latest` in one read transaction** (`BEGIN` … `COMMIT`, deferred, no
write lock): measured in review with two `DatabaseSync` connections on one WAL file, reading rows and then the
counter in two statements missed a row the other connection committed in between (`records [1,2] latest 3`);
inside one read transaction both came from the same snapshot (`records [1,2,3] latest 3`). The handler then
subscribes in the same synchronous call; a change committed after that snapshot has a higher `seq` than the
cursor and is pushed by the next `publish()`.

### D6. Paging the sync

At most 100 records per answer, and records are added only while their size, **`Buffer.byteLength(JSON.stringify(
record), 'utf8')` summed**, stays within 200 KiB, so the answer frame stays under 256 KiB (apart from the request
`id` the client chose), the limit clients already apply in the other direction. Bytes, not `string.length`: a
report of 4,000 CJK characters is 4,000 code units but about 12 KB, and counting units would let a page reach
about 560 KB (measured in review). One record is at most about 24 KiB (a 4,000-unit report in which every unit is a control character escaped as `\u00XX`, 6 bytes), so at least eight fit;
the first record is always included. `latest` is the counter's value; `after > latest` can only mean the
database was restored from an older backup, and the answer starts from 0 with `reset: true` (Risks).

### D7. Schema 3

SQLite cannot change a `CHECK` in place, so migration 3 rebuilds the table: create `handoffs_new` with the
new columns and **every column, `REFERENCES` and the `UNIQUE (sender_member_id, client_id)` of schema 2**, copy,
drop, rename, recreate the indexes, create `counters`. A test compares `PRAGMA index_list` / `foreign_key_list`
of an upgraded database with a fresh one. Measured on Node 22.22 with
`node:sqlite`, inside the migration's `BEGIN IMMEDIATE` with foreign keys on: the copy keeps rows and
`foreign_key_check` is empty (nothing references `handoffs`). The dropped table's pages are zeroed by
`secure_delete`.

```
handoffs (
  … every column of schema 2 …,
  status TEXT NOT NULL CHECK (status IN ('pending','delivered','taken','declined','done','expired')),
  seq INTEGER NOT NULL UNIQUE,
  changed_at INTEGER NOT NULL,         -- last change; records are deleted 90 days after it
  report_enc TEXT,                     -- 'none' when report_text is set
  report_text TEXT,                    -- decline reason or latest report; NULL when none or deleted
  report_at INTEGER,                   -- when it was written; reason/report deleted 30 days after it
  report_hash BLOB,                    -- recognises a resent report after the text is deleted (D1)
  report_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (sender_member_id, client_id)             -- kept
)
INDEX (recipient_member_id, status, created_at)    -- kept
INDEX (sender_member_id, created_at)               -- kept: the hourly rate count
INDEX (sender_member_id, seq)                      -- sync
INDEX (changed_at)                                 -- record retention
INDEX (report_at) WHERE report_text IS NOT NULL    -- report retention
```

Existing rows get `seq` by `row_number() OVER (ORDER BY created_at, id)` and `changed_at =
coalesce(ended_at, created_at)`; the counter starts at the row count. So a database upgraded from 0.2.x
already has a feed, and its delivered rows' 90 days count from their delivery.

`ended_at` keeps its M1 meaning (left `pending`). `HandoffStatus` widens to the six statuses, which also widens
`handoff.send`'s duplicate answer (a resend after the handoff was taken answers `taken`).

### D8. Retention

The maintenance step becomes: expire overdue (M1) → clear `report_text` / `report_enc` where `report_at <= now −
30 d` → delete rows where `changed_at <= now − 90 d` → `publish()` → WAL truncate (M1). One `BEGIN IMMEDIATE`
each. Neither deletion takes a `seq`: a device that already has the record keeps its copy (the client rule says
it may), and one that syncs later simply does not get it.

- **30 days for reason and report**: PRD §9's default for "bodies and reports … after a final state". Counted
  from the latest report, since that is when the sender was last told.
- **90 days for the record**: PRD §9 says metadata for the Sent list is "kept longer, and bounded too". Three
  times the hold covers a quarter of follow-up, and keeps the table to at most 90 days of sends (≤ 30 an hour
  per member with the default rate). It is counted from the last change, so a handoff still `delivered` or `taken`
  is also bounded: a report arriving after that is `HANDOFF_UNKNOWN`. A pending handoff can never reach it (it
  expires at 30 days, which is a change).
- Both are fixed, like the 30-day hold; a setting can be added when an operator asks.

The data-directory guarantee is M1's mechanism unchanged: `secure_delete` zeroes the cleared cells and freed
pages, the truncate empties the WAL.

### D9. Titles are not kept for the sender's other devices

The sending device has the title in its own Sent list; a record seen on another device of the sender (or after
reinstalling) has no title. Keeping the title until the record is deleted would make it the one piece of a
handoff's text the server keeps for 90 days, and break M1's simple promise ("title and body are deleted on
delivery"), for a list the user mostly reads on the machine they sent from. The record carries recipient,
times, status and the report, which is what following up needs. Accepted; revisit if users miss it.

### D10. The sender's agent (PRD §13 open question 1)

Decided for the protocol, and recorded in the PRD for the spekterm M2 client: the sending session learns the
**status** (taken, declined, done, expired) through its relations file, as it learns a same-machine child's
state. The **report and the decline reason are third-party text** — written by another person or their agent —
so spekterm does not put them into the agent's context on its own; the user sees them in the Sent list and can
pass them on. This is the same rule as for incoming handoffs (PRD §7.2). The server needs nothing for it beyond
the records: `clientId` and `id` let spekterm find the session that sent the handoff.

### D11. One notification per change, on the sending device

All of the sender's subscribed devices receive every event (every one keeps a Sent list). To avoid notifying the
user on every machine at once, the record carries `sentFrom` (the sending device's id) and the client rule says
to notify only there. No operation showed a member the ids of their other devices before; they are the member's
own devices and opaque, so showing them to that member alone is harmless.

### D12. Removed and revoked

- **Recipient removed**: their pending handoffs expire in `removeMemberById` (M1 D6), which now takes a `seq` per
  row, so senders learn it. Delivered or taken handoffs keep their status — nobody can report them any more, and
  inventing a status would tell the sender something that did not happen. Every retained handoff addressed to
  them, in any status, takes a new `seq` in the same transaction (bounded: 90 days of the senders' rate), and every
  record carries `to.removed` (read from `members.removed_at` when the record is built); without the new `seq` a
  device that synced before the removal would keep `removed: false` while one that synced after shows `true`. A
  display-name change (`member rename`) takes no `seq`: `to.displayName` is current as of the record's `seq`, and
  a client wanting the current name asks `team.members`. So a sender whose handoff
  sits at `delivered` sees that Sam left, instead of taking it as the "talk to Sam" cue of PRD §6.5.
- **Sender removed**: their connections close; the recipient can still report (the record is kept for its 90
  days, then deleted).
- **The delivered device is revoked** (lost laptop): no other device may report (the session was on that
  machine). Accepted with the device-choice trade-off of PRD §13.1.

### D13. No hourly rate on reports

Reports are bounded per handoff by the state machine and the 10-report cap, and handoffs by the hourly send
rate, so reports from one member are bounded by 10 × the handoffs they received. A per-member report rate would
add a window table for no further protection.

### D14. Logging

"handoff h_… taken by device d_…", "declined by d_… (with a reason)", "done by d_… (report 3)",
"record of h_… deleted", "report of h_… deleted". Never the reason or the report; the log hygiene test covers
both.

## Risks / Trade-offs

- [Restored from an older backup] → the counter goes back. A client ahead of `latest` gets `reset: true` and a
  full list. One that is behind `latest` again by the time it syncs (the restored server made more changes than
  it lost) misses the changes between; restoring a backup loses data anyway, and the guide says so.
- [Sender offline during several transitions] → sees only the latest state; `taken` may never be seen if `done`
  came before the next sync. The record's `deliveredAt` and `changedAt` say when.
- [A record deleted while a device was offline 90 days] → that device keeps its stale copy; the client rule says
  records the server no longer has may be kept.
- [Publishing reads after every request] → a range read on the unique `seq` index of the rows changed since the
  last call, which is usually empty.
- [Notifications only on the sending device] → if that device is gone, the member's other devices show the
  change without notifying. Accepted: the Sent list still shows it.
- [Report text sits in the database 30 days] → the operator can read it (PRD §7.1, guide §5 updated).

## Migration Plan

Migration 3 runs at startup (D7); a database of version 2 is upgraded in place, an older server refuses a
version-3 database (the downgrade rule). Rollback: restore the backup taken before upgrading. Protocol stays
version 1 (draft); the new operations appear in `operations`, so a client can tell a 0.3 server from a 0.2 one.

## Open Questions

None for the server. The spekterm M2 client follows the client rules in `docs/protocol.md`.
