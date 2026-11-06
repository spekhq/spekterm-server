## MODIFIED Requirements

### Requirement: One WebSocket endpoint

The server SHALL accept WebSocket connections at the path `/connect`, and at `/relay` for relay tunnels
(`phone-relay`), and SHALL refuse a WebSocket upgrade on any other path with HTTP 404. Messages on `/connect`
SHALL be UTF-8 JSON text frames. A frame larger than 256 KiB SHALL close the connection with WebSocket close code
1009 and no answer, and SHALL NOT affect any other connection or the server process. A binary frame on `/connect`
SHALL close the connection with close code 1003.

#### Scenario: Wrong path
- **WHEN** a client opens a WebSocket to `/ws`
- **THEN** the upgrade is refused with HTTP 404

#### Scenario: Oversized frame
- **WHEN** an authenticated client sends a 300 KiB text frame while another device is connected
- **THEN** the server closes the first connection with code 1009, and the other device's connection and the
  server keep working

#### Scenario: Relay path
- **WHEN** a client opens a WebSocket to `/relay`
- **THEN** the upgrade is accepted, also when relaying is off

### Requirement: Operations list

The `operations` field of the `join` and `hello` results SHALL list every operation the server accepts after
authentication on `/connect`. A client SHALL be able to rely on it to hide features the server does not have,
instead of learning it from `UNKNOWN_OPERATION`.

#### Scenario: Operations of this change
- **WHEN** a device authenticates with a server of this change running without `RELAY=on`
- **THEN** `operations` is exactly `["device.leave", "device.rename", "handoff.received", "handoff.send",
  "handoff.sync", "handoff.update", "team.members"]`

#### Scenario: Operations with relaying on
- **WHEN** a device authenticates with a server of this change running with `RELAY=on`
- **THEN** `operations` is exactly `["device.leave", "device.rename", "handoff.received", "handoff.send",
  "handoff.sync", "handoff.update", "relay.grant", "relay.grants", "relay.refuse", "relay.revoke",
  "team.members"]`

### Requirement: The protocol document is the contract

`docs/protocol.md` SHALL describe the invite link, the transport and certificate pinning, the frames, every
operation the server accepts with its parameters and result, every event the server sends with its data,
every error code with its `detail` fields, every close code with what the client should do on it, how to
recover when a join's answer is lost, the rules a client follows to receive handoffs (requirement "Receiving
rules for clients" of `handoff-delivery`), the rules a client follows to report statuses and keep its Sent
list (requirement "Sending rules for clients" of `handoff-status`), and the relay: the `/relay` endpoint, its
operations, splicing, flow control, how a tunnel ends, what the phone and the desktop do on each error and close
code, and what the server sees (`phone-relay`), so that a client can be built from it alone.
A test SHALL fail when the operations (of `/connect` and of `/relay`), the event kinds, the error codes or the
close codes listed in the document differ from those the server defines.

#### Scenario: Undocumented operation
- **WHEN** an operation is added to the server but not to `docs/protocol.md`
- **THEN** the test suite fails, naming the operation

#### Scenario: Undocumented event
- **WHEN** an event kind is added to the server but not to `docs/protocol.md`
- **THEN** the test suite fails, naming the event kind

#### Scenario: Undocumented relay operation
- **WHEN** an operation is added to the `/relay` endpoint but not to the protocol document's relay section
- **THEN** the test suite fails, naming the operation

### Requirement: Request, answer and event frames

On `/connect`, and on `/relay` before the splice (`phone-relay`, which also closes a `/relay` connection with
1003 and no answer when a data frame arrives before the answer), a client SHALL send requests shaped `{"t":"req","id":<number or string>,"m":"<operation>","p":{…}}`. The
server SHALL answer each request exactly once with `{"t":"res","id":<same id>,"ok":true,"r":<result>}` or
`{"t":"res","id":<same id>,"ok":false,"e":{"code":"<CODE>","message":"<text>","detail":{…}?}}`, and MAY push
events shaped `{"t":"evt","k":"<kind>","d":<data>}`. `detail` is optional and its fields are defined per
error code. A frame that is not valid JSON or lacks these fields SHALL be answered with `BAD_FRAME` (with
`id: null` when no id could be read). An operation the server does not know, or one the endpoint does not accept (on `/relay`, anything but
`relay.open` and `relay.accept`; on `/connect`, the relay operations while relaying is off), SHALL be answered
with `UNKNOWN_OPERATION`, before any authentication check. A parameter that is missing or has the wrong type or
value SHALL be answered with `BAD_PARAMS` with `detail.field` naming it. An unexpected failure inside the
server SHALL be answered with `INTERNAL`. Fields the server does not know SHALL be ignored, so that later
versions can add optional fields without breaking older peers.

#### Scenario: Not JSON after authenticating
- **WHEN** an authenticated client sends the text `hello`
- **THEN** the server answers `{"t":"res","id":null,"ok":false,"e":{"code":"BAD_FRAME",…}}` and keeps the
  connection open

#### Scenario: Unknown operation
- **WHEN** an authenticated client sends `{"t":"req","id":7,"m":"presence.set","p":{}}` to a server that does
  not have that operation
- **THEN** the server answers id 7 with `UNKNOWN_OPERATION` and the connection stays open

#### Scenario: Unknown field
- **WHEN** a `hello` request carries an extra field `"resume": 42`
- **THEN** the server ignores the field and authenticates normally

#### Scenario: Bad parameter
- **WHEN** an authenticated client sends `device.rename` with `name: 5`
- **THEN** the server answers `BAD_PARAMS` with `detail.field: "name"`

### Requirement: Before authentication

This requirement is about `/connect`; `/relay` has its own single-request rule (`phone-relay`).

Before authentication the server SHALL accept only `invite.inspect`, `join` and `hello`; any other known
operation SHALL be answered with `NOT_AUTHENTICATED`. If no `join` or `hello` succeeds within 10 seconds of the
connection opening, the server SHALL close the connection with close code 4001; a successful `invite.inspect`
does not extend this. `invite.inspect` MAY be sent on a connection of its own: the client may close it, or
take the 4001 that follows as normal and not show an error, and send `join` later on a new connection.

Before authentication, every error answer SHALL be followed, one second later, by closing the connection with
close code 4003, and frames that arrive in that second SHALL be ignored. 4003 itself means only "refused";
what the client does next depends on the error code of the answer before it:

| Error before 4003 | Client |
|---|---|
| `AUTH_FAILED` | The device is not (or no longer) on the team: discard the credential, do not reconnect with it. |
| `UNSUPPORTED_VERSION` | Do not reconnect until the client or the server is upgraded. |
| `INVITE_UNKNOWN`, `INVITE_EXPIRED`, `INVITE_USED` | Do not retry this invite; a new one is needed. |
| `HANDLE_TAKEN`, `BAD_PARAMS` | Reconnect only after the user has changed the input. |
| `BAD_FRAME`, `NOT_AUTHENTICATED`, `UNKNOWN_OPERATION` | A client bug: do not retry automatically. |
| `INTERNAL` | Retry with backoff. |

Once a connection is authenticated, `invite.inspect`, `join` or `hello` SHALL be answered with
`ALREADY_AUTHENTICATED` and the connection stays open.

#### Scenario: Silent client
- **WHEN** a client opens a connection and sends nothing for 10 seconds
- **THEN** the server closes it with code 4001

#### Scenario: Operation before authenticating
- **WHEN** a client's first request is `device.leave`
- **THEN** the server answers `NOT_AUTHENTICATED` and closes the connection with code 4003 one second later

#### Scenario: Device revoked while offline
- **WHEN** a device was revoked while it was not connected, and it connects and sends `hello`
- **THEN** it receives `AUTH_FAILED` followed by close 4003, and per the table above it discards its credential
  instead of reconnecting

#### Scenario: Inspect then join later
- **WHEN** a client inspects an invite, the user takes 30 seconds to type a handle, and the inspecting
  connection was closed with 4001 meanwhile
- **THEN** a `join` on a new connection succeeds

#### Scenario: Inspect after authenticating
- **WHEN** an authenticated client sends `invite.inspect`
- **THEN** the server answers `ALREADY_AUTHENTICATED` and the connection stays open

#### Scenario: Frames after a refusal
- **WHEN** a client's `join` is refused and it sends a valid `hello` within the following second
- **THEN** the `hello` is ignored and the connection is closed with 4003

#### Scenario: Failed join
- **WHEN** a join is refused with `HANDLE_TAKEN`
- **THEN** the connection is closed with code 4003 one second later, the invite stays redeemable, and a
  join with another handle on a new connection succeeds

### Requirement: One live connection per device

A device SHALL have at most one authenticated connection. When a device authenticates while it already has
one, the server SHALL close the older connection with close code 4006 and keep the newer one. A client whose
connection is closed with 4006 SHALL NOT reconnect on its own, so that two machines holding the same
credential do not keep replacing each other. Only `/connect` connections count: a `/relay` connection
authenticated with `relay.accept` neither replaces the device's `/connect` connection nor is replaced by it.

#### Scenario: Reconnect while the old connection lingers
- **WHEN** a device's connection is half-open and the device connects and authenticates again
- **THEN** the older connection is closed with code 4006 and the new one works

#### Scenario: Revoked after being replaced
- **WHEN** a device's first connection was replaced by a second one, and the device is then revoked
- **THEN** the second connection is closed with code 4004

#### Scenario: Tunnel leg alongside the team connection
- **WHEN** a device has a `/connect` connection and accepts a tunnel on `/relay` with its credential
- **THEN** neither connection is closed with 4006

### Requirement: Keepalive

The server SHALL send a WebSocket ping every 30 seconds on each connection and SHALL terminate a connection
that has not answered the previous ping by the time the next one is due. `/relay` legs follow their own liveness
rule instead (`phone-relay`, "Liveness of tunnel legs").

#### Scenario: Dead peer
- **WHEN** a client stops answering pings
- **THEN** the server terminates the connection within 60 seconds

### Requirement: Identifier format

Member, device, invite, handoff, relay grant and tunnel ids SHALL each be 1 to 64 characters of `A`–`Z`, `a`–`z`, `0`–`9`, `_` and
`-`, and SHALL NOT begin with `-`, so that a client can use them as keys. Ids are case-sensitive.
`docs/protocol.md` SHALL state this.

#### Scenario: Ids from the server
- **WHEN** a device joins and receives a handoff
- **THEN** its member id, device id and the handoff id each match `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$`
