# handoff-status Specification

## Purpose
Carries what happens to a handoff back to its sender: the recipient's device reports taken, declined or done
with the report, and every device of the sender learns each change, across disconnects, through a change feed
it resumes from the last change it stored; reports and records are kept for a bounded time.

## Requirements

### Requirement: Statuses

A handoff SHALL be in one of the statuses `pending`, `delivered`, `taken`, `declined`, `done` or `expired`.
`pending`, `delivered` and `expired` keep their meaning from `handoff-delivery`. A handoff SHALL move only along
these transitions:

| From | To | Cause |
|---|---|---|
| `pending` | `delivered` | acknowledged (`handoff.received`) |
| `pending` | `expired` | 30 days passed, or its recipient was removed |
| `delivered` | `taken`, `declined`, `done` | `handoff.update` |
| `taken` | `declined`, `done` | `handoff.update` |
| `done` | `done` with a newer report | `handoff.update` |

`declined` and `expired` SHALL be final. A delivered or taken handoff SHALL NOT expire.

#### Scenario: Taken then done
- **WHEN** Sam's desktop acknowledges a handoff, then reports `taken`, then `done` with a report
- **THEN** its status goes `pending` → `delivered` → `taken` → `done`

#### Scenario: Delivered handoff is not expired
- **WHEN** a handoff was delivered and 31 days pass without any report
- **THEN** its status is still `delivered`, and a report of `done` from the delivered-to device is accepted

### Requirement: Reporting a status

A device of the recipient SHALL report a status with `handoff.update` carrying `id`, `status` (`taken`,
`declined` or `done`) and, depending on the status, `payload` (`enc`, `text`):

- `taken`: no `payload` (one that is sent is ignored);
- `declined`: `payload` optional; `text` is the reason, at most 500 UTF-16 code units, and may be empty (no
  reason);
- `done`: `payload` required; `text` is the recipient agent's report, at most 4,000 UTF-16 code units and
  containing at least one character that is not white space.

`payload.enc` SHALL be `"none"`, and `text` SHALL be well-formed UTF-16, measured on the text as received and
not altered. A violation SHALL be answered `BAD_PARAMS` with `detail.field` (`id`, `status`, `payload`,
`payload.enc`, `payload.text`) and, for a length, `detail.limit`. On success the answer SHALL be
`{ "status": <the handoff's status now> }`.

#### Scenario: Taken
- **WHEN** Sam's desktop, to which a handoff was delivered, sends `{id, status: "taken"}`
- **THEN** the answer is `{status: "taken"}`

#### Scenario: Declined with a reason
- **WHEN** Sam's desktop sends `{id, status: "declined", payload: {enc: "none", text: "Kim owns billing now"}}`
- **THEN** the answer is `{status: "declined"}` and the reason is stored

#### Scenario: Report at the limit
- **WHEN** Sam's desktop reports `done` with a report of exactly 4,000 UTF-16 code units
- **THEN** it is accepted

#### Scenario: Report over the limit
- **WHEN** Sam's desktop reports `done` with a report of 4,001 UTF-16 code units
- **THEN** the server answers `BAD_PARAMS` with `detail.field: "payload.text"` and `detail.limit: 4000`

#### Scenario: Empty report
- **WHEN** Sam's desktop reports `done` with a report of only spaces and newlines
- **THEN** the server answers `BAD_PARAMS` with `detail.field: "payload.text"`

#### Scenario: Reason over the limit
- **WHEN** Sam's desktop reports `declined` with a reason of 501 UTF-16 code units
- **THEN** the server answers `BAD_PARAMS` with `detail.field: "payload.text"` and `detail.limit: 500`

### Requirement: Who may report

Only the device a handoff was delivered to SHALL be able to report its status. The server SHALL answer, checking
in this order:

- `HANDOFF_UNKNOWN` when no such handoff exists (never sent, or its record was deleted for retention) or it is
  not addressed to this device's member;
- `HANDOFF_EXPIRED` when it is `expired`, or still `pending` past its `expiresAt` (which the server then marks
  `expired`, as for an acknowledgement);
- `HANDOFF_NOT_DELIVERED` when it is still `pending` (the device has to acknowledge it first);
- `HANDOFF_DELIVERED_ELSEWHERE` when it was delivered to another device of the member.

Apart from that expiry, nothing SHALL be changed by a refused report.

#### Scenario: Other device of the recipient
- **WHEN** a handoff was delivered to Sam's desktop and Sam's laptop reports `taken`
- **THEN** the server answers `HANDOFF_DELIVERED_ELSEWHERE` and the status stays `delivered`

#### Scenario: Not acknowledged yet
- **WHEN** Sam's desktop reports `taken` for a handoff offered to it but not yet acknowledged
- **THEN** the server answers `HANDOFF_NOT_DELIVERED`

#### Scenario: Pending past its expiry
- **WHEN** a handoff's `expiresAt` has passed before the periodic check ran, and a device of the recipient
  reports `taken` for it
- **THEN** the server answers `HANDOFF_EXPIRED` and the handoff is `expired`

#### Scenario: The sender reports
- **WHEN** Alex's device reports `done` for a handoff Alex sent to Sam
- **THEN** the server answers `HANDOFF_UNKNOWN`

### Requirement: Repeated and late reports

A report SHALL be answered `{status}` without any change, and without a new sequence number, when:

- it repeats the current status with the same `payload` text (`taken` again; `declined` again with the same
  reason, an absent `payload` counting as an empty reason; `done` again with the same report), so that a device
  whose answer was lost can resend. Sameness SHALL be recognised also after the reason or report was deleted
  for retention;
- it is `taken` and the handoff is already `done`.

A `done` whose report differs from the current one SHALL replace the report. At most 10 reports SHALL be
accepted for one handoff; a further different report SHALL be answered `TOO_MANY_REPORTS` with
`detail.limit: 10`. Any other report on a `declined` or `done` handoff (`declined` with another reason,
`taken` or `done` after `declined`, `declined` after `done`) SHALL be answered `HANDOFF_FINISHED` with
`detail.status` giving the current status.

#### Scenario: Answer lost, report resent
- **WHEN** Sam's desktop reported `done` with report R, the answer was lost, and it reports `done` with R again
- **THEN** the answer is `{status: "done"}` and the sender's devices are told of it once

#### Scenario: Resent after the report was deleted
- **WHEN** a handoff's report R was deleted for retention and the delivered-to device reports `done` with R again
- **THEN** the answer is `{status: "done"}`, nothing changes, and the sender's devices are not told again

#### Scenario: A newer report
- **WHEN** a handoff is `done` with report R1 and Sam's desktop reports `done` with R2
- **THEN** the report is R2 and the sender's devices are told of the change

#### Scenario: Eleventh report
- **WHEN** a handoff has had 10 different reports and Sam's desktop reports an 11th
- **THEN** the server answers `TOO_MANY_REPORTS` with `detail.limit: 10`, and the report stays the 10th

#### Scenario: Done after declining
- **WHEN** Sam declined a handoff and the session's agent then reports `done`
- **THEN** the server answers `HANDOFF_FINISHED` with `detail.status: "declined"`

#### Scenario: Declined after being taken
- **WHEN** Sam's desktop reported `taken` and later `declined` with a reason
- **THEN** the status is `declined`

### Requirement: Dismissing is not reported

The protocol SHALL have no status for a recipient who dismissed a handoff without declining it. A handoff that
the recipient dismissed SHALL stay `delivered` (PRD §13.1).

#### Scenario: Dismissed
- **WHEN** Sam removes a delivered handoff from the inbox without declining
- **THEN** Sam's spekterm sends no `handoff.update`, and Alex's devices see it as `delivered`

### Requirement: Change sequence

Every change to a handoff — being sent, delivered, taken, declined, done (including a newer report), expired, or
its recipient being removed from the team (in any status) — whether made by the server or by the admin command
line, SHALL give the handoff a new sequence number, a
positive integer greater than every sequence number given before on this server. A repeated report that
changes nothing SHALL NOT give a new one. Deleting a report or a record for retention SHALL NOT give one.

#### Scenario: Expired by the admin command line
- **WHEN** the admin command line removes Sam while a handoff from Alex to Sam is pending
- **THEN** the handoff becomes `expired` with a sequence number greater than any before

#### Scenario: Recipient removed after taking
- **WHEN** Sam took a handoff from Alex and the admin then removes Sam
- **THEN** the handoff stays `taken` and takes a new sequence number, and its record carries `to.removed: true`

### Requirement: Status records

A status record SHALL describe a handoff the member sent, in its current state:
`{ "seq": number, "id": string, "clientId": string, "to": { "id", "handle", "displayName", "removed" }, "sentFrom": string,
"status": string, "sentAt": number, "expiresAt": number, "changedAt": number, "deliveredAt"?: number,
"reports"?: number, "payload"?: { "enc": "none", "text": string } }`.

- `seq` is the handoff's latest sequence number; `changedAt` the time of its latest change;
- `to` is the recipient, also after they were removed from the team; `removed` (boolean) says whether they were;
  `handle` and `displayName` may lag a rename, which alone gives no new `seq`;
- `sentFrom` is the id of the sender's device that sent it;
- `deliveredAt` is present once it was delivered;
- `payload` is present when the handoff is `declined` with a non-empty reason or `done`, and the text has not
  been deleted for retention; its `text` is the reason or the latest report;
- `reports` is present when the handoff is `done`: how many reports were accepted.

A status record SHALL NOT carry the handoff's title or body.

#### Scenario: Done
- **WHEN** a handoff from Alex to Sam is `done` with report R
- **THEN** its record carries `status: "done"`, `to.handle: "sam"`, `reports: 1`, `payload.text` R, and no title

### Requirement: Syncing the sender's handoffs

An authenticated device SHALL be able to ask for the handoffs its member sent that changed after a sequence
number with `handoff.sync` carrying `after` (a non-negative integer; absent means 0). The answer SHALL be
`{ "records": [StatusRecord], "more": boolean, "latest": number, "reset": boolean }`:

- `records` are the member's sent handoffs whose sequence number is greater than `after`, in increasing order of
  `seq`: at most 100, and together at most 200 KiB of UTF-8 JSON, except that the first record is always
  included;
- `more` is `true` when there are further records; the client asks again with `after` set to the last
  record's `seq`;
- `latest` is the highest sequence number given on the server so far;
- when `after` is greater than `latest` (the server's data was restored from an older backup), the server SHALL
  answer as for `after: 0` with `reset: true`; otherwise `reset` is `false`.

`records` and `latest` SHALL be read from one consistent state of the database, so that no change below `latest`
is missing from `records` because another process committed it while the answer was being made. A non-integer
or negative `after` SHALL be answered `BAD_PARAMS` with `detail.field: "after"`.

#### Scenario: First sync on a new device
- **WHEN** Alex joins with a second device and sends `handoff.sync` with `after: 0`
- **THEN** the answer lists every handoff Alex sent that the server still keeps, each in its current state

#### Scenario: Resume after being offline
- **WHEN** Alex's desktop stored records up to `seq` 40 and disconnected, and meanwhile one handoff was taken
  and then done
- **THEN** `handoff.sync` with `after: 40` returns that handoff once, as `done` with its report

#### Scenario: Paged
- **WHEN** Alex has 250 records after `after`
- **THEN** the first answer carries 100 records and `more: true`, and asking again from the last `seq` returns
  the rest

#### Scenario: Paged by size
- **WHEN** Alex has 50 `done` records whose reports are 4,000 CJK characters each
- **THEN** each answer's records stay within 200 KiB of UTF-8 JSON, and paging returns all 50

#### Scenario: Cursor from a newer state
- **WHEN** the client sends `after: 500` and `latest` is 300
- **THEN** the answer carries `reset: true` and the records from the beginning

### Requirement: Status events

A connection is **subscribed** while its latest successful `handoff.sync` answer said `more: false`; an error
answer leaves it as it was. Its starting point is
the `seq` of the last record of that answer or, with no records, the `after` it sent (0 when the answer said
`reset: true`). A subscribed connection SHALL receive a `handoff.status` event, carrying a status record as its
data, for every handoff its member sent whose `seq` becomes greater than what the connection was last given
(its starting point, or the last event's `seq`), including changes made by the admin command line, in
increasing order of `seq`, without gaps that a later event would hide. The server SHALL send these events to
every subscribed connection of the member, and only after the answer to the request that caused the change. A
change made by the admin command line SHALL reach subscribed connections within 10 seconds. Before sending an
event to a connection, the server SHALL check that its device is still not revoked; if it is, it SHALL close
that connection with 4004 instead. If the server cannot bring a subscribed connection up to date (an internal
failure), it SHALL close that connection with 1011, so that the client reconnects and syncs again, rather than
leave it behind. A connection that is not subscribed SHALL NOT receive `handoff.status`
events.

#### Scenario: Taken while the sender is connected
- **WHEN** Alex's desktop has synced, and Sam's desktop reports `taken`
- **THEN** Alex's desktop receives a `handoff.status` event with `status: "taken"` within a second

#### Scenario: Two devices of the sender
- **WHEN** Alex's desktop and laptop have both synced, and Sam reports `done`
- **THEN** both receive the event, each carrying `sentFrom` the device that sent it

#### Scenario: Own send
- **WHEN** Alex's desktop has synced and sends a handoff
- **THEN** it receives the send answer first and then a `handoff.status` event with `status: "pending"` for it

#### Scenario: Recipient removed by the admin
- **WHEN** Alex's desktop has synced and the admin command line removes Sam while Alex's handoff to Sam is
  pending
- **THEN** within 10 seconds Alex's desktop receives a `handoff.status` event with `status: "expired"`

#### Scenario: Expired by time
- **WHEN** a handoff from Alex has been pending for 30 days and Alex's desktop is connected and synced
- **THEN** Alex's desktop receives a `handoff.status` event with `status: "expired"` within a minute

#### Scenario: Changed while the sync answer was being made
- **WHEN** Alex's desktop sends `handoff.sync` and the admin command line commits a change to one of Alex's
  handoffs while the server is making the answer
- **THEN** the change reaches the desktop exactly once, in the answer or as an event

#### Scenario: Not synced
- **WHEN** Alex's desktop authenticated but has not sent `handoff.sync`, and Sam reports `taken`
- **THEN** Alex's desktop receives no event; its next `handoff.sync` returns the change

### Requirement: Sending rules for clients

`docs/protocol.md` SHALL state the rules a sending client follows to keep its Sent list, which the requirements
above rely on:

- after every `join` or `hello`, call `handoff.sync` from the last stored `seq` until `more: false`;
- store a record durably before storing its `seq` as the last seen; a record replaces any earlier one with the
  same `id`; ignore a record whose `seq` is not greater than the stored one for that `id` (except during a reset);
- on `reset: true`, treat the records from that answer up to the next answer with `more: false` as the server's
  whole list (records it no longer has may be kept, marked as unknown to the server); remember durably that such a
  reset is in progress, and if the paging is interrupted, sync again from 0 to finish it; while it is in progress,
  a record replaces the stored one with the same `id` whatever its `seq`, and the last seen `seq` is set to each
  page's last `seq` rather than kept as the highest;
- a record for a handoff this device did not send (another device of the member, or a reinstall) has no title:
  show it without one;
- notify the user of `done`, `declined` and `expired` only on the device named by `sentFrom`; the member's other
  devices update their list without notifying;
- the server forgets a handoff 90 days after its last change and its reason or report 30 days after it was
  written; the client may keep its copies longer;
- show a recipient with `to.removed: true` as no longer on the team.

And the rules a receiving client follows to report:

- report only for a handoff whose acknowledgement was answered `{}`, from that device; on `HANDOFF_NOT_DELIVERED`,
  acknowledge it again and then resend the report;
- send only well-formed UTF-16 (for example, `toWellFormed()` after normalising) within the limits, so that a
  report the client accepted is not refused;
- send the reports of one handoff one at a time, in order, each after the previous was answered; after a lost
  answer, send the same report again before any later one;
- report `taken` once a session for it has actually started (it cannot be taken back), `declined` only when the
  user chooses to decline, and `done` with the session agent's report; `taken` is optional, and a client that
  never reported it may go straight to `done` or `declined`;
- on `HANDOFF_FINISHED`, `HANDOFF_EXPIRED`, `HANDOFF_DELIVERED_ELSEWHERE`, `HANDOFF_UNKNOWN` or
  `TOO_MANY_REPORTS`, stop sending reports for that handoff.

#### Scenario: Rules documented
- **WHEN** a client developer reads `docs/protocol.md`
- **THEN** each rule above is stated with the fields and error codes it uses

### Requirement: How long reports and records are kept

The server SHALL delete a handoff's decline reason or report 30 days after it was written (for a report, after
the latest one), and SHALL delete a handoff's whole record 90 days after its last change. Within a minute of
either deletion, the deleted text SHALL no longer be present in any file of the data directory, with the same
exception for another process's transaction as in `handoff-delivery`. A deleted record SHALL no longer appear in
`handoff.sync`; a report for it SHALL be answered `HANDOFF_UNKNOWN`. Neither a reason nor a report SHALL be
written to the log.

#### Scenario: Report kept 30 days
- **WHEN** a report was written 30 days ago and a minute has passed
- **THEN** `handoff.sync` returns the handoff as `done` without `payload`, and the report's text appears in no
  file of the data directory

#### Scenario: Record kept 90 days
- **WHEN** a handoff's last change was 90 days ago and a minute has passed
- **THEN** `handoff.sync` from 0 no longer returns it

#### Scenario: Taken and never finished
- **WHEN** a handoff was taken 90 days ago and nothing happened since
- **THEN** its record is deleted, and a later report of it is answered `HANDOFF_UNKNOWN`

#### Scenario: Log
- **WHEN** a handoff is declined with a reason and another is done with a report
- **THEN** the log names the handoff ids, statuses and device ids, but contains neither the reason nor the report
