# team-directory Specification

## Purpose
Lets a device learn who is on its team, so that its user and its agent can address a handoff to a teammate by
handle.

## Requirements

### Requirement: Listing the team's members

An authenticated device SHALL be able to ask for the team's members with `team.members`. The answer SHALL
carry `members`: every member who has not been removed, including the asking device's own member, each with
`id`, `handle`, `displayName` and `deviceCount` (the number of the member's devices that are not revoked),
ordered by handle. It SHALL NOT carry devices, device names or last-seen times.

#### Scenario: Three members
- **WHEN** the team has `alex`, `sam` and `kim`, and Alex's device sends `team.members`
- **THEN** the answer lists `alex`, `kim` and `sam` in that order, each with id, handle, display name and
  device count only

#### Scenario: Removed member
- **WHEN** `kim` was removed
- **THEN** `kim` is not in the list

#### Scenario: Current device count before leaving
- **WHEN** Sam authenticated on the desktop while the laptop was also on the team, then the admin revoked the
  laptop, and the desktop sends `team.members`
- **THEN** Sam's entry carries `deviceCount: 1`, so the client can say that leaving removes Sam from the team
