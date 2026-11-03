# server-operation Specification

## Purpose
Defines how a team runs the server: configuration, storage and its upgrades, TLS, health checking, the
container, logging and the guarantee that the server only accepts connections and makes none.

## Requirements

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

### Requirement: TLS served directly or by a terminator

With `TLS_CERT` and `TLS_KEY` set, the server SHALL serve TLS itself (TLS 1.2 or later) on its port. Without
them, it SHALL serve plain HTTP and WebSocket on its port, intended to sit behind a TLS terminator, and SHALL
log at startup that it expects one.

#### Scenario: Self-signed certificate
- **WHEN** the server is started with a self-signed certificate and key
- **THEN** a client that pins that certificate's SHA-256 fingerprint connects over `wss://`

#### Scenario: Behind a reverse proxy
- **WHEN** the server is started without TLS variables
- **THEN** it serves plain WebSocket on its port and logs that a TLS terminator is expected in front

### Requirement: One data directory

All state SHALL live in a single SQLite database inside `DATA_DIR`, so that a copy of the directory taken
while the server is stopped is a complete backup. The server SHALL bring an older database up to its schema
at startup, and SHALL refuse to start on a database whose schema is newer than it knows, without changing it.

#### Scenario: Fresh start
- **WHEN** the server starts on an empty data directory
- **THEN** it creates the database and starts

#### Scenario: Downgrade
- **WHEN** a database written by a newer server is opened by an older one
- **THEN** the older server refuses to start, says the database is newer, and leaves it unchanged

### Requirement: Health check

The server SHALL answer `GET /healthz` with HTTP 200 while a query on one of its own tables succeeds, and
with HTTP 503 when it fails. Any other plain HTTP request SHALL be answered with HTTP 404.

#### Scenario: Healthy
- **WHEN** a container health check requests `/healthz` on a running server
- **THEN** it receives HTTP 200

### Requirement: No outbound connections

The server SHALL NOT open any network connection of its own (TCP, UDP or DNS lookups). It only accepts
connections.

#### Scenario: No socket opened by the server
- **WHEN** a test exercises every operation and admin command while observing every client socket the
  process opens
- **THEN** the server process opened none

#### Scenario: Running without network egress
- **WHEN** the server runs in a container with outbound traffic blocked
- **THEN** every feature in this change works

### Requirement: Secrets stay out of logs

The server and the admin command line SHALL NOT write credentials or invite codes to logs. The invite link
printed by `invite create` is the only place an invite code appears.

#### Scenario: Join logged
- **WHEN** a device joins
- **THEN** the log line names the member and device but contains neither the invite code nor the credential

### Requirement: Graceful shutdown

On SIGTERM or SIGINT the server SHALL stop accepting connections, close open connections with close code
1001 and close the database before exiting.

#### Scenario: Container stop
- **WHEN** the container is stopped while devices are connected
- **THEN** each device's connection is closed with code 1001 and the process exits with status 0

### Requirement: Container image

The repository SHALL provide a container image definition that runs the server as a non-root user, keeps
`DATA_DIR` at `/data` as a volume, exposes the port, declares the health check, and puts
`spekterm-server-admin` on the path. A one-page self-hosting guide SHALL explain how to run it behind a
reverse proxy and with a self-signed certificate, how to create the first invite, how to back up, that a
certificate change needs a restart, that replacing a self-signed (pinned) certificate means every device has
to join again, how to recover a device whose join answer was lost, and that the operator can read handoff
contents (PRD §7.1).

#### Scenario: Admin command in the container
- **WHEN** the admin runs `docker exec <container> spekterm-server-admin invite create`
- **THEN** it prints an invite link for the running server
