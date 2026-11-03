## Purpose

Defines who is on the team a server serves and how access is gained and lost: the team itself, members,
devices, single-use invites and per-device credentials.

## ADDED Requirements

### Requirement: One team per server

A server SHALL serve exactly one team. The team SHALL have a name, which the admin sets and which every
inspecting, joining or authenticating device is told. Before the admin sets one, the name SHALL be `Team`.

#### Scenario: Team name reaches devices
- **WHEN** the admin has set the team name to "Billing crew" and a device authenticates
- **THEN** the authentication result carries the team name "Billing crew"

#### Scenario: Name not set yet
- **WHEN** no team name was ever set and a device joins
- **THEN** the join result carries the team name "Team"

### Requirement: Names are bounded and plain

The team name, a member's display name and a device name SHALL each be 1 to 64 Unicode code points after
trimming surrounding whitespace, and SHALL NOT contain control characters (Unicode category Cc) or line or
paragraph separators (U+2028, U+2029). A value that breaks this SHALL be refused (`BAD_PARAMS` naming the
field over the connection; an error message on the command line); it SHALL NOT be silently cut or altered
beyond the trim.

#### Scenario: Display name too long
- **WHEN** a joiner sends a display name of 65 code points
- **THEN** the join is refused with `BAD_PARAMS` and `detail.field: "displayName"`, and the invite stays unused

#### Scenario: Surrounding whitespace
- **WHEN** a joiner sends the device name "  work laptop "
- **THEN** the device is stored with the name "work laptop"

#### Scenario: Emoji count as one
- **WHEN** a joiner sends a display name of 64 emoji outside the Basic Multilingual Plane
- **THEN** the join succeeds

### Requirement: Handles identify members

Each member SHALL have a handle that is unique within the team among members who have not been removed.
A handle SHALL match `^[a-z0-9][a-z0-9-]{0,31}$` after the server lowercases what the joiner sends. The
joiner chooses the handle when joining as a new member. A handle SHALL NOT change after joining.

#### Scenario: Handle taken
- **WHEN** a member with handle `sam` exists and a joiner asks for `Sam`
- **THEN** the join is refused with `HANDLE_TAKEN`, and the invite stays unused so the joiner can retry with
  another handle

#### Scenario: Handle of a removed member
- **WHEN** the member `sam` was removed and a new joiner asks for `sam`
- **THEN** the join succeeds and creates a new member with a new member id

#### Scenario: Invalid handle
- **WHEN** a joiner asks for the handle `sam_w`
- **THEN** the join is refused with `BAD_PARAMS` and `detail.field: "handle"`

### Requirement: Invites are single-use and expire

An invite SHALL be redeemable at most once and only before it expires. The default lifetime SHALL be 7 days;
the admin MAY choose between 1 hour and 30 days when creating it. An invite SHALL be one of two kinds: for a
**new member**, or for a **new device of an existing member**. The server SHALL store only a hash of the
invite code; the code itself SHALL be shown once, when the invite is created. An invite code SHALL carry at
least 128 bits of randomness and SHALL be compared case-insensitively.

#### Scenario: Redeemed twice
- **WHEN** an invite was redeemed and someone redeems the same code again
- **THEN** the join is refused with `INVITE_USED`

#### Scenario: Expired
- **WHEN** an invite created with a lifetime of 1 day is redeemed 25 hours later
- **THEN** the join is refused with `INVITE_EXPIRED`

#### Scenario: Unknown code
- **WHEN** a code that was never issued, or whose invite was cancelled, is redeemed
- **THEN** the join is refused with `INVITE_UNKNOWN`

#### Scenario: Failed join does not consume the invite
- **WHEN** a join is refused with `BAD_PARAMS`, `HANDLE_TAKEN` or `UNSUPPORTED_VERSION`
- **THEN** the invite remains redeemable

### Requirement: Joining as a new member

Redeeming a new-member invite with a valid handle, display name and device name SHALL, in one step, create
the member, create the member's first device, mark the invite used and return the device's credential.

#### Scenario: First join
- **WHEN** Sam redeems a new-member invite with handle `sam`, display name "Sam" and device name "home desktop"
- **THEN** a member `sam` and a device "home desktop" exist, the invite is used, and the result carries the
  member, the device and a credential

### Requirement: Adding a device to an existing member

Redeeming an invite created for an existing member SHALL create a new device of that member and return its
credential. A handle or display name sent with it SHALL be ignored. An invite for a member who has since been
removed SHALL be refused with `INVITE_UNKNOWN`, including when the removal and the redemption happen at the
same moment from two processes.

#### Scenario: Second device
- **WHEN** the admin creates an invite for `sam` and Sam redeems it on a laptop with device name "work laptop"
- **THEN** `sam` has two devices, and the existing device's credential still works

#### Scenario: Member removed after the invite was created
- **WHEN** an invite was created for `sam`, `sam` was then removed, and the invite is redeemed
- **THEN** the join is refused with `INVITE_UNKNOWN`

#### Scenario: Removal races the redemption
- **WHEN** the command line removes `sam` while a device invite for `sam` is being redeemed
- **THEN** either the join is refused with `INVITE_UNKNOWN`, or the join succeeds and the new device is
  revoked by the removal; the joiner never receives `INTERNAL`

### Requirement: Each device has its own credential

Each device SHALL receive its own credential when it joins: a device id and a secret carrying at least 256
bits of randomness. The server SHALL store only a hash of the secret and SHALL return the secret only in the
join result, never again. Revoking one device SHALL NOT affect any other device.

#### Scenario: Credential not stored in clear
- **WHEN** the data directory is inspected after a join
- **THEN** neither the secret nor the invite code appears in it

#### Scenario: Revoking one device
- **WHEN** `sam` has two devices and one is revoked
- **THEN** the other device still authenticates

### Requirement: A device can leave

An authenticated device SHALL be able to leave with `device.leave`, which revokes it. When it was the
member's last device that is not revoked, the member SHALL be removed as well, so that leaving from a
member's only device leaves the team. Otherwise the member and the other devices are unaffected.

#### Scenario: Leaving from one of two devices
- **WHEN** `sam` has two devices and one sends `device.leave`
- **THEN** the result carries `memberRemoved: false`, that device's connection is closed with 4004, its
  credential no longer authenticates, and `sam` remains a member with the other device

The result of `device.leave` SHALL carry `memberRemoved` (`true` when the member was removed with it). The
count of remaining devices SHALL be taken inside the same transaction as the revocation.

#### Scenario: Leaving from the last device
- **WHEN** `sam` has one device and it sends `device.leave`
- **THEN** the result carries `memberRemoved: true`, the connection is closed with 4004, and `sam` is removed
  as if by the admin, including that `sam`'s unused device invites are cancelled

#### Scenario: Leaving the old machine before joining the new one
- **WHEN** the admin issued a device invite for `sam`, and `sam` then leaves from their only device before
  redeeming it
- **THEN** the invite is refused with `INVITE_UNKNOWN`, and `sam` needs a new-member invite

### Requirement: Access can be taken away

The admin SHALL be able to revoke a single device and to remove a member. Removing a member SHALL revoke all of
the member's devices, cancel the member's unused device invites and free the handle. A removed member's record
SHALL be kept (marked removed) so that later history can still name them; it SHALL NOT appear among the team's
members. Revoking a member's last device by the admin SHALL NOT remove the member, so that the admin can
re-invite a device for them.

#### Scenario: Removing a member
- **WHEN** the admin removes `sam`, who has two devices and one unused device invite
- **THEN** neither device authenticates, the invite is refused with `INVITE_UNKNOWN`, and `sam` is no longer
  listed as a member

#### Scenario: Admin revokes the last device
- **WHEN** the admin revokes `sam`'s only device
- **THEN** `sam` is still listed as a member with no devices, and a device invite for `sam` can be created
