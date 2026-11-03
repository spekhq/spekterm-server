## Purpose

Defines the one WebSocket connection between a spekterm device and the server: how it is opened, joined or
authenticated, kept alive, replaced and closed, and how its contract is written down and held to the code.

## ADDED Requirements

### Requirement: One WebSocket endpoint

The server SHALL accept WebSocket connections at the path `/connect` and SHALL refuse a WebSocket upgrade on
any other path with HTTP 404. Messages SHALL be UTF-8 JSON text frames. A frame larger than 256 KiB SHALL
close the connection with WebSocket close code 1009 and no answer, and SHALL NOT affect any other connection
or the server process. A binary frame SHALL close the connection with close code 1003.

#### Scenario: Wrong path
- **WHEN** a client opens a WebSocket to `/ws`
- **THEN** the upgrade is refused with HTTP 404

#### Scenario: Oversized frame
- **WHEN** an authenticated client sends a 300 KiB text frame while another device is connected
- **THEN** the server closes the first connection with code 1009, and the other device's connection and the
  server keep working

### Requirement: Request, answer and event frames

A client SHALL send requests shaped `{"t":"req","id":<number or string>,"m":"<operation>","p":{…}}`. The
server SHALL answer each request exactly once with `{"t":"res","id":<same id>,"ok":true,"r":<result>}` or
`{"t":"res","id":<same id>,"ok":false,"e":{"code":"<CODE>","message":"<text>","detail":{…}?}}`, and MAY push
events shaped `{"t":"evt","k":"<kind>","d":<data>}`. `detail` is optional and its fields are defined per
error code. A frame that is not valid JSON or lacks these fields SHALL be answered with `BAD_FRAME` (with
`id: null` when no id could be read). An operation the server does not know SHALL be answered with
`UNKNOWN_OPERATION`, before any authentication check. A parameter that is missing or has the wrong type or
value SHALL be answered with `BAD_PARAMS` with `detail.field` naming it. An unexpected failure inside the
server SHALL be answered with `INTERNAL`. Fields the server does not know SHALL be ignored, so that later
versions can add optional fields without breaking older peers.

#### Scenario: Not JSON after authenticating
- **WHEN** an authenticated client sends the text `hello`
- **THEN** the server answers `{"t":"res","id":null,"ok":false,"e":{"code":"BAD_FRAME",…}}` and keeps the
  connection open

#### Scenario: Unknown operation
- **WHEN** an authenticated client sends `{"t":"req","id":7,"m":"handoff.send","p":{}}` to a server of this
  change
- **THEN** the server answers id 7 with `UNKNOWN_OPERATION` and the connection stays open

#### Scenario: Unknown field
- **WHEN** a `hello` request carries an extra field `"resume": 42`
- **THEN** the server ignores the field and authenticates normally

#### Scenario: Bad parameter
- **WHEN** an authenticated client sends `device.rename` with `name: 5`
- **THEN** the server answers `BAD_PARAMS` with `detail.field: "name"`

### Requirement: Before authentication

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

### Requirement: Protocol version negotiation

`invite.inspect`, `join` and `hello` SHALL carry `protocol`, the list of protocol versions the client speaks.
The server SHALL check `protocol` before any other parameter. It SHALL choose the highest version both sides
speak and return it as `protocol` in the result. When there is none, the server SHALL answer
`UNSUPPORTED_VERSION` with the versions it speaks in `detail.supported` (and then close with 4003, as for any
error before authentication), so that the client can say plainly that it and the server do not match. This
change defines version `1`.

#### Scenario: Common version
- **WHEN** a client sends `protocol: [1, 2]` to a server that speaks only 1
- **THEN** the result carries `protocol: 1`

#### Scenario: No common version, other parameters unknown to the server
- **WHEN** a client sends `join` with `protocol: [2]` and parameters shaped for version 2 to a server that
  speaks only 1
- **THEN** the server answers `UNSUPPORTED_VERSION` with `detail.supported: [1]`, not `BAD_PARAMS`

### Requirement: Inspecting an invite

`invite.inspect` SHALL carry `protocol` and the invite `code`. For a redeemable invite the result SHALL carry
`protocol`, `kind` (`member` for a new-member invite, `device` for a new-device invite), `team` (`name`),
`expiresAt` (milliseconds since the epoch), and for a device invite `member` (`handle`, `displayName`). It SHALL
NOT redeem the invite and SHALL NOT authenticate the connection. For an invite that is not redeemable it SHALL
answer `INVITE_UNKNOWN`, `INVITE_EXPIRED` or `INVITE_USED` as `join` would.

#### Scenario: Device invite
- **WHEN** a client inspects an invite created for `sam`
- **THEN** the result carries `kind: "device"`, the team name, the expiry and `member.handle: "sam"`, and the
  client can skip asking for a handle and a display name

### Requirement: Joining over the connection

`join` SHALL carry `protocol`, the invite `code`, the `deviceName`, and for a new-member invite the `handle` and
`displayName`. On success the result SHALL carry `protocol`, `server` (`name`, `version`), `operations`,
`team` (`name`), `member` (`id`, `handle`, `displayName`, `deviceCount`), `device` (`id`, `name`), and the
credential as
`deviceId` and `deviceSecret`, and the connection SHALL be authenticated as the new device. The credential is
given only in this answer.

#### Scenario: Join then use the connection
- **WHEN** a join succeeds
- **THEN** the same connection accepts authenticated operations without a `hello`

### Requirement: Authenticating over the connection

`hello` SHALL carry `protocol`, `deviceId` and `deviceSecret`. For a device that is not revoked and the
matching secret, the result SHALL carry `protocol`, `server`, `operations`, `team`, `member` and `device` as
in `join`, without the credential, and the connection SHALL be authenticated as that device. A missing or
non-string `deviceId` or `deviceSecret`, an unknown or revoked device, or a wrong secret SHALL all be answered
with `AUTH_FAILED`. The server SHALL record the time of the device's last successful authentication and keep
it current, at least once every 90 seconds, while the connection stays open. `member.deviceCount` is the
number of the member's devices that are not revoked, this one included, so that a client can tell the user
whether leaving from this device will also leave the team.

#### Scenario: Revoked device
- **WHEN** a revoked device sends `hello` with its old credential
- **THEN** the server answers `AUTH_FAILED` and closes with code 4003 one second later

### Requirement: Operations list

The `operations` field of the `join` and `hello` results SHALL list every operation the server accepts after
authentication. A client SHALL be able to rely on it to hide features the server does not have, instead of
learning it from `UNKNOWN_OPERATION`.

#### Scenario: Operations of this change
- **WHEN** a device authenticates with a server of this change
- **THEN** `operations` is exactly `["device.leave", "device.rename"]`

### Requirement: Renaming this device

An authenticated device SHALL be able to rename itself with `device.rename` carrying `name`, under the naming
rules of team membership. The result SHALL carry the stored `device` (`id`, `name`).

#### Scenario: Rename
- **WHEN** a device sends `device.rename` with `name: " work laptop "`
- **THEN** the result carries `device.name: "work laptop"` and the admin's member list shows the new name

### Requirement: One live connection per device

A device SHALL have at most one authenticated connection. When a device authenticates while it already has
one, the server SHALL close the older connection with close code 4006 and keep the newer one. A client whose
connection is closed with 4006 SHALL NOT reconnect on its own, so that two machines holding the same
credential do not keep replacing each other.

#### Scenario: Reconnect while the old connection lingers
- **WHEN** a device's connection is half-open and the device connects and authenticates again
- **THEN** the older connection is closed with code 4006 and the new one works

#### Scenario: Revoked after being replaced
- **WHEN** a device's first connection was replaced by a second one, and the device is then revoked
- **THEN** the second connection is closed with code 4004

### Requirement: Access ends promptly

When a device is revoked (by the admin, by removing its member, or by `device.leave`), the server SHALL close
that device's authenticated connection with close code 4004 within 10 seconds, including when the revocation
was made by the admin command line in another process. A client whose connection is closed with 4004 SHALL NOT
reconnect with that credential; it can only join again with a new invite.

#### Scenario: Admin revokes a connected device
- **WHEN** a device is connected and the admin revokes it from the command line
- **THEN** within 10 seconds the device's connection is closed with code 4004

### Requirement: Keepalive

The server SHALL send a WebSocket ping every 30 seconds on each connection and SHALL terminate a connection
that has not answered the previous ping by the time the next one is due.

#### Scenario: Dead peer
- **WHEN** a client stops answering pings
- **THEN** the server terminates the connection within 60 seconds

### Requirement: The protocol document is the contract

`docs/protocol.md` SHALL describe the invite link, the transport and certificate pinning, the frames, every
operation the server accepts with its parameters and result, every error code with its `detail` fields, every
close code with what the client should do on it, and how to recover when a join's answer is lost, so that a
client can be built from it alone. A test SHALL fail when the operations, the error codes or the close codes
listed in the document differ from those the server defines.

#### Scenario: Undocumented operation
- **WHEN** an operation is added to the server but not to `docs/protocol.md`
- **THEN** the test suite fails, naming the operation
