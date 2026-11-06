# phone-relay Specification

## Purpose
Defines the blind relay for a member's own phone: grants a desktop gives its paired phones, the `/relay` endpoint
and its one-request handshake, splicing with flow control, the throughput cap and the liveness of tunnel legs,
the limits, how tunnels end, and what the server logs. The server never terminates the phone's TLS to the desktop.

## Requirements

### Requirement: Relaying is the operator's choice

The server SHALL relay only when the operator set `RELAY=on`. With relaying off, the relay operations on
`/connect` SHALL be answered `UNKNOWN_OPERATION` and be absent from `operations`, and `relay.open` and
`relay.accept` on `/relay` SHALL be answered `RELAY_DISABLED` once their protocol version is negotiated. Grants stored while relaying was on SHALL be kept, unusable, while it is off.

#### Scenario: Off by default
- **WHEN** the server starts without `RELAY` and a device sends `relay.grant`
- **THEN** it is answered `UNKNOWN_OPERATION`, and `operations` lists no `relay.` operation

#### Scenario: Phone against a server that does not relay
- **WHEN** relaying is off and a phone sends `relay.open` on `/relay`
- **THEN** it is answered `RELAY_DISABLED`, and the connection is closed with 4003 one second later

#### Scenario: Turned off and on again
- **WHEN** a device created a grant, the server restarts with `RELAY=off` and later again with `RELAY=on`
- **THEN** the grant opens tunnels again without being created anew

### Requirement: Grants

An authenticated device SHALL be able to create a grant with `relay.grant { name }`, answered
`{ grant: { id, name, createdAt }, secret }`, where the secret carries 256 bits of randomness and is returned
only in that answer. The server SHALL store only a hash of the secret. `name` follows the naming rules of team
membership. A device SHALL hold at most 16 grants; the 17th SHALL be answered `TOO_MANY_GRANTS` with
`detail.limit: 16`. `relay.grants {}` SHALL list the calling device's grants
(`{ grants: [{ id, name, createdAt, lastUsedAt? }] }`, oldest first) and no other device's. Grant ids (`g_…`)
and tunnel ids (`t_…`) SHALL follow the identifier format of `server-connection`.

#### Scenario: Creating a grant
- **WHEN** a desktop sends `relay.grant { "name": "Pixel 8" }`
- **THEN** the answer carries a grant id starting `g_` and a secret, and the data directory contains neither the
  secret nor anything from which it can be read back

#### Scenario: Seventeenth grant
- **WHEN** a device holding 16 grants sends `relay.grant`
- **THEN** it is answered `TOO_MANY_GRANTS` with `detail.limit: 16` and no grant is created

#### Scenario: Only one's own grants are listed
- **WHEN** two devices of the same member each created a grant and one sends `relay.grants`
- **THEN** the answer lists only that device's grant

### Requirement: Revoking a grant

`relay.revoke { id }` SHALL delete one of the calling device's grants and end its tunnels (the phone leg with
4004, the desktop leg with 4010; a pending phone leg answered `GRANT_INVALID`, then closed with 4003), answering
`{ revoked: true }`. For an id the device does not hold — never
created, already revoked, or another device's — it SHALL answer `{ revoked: false }` and change nothing.

#### Scenario: Revoking a grant in use
- **WHEN** a desktop revokes a grant that has an open tunnel
- **THEN** the answer is `{ revoked: true }`, the phone leg is closed with 4004, the desktop leg with 4010, and a
  later `relay.open` with that grant is answered `GRANT_INVALID`

#### Scenario: Revoking again after a lost answer
- **WHEN** the desktop sends the same `relay.revoke` twice
- **THEN** the second answer is `{ revoked: false }`

#### Scenario: Another device's grant
- **WHEN** a device sends `relay.revoke` with the id of a grant another device holds
- **THEN** the answer is `{ revoked: false }` and the grant still works

#### Scenario: Revoked while the phone waits
- **WHEN** a phone's `relay.open` is pending and the desktop revokes that grant
- **THEN** the phone is answered `GRANT_INVALID` and closed with 4003, and a `relay.accept` for the tunnel is
  answered `TUNNEL_UNKNOWN`

### Requirement: Grants end with their device

Revoking a device (by the admin), a device leaving, and removing its member SHALL delete the device's grants in
the same transaction and end its tunnels, both legs with 4004; a pending phone leg for one of those grants SHALL
be answered `GRANT_INVALID`, then closed with 4003, also when the same revocation closes the desktop's `/connect`
connection (this answer takes precedence over `DESKTOP_UNAVAILABLE`). When the revocation is made by another process (the admin
command line), the tunnels SHALL end within 10 seconds, also when the desktop has no `/connect` connection at
the time.

#### Scenario: Desktop leaves the team
- **WHEN** a desktop with two grants and an open tunnel sends `device.leave`
- **THEN** both grants are gone, both legs of the tunnel are closed with 4004, and `relay.open` with either grant
  is answered `GRANT_INVALID`

#### Scenario: Admin revokes the desktop
- **WHEN** the admin runs `device revoke` for a desktop with an open tunnel
- **THEN** both legs of the tunnel are closed with 4004 within 10 seconds

#### Scenario: Admin revokes the desktop while the phone waits
- **WHEN** a phone's `relay.open` is pending and the admin runs `device revoke` for its desktop
- **THEN** within 10 seconds the phone is answered `GRANT_INVALID` and closed with 4003, and the desktop's
  `/connect` connection is closed with 4004

#### Scenario: Admin revokes the desktop while its team connection is down
- **WHEN** a desktop's `/connect` connection has closed, its tunnel is still open, and the admin runs
  `device revoke` for it
- **THEN** both legs of the tunnel are closed with 4004 within 10 seconds

### Requirement: The relay endpoint

The server SHALL accept WebSocket upgrades at `/relay` with the same TLS, frame size limit and keepalive as
`/connect`. A connection to `/relay` SHALL send exactly one request, `relay.open` or `relay.accept`, in the frame
format of `/connect`, within 10 seconds of opening, or be closed with 4001. Every error answer on `/relay` SHALL
be followed one second later by close 4003, with frames in that second ignored. A text frame that is not a
request SHALL be answered `BAD_FRAME`; any operation other than these two, `hello` included, SHALL be answered
`UNKNOWN_OPERATION`. A binary frame before the answer, or any data frame (text or binary, not ping or pong)
between the request and its answer, SHALL close the connection with 1003. No events are sent on `/relay`. Both
requests SHALL negotiate the protocol version as `hello` does, before any other check. A binary message SHALL be
at most 256 KiB (1009 over it); the protocol document SHALL require clients to cut their stream writes into
messages of at most 64 KiB.

#### Scenario: Silent connection
- **WHEN** a client opens `/relay` and sends nothing for 10 seconds
- **THEN** the connection is closed with 4001

#### Scenario: Handoff operation on the relay endpoint
- **WHEN** a client sends `hello` on `/relay`
- **THEN** it is answered `UNKNOWN_OPERATION` and closed with 4003 one second later

#### Scenario: Bytes before the answer
- **WHEN** a phone sends `relay.open` and then a binary frame before the answer
- **THEN** the connection is closed with 1003 and no tunnel is pending for it

### Requirement: Opening a tunnel from the phone

`relay.open { protocol, grant, secret }` SHALL be checked in this order: protocol version
(`UNSUPPORTED_VERSION`), relaying on (`RELAY_DISABLED`), parameters (`BAD_PARAMS` with `detail.field`), the
grant and its secret compared in constant time (`GRANT_INVALID`), the grant's open rate (`RATE_LIMITED` with
`detail.retryAt`), the limits (`RELAY_BUSY` with `detail.limit`), and that the grant's device has an
authenticated `/connect` connection (`DESKTOP_UNAVAILABLE`). The server SHALL then create a tunnel id and send
`relay.incoming { tunnel, grant, expiresAt }` to that device's current `/connect` connection, and SHALL answer the
phone `{ protocol, tunnel }` only once the desktop's leg is accepted. It SHALL answer `DESKTOP_REFUSED` when the
desktop refuses, and `DESKTOP_UNAVAILABLE` when the desktop does not accept within 10 seconds or its `/connect`
connection closes first. An accepted `relay.open` SHALL record the grant's last use.

#### Scenario: Desktop connected and willing
- **WHEN** a phone sends `relay.open` with a valid grant whose desktop is connected, and the desktop accepts
- **THEN** the desktop's `/connect` connection receives `relay.incoming` with a tunnel id starting `t_`, and the
  phone is answered `{ "protocol": 1, "tunnel": <that id> }` after the desktop's `relay.accept` is answered

#### Scenario: Desktop not connected
- **WHEN** a phone sends `relay.open` with a valid grant whose desktop has no `/connect` connection
- **THEN** it is answered `DESKTOP_UNAVAILABLE` at once and no event is sent anywhere

#### Scenario: Desktop does not answer
- **WHEN** the desktop receives `relay.incoming` and neither accepts nor refuses
- **THEN** the phone is answered `DESKTOP_UNAVAILABLE` 10 seconds after its request, and a later `relay.accept` for
  that tunnel is answered `TUNNEL_UNKNOWN`

#### Scenario: Phone gives up while waiting
- **WHEN** a phone sends `relay.open`, the desktop receives `relay.incoming`, and the phone closes its connection
  before the answer
- **THEN** the tunnel is dropped and a later `relay.accept` for it is answered `TUNNEL_UNKNOWN`

#### Scenario: Wrong secret
- **WHEN** a phone sends `relay.open` with a known grant id and a wrong secret
- **THEN** it is answered `GRANT_INVALID` and the desktop receives nothing

### Requirement: Accepting or refusing a tunnel on the desktop

A desktop that received `relay.incoming` SHALL be able to refuse it with `relay.refuse { tunnel }` on `/connect`,
answered `{}` also for a tunnel that is unknown or not its own (which it does not affect). To accept, the desktop
opens `/relay` and sends `relay.accept { protocol, deviceId, deviceSecret, tunnel }`, checked in this order:
protocol version, relaying on, parameters, the device credential (`AUTH_FAILED`), and that the tunnel is pending
and was offered to that device (`TUNNEL_UNKNOWN`). On success the server SHALL answer the desktop
`{ protocol }`, then the phone, then splice. A `/relay` connection SHALL NOT count as the device's `/connect`
connection: it SHALL NOT replace it and SHALL NOT be offered handoffs.

#### Scenario: Refused
- **WHEN** the desktop answers `relay.incoming` with `relay.refuse`
- **THEN** the phone is answered `DESKTOP_REFUSED` and the tunnel is no longer pending

#### Scenario: Another device accepts
- **WHEN** a different device of the same member sends `relay.accept` with a tunnel id offered to the first
  device
- **THEN** it is answered `TUNNEL_UNKNOWN`, and the first device can still accept

#### Scenario: Accepting does not replace the team connection
- **WHEN** the desktop accepts a tunnel while its `/connect` connection is open
- **THEN** the `/connect` connection stays open and keeps receiving handoffs

### Requirement: Splicing

After both answers, the server SHALL send every binary message received on one leg as one binary message on the
other, unchanged and in order, and SHALL NOT inspect or log its content. A text frame on a leg after the splice
SHALL close that leg with 1003 and the other with 4010.

#### Scenario: Bytes cross unchanged
- **WHEN** the phone leg sends 1 MiB of random bytes in binary frames of varying size
- **THEN** the desktop leg receives the same bytes, in the same messages and order, and vice versa

#### Scenario: TLS through the tunnel
- **WHEN** the desktop side of a test serves TLS with a self-signed certificate over its leg and the phone side
  pins that certificate over its own leg
- **THEN** the handshake succeeds and data exchanged inside it arrives intact, while the server's certificate
  plays no part in it

### Requirement: Flow control and throughput

When a leg's unsent buffer exceeds 64 KiB, the server SHALL stop reading from the other leg until the buffer is
under 16 KiB. When `RELAY_KIB_PER_SECOND` is not 0, the server SHALL limit each direction of a tunnel with a
token bucket of one second's worth, full at the start, that a message may overdraw, pausing the sending leg while
the bucket is negative; in any T seconds a direction SHALL carry at most `RELAY_KIB_PER_SECOND × (T + 1)` KiB plus
one message plus one socket read.

#### Scenario: Slow phone
- **WHEN** the desktop leg sends as fast as it can and the phone leg reads nothing for a while
- **THEN** the server's buffered bytes for that tunnel stop growing at about the 64 KiB window, and when the phone
  starts reading every byte arrives

#### Scenario: Throughput cap
- **WHEN** `RELAY_KIB_PER_SECOND` is 64 and the desktop leg sends 1 KiB messages as fast as it can for 10 seconds
- **THEN** the phone leg receives at least 576 KiB and at most 800 KiB in those 10 seconds

#### Scenario: Message larger than the bucket
- **WHEN** `RELAY_KIB_PER_SECOND` is 16 and the desktop leg sends one 200 KiB message
- **THEN** the phone leg receives it whole, and a next message, sent after the first one arrived, reaches the
  phone about 12 seconds after the first

### Requirement: Liveness of tunnel legs

The server SHALL ping each `/relay` leg every 30 seconds. At each ping, a leg SHALL count as alive if it answered
the previous ping, or more of the bytes forwarded to it left the server's buffers since the previous ping, or the
server has paused reading from it; a leg's ping state SHALL start afresh when it is resumed. A leg that is not
alive SHALL be terminated, and the other leg closed with 4010. A leg to which bytes were forwarded since its last
pong SHALL be terminated only after 120 seconds in which it neither answered a ping nor made such progress.

#### Scenario: Slow phone outlasts the keepalive
- **WHEN** the desktop leg sends as fast as it can and the phone leg reads 10 KiB per second for three minutes
- **THEN** neither leg is closed, and the phone receives data the whole time

#### Scenario: Stuck phone
- **WHEN** the desktop leg sends as fast as it can and the phone leg stops reading its socket entirely
- **THEN** the phone leg is terminated and the desktop leg closed with 4010 between 120 and 150 seconds after the
  phone stopped reading

### Requirement: Relay limits

The server SHALL allow at most `RELAY_MAX_TUNNELS` tunnels at once, open or pending, and at most 4 per desktop
device, answering `RELAY_BUSY` with `detail.limit` `"server"` or `"device"`. It SHALL send `relay.incoming` for at
most 20 `relay.open` per grant in any 10 minutes, counting each when `relay.incoming` is sent whatever follows
(accepted, refused, timed out, or the phone gone), and not counting an immediate `DESKTOP_UNAVAILABLE`; beyond that
it SHALL answer `RATE_LIMITED` with `detail.retryAt`.

#### Scenario: Fifth tunnel to one desktop
- **WHEN** a desktop has 4 tunnels open or pending and a phone sends another `relay.open` for it
- **THEN** it is answered `RELAY_BUSY` with `detail.limit: "device"`

#### Scenario: Server full
- **WHEN** `RELAY_MAX_TUNNELS` is 2, two tunnels of different desktops are open, and a third phone sends
  `relay.open`
- **THEN** it is answered `RELAY_BUSY` with `detail.limit: "server"`, and once one tunnel closes a new
  `relay.open` succeeds

#### Scenario: Phone closes early, again and again
- **WHEN** a phone sends `relay.open` with one grant and closes before the answer, 20 times within 10 minutes,
  and then sends `relay.open` again
- **THEN** the 21st is answered `RATE_LIMITED`, and the desktop received exactly 20 `relay.incoming`

#### Scenario: Desktop off for a while
- **WHEN** a phone sends `relay.open` 30 times within 10 minutes while its desktop has no `/connect` connection,
  and the desktop then connects
- **THEN** each of the 30 is answered `DESKTOP_UNAVAILABLE`, and the next `relay.open` reaches the desktop

#### Scenario: A looping phone
- **WHEN** a phone opens and drops 20 tunnels with one grant within 10 minutes and sends `relay.open` again
- **THEN** it is answered `RATE_LIMITED` with `detail.retryAt` no later than 10 minutes after the first of them,
  and the desktop receives no `relay.incoming` for it

### Requirement: How a tunnel ends

An open tunnel SHALL end when either leg closes or is found not alive (the other leg closed with 4010), when its
grant is revoked, when its desktop device is revoked or leaves or its member is removed, and when the server shuts
down (both legs with 1001). An open tunnel SHALL NOT end because its desktop's `/connect` connection closes or is
replaced; a pending one ends as the requirement on opening a tunnel says. On shutdown, pending phone legs SHALL be
closed with 1001 without an answer. Nothing about a tunnel survives a restart.

#### Scenario: Desktop's team connection reconnects
- **WHEN** a tunnel is open and the desktop's `/connect` connection drops and reconnects
- **THEN** the tunnel keeps carrying bytes

#### Scenario: Phone goes away
- **WHEN** the phone leg's connection drops without a close frame
- **THEN** the desktop leg is closed with 4010 within 60 seconds when nothing was waiting to be sent to the phone,
  and within 150 seconds otherwise

#### Scenario: Server restart
- **WHEN** the server shuts down with a tunnel open
- **THEN** both legs are closed with 1001, and after the restart the phone opens a new tunnel with the same grant

### Requirement: What the relay logs

The server SHALL log each tunnel's opening (tunnel id, device id, grant id) and closing (duration, bytes in each
direction, the reason), and each refused `relay.open` or `relay.accept` by error code and grant or tunnel id. It
SHALL NOT log grant secrets, device secrets, remote addresses or relayed content.

#### Scenario: Tunnel logged
- **WHEN** a tunnel carries known bytes and closes
- **THEN** the log names the tunnel, device and grant and the byte counts, and contains neither the grant secret
  nor any of the relayed bytes
