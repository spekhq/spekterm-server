## MODIFIED Requirements

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
nothing. Before offering on a connection, the server SHALL check that its device is still not revoked; if it is,
it SHALL NOT offer there, SHALL close that connection with 4004, and SHALL offer to the member's next ready
connection, if any.

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

#### Scenario: Device revoked before the sweep noticed
- **WHEN** the admin command line revoked Sam's laptop, the server has not yet closed its connection, and Alex
  sends to `sam` while Sam's desktop is also connected
- **THEN** the laptop receives no `handoff.incoming` and is closed with 4004, and the desktop receives the event

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
- when it discards its credential (close 4004, or `AUTH_FAILED`), **show** the handoffs it stored but never had
  answered, marked as possibly also delivered to another device: the acknowledgement may have reached the
  server, which then counts the handoff as delivered here, and deleting it would lose it;
- when it cannot store an incoming handoff now (for example its inbox is full), keep the offer in memory and
  store and acknowledge it when it can; the handoff stays with this connection until then;
- keep a sent handoff's `clientId` until the send is answered, and resend with the same `clientId` after a lost
  answer.

#### Scenario: Rules documented
- **WHEN** a client developer reads `docs/protocol.md`
- **THEN** each rule above is stated with the error codes it reacts to

#### Scenario: Credential discarded with an unanswered acknowledgement
- **WHEN** a device stored a handoff and sent `handoff.received`, the answer was lost, and the device is then
  revoked while offline
- **THEN** per the documented rule the device shows the handoff, marked as possibly delivered elsewhere,
  instead of deleting it
