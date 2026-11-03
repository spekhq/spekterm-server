## MODIFIED Requirements

### Requirement: Authenticating over the connection

`hello` SHALL carry `protocol`, `deviceId` and `deviceSecret`. For a device that is not revoked and the
matching secret, the result SHALL carry `protocol`, `server`, `operations`, `team`, `member` and `device` as
in `join`, without the credential, and the connection SHALL be authenticated as that device. A missing or
non-string `deviceId` or `deviceSecret`, an unknown or revoked device, or a wrong secret SHALL all be answered
with `AUTH_FAILED`. The server SHALL record the time of the device's last successful authentication and keep
it current, at least once every 90 seconds, while the connection stays open. `member.deviceCount` is the
number of the member's devices that are not revoked, this one included, at the moment of authentication; it
can be stale later, so a client deciding what leaving will do SHALL use `team.members` (team-directory) right
before asking the user.

#### Scenario: Revoked device
- **WHEN** a revoked device sends `hello` with its old credential
- **THEN** the server answers `AUTH_FAILED` and closes with code 4003 one second later

### Requirement: Access ends promptly

When a device is revoked (by the admin, by removing its member, or by `device.leave`), the server SHALL close
that device's authenticated connection with close code 4004 within 10 seconds, including when the revocation
was made by the admin command line in another process. Every request that needs authentication SHALL first
check that the connection's device is still not revoked; if it is, the server SHALL answer `AUTH_FAILED`, carry
out nothing, and close the connection with 4004 right after the answer. A client whose connection is closed
with 4004 SHALL NOT reconnect with that credential; it can only join again with a new invite.

#### Scenario: Admin revokes a connected device
- **WHEN** a device is connected and the admin revokes it from the command line
- **THEN** within 10 seconds the device's connection is closed with code 4004

#### Scenario: Request in the window before the sweep
- **WHEN** the admin command line revoked a connected device and, before the server noticed, the device sends
  `handoff.send`
- **THEN** the server answers `AUTH_FAILED`, stores nothing, and closes the connection with 4004

## ADDED Requirements

### Requirement: Identifier format

Member, device, invite and handoff ids SHALL each be 1 to 64 characters of `A`–`Z`, `a`–`z`, `0`–`9`, `_` and
`-`, and SHALL NOT begin with `-`, so that a client can use them as keys. Ids are case-sensitive.
`docs/protocol.md` SHALL state this.

#### Scenario: Ids from the server
- **WHEN** a device joins and receives a handoff
- **THEN** its member id, device id and the handoff id each match `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$`
