## Context

spekterm's remote access (`spekterm/docs/remote-protocol.md`) is a TLS WebSocket listener on the desktop
(`src/main/remote-server.ts`: `https.createServer` + `ws` at `/v1`, default port 47615). The certificate is a
self-signed ECDSA P-256 leaf; the phone pins SHA-256 of its DER and checks no host name. The phone then
authenticates inside the WebSocket with `hello {deviceId, deviceSecret}` or `pair {code}`; there is no mutual
TLS. The listener throttles failures per remote address (`AddressThrottle`: 10 failures in 60 s block that
address for 60 s), allows 16 authenticated connections, pings every 20 s, and streams terminal output per pty
chunk and conversation updates as JSON text frames (inner `ws` has `perMessageDeflate: true`).

The phone (spekterm-android, OkHttp 5) races the desktop's addresses with a 250 ms stagger and a 5 s connect
timeout, pins the leaf in its trust manager and host name verifier, and reconnects with backoff and on every
network change. Away from the desktop's network it needs Tailscale or a port forward.

The desktop's team connection (`spekterm/src/main/team-connection.ts`) does `tls.connect` itself, checks the
server's pin (or the system's trust store) on `secureConnect`, and only then hands the socket to `ws`
(`createConnection`), so no byte leaves before the check (`spekterm/docs/lessons/team.md`). spekterm's
`scripts/network-surface.test.mjs` allows `https` + `ws` only in `remote-server.ts` and `tls` + `ws` only in
`team-connection.ts`.

On the server, protocol version 1 is stable and changes only additively. `/connect` carries UTF-8 JSON text
frames only (a binary frame closes with 1003; a frame over 256 KiB with 1009). The server makes no outbound
connections. One team runs it on a Synology DS218j: two Cortex-A9 cores at about 1.3 GHz (ARMv7, NEON, no AES
instructions), 500 MB of memory with about 160 MB available, Node 22 run directly (`docs/self-hosting.md` §1b).

Decided by the user on 2026-11-06, not to be reopened here: direct access stays the default; for members of a
team, the relay is an optional second path, not a replacement.

## Goals / Non-Goals

**Goals:**

- A member's phone reaches that member's desktop through the team server when the operator and the member
  have turned the relay on, with the phone's TLS ending at the desktop and the desktop's authentication
  unchanged.
- Only one's own phone to one's own desktop.
- The server stays inbound-only and its handoff traffic is not slowed by relayed streams.
- Bounded load on a small ARM machine, with limits set from measurement on that machine.
- Additive to protocol version 1; older clients and servers are unaffected.
- A design the spekterm and spekterm-android changes can implement without reopening the server's side.

**Non-Goals:**

- Push, or reaching the desktop while spekterm is closed.
- Remote access to another member's desktop; an officially hosted relay.
- Pairing a phone through the relay (a phone pairs directly, as today; design D11).
- Resuming a tunnel after it ends.
- A relay-only desktop (relay without the desktop's own listener; design D9).

## Decisions

### D1. Control on the team connection, bytes on a connection per tunnel

The handoff that started this asked to argue one of two shapes: carry the relay on the existing team connection
(the "additional channel types" PRD §8.4 reserved), or open other connections.

**Chosen: both, split by job.** Grants and the "a phone is waiting" signal go over `/connect` as ordinary
operations and an event. The relayed bytes go over two new WebSockets per tunnel at a new path `/relay`: one the
phone opens, one the desktop opens on request. The server splices them.

Why not multiplex the bytes onto `/connect`:

- `/connect` is a text protocol: a binary frame closes it (1003), and that rule is part of stable version 1.
  Carrying TLS records would mean base64 inside JSON (a third more bytes, plus a JSON parse and a base64 decode
  per chunk on both ends and on the ARM server) or a binary sub-protocol on a connection whose clients today
  treat a binary frame as a bug.
- Head-of-line blocking: a `cat` of a large file on the terminal the phone is watching would queue in front of
  handoffs, status events and pings on the same TCP stream, and one tunnel's flow control would stall the whole
  team connection. On separate connections TCP gives each tunnel its own flow control for free.
- The desktop's remote-access listener needs a **byte stream per phone** to run TLS on. With a multiplexed
  channel the desktop would have to build a stream per channel, with windows and acknowledgements, which is a
  protocol of its own. With a WebSocket per tunnel, `ws`'s `createWebSocketStream` gives that stream directly.
- Lifetime: a team connection is replaced (4006), reconnected with backoff and closed on revocation, on its own
  schedule. Tunnels that ride it would die with each of those; separate tunnels survive a team reconnect.

Cost of the chosen shape: one more TLS handshake to the server per tunnel on each side, and two more sockets
per tunnel on the server. A tunnel is opened when the phone connects, not per request, so this happens about as
often as the phone reconnects. The handshake cost on the DS218j is measured (D8).

Why not a separate long-lived relay connection from the desktop that multiplexes all its tunnels: it saves the
desktop's per-tunnel handshake but brings back the multiplexing protocol and the head-of-line blocking between
tunnels, for a desktop that rarely has more than one phone connected.

**PRD §8.4's reservation** is thereby used for the control messages only; PRD §8.4 and §8.5 say so.

### D2. Grants

A **grant** lets one phone ask for tunnels to one desktop device.

- `relay.grant { name }` on `/connect` creates one for the calling device and answers `{ grant: Grant, secret }`.
  `name` follows the naming rules (it is the phone's name, shown in `member list`). The secret is 32 random
  bytes in base64url, returned once; the server stores its SHA-256, as for device secrets. Grant ids are
  `g_` + 32 hex digits, under the common id rules.
- `relay.grants {}` lists the calling device's grants: `{ grants: [Grant] }` with
  `Grant = { id, name, createdAt, lastUsedAt? }`, ordered by `createdAt`.
- `relay.revoke { id }` deletes one of the calling device's grants and ends its tunnels (the phone leg with
  4004, the desktop leg with 4010; a pending phone leg is answered `GRANT_INVALID`). It answers
  `{ revoked: boolean }`; `false` when the device holds no such grant (never existed, already revoked, or
  another device's), so a retry after a lost answer is safe and nothing about other devices' grants leaks.
- At most **16** grants per device (spekterm's listener allows 16 authenticated connections at once): the 17th
  is `TOO_MANY_GRANTS` with `detail.limit`.
- A grant belongs to the **device**, not the member: a tunnel must reach one particular desktop. Revoking the
  device (admin), the device leaving, and removing the member delete its grants in the same transaction and end
  its tunnels (4004).
- Grants are stored in the database and survive restarts. With `RELAY` off they are kept but unusable, and the
  relay operations are not offered.

The desktop gives a grant's id and secret, with the server's address and pin, to one paired phone over that
phone's authenticated remote connection (D9). The server never learns the phone's remote-access identity at the
desktop; it knows the phone by its grant and by the grant's `name`, which the desktop sets (usually the phone's
name) and `member list` shows.

### D3. The `/relay` endpoint and the handshake

`/relay` accepts WebSocket upgrades like `/connect` (same TLS, same 256 KiB frame limit, same ping every 30 s).
Before the splice a connection speaks the frame format of `/connect` (text JSON `req` / `res`), limited to one
request; after it, binary frames only. With `RELAY` off, `relay.open` and `relay.accept` are still parsed and
version-negotiated, then answered `RELAY_DISABLED`.

Phone leg:

1. The phone sends `relay.open { protocol: [1], grant: string, secret: string }`.
2. The server checks, in order: protocol (`UNSUPPORTED_VERSION`); relaying on (`RELAY_DISABLED`); parameters
   (`BAD_PARAMS`); the grant and secret (`GRANT_INVALID`, constant-time compare); the grant's open rate
   (`RATE_LIMITED`, `detail.retryAt`); the limits (`RELAY_BUSY`, `detail.limit`: `"server"` or `"device"`);
   that the grant's device has an authenticated `/connect` connection (`DESKTOP_UNAVAILABLE`).
3. The server creates a tunnel id (`t_` + 32 hex digits), records the tunnel as pending, and sends
   `relay.incoming { tunnel, grant, expiresAt }` to the device's current `/connect` connection.
4. When the desktop leg is accepted, the server answers the phone `{ protocol: 1, tunnel }`. From that answer
   on, the phone may send binary frames; it starts its TLS handshake to the desktop.
5. If the desktop refuses (`relay.refuse`), the phone gets `DESKTOP_REFUSED`. If the desktop does not accept
   within **10 seconds**, or its `/connect` connection closes first, `DESKTOP_UNAVAILABLE`.

Desktop leg:

1. On `relay.incoming`, the desktop either refuses with `relay.refuse { tunnel }` on `/connect` (answered `{}`,
   also for an unknown tunnel), or opens a WebSocket to `/relay` on the **same server address, with the same
   certificate check** as its team connection, and sends
   `relay.accept { protocol: [1], deviceId, deviceSecret, tunnel }`.
2. The server checks: protocol; relaying on; the device credential (`AUTH_FAILED`); that the tunnel is pending
   and belongs to that device (`TUNNEL_UNKNOWN`, also after the 10 seconds or after the phone leg went away).
3. The server answers the desktop `{ protocol: 1 }`, then the phone (step 4 above), and splices.

Rules shared with `/connect`'s pre-authentication phase: one request within **10 seconds** of opening or close
4001 (a pending phone leg has sent its request, so the 10 seconds of step 5 apply instead); every error answer
followed one second later by close 4003; frames in that second ignored; no events on `/relay`. A text frame
that is not a request is `BAD_FRAME`; an operation other than `relay.open` / `relay.accept` (including `hello`)
is `UNKNOWN_OPERATION` on this endpoint. A binary frame before the answer, or any data frame (text or binary;
pings and pongs are not data) after the request and before its answer, closes with 1003.

While a phone leg is pending:

- The phone leg closes → the tunnel is dropped; a later `relay.accept` for it is `TUNNEL_UNKNOWN`.
- The grant is revoked, or the desktop device is revoked, leaves or its member is removed (which deletes the
  grant) → the phone is answered `GRANT_INVALID`, then 4003. The phone discards the grant, as on an open tunnel's
  4004. This takes precedence over the next rule: when a revocation also closes the `/connect` connection, the
  server settles the pending tunnels of deleted grants first.
- The `/connect` connection the `relay.incoming` went to closes, for any reason including replacement (4006) →
  `DESKTOP_UNAVAILABLE`; the phone retries and the new connection gets a new `relay.incoming`.
- The server shuts down → the phone leg is closed with 1001 without an answer.
 `relay.accept` does **not** count as the device's `/connect` connection: it neither replaces it (no 4006)
nor is it offered handoffs.

Why the desktop dials and the server does not: the server stays inbound-only (`server-operation`), and the
desktop's remote-access listener stays unreachable from outside unless the desktop itself reaches out.

Why the phone's answer waits for the splice instead of answering at once and buffering: the phone's TLS
handshake then starts against a live peer, and a desktop that never comes is reported with a code the phone can
act on, not a TLS timeout.

### D4. Splicing and flow control

After the answers, each binary message from one leg is sent as one binary message on the other, unchanged.
The server does not inspect, buffer beyond the flow-control window, or log the bytes.

- **Message size**: a binary message on `/relay` may be at most 256 KiB (the endpoint's frame limit, 1009 over
  it). A client **must cut its stream writes into messages of at most 64 KiB**. This matters because both ends
  run TLS over a stream wrapped around the WebSocket (`createWebSocketStream` sends one message per write), and
  Node's `TLSSocket` over a JS duplex hands down all records of one application write as one chunk: the review
  measured a 4 MiB write arriving as one 4.2 MB chunk, and a 300 KiB write through `createWebSocketStream`
  closing a 256 KiB-limited peer with 1009. spekterm's remote protocol allows 1 MiB messages, so without
  cutting, a large snapshot would kill the tunnel on every reconnect. D9 and D10 require a cutting step in front
  of the WebSocket.
- **Flow control**: when the receiving leg's `bufferedAmount` exceeds **64 KiB**, the server pauses reading from
  the sending leg (`ws.pause()`, which stops reading the socket so TCP pushes back to the sender) and resumes it
  when the amount falls under **16 KiB**. The window is small on purpose: everything the server holds for a leg
  sits in front of that leg's pings, and in front of the inner protocol's own pings (spekterm's listener pings
  every 20 s and drops a phone after two missed). At 10 KiB/s, 64 KiB adds about 6 s; the 1 MiB of the first
  draft added up to 100 s (the review measured no pong for 65 s at 10 KiB/s behind a 1 MiB backlog). Kernel
  socket buffers add to this and to memory, outside the server's control and outside RSS; task 1.2 records them
  (`/proc/net/sockstat`) in a slow-reader run.
- **Liveness of a leg** (replaces `/connect`'s missed-pong rule on `/relay`): the server pings every 30 s, and at
  each tick a leg counts as alive if it answered the previous ping, **or** more of the bytes forwarded to it left
  the server's buffers since the previous tick (its peer's TCP is accepting them, so the peer is reading), **or**
  the server has it paused (it cannot read the pong then). Progress is counted as bytes forwarded minus bytes
  still unsent, not as a shrinking buffer: found in implementation, a backlog that has moved into the kernel's
  socket buffer leaves the server's buffer empty while the pong still waits behind it. A leg's pong state starts
  afresh when it is resumed. A leg that is not alive at a tick is terminated and the other leg closed with 4010.
  With nothing forwarded since its last pong, a dead peer is found within 60 s, as on `/connect`. Otherwise
  progress stands in for the pong; a peer that stops reading entirely stops its TCP window and so the progress,
  and is found **after 120 s** without progress or pong (so a phone stalled for a moment, for example switching
  networks, is not dropped at the first tick). What the kernel holds for a slow peer is bounded by TCP's window,
  small on a slow link.
  The paused sending leg is never judged while paused, so a stuck receiver ends the tunnel through its own leg.
- **Throughput cap**: each direction of a tunnel may carry at most `RELAY_KIB_PER_SECOND` KiB per second. A token
  bucket holding at most one second's worth, full at the start, refilled every 100 ms; each forwarded message
  takes its size from the bucket, which **may go negative** (a message larger than the bucket must still pass);
  while it is negative, the sending leg is paused (and is therefore not judged by the liveness rule). In any T seconds a
  direction therefore carries at most `cap × (T + 1)` plus one message plus what one socket read had already
  buffered when the pause began. `0` disables the cap. The default comes from D8.
- A **text frame** after the splice closes the tunnel (that leg with 1003, the other with 4010). A frame over
  256 KiB closes that leg with 1009 and the other with 4010.

### D5. Limits

| Limit | Setting | Default | Over it |
|---|---|---|---|
| Tunnels at once, open or pending, on the server | `RELAY_MAX_TUNNELS` | 32 (D8) | `RELAY_BUSY`, `detail.limit: "server"` |
| Tunnels at once per desktop device | fixed | 4 | `RELAY_BUSY`, `detail.limit: "device"` |
| `relay.open` per grant | fixed | 20 per 10 minutes, counted when `relay.incoming` is sent, whatever follows | `RATE_LIMITED`, `detail.retryAt` |
| Throughput per tunnel and direction | `RELAY_KIB_PER_SECOND` | 512 (D8) | paused (D4) |
| Grants per device | fixed | 16 | `TOO_MANY_GRANTS` |

The per-device limit of 4 covers a phone and a tablet with one reconnect each in flight; a fifth tunnel from the
same person is a loop, not a use. The open rate stops a looping phone (or a leaked grant) from making the
desktop dial again and again. It counts at the moment the desktop is told, because that is the cost it bounds:
a phone that opens and closes before the answer has still made the desktop dial. An immediate
`DESKTOP_UNAVAILABLE` (the desktop is not connected, nothing is sent to it) is not counted, so a phone retrying
while the desktop is off is not locked out when it comes back. 20 per 10 minutes is above what
spekterm-android's backoff produces (1 s doubling to 60 s, with a network change ending the current wait
without resetting the count) for an ordinary day of moving between networks. The per-grant counters live in
memory and reset on restart, which is acceptable: a restart also ends every tunnel.

### D6. How a tunnel ends

| Event | Phone leg | Desktop leg |
|---|---|---|
| The other leg closes, for any reason, or misses a ping | 4010 | 4010 |
| The grant is revoked (`relay.revoke`) | 4004 | 4010 |
| The desktop device is revoked, leaves, or its member is removed | 4004 | 4004 |
| The server shuts down | 1001 | 1001 |
| A text frame, or an oversized frame, on one leg | 1003 / 1009 on that leg, 4010 on the other | |

4004 keeps its version 1 meaning, "discard this credential": for the phone it is the grant. A new close code
**4010** means "the other end of the tunnel is gone": reconnect with backoff. A tunnel survives its desktop's
`/connect` connection being replaced or reconnecting; only pending tunnels need that connection.
Revocations made by the admin command line (another process) reach tunnels through the revocation sweep, within
10 seconds. The sweep today looks only at devices with a `/connect` connection and skips when there are none;
it must check the devices with a `/connect` connection **and** the devices with tunnels, because a tunnel
outlives its desktop's team connection. Pending tunnels end as listed in D3. Nothing is resumed: the phone reconnects as after any drop, and spekterm's remote
protocol already resumes the watched terminal and conversation.

### D7. Configuration, operations list, logs

- `RELAY`: `on` or `off`, default `off`. Any other value stops the server at startup. When off, `/relay`
  still upgrades but answers every request `RELAY_DISABLED` (then 4003), so a phone can tell a server that does
  not relay from one too old to have `/relay` (HTTP 404); and the relay operations on `/connect` are not
  offered (`UNKNOWN_OPERATION`, absent from `operations`).
- `RELAY_MAX_TUNNELS` (1–1000) and `RELAY_KIB_PER_SECOND` (0–1048576), whole numbers, defaults from D8.
- `operations` with `RELAY=on` adds `relay.grant`, `relay.grants`, `relay.refuse`, `relay.revoke`. `relay.open`
  and `relay.accept` belong to `/relay` and are listed in the protocol document's relay section, not in
  `operations`. The four `/connect` operations are registered in `OPERATIONS` **always** (so the protocol
  document test, which compares the document with the static registry, holds), and dispatch answers them
  `UNKNOWN_OPERATION` before the authentication check when relaying is off; `authenticatedOperations` takes the
  setting. `/relay`'s two operations live in their own registry.
- Log lines: `tunnel <t> opened: device <d>, grant <g>`; `tunnel <t> closed after <s> s: <n> bytes to the
  desktop, <m> bytes to the phone (<reason>)`; refusals by code and grant id. No addresses (the server logs
  none today), no secrets, no content.
- `member list` (admin) shows each device's grants: name, created, last used.

### D8. Measuring the cost, and setting the defaults from it

The relay terminates TLS twice per byte on the server (phone leg in, desktop leg out) and does WebSocket framing
twice; the phone's inner TLS passes through. The user asked for measurement on the deployment's machine, not
inference.

`scripts/relay-bench.mjs` runs each scenario in a **fresh** WSS server process that pairs connections and
splices them as D4 does (with a 30 s ping), plus clients on the same machine, and reports the server process's
CPU (`process.cpuUsage`) and RSS. Scenarios: 20 tunnels idle for 70 s (two pings: the steady state, since the
phone's foreground service keeps its tunnel open), one tunnel at 16 and 64 KiB/s in **256-byte and 1 KiB
messages** (what pty chunks become after the inner WebSocket and TLS: the cost follows the number of messages
more than the bytes, the review measured 44 times the CPU for the same 64 KiB/s in 256 B messages as in 64 KiB
ones), 128, 256 and 512 KiB/s in 1 KiB messages, 1 MiB/s and unbounded in 16 KiB messages, four tunnels at 64 KiB/s in 1 KiB
messages, and tunnel opens per second. Each runs once with the default cipher and once with the server preferring
`TLS_CHACHA20_POLY1305_SHA256`, because the A9 has no AES instructions.

Reference run on an x86 laptop (Node 22, AES-NI), server process only, each scenario in a fresh process, with the
negotiated cipher checked per scenario (`TLS_AES_256_GCM_SHA384` by default, `TLS_CHACHA20_POLY1305_SHA256` with
the ChaCha preference):

| Scenario | Relayed | CPU, AES-256-GCM | CPU, ChaCha20 |
|---|---|---|---|
| 20 tunnels idle, 70 s (≈ 180 KiB RSS per tunnel) | 0 | 0.1 % | |
| 1 tunnel, 16 KiB/s in 256 B | 16 KiB/s | 3.5 % | 3.5 % |
| 1 tunnel, 64 KiB/s in 256 B | 63 KiB/s | 4.7 % | 4.6 % |
| 1 tunnel, 64 KiB/s in 1 KiB | 63 KiB/s | 3.6 % | 3.2 % |
| 1 tunnel, 128 KiB/s in 1 KiB | 127 KiB/s | 4.1 % | 4.3 % |
| 1 tunnel, 256 KiB/s in 1 KiB | 253 KiB/s | 4.8 % | 5.0 % |
| 1 tunnel, 512 KiB/s in 1 KiB | 506 KiB/s | 5.6 % | 5.8 % |
| 1 tunnel, 1 MiB/s in 16 KiB | 1014 KiB/s | 4.3 % | 4.6 % |
| 1 tunnel, unbounded in 16 KiB | 91 MiB/s | 64 % | 68 % |
| 4 tunnels, 64 KiB/s each in 1 KiB | 253 KiB/s | 6.5 % | 6.4 % |
| tunnel opens, both legs (client-bound: opened one after another) | 95 / 126 per s | 46 % | 47 % |

With AES instructions the two ciphers cost the same, as expected; on the A9 they will not. The bench also has a
single-scenario mode (`ONLY=<tunnels>,<KiB/s>,<message bytes>,<seconds>`) for the rules below.

These numbers say nothing about the DS218j; they show the method works.

**DS218j run** (2026-11-06, Node 22.23.4, the NAS's own services running; bench clients on the same machine,
so the unbounded rows are limited by both cores together):

| Scenario | Relayed | CPU, AES-256-GCM | CPU, ChaCha20 |
|---|---|---|---|
| 20 tunnels idle, 70 s (≈ 163 KiB RSS per tunnel) | 0 | 0.2 % | |
| 1 tunnel, 16 KiB/s in 256 B | 16 KiB/s | 5.4 % | 6.1 % |
| 1 tunnel, 64 KiB/s in 256 B | 63 KiB/s | 10.6 % | 10.1 % |
| 1 tunnel, 64 KiB/s in 1 KiB | 64 KiB/s | 5.7 % | 5.5 % |
| 1 tunnel, 128 KiB/s in 1 KiB | 127 KiB/s | 10.0 % | 9.3 % |
| 1 tunnel, 256 KiB/s in 1 KiB | 254 KiB/s | 12.9 % | 10.5 % |
| 1 tunnel, 512 KiB/s in 1 KiB | 509 KiB/s | 16.4 % | 12.8 % |
| 1 tunnel, 1 MiB/s in 16 KiB | 1014 KiB/s | 18.6 % | 10.9 % |
| 1 tunnel, unbounded in 16 KiB | 4.0 MiB/s | 57 % | 15 MiB/s at 87 % |
| 4 tunnels, 64 KiB/s each in 1 KiB | 254 KiB/s | 18.2 % | 16.5 % |
| 2 tunnels, 256 KiB/s each in 1 KiB | 507 KiB/s | 20.2 % | |
| 2 tunnels, 512 KiB/s each in 1 KiB | 1009 KiB/s | 26.1 % | |
| tunnel opens, both legs (client-bound) | 27 per s | 51 % | 50 % |

**Slow readers on the DS218j** (the reading side paced by pausing its socket, behind an unbounded sender; the
kernel's TCP memory from `/proc/net/sockstat`, in 4 KiB pages, with both ends of each connection on the NAS):
one tunnel 949 pages (3.7 MiB), four tunnels 3,748 pages (14.6 MiB), server CPU 3.9 % and 9.7 %, server RSS
unchanged. On a real network the phone's half of that sits on the phone, and a slow link keeps TCP's window
small, so this is an upper bound. The kernel caps all TCP memory itself (`tcp_mem` on this NAS: pressure from
15,774 pages, 62 MiB), shrinking buffers rather than failing.

What the run decides:

- **Stop rule**: not triggered; one tunnel at 64 KiB/s in 1 KiB messages takes 5.7 % of one core.
- **`RELAY_KIB_PER_SECOND` = 512**: the highest candidate within a quarter core (16.4 %).
- **`RELAY_MAX_TUNNELS` = 32**: idle tunnels cost about 163 KiB each, so the 50 MB rule alone would allow about
  300, and two tunnels at the cap take 26 % of one core, within the half-core rule. 32 is chosen below both, as
  eight members with a phone and a tablet and a reconnect in flight each. The slow-reader run bounds a stalled
  tunnel's kernel memory at under 3.7 MiB; 32 of them at once would reach the kernel's own TCP memory pressure,
  which it handles by shrinking buffers, so 32 stays.
- **Cipher: prefer ChaCha20.** The two-thirds rule as written (1 KiB scenarios) is not met (ChaCha costs 78–81 %
  of AES at 256–512 KiB/s), but ChaCha is never more expensive in any scenario and carries 3.7 times the bulk
  throughput per core (15 MiB/s at 87 % against 4 MiB/s at 57 %), which is what a large snapshot or a `cat` needs.
  The rule is replaced by: prefer ChaCha20 when it is no more expensive in any 1 KiB scenario and cheaper in the
  bulk one.

The rules the run was judged by, set before it: The DS218j run gates
the defaults, by these rules:

- `RELAY_KIB_PER_SECOND`: the highest of 64, 128, 256, 512 KiB/s at which one tunnel **in 1 KiB messages** uses
  at most a quarter of one core (all four are bench scenarios).
- `RELAY_MAX_TUNNELS`: the most tunnels whose idle memory stays under 50 MB **and** of which two at the cap use at
  most half a core, measured with the single-scenario mode at the chosen cap (a team rarely has more than two
  members watching a busy terminal at once; the rest are idle tunnels, measured at their real cost).
- **Cipher**: if ChaCha20 costs at most two-thirds of the default cipher's CPU in the 1 KiB scenarios, a server
  that serves TLS itself prefers it: `ciphers` starting `TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:`
  followed by Node's defaults, with `honorCipherOrder: true` (Node has no separate TLS 1.3 option; the first
  draft's `ciphersuites` was silently ignored). Behind a reverse proxy the guide tells the operator the same.
- **Stop**: if one tunnel at 64 KiB/s in 1 KiB messages needs more than a quarter of one core, the design goes
  back to the user before implementation continues.

The measured numbers go into `docs/self-hosting.md` (the operator's reference) and into D5 here. After the
clients exist, a real session (the phone watching a busy terminal and a conversation through the DS218j) is
measured from the tunnel's close log (bytes, duration) and `top` (task 7.3).

**Real session through the DS218j** (task 7.3, 2026-11-07 Taipei time): a Pixel 7 on a cellular network reached
a spekterm desktop at another site through the NAS for 980 s, watching a terminal that printed a 15-line process
list every 2 s for 5 minutes, then a few hundred lines a second for 5 minutes with one 2.7 MB burst. The tunnel
carried 893,747 bytes to the phone and 4,663 to the desktop (about 0.9 KiB/s on average) and never dropped; the
server process used 1.63 s of CPU in 15 minutes (0.2 % of one core on average, at most about 1.4 % over any
5 s), its RSS grew by 0.3 MB, and the kernel's TCP memory stayed under 60 pages. Far less crossed than the
terminal printed, so spekterm's remote protocol evidently sends the phone much less than raw terminal output
(not investigated here; a question for spekterm). The defaults stand.

### D9. spekterm (desktop) — work for its own change

Recorded here so the server side does not have to be reopened; spekterm's change decides the details.

- **Setting**: "Reach this desktop from the phone through the team server", off by default; shown when the team
  connection is up, its `operations` list `relay.grant`, and remote access is on. Turning it on asks for a grant
  for each paired phone; turning it off, leaving the team, or the device being revoked revokes them (or they
  are gone with the device).
- **Grants**: one per paired phone, created when the phone pairs (setting on) or when the setting is turned on.
  The desktop keeps each grant's id and secret in its secrets file (0600, as the device secret) next to the
  phone's remote device id, and gives them to that phone over its authenticated remote connection — an additive
  field or event in spekterm's remote protocol carrying `{ url, fp?, grant, secret }`, where `url` and `fp`
  are the team server's address and pin as the desktop holds them. Unpairing the phone revokes its grant. After
  every `hello`, the desktop reconciles with `relay.grants` (revoke what it no longer wants, forget what the
  server no longer has).
- **Tunnels**: `relay.incoming` is handled in `team-connection.ts`'s event path. The desktop refuses
  (`relay.refuse`) when the setting or remote access is off or the grant is not one it holds; otherwise it opens
  the desktop leg **in `team-connection.ts`** (which already may import `tls` and `ws`), with the same
  "verify on `secureConnect`, then `createConnection`" sequence and the same pin, to the team server's own
  address — never an address from the event. It wraps the WebSocket with `createWebSocketStream` **behind a
  step that cuts every write into messages of at most 64 KiB** (D4) and hands the duplex to `remote-server.ts`
  through a narrow function that calls `server.emit('connection', duplex)`, so the listener's TLS, `ws` upgrade,
  authentication, connection limits and pings apply unchanged. (The review checked that `emit('connection',
  duplex)` on an `https.Server` serves TLS and HTTP over a JS duplex.)
- **Inner keepalive**: the relay holds at most 64 KiB per direction in front of the listener's pings (D4), so a
  relayed phone on a slow link sees the listener's 20 s pings a few seconds later than a direct one would; no
  change to the listener's keepalive is needed for that, but spekterm's change should check it on a slow link.
- **No pairing through the relay**: a relayed connection accepts `hello` only, not `pair` (D11), so an open
  pairing code is reachable only from the desktop's own network, as today.
- **Throttle key**: a relayed connection has no `remoteAddress` (the review measured `undefined`, with the
  original duplex reachable only through internal fields), so `AddressThrottle` would key every relayed phone as
  `'unknown'` and ten failures through any grant would block all of them. Relayed connections must be throttled
  by `relay:<grant id>`; how the listener learns the grant of a connection (for example by building the
  `TLSSocket` itself, or a map filled before `emit`) is for spekterm's change to settle.
- **Network surface**: no new module or import is allowed, so `scripts/network-surface.test.mjs`'s allow-lists
  stay as they are, but what they protect changes: CLAUDE.md's "no relay, no outbound connection" for remote
  access, the website's "Data and network" page and the PRD's remote access section say that, with the setting
  on, the desktop opens a connection to the team server when one of its phones asks. The listener still needs
  to be on (`listen()`), because the relay is a second path; a listener that accepts relayed connections without
  listening on a port is out of scope.
- **Lifecycle**: tunnels are independent of the team connection's reconnects; ending remote access ends them
  (the listener's `#stop` terminates its `ws` clients, relayed ones included).

### D10. spekterm-android — work for its own change

- **Message size**: cut every write on the outer WebSocket into messages of at most 64 KiB (D4).
- **Timeouts**: the relay path is outer TLS and upgrade, up to 10 s waiting for the desktop, then the inner TLS
  and `hello`; its open timeout must be at least 25 s, not the 10 s used for a direct address, or the phone gives
  up before the server can answer `DESKTOP_UNAVAILABLE`.
- **When to use the relay**: only with a grant from its desktop. The relay joins the existing address race as
  the last candidate, started **1 second after the last direct candidate** started, so on the desktop's network
  the direct path wins and elsewhere the relay answers about a second after the race begins (direct candidates
  to private addresses may hang until their 5 s connect timeout, which the race already tolerates). A network
  change reconnects and races again, so moving back onto the desktop's network returns to direct. The UI says
  which path is in use.
- **Two certificate checks**: the outer connection to the team server is pinned to the server's `fp` when the
  grant info carries one, otherwise checked against the system's trust store with the host name; the inner TLS
  to the desktop is checked exactly as today (leaf pin in the trust manager and host name verifier, and again on
  open). Nothing is sent on the outer connection before its check, and no inner byte before `relay.open` is
  answered.
- **Layering**: the inner TLS + WebSocket must run over the outer WebSocket's byte stream. Two ways fit the
  current OkHttp stack: (a) an `SSLEngine` over the outer WebSocket with the inner WebSocket framed by hand, or
  (b) a `java.net.Socket` backed by the outer WebSocket given to OkHttp through a custom `SocketFactory`, with the
  existing `sslSocketFactory` and pin on top. The Android change chooses; (b) keeps the inner client unchanged
  but must satisfy OkHttp's socket calls.
- **Codes**: `GRANT_INVALID` or close 4004 → discard the grant, stop using the relay until the desktop gives a new
  one. `RELAY_DISABLED`, HTTP 404 → stop trying the relay for this server until the grant info changes or the
  app restarts. `DESKTOP_UNAVAILABLE`, `DESKTOP_REFUSED`, `RELAY_BUSY`, 4010, 1001 → backoff as today.
  `RATE_LIMITED` → wait until `detail.retryAt`.
- The phone needs no team membership and never sees a member credential.

### D11. Pairing stays direct

A phone gets its grant only after it is paired and connected, and the desktop does not accept `pair` on a
relayed connection (D9). Carrying a grant in the pairing link (so a phone
could pair away from the desktop's network) would put a credential into a QR code that is valid longer than the
5-minute pairing code, and the grant must exist before the phone does. Left out; a later change can add it.

### D12. Storage

Schema migration 4 adds `relay_grants (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
name TEXT NOT NULL, secret_hash BLOB NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER)` with an index
on `device_id`. Deleting a grant deletes its row. `last_used_at` is written on each accepted `relay.open`
(at most 20 per 10 minutes per grant). Tunnels are in memory only.

### D13. Protocol document

`docs/protocol.md` gains, additively: the four `/connect` operations in section 5; `relay.incoming` in
section 10; the new error codes (`RELAY_DISABLED`, `GRANT_INVALID`, `DESKTOP_UNAVAILABLE`, `DESKTOP_REFUSED`,
`RELAY_BUSY`, `TUNNEL_UNKNOWN`, `TOO_MANY_GRANTS`) and close code 4010 in section 3; and a new section "13. The
relay" with the `/relay` endpoint, `relay.open`, `relay.accept`, the splice, flow control, how a tunnel ends,
the rules for the phone and the desktop (D9, D10 in protocol terms) and what the server sees. Section 2's "Any
other path is refused with HTTP 404" names `/relay`. `test/protocol-doc.test.ts` also reads `/relay`'s
operations from section 13 and the relay error codes' client actions from its own table.

## Risks / Trade-offs

- **The DS218j may be too slow for useful streams** (no AES instructions, two A9 cores, shared with the NAS's
  own services) → measured before defaults are set (D8), with a stop-and-ask threshold; ChaCha20 measured too.
- **Operator reach to the desktop's listener** (PRD §7.7) → the desktop dials only for grants it holds, to its
  own server; the listener's authentication is unchanged; off by default for the member.
- **A leaked grant** lets its holder make the desktop dial up to 20 times in 10 minutes (counted when the desktop
  is told, so closing early does not escape it), and reach the listener's TLS → still needs a phone credential
  (`pair` is refused on relayed connections); unpairing revokes.
- **Two TLS terminations on the server per byte** double the CPU of a plain proxy → accepted for blindness and
  pinning; measured.
- **The relay hides the network path from the user** → the phone shows which path it uses (D10).
- **Defaults fitted to one machine** → they are settings; `docs/self-hosting.md` says how to run the bench on
  other hardware.

## Migration Plan

- Schema migration 4 runs at startup; an older server refuses the newer database, as today (restore the backup
  to go back).
- `RELAY` defaults to off, so upgrading changes nothing until the operator turns it on.
- Order: server 0.4.0 → spekterm → spekterm-android. Each client hides the relay until the other side has it
  (`operations`, grant info present).

## Open Questions

- How spekterm's listener learns a relayed connection's grant for its throttle (D9) is left to spekterm's change.
- Task 7.3 (a real session through the DS218j) can only run after spekterm and spekterm-android ship the relay,
  so this change stays open until then.
