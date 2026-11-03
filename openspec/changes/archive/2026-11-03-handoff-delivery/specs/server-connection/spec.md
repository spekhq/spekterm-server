## MODIFIED Requirements

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
- **WHEN** an authenticated client sends `{"t":"req","id":7,"m":"presence.set","p":{}}` to a server that does
  not have that operation
- **THEN** the server answers id 7 with `UNKNOWN_OPERATION` and the connection stays open

#### Scenario: Unknown field
- **WHEN** a `hello` request carries an extra field `"resume": 42`
- **THEN** the server ignores the field and authenticates normally

#### Scenario: Bad parameter
- **WHEN** an authenticated client sends `device.rename` with `name: 5`
- **THEN** the server answers `BAD_PARAMS` with `detail.field: "name"`

### Requirement: Operations list

The `operations` field of the `join` and `hello` results SHALL list every operation the server accepts after
authentication. A client SHALL be able to rely on it to hide features the server does not have, instead of
learning it from `UNKNOWN_OPERATION`.

#### Scenario: Operations of this change
- **WHEN** a device authenticates with a server of this change
- **THEN** `operations` is exactly `["device.leave", "device.rename", "handoff.received", "handoff.send", "team.members"]`

### Requirement: The protocol document is the contract

`docs/protocol.md` SHALL describe the invite link, the transport and certificate pinning, the frames, every
operation the server accepts with its parameters and result, every event the server sends with its data,
every error code with its `detail` fields, every close code with what the client should do on it, how to
recover when a join's answer is lost, and the rules a client follows to receive handoffs (requirement
"Receiving rules for clients" of `handoff-delivery`), so that a client can be built from it alone. A test SHALL fail when the
operations, the event kinds, the error codes or the close codes listed in the document differ from those the
server defines.

#### Scenario: Undocumented operation
- **WHEN** an operation is added to the server but not to `docs/protocol.md`
- **THEN** the test suite fails, naming the operation

#### Scenario: Undocumented event
- **WHEN** an event kind is added to the server but not to `docs/protocol.md`
- **THEN** the test suite fails, naming the event kind
