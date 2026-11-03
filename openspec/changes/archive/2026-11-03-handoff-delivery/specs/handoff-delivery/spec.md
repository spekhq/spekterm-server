## Purpose

Carries a handoff from one team member to another: sending it, holding it while the recipient is away,
offering it to exactly one of the recipient's devices, recording its delivery, expiring it, and keeping its
text no longer than needed.

## ADDED Requirements

### Requirement: Sending a handoff

An authenticated device SHALL be able to send a handoff with `handoff.send` carrying `clientId`, `to` (the
recipient's handle) and `payload` (`enc`, `title`, `body`). On success the server SHALL store it as `pending`
and answer with `handoff` (`id`, `status`, `sentAt`, `expiresAt`), `recipient` (`id`, `handle`,
`displayName`, `deviceCount`) and `duplicate: false`. `id` is assigned by the server; `expiresAt` is 30 days
after `sentAt`; `deviceCount` is the number of the recipient's devices that are not revoked.

#### Scenario: Send to a teammate
- **WHEN** Alex's device sends `{clientId: "c1", to: "sam", payload: {enc: "none", title: "Billing change", body: "…"}}`
- **THEN** the answer carries a new `handoff.id`, `status: "pending"`, `recipient.handle: "sam"`, and
  `duplicate: false`

#### Scenario: Recipient without devices
- **WHEN** Alex sends to `sam`, a member whose devices are all revoked
- **THEN** the handoff is accepted and held, and the answer carries `recipient.deviceCount: 0`

### Requirement: Recipients

The recipient SHALL be a member of the team who has not been removed, other than the sender. The handle is
compared case-insensitively. An unknown or removed handle SHALL be refused with `RECIPIENT_UNKNOWN`; the
sender's own handle SHALL be refused with `RECIPIENT_IS_SELF`.

#### Scenario: Unknown recipient
- **WHEN** a device sends to `nobody`
- **THEN** the server answers `RECIPIENT_UNKNOWN` and stores nothing

#### Scenario: Sending to oneself
- **WHEN** Sam's laptop sends to `sam`
- **THEN** the server answers `RECIPIENT_IS_SELF`

### Requirement: Handoff text limits

`payload.enc` SHALL be `"none"`. `payload.title` SHALL be a string of at most 200 UTF-16 code units and
`payload.body` a string of at most 20,000 UTF-16 code units, measured on the text as received; either may be
empty. These are the unit and the limits spekterm applies to a same-machine handoff's title and body. Both SHALL
be well-formed UTF-16 (no lone surrogates). Anything else SHALL be refused with `BAD_PARAMS`, `detail.field`
naming the field (`payload.enc`, `payload.title`, `payload.body`) and, for a length, `detail.limit` giving the
limit. The server SHALL NOT alter the text.

#### Scenario: Body at the limit
- **WHEN** a device sends a body of exactly 20,000 UTF-16 code units
- **THEN** the handoff is accepted

#### Scenario: Body over the limit
- **WHEN** a device sends a body of 20,001 UTF-16 code units
- **THEN** the server answers `BAD_PARAMS` with `detail.field: "payload.body"` and `detail.limit: 20000`

#### Scenario: Lone surrogate
- **WHEN** a device sends a title containing a high surrogate not followed by a low surrogate
- **THEN** the server answers `BAD_PARAMS` with `detail.field: "payload.title"`

#### Scenario: Encrypted payload not supported yet
- **WHEN** a device sends `payload.enc: "x25519"`
- **THEN** the server answers `BAD_PARAMS` with `detail.field: "payload.enc"`

### Requirement: Resending does not duplicate

`clientId` SHALL be 1 to 64 characters of `A`–`Z`, `a`–`z`, `0`–`9`, `_` and `-`, chosen by the sender. When the
same member sends again with a `clientId` they used before, and the same `to` and `payload`, the server SHALL
answer with the existing handoff (its current `status`), the recipient it was stored for, and
`duplicate: true`, and SHALL NOT store or offer a second one. When `to` or `payload` differ, it SHALL answer
`HANDOFF_ID_REUSED`. This holds after the original was delivered or expired, and when the member is at the
rate limit.

#### Scenario: Answer lost, request resent
- **WHEN** a device's `handoff.send` was stored but its answer was lost, and the device sends the same request
  again on a new connection
- **THEN** the answer carries the same `handoff.id` and `duplicate: true`, and the recipient receives one
  handoff

#### Scenario: Same id, different text
- **WHEN** a member sends a second handoff with an earlier `clientId` but a different body
- **THEN** the server answers `HANDOFF_ID_REUSED`

### Requirement: Hourly rate per member

The server SHALL accept at most `HANDOFF_RATE_PER_HOUR` new handoffs from one member in any 60-minute window,
across all of the member's devices: a send at time `t` counts the member's handoffs sent after `t − 60 min`.
A send over the limit SHALL be refused with `RATE_LIMITED`, with `detail.retryAt` (milliseconds since the
epoch): the earliest time at which the same send would be accepted. A resend answered with `duplicate: true`
SHALL NOT count.

#### Scenario: A looping agent
- **WHEN** the rate is 30 and a member's agent sends a 31st handoff within an hour
- **THEN** the server answers `RATE_LIMITED` with `detail.retryAt`, and the recipient's queue holds 30

#### Scenario: Retry at the given time
- **WHEN** a send was refused with `detail.retryAt: T` and the member sends again at exactly `T`
- **THEN** the handoff is accepted

#### Scenario: Limit lowered
- **WHEN** a member sent 30 handoffs in the last hour and the server restarts with a rate of 10
- **THEN** a send is refused, and `detail.retryAt` is when the 21st-newest of those 30 leaves the window

### Requirement: Offering to one device at a time

The server SHALL offer each pending handoff to at most one of the recipient's connections at a time, by
sending it a `handoff.incoming` event with `id`, `from` (`id`, `handle`, `displayName`), `payload` (`enc`,
`title`, `body`), `sentAt` and `expiresAt`. A connection is **ready** once the answer to its successful `join`
or `hello` has been sent; events SHALL be sent only to ready connections. Among a recipient's ready
connections the server SHALL choose the one that became ready most recently. It SHALL offer:

- when the handoff is sent and a connection of the recipient is ready;
- when a connection of the recipient becomes ready: every pending handoff not currently offered to another
  open connection, oldest first;
- when the connection a handoff was offered on closes before it was acknowledged: to the recipient's most
  recently ready connection, if any — except that when it closed because a newer connection of the **same
  device** replaced it, the handoff waits for that newer connection to become ready.

A handoff SHALL NOT be offered twice on the same connection. While the server is shutting down it SHALL offer
nothing.

#### Scenario: Recipient connected
- **WHEN** Sam's desktop is connected and Alex sends to `sam`
- **THEN** Sam's desktop receives a `handoff.incoming` event for it within a second

#### Scenario: Recipient offline
- **WHEN** Alex sends to `sam` while no device of Sam's is connected, and Sam's desktop connects an hour later
- **THEN** Sam's desktop receives the `handoff.incoming` event after its `hello` answer

#### Scenario: Two devices connected
- **WHEN** Sam's desktop and laptop are both connected, the laptop became ready last, and Alex sends to `sam`
- **THEN** only the laptop receives the event

#### Scenario: Offered device goes away
- **WHEN** the laptop received the event and its connection closes before acknowledging, while the desktop is
  connected
- **THEN** the desktop receives the event

#### Scenario: Offered device reconnects and replaces its old connection
- **WHEN** the laptop received the event, its connection went half-open, and the laptop connects again while
  the desktop is connected
- **THEN** the event is sent to the laptop's new connection after its `hello` answer, and the desktop does
  not receive it

#### Scenario: Shutdown
- **WHEN** the server shuts down while Sam's laptop holds an offer and the desktop is connected
- **THEN** the desktop is not offered it before the connections close

### Requirement: Acknowledging delivery

A device of the recipient SHALL acknowledge a handoff with `handoff.received` carrying its `id`. The first
acknowledgement of a pending handoff SHALL mark it `delivered` to that device and answer `{}`. An
acknowledgement from the device it was already delivered to SHALL also answer `{}`. An acknowledgement from
another device after it was delivered SHALL be answered `HANDOFF_DELIVERED_ELSEWHERE`. An acknowledgement of a
handoff that is expired — including one past its `expiresAt` that the periodic check has not yet marked —
SHALL be answered `HANDOFF_EXPIRED`. A handoff that does not exist or was not addressed to this device's member
SHALL be answered `HANDOFF_UNKNOWN`. A delivered handoff SHALL never be offered again.

#### Scenario: Acknowledged
- **WHEN** Sam's desktop receives the event, stores the item and sends `handoff.received`
- **THEN** the answer is `{}`, and neither of Sam's devices is offered the handoff again

#### Scenario: Acknowledgement answer lost
- **WHEN** the desktop's acknowledgement was recorded but its answer was lost, and it acknowledges again
- **THEN** the answer is `{}`

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

### Requirement: Receiving rules for clients

`docs/protocol.md` SHALL state the rules a receiving client follows, which the requirements above rely on:

- store an incoming handoff durably but **hidden**, then acknowledge it; show it and notify only once the
  acknowledgement is answered `{}`;
- on an incoming handoff whose id it already stored, do not show it again, but **acknowledge it again**;
- after reconnecting, acknowledge again every stored handoff whose acknowledgement was not answered;
- on `HANDOFF_DELIVERED_ELSEWHERE` or `HANDOFF_EXPIRED`, remove it from the inbox (it may keep a record of the
  id to recognise repeats);
- on `HANDOFF_UNKNOWN` for a handoff it stored (the server lost it, for example after being restored from a
  backup), or when the server's `operations` no longer list `handoff.received`, show it: the stored copy is the
  only one left;
- when it discards its credential (close 4004, or `AUTH_FAILED`), remove the handoffs it stored but never had
  acknowledged;
- when it cannot store an incoming handoff now (for example its inbox is full), keep the offer in memory and
  store and acknowledge it when it can; the handoff stays with this connection until then;
- keep a sent handoff's `clientId` until the send is answered, and resend with the same `clientId` after a lost
  answer.

#### Scenario: Rules documented
- **WHEN** a client developer reads `docs/protocol.md`
- **THEN** each rule above is stated with the error codes it reacts to

### Requirement: Expiry

A handoff that is still `pending` 30 days after it was sent SHALL become `expired` and SHALL no longer be
offered. When a member is removed (by the admin, or by leaving from their last device), every handoff pending
for them SHALL become `expired`. Handoffs a removed member sent and that are still pending SHALL still be
delivered, naming the removed member in `from`. The server SHALL check for overdue handoffs at least once a
minute and whenever it is about to offer or record the acknowledgement of one.

#### Scenario: Thirty days pass
- **WHEN** a handoff to Sam has been pending for 30 days and Sam's desktop then connects
- **THEN** it is not offered, and an acknowledgement of it is answered `HANDOFF_EXPIRED`

#### Scenario: Recipient removed
- **WHEN** the admin removes `sam` while two handoffs are pending for `sam`
- **THEN** both become `expired`

### Requirement: The server keeps the text only while it waits

The server SHALL delete a handoff's title and body when it is delivered or expires, keeping only its id,
client id, sender, recipient, times, status, the device it was delivered to, and a hash that lets a resend be
recognised (requirement "Resending does not duplicate"). Within a minute of that, the text SHALL no longer be
present in any file of the data directory (including free database pages and the write-ahead log), unless
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

#### Scenario: Another process reading
- **WHEN** another process holds a read transaction on the database when the minute's clean-up runs
- **THEN** the clean-up returns at once without blocking the server, and completes at the next minute after
  the reader finished

#### Scenario: Log
- **WHEN** a handoff is sent, offered and acknowledged
- **THEN** the log names the handoff id, the sender and the recipient, but contains neither its title nor its
  body
