## MODIFIED Requirements

### Requirement: Operations list

The `operations` field of the `join` and `hello` results SHALL list every operation the server accepts after
authentication. A client SHALL be able to rely on it to hide features the server does not have, instead of
learning it from `UNKNOWN_OPERATION`.

#### Scenario: Operations of this change
- **WHEN** a device authenticates with a server of this change
- **THEN** `operations` is exactly `["device.leave", "device.rename", "handoff.received", "handoff.send",
  "handoff.sync", "handoff.update", "team.members"]`

### Requirement: The protocol document is the contract

`docs/protocol.md` SHALL describe the invite link, the transport and certificate pinning, the frames, every
operation the server accepts with its parameters and result, every event the server sends with its data,
every error code with its `detail` fields, every close code with what the client should do on it, how to
recover when a join's answer is lost, the rules a client follows to receive handoffs (requirement "Receiving
rules for clients" of `handoff-delivery`), and the rules a client follows to report statuses and keep its Sent
list (requirement "Sending rules for clients" of `handoff-status`), so that a client can be built from it alone.
A test SHALL fail when the operations, the event kinds, the error codes or the close codes listed in the
document differ from those the server defines.

#### Scenario: Undocumented operation
- **WHEN** an operation is added to the server but not to `docs/protocol.md`
- **THEN** the test suite fails, naming the operation

#### Scenario: Undocumented event
- **WHEN** an event kind is added to the server but not to `docs/protocol.md`
- **THEN** the test suite fails, naming the event kind
