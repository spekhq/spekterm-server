## MODIFIED Requirements

### Requirement: Listing members and devices

`member list` SHALL list each member who has not been removed, with handle and display name, and under each
member the devices that are not revoked with device id, name, join time and last-seen time, and under each
device its relay grants with grant id, name, creation time and last-used time. Grant secrets are never shown.

#### Scenario: Member with two devices
- **WHEN** `sam` has a home desktop and a work laptop
- **THEN** `member list` shows `sam` with both devices and when each was last seen

#### Scenario: Desktop with a phone grant
- **WHEN** `sam`'s home desktop created a grant named "Pixel 8" that opened a tunnel yesterday
- **THEN** `member list` shows the grant under that desktop with its id, name, creation time and yesterday as its
  last use
