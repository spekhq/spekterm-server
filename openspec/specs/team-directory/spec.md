# team-directory Specification

## Purpose
Lets a device learn who is on its team, so that its user and its agent can address a handoff to a teammate by
handle.

## Requirements

### Requirement: Listing the team's members

An authenticated device SHALL be able to ask for the team's members with `team.members`. The answer SHALL
carry `members`: every member who has not been removed, including the asking device's own member, each with
`id`, `handle` and `displayName`, ordered by handle. It SHALL NOT carry devices, device names or last-seen
times.

#### Scenario: Three members
- **WHEN** the team has `alex`, `sam` and `kim`, and Alex's device sends `team.members`
- **THEN** the answer lists `alex`, `kim` and `sam` in that order, each with id, handle and display name only

#### Scenario: Removed member
- **WHEN** `kim` was removed
- **THEN** `kim` is not in the list
