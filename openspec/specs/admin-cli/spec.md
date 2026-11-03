# admin-cli Specification

## Purpose
Defines the administrator's command line, the only management interface of the server in v1: the team
name, invites, members and devices.

## Requirements

### Requirement: Admin command line

The server SHALL provide a command line, `spekterm-server-admin`, that works on the server's data directory
and can be run while the server is running. Every command SHALL exit with status 0 on success and non-zero
with a one-line message on standard error on failure. Whoever can run this command is the team's admin; v1
offers no admin operations over the connection.

#### Scenario: Unknown member
- **WHEN** the admin runs `spekterm-server-admin member remove nobody`
- **THEN** it prints that no member `nobody` exists and exits non-zero

#### Scenario: Running alongside the server
- **WHEN** the server is running and the admin creates an invite
- **THEN** the invite is redeemable at once without restarting the server

### Requirement: Team name

`team name` SHALL print the team name, and `team name <name>` SHALL set it, under the naming rules of team
membership.

#### Scenario: Setting the name
- **WHEN** the admin runs `spekterm-server-admin team name "Billing crew"`
- **THEN** devices that authenticate afterwards are told the team name "Billing crew"

### Requirement: Creating invites

`invite create` SHALL create a new-member invite; `invite create --member <handle>` SHALL create a
new-device invite for that member. `--expires <duration>` (for example `12h`, `7d`) SHALL set the lifetime
within the allowed range. The command SHALL print the invite link once, with its expiry time. It SHALL
refuse to run when the server's public address is not configured, because the link could not tell a client
where to connect. When the server serves TLS itself with a **self-signed** certificate, the link SHALL carry
the certificate's fingerprint (SHA-256 of the leaf certificate in DER, 64 upper-case hex digits) so that the
client pins it. With a certificate issued by a certificate authority, the link SHALL NOT carry a fingerprint,
because pinning a certificate that is renewed every few months would lock every device out at renewal.
`--pin` SHALL force the fingerprint into the link whenever the server serves TLS itself, for a certificate
from a private authority that members' systems do not trust (for example one made with mkcert); it SHALL be
refused when the server does not serve TLS itself.

#### Scenario: New-member invite
- **WHEN** the public address is `wss://team.example.com` and the admin runs `invite create`
- **THEN** the command prints a `spekterm://join` link whose server address is `wss://team.example.com`
  and an expiry 7 days ahead

#### Scenario: Self-signed certificate
- **WHEN** the server is configured with a self-signed certificate and the admin runs `invite create`
- **THEN** the link carries `fp` equal to the certificate's SHA-256 fingerprint

#### Scenario: Certificate from an authority
- **WHEN** the server is configured with a certificate issued by a certificate authority
- **THEN** the link carries no `fp`

#### Scenario: Private authority
- **WHEN** the server's certificate was issued by a private authority and the admin runs `invite create --pin`
- **THEN** the link carries `fp` equal to the certificate's SHA-256 fingerprint

#### Scenario: Public address missing
- **WHEN** no public address is configured and the admin runs `invite create`
- **THEN** the command explains that the public address must be set and exits non-zero without creating an
  invite

### Requirement: Listing and cancelling invites

`invite list` SHALL list invites that are still redeemable (not used, not cancelled, not expired) with an
id, kind, member (for device invites), creation time and expiry, but never the code. `invite cancel <id>` SHALL make that invite unredeemable.

#### Scenario: Cancelled invite
- **WHEN** the admin cancels an invite and someone then redeems its code
- **THEN** the join is refused with `INVITE_UNKNOWN`

### Requirement: Listing members and devices

`member list` SHALL list each member who has not been removed, with handle and display name, and under each
member the devices that are not revoked with device id, name, join time and last-seen time.

#### Scenario: Member with two devices
- **WHEN** `sam` has a home desktop and a work laptop
- **THEN** `member list` shows `sam` with both devices and when each was last seen

### Requirement: Renaming a member

`member rename <handle> <display name>` SHALL change the member's display name, under the naming rules of
team membership, keeping the member id and handle.

#### Scenario: Fixing a typo
- **WHEN** the admin runs `member rename sam "Sam W."`
- **THEN** the member `sam` keeps its id and devices, and devices that authenticate afterwards see the
  display name "Sam W."

### Requirement: Ids that the command line can take

Member, device and invite ids SHALL never begin with `-`, so that they are never read as command-line options.

#### Scenario: Revoking by id
- **WHEN** the admin copies a device id from `member list` into `device revoke <id>`
- **THEN** the command revokes that device

### Requirement: Removing members and revoking devices

`member remove <handle>` SHALL remove the member and `device revoke <device-id>` SHALL revoke the device,
with the effects that team membership defines.

#### Scenario: Revoking a device
- **WHEN** the admin runs `device revoke <id>` for a connected device
- **THEN** the command succeeds and the device's connection closes within 10 seconds
