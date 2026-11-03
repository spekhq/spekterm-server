## MODIFIED Requirements

### Requirement: Resending does not duplicate

`clientId` SHALL be 1 to 64 characters of `A`–`Z`, `a`–`z`, `0`–`9`, `_` and `-`, chosen by the sender. When the
same member sends again with a `clientId` they used before, and the same `to` and `payload`, the server SHALL
answer with the existing handoff (its current `status`, which may be any status of `handoff-status`), the
recipient it was stored for, and `duplicate: true`, and SHALL NOT store or offer a second one. When `to` or
`payload` differ, it SHALL answer `HANDOFF_ID_REUSED`. This holds after the original was delivered, taken,
declined, done or expired, and when the member is at the rate limit, until the original's record is deleted for
retention (`handoff-status`, 90 days after its last change); a send after that is a new handoff.

#### Scenario: Answer lost, request resent
- **WHEN** a device's `handoff.send` was stored but its answer was lost, and the device sends the same request
  again on a new connection
- **THEN** the answer carries the same `handoff.id` and `duplicate: true`, and the recipient receives one
  handoff

#### Scenario: Resent after being taken
- **WHEN** a handoff was delivered and taken, and its sender resends the same request with the same `clientId`
- **THEN** the answer carries the same `handoff.id`, `status: "taken"` and `duplicate: true`

#### Scenario: Same id, different text
- **WHEN** a member sends a second handoff with an earlier `clientId` but a different body
- **THEN** the server answers `HANDOFF_ID_REUSED`

### Requirement: Acknowledging delivery

A device of the recipient SHALL acknowledge a handoff with `handoff.received` carrying its `id`. The first
acknowledgement of a pending handoff SHALL mark it `delivered` to that device and answer `{}`. An
acknowledgement from the device it was already delivered to SHALL also answer `{}`, whatever its status since
(`delivered`, `taken`, `declined` or `done`; `handoff-status`), and SHALL change nothing. An acknowledgement
from another device after it was delivered SHALL be answered `HANDOFF_DELIVERED_ELSEWHERE`. An acknowledgement
of a handoff that is expired — including a pending one past its `expiresAt` that the periodic check has not yet
marked — SHALL be answered `HANDOFF_EXPIRED`. A handoff that does not exist (never sent, or its record was deleted for
retention) or was not addressed to this device's member SHALL be answered `HANDOFF_UNKNOWN`. A delivered
handoff SHALL never be offered again.

#### Scenario: Acknowledged
- **WHEN** Sam's desktop receives the event, stores the item and sends `handoff.received`
- **THEN** the answer is `{}`, and neither of Sam's devices is offered the handoff again

#### Scenario: Acknowledgement answer lost
- **WHEN** the desktop's acknowledgement was recorded but its answer was lost, and it acknowledges again
- **THEN** the answer is `{}`

#### Scenario: Acknowledged again after being taken
- **WHEN** the desktop acknowledged a handoff and reported `taken`, and after reconnecting acknowledges it again
- **THEN** the answer is `{}` and the status stays `taken`

#### Scenario: Acknowledged again after 30 days
- **WHEN** the desktop acknowledged a handoff, reported `taken`, and acknowledges it again 31 days after it was
  sent
- **THEN** the answer is `{}` and the status stays `taken`

#### Scenario: Acknowledgement lost, offered again to the same device
- **WHEN** the desktop stored a handoff and sent `handoff.received`, the server never read it (the connection
  dropped), and on the desktop's next connection the handoff is offered again and the desktop acknowledges
- **THEN** the answer is `{}` and no other device is offered it

#### Scenario: Late acknowledgement from a device that crashed
- **WHEN** the laptop stored a handoff but crashed before acknowledging, the desktop then received and
  acknowledged it, and the laptop reconnects and acknowledges
- **THEN** the laptop's acknowledgement is answered `HANDOFF_DELIVERED_ELSEWHERE`

#### Scenario: Expired before acknowledging
- **WHEN** a handoff's `expiresAt` has passed and a device acknowledges it before the periodic check ran
- **THEN** the server answers `HANDOFF_EXPIRED`

#### Scenario: Someone else's handoff
- **WHEN** Alex's device acknowledges a handoff addressed to Sam
- **THEN** the server answers `HANDOFF_UNKNOWN`

### Requirement: The server keeps the text only while it waits

The server SHALL delete a handoff's title and body when it is delivered or expires, keeping only its id,
client id, sender, the sending device, recipient, times, status, the device it was delivered to, its sequence
number, its decline reason or report with its encryption marker and how many reports were accepted
(`handoff-status`), a hash that lets a resend be recognised
(requirement "Resending does not duplicate"), and a hash of the reason or report that lets a resent report be
recognised after its text was deleted. It SHALL delete what it keeps as `handoff-status` requirement
"How long reports and records are kept" says. Within a minute of a deletion, the deleted text SHALL no longer
be present in any file of the data directory (including free database pages and the write-ahead log), unless
another process holds a read or write transaction on the database at that moment, in which case it SHALL
happen at the next minute that none does. Waiting for another process SHALL NOT block the server. Neither the
title nor the body SHALL be written to the log.

#### Scenario: After delivery
- **WHEN** a handoff has been acknowledged and a minute has passed
- **THEN** its title and body appear in no file of the data directory

#### Scenario: After expiry
- **WHEN** a handoff expired (by time, or because the admin command line removed its recipient) and a minute
  has passed
- **THEN** its title and body appear in no file of the data directory

#### Scenario: After an upgrade
- **WHEN** a server of this change starts on a database written by the previous version, holding pending and
  delivered handoffs
- **THEN** the pending ones keep their title and body until they are delivered or expire, and the others still
  have none

#### Scenario: Another process reading
- **WHEN** another process holds a read transaction on the database when the minute's clean-up runs
- **THEN** the clean-up returns at once without blocking the server, and completes at the next minute after
  the reader finished

#### Scenario: Log
- **WHEN** a handoff is sent, offered and acknowledged
- **THEN** the log names the handoff id, the sender and the recipient, but contains neither its title nor its
  body
