## MODIFIED Requirements

### Requirement: Configuration from the environment

The server and the admin command line SHALL read their configuration from environment variables: `PORT`
(default `8080`), `DATA_DIR` (default `/data`), `PUBLIC_URL` (the address clients use, `wss://host` or
`wss://host:port`, with no path; a trailing `/` is dropped; no default, and only `invite create` needs it),
`TLS_CERT` / `TLS_KEY` (paths to a PEM certificate chain and key; both or neither), and
`HANDOFF_RATE_PER_HOUR` (the most handoffs one member may send in any hour; a whole number from 1 to 10000;
default `30`). An invalid value SHALL stop the server at startup with a message naming the variable. The
certificate is read at startup; replacing it takes effect on restart.

#### Scenario: Only one TLS variable
- **WHEN** `TLS_CERT` is set and `TLS_KEY` is not
- **THEN** the server refuses to start and names the missing variable

#### Scenario: Public address with a path
- **WHEN** `PUBLIC_URL` is `wss://example.com/team`
- **THEN** the server refuses to start, saying the address must not carry a path

#### Scenario: Public address not wss
- **WHEN** `PUBLIC_URL` is `http://team.example.com`
- **THEN** the server refuses to start, saying the address must start with `wss://`

#### Scenario: Invalid rate
- **WHEN** `HANDOFF_RATE_PER_HOUR` is `0` or `many`
- **THEN** the server refuses to start and names `HANDOFF_RATE_PER_HOUR`
