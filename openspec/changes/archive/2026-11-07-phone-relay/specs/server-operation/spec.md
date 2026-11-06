## MODIFIED Requirements

### Requirement: Configuration from the environment

The server and the admin command line SHALL read their configuration from environment variables: `PORT`
(default `8080`), `DATA_DIR` (default `/data`), `PUBLIC_URL` (the address clients use, `wss://host` or
`wss://host:port`, with no path; a trailing `/` is dropped; no default, and only `invite create` needs it),
`TLS_CERT` / `TLS_KEY` (paths to a PEM certificate chain and key; both or neither),
`HANDOFF_RATE_PER_HOUR` (the most handoffs one member may send in any hour; a whole number from 1 to 10000;
default `30`), `RELAY` (`on` or `off`; default `off`), `RELAY_MAX_TUNNELS` (the most relay tunnels at once; a
whole number from 1 to 1000; default `32`) and
`RELAY_KIB_PER_SECOND` (the most KiB per second each direction of a tunnel carries; a whole number from 0 to
1048576, 0 meaning no cap; default `512`). An invalid value SHALL stop the server at
startup with a message naming the variable. The certificate is read at startup; replacing it takes effect on
restart.

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

#### Scenario: Invalid relay setting
- **WHEN** `RELAY` is `yes`, or `RELAY_MAX_TUNNELS` is `0`
- **THEN** the server refuses to start and names the variable

### Requirement: No outbound connections

The server SHALL NOT open any network connection of its own (TCP, UDP or DNS lookups). It only accepts
connections; both legs of a relay tunnel are connections it accepts.

#### Scenario: No socket opened by the server
- **WHEN** a test exercises every operation, a relay tunnel from open to close, and every admin command while
  observing every client socket the process opens
- **THEN** the server process opened none

#### Scenario: Running without network egress
- **WHEN** the server runs in a container with outbound traffic blocked
- **THEN** every feature in this change works
