# spekterm-server protocol, version 1

The contract between spekterm (the client) and spekterm-server. It is written so that a client can be built
from it alone. `test/protocol-doc.test.ts` fails when the operations, error codes or close codes listed here
and the ones the server defines differ.

**Status: draft.** Version 1 may still change, additively or not, until a spekterm release ships a client
for it. From then on version 1 changes only additively — new operations, new optional fields, new event kinds,
new error codes — and anything else is version 2. A client must ignore fields it does not know.

The frames and most names follow spekterm's own remote protocol (`spekterm/docs/remote-protocol.md`), so the
two read alike. Section 9 lists where they differ.

## 1. Invite link

An admin creates an invite on the server and sends its link to the person joining, who pastes it into
spekterm's Settings → Team:

```
spekterm://join?v=1&s=<server address>&c=<code>[&fp=<fingerprint>]
```

| Field | Meaning |
|---|---|
| `v` | Link version, `1`. |
| `s` | The server's address, `wss://host` or `wss://host:port`, URL-encoded. No path. |
| `c` | The invite code: 26 characters of RFC 4648 base32 (128 bits). Single use; expires (default 7 days). Case-insensitive. |
| `fp` | Present only when the server serves a self-signed certificate (or the admin forced it for a private authority): SHA-256 of the server's leaf certificate in DER, 64 upper-case hex digits, no separators. Compare case-insensitively. |

The link is a secret until it is used: anyone holding it can join.

## 2. Transport and certificate pinning

- **WebSocket over TLS**: `<s>/connect`, for example `wss://team.example.com/connect`. Any other path is refused
  with HTTP 404. Refuse a server address that is not `wss://`.
- **Without `fp`**: verify the certificate as usual, against the system's trust store and the host name.
- **With `fp`**: trust exactly the pinned certificate — the leaf's SHA-256 over its DER must equal `fp`. No CA,
  no host name. Keep the pin with the membership. If the server's certificate changes, the pin no longer
  matches and the device has to join again with a new invite; say so instead of retrying.
- Send nothing before the certificate is verified.
- Frames are UTF-8 JSON **text** frames. A binary frame closes the connection with 1003. A frame over
  **256 KiB** closes the connection with 1009, with no answer.
- The server pings every 30 seconds and drops a connection that has not answered the previous ping. WebSocket
  libraries answer pings on their own.

## 3. Frames

| Direction | Shape |
|---|---|
| client → server | `{ "t": "req", "id": <number or string>, "m": "<operation>", "p": { … } }` |
| server → client, answer | `{ "t": "res", "id": <same id>, "ok": true, "r": <result> }` |
| | `{ "t": "res", "id": <same id>, "ok": false, "e": { "code": "<CODE>", "message": "<text>", "detail": { … }? } }` |
| server → client, event | `{ "t": "evt", "k": "<kind>", "d": <data> }` |

`id` is chosen by the client and echoed. Every request gets exactly one answer. `p` may be omitted for an
operation without parameters. A frame that is not a request is answered with `BAD_FRAME` (`id: null` when no id
could be read). Events are listed in section 10; clients must ignore event kinds they do not know. Events are
sent only to authenticated connections, and never before the `join` / `hello` answer.

### Error codes

Stable strings; branch on them, show `message` only as a detail.

| Code | Meaning |
|---|---|
| `BAD_FRAME` | Not a request frame. |
| `BAD_PARAMS` | A parameter is missing, has the wrong type or an invalid value. `detail.field` names it. |
| `UNKNOWN_OPERATION` | Not an operation of this server. Nothing happened. |
| `UNSUPPORTED_VERSION` | None of the offered protocol versions is spoken. `detail.supported` lists the server's. |
| `NOT_AUTHENTICATED` | An operation that needs an authenticated connection, sent before `join` or `hello` succeeded. |
| `ALREADY_AUTHENTICATED` | `invite.inspect`, `join` or `hello` on a connection that is already authenticated. The connection stays open. |
| `AUTH_FAILED` | The device is not on the team: unknown, revoked, removed with its member, or a wrong secret. Before authentication it is followed by 4003; on an authenticated connection (the device was revoked moments ago) by 4004 right after the answer, and the request did nothing. Either way, discard the credential. |
| `INVITE_UNKNOWN` | No such invite: never issued, cancelled, or for a member who was removed since. |
| `INVITE_EXPIRED` | The invite has expired. |
| `INVITE_USED` | The invite was already used. |
| `HANDLE_TAKEN` | Another member has this handle. The invite is still good; ask for another handle. |
| `RECIPIENT_UNKNOWN` | `handoff.send`: no member with that handle (or they were removed). Nothing was stored. |
| `RECIPIENT_IS_SELF` | `handoff.send`: a handoff goes to someone else. |
| `HANDOFF_ID_REUSED` | `handoff.send`: this `clientId` was already used by this member for a different handoff (another recipient or text). Use a new `clientId`. |
| `RATE_LIMITED` | `handoff.send`: the member sent the most handoffs allowed in an hour. `detail.retryAt` (ms since the epoch) is the earliest time the same send is accepted. |
| `HANDOFF_UNKNOWN` | `handoff.received`, `handoff.update`: no such handoff for this member (never sent, or its record was deleted after 90 days). |
| `HANDOFF_EXPIRED` | `handoff.received`, `handoff.update`: the handoff expired (30 days, or its recipient was removed). Remove it from the inbox. |
| `HANDOFF_DELIVERED_ELSEWHERE` | `handoff.received`, `handoff.update`: another device of this member acknowledged it first. Remove it from the inbox. |
| `HANDOFF_NOT_DELIVERED` | `handoff.update`: the handoff was not acknowledged yet. Acknowledge it with `handoff.received`, then report again. |
| `HANDOFF_FINISHED` | `handoff.update`: the report contradicts a final status (`declined`, or `declined` after `done`). `detail.status` is the current status. Stop reporting for it. |
| `TOO_MANY_REPORTS` | `handoff.update`: this handoff already has the most reports allowed. `detail.limit` is that number (10). |
| `INTERNAL` | Anything else. |

### Close codes

| Code | When | Client |
|---|---|---|
| 1001 | The server is shutting down. | Reconnect with backoff. |
| 1003 | A binary frame was sent. | A client bug; do not retry automatically. |
| 1009 | A frame over 256 KiB was sent. | A client bug; do not retry automatically. |
| 1011 | The server could not bring this connection's `handoff.status` events up to date (an internal failure). | Reconnect with backoff, then `handoff.sync` from the last stored `seq`. |
| 4001 | No successful `join` or `hello` within 10 seconds of the connection opening. | Expected after `invite.inspect` on its own connection; otherwise reconnect. |
| 4003 | Refused: one second after an error answer before authentication. | Depends on the error before it (section 4). |
| 4004 | The device was revoked (by the admin, by removing its member, or by `device.leave`). | Do not reconnect with that credential; discard it. Joining again needs a new invite. |
| 4006 | A newer connection of the same device replaced this one. | Do not reconnect on your own: another process or machine is using this credential. |

A connection that drops without a close code (1006) is reconnected with backoff.

## 4. Before authentication

The first requests on a connection may be `invite.inspect`, `join` and `hello`; nothing else is accepted until
`join` or `hello` succeeds (`NOT_AUTHENTICATED`). A connection must authenticate within **10 seconds** or it is
closed with 4001; a successful `invite.inspect` does not extend this.

Before authentication, **every error answer is followed one second later by close 4003**, and frames that
arrive in that second are ignored. Reconnect to try again — but only where the error says retrying can help:

| Error before 4003 | Client |
|---|---|
| `AUTH_FAILED` | The device is not, or no longer, on the team: discard the credential, do not reconnect with it. This is how a device revoked while it was offline finds out. |
| `UNSUPPORTED_VERSION` | Do not reconnect until the client or the server is upgraded. Say which side is older. |
| `INVITE_UNKNOWN`, `INVITE_EXPIRED`, `INVITE_USED` | Do not retry this invite; a new one is needed. |
| `HANDLE_TAKEN`, `BAD_PARAMS` | Reconnect only after the user has changed the input. |
| `BAD_FRAME`, `NOT_AUTHENTICATED`, `UNKNOWN_OPERATION` | A client bug: do not retry automatically. |
| `INTERNAL` | Retry with backoff. |

### Version negotiation

`invite.inspect`, `join` and `hello` carry `protocol`: the versions the client speaks, for example `[1]`. The
server checks it before any other parameter, chooses the highest version both speak and returns it as
`r.protocol`. With no common version it answers `UNSUPPORTED_VERSION` with `detail.supported`. This document
is version 1.

## 5. Operations

Shapes use `string`, `number` (integers; times are milliseconds since the Unix epoch) and nested objects.
Names (`displayName`, `deviceName`, `name`) are trimmed, then must be 1–64 Unicode code points with no control
characters (category Cc) and no U+2028 / U+2029; otherwise `BAD_PARAMS` with `detail.field`.

**Ids** (member, device, invite, handoff) are 1–64 characters of `A`–`Z`, `a`–`z`, `0`–`9`, `_` and `-`, never
starting with `-`, and case-sensitive. Treat them as opaque.

**Every operation below** can also be answered `AUTH_FAILED` when the device was revoked after the connection
authenticated (by the admin, or with its member). Nothing was done; the connection is closed with 4004 right
after the answer.

Objects used in results:

- **Server**: `{ "name": "spekterm-server", "version": string }` — the server software and its version.
- **Team**: `{ "name": string }`.
- **Member**: `{ "id": string, "handle": string, "displayName": string, "deviceCount": number }` — `deviceCount`
  is the number of this member's devices that are not revoked, this one included, **at the moment of
  authentication**. It can be stale later; use `team.members` for a current count.
- **Device**: `{ "id": string, "name": string }`.

### `invite.inspect`

Before authentication. Tells the client what an invite is for, without redeeming it, so the client asks for a
handle and a display name only when a new member is joining, and shows the team before the user commits.

`p`: `{ "protocol": [1], "code": string }`
→ `r`: `{ "protocol": 1, "kind": "member" | "device", "team": Team, "expiresAt": number, "member"?: { "handle": string, "displayName": string } }`

`kind: "member"` joins a new member. `kind: "device"` adds a device to the existing member given in `member`.
Errors: `INVITE_UNKNOWN`, `INVITE_EXPIRED`, `INVITE_USED`, `BAD_PARAMS`, `UNSUPPORTED_VERSION`.

Typing a handle takes longer than the 10-second window, so inspect normally runs on a connection of its own
(close it, or let it end with 4001), and `join` on a new one.

### `join`

Before authentication. Redeems an invite and makes this connection the new device.

`p`: `{ "protocol": [1], "code": string, "deviceName": string, "handle"?: string, "displayName"?: string }`

`handle` and `displayName` are required for a `member` invite and ignored for a `device` invite. A handle is
1–32 characters of `a`–`z`, `0`–`9` and `-`, starting with a letter or digit; it is lowercased first, and cannot
change later.

→ `r`: `{ "protocol": 1, "server": Server, "operations": [string], "team": Team, "member": Member, "device": Device, "deviceId": string, "deviceSecret": string }`

**The credential (`deviceId`, `deviceSecret`) is given once**; the server keeps only a hash of the secret.
Never hand it to a terminal or an agent. (spekterm keeps it in its secrets file, readable only by the user
account — and so by any program running as that user, agents' shell commands included; PRD §7.4.) The
connection is now authenticated as the new device.

Errors: `INVITE_UNKNOWN`, `INVITE_EXPIRED`, `INVITE_USED`, `HANDLE_TAKEN`, `BAD_PARAMS`, `UNSUPPORTED_VERSION`.
A refused join does not use up the invite.

**If the answer is lost** (the connection drops after sending `join`), the invite may have been used and the
secret is gone. The user asks the admin, who sees the orphan device in `member list`, revokes it, and issues a
new invite (a device invite if the member exists).

### `hello`

Before authentication. Authenticates the connection as an existing device.

`p`: `{ "protocol": [1], "deviceId": string, "deviceSecret": string }`
→ `r`: `{ "protocol": 1, "server": Server, "operations": [string], "team": Team, "member": Member, "device": Device }`

Errors: `AUTH_FAILED`, `BAD_PARAMS` (`protocol` only), `UNSUPPORTED_VERSION`.

`operations` lists the operations this server accepts after authentication. Show a feature only when its
operation is listed; an older server answers newer ones with `UNKNOWN_OPERATION`.

### `device.rename`

Renames this device.

`p`: `{ "name": string }` → `r`: `{ "device": Device }`

### `device.leave`

This device leaves. Its credential stops working and, after the answer, the connection is closed with 4004.
When it was the member's last device, **the member leaves the team too**: they are removed, their handle is
freed, and their unused device invites are cancelled. To tell the user beforehand which of the two will happen,
ask `team.members` right before and read this member's `deviceCount` (the one from `join` / `hello` may be
stale). The answer's `memberRemoved` says what actually happened.

`p`: `{}` → `r`: `{ "memberRemoved": boolean }`

### `team.members`

The team's members, to choose a recipient from (and for the agent to know whom it can hand work to). Includes
this device's own member. Ask again when you need a fresh list; it is not pushed.

`p`: `{}` → `r`: `{ "members": [{ "id": string, "handle": string, "displayName": string, "deviceCount": number }] }`,
ordered by handle. `deviceCount` is the member's devices that are not revoked, now.

### `handoff.send`

Sends a handoff to a teammate. **Call it only after the user confirmed the full text** (PRD §7.3).

`p`: `{ "clientId": string, "to": string, "payload": { "enc": "none", "title": string, "body": string } }`

- `clientId`: chosen by the client, 1–64 of `A`–`Z`, `a`–`z`, `0`–`9`, `_`, `-`. Keep it until the send is
  answered. **If the answer is lost, send the same request again with the same `clientId`**: the server answers
  with the handoff it already stored (`duplicate: true`) instead of storing a second one. This holds until the
  handoff's record is deleted, 90 days after its last change (section 8); a send after that is a new handoff.
- `to`: the recipient's handle (case-insensitive). Not your own.
- `payload.enc`: `"none"`. (Room for end-to-end encryption later; any other value is `BAD_PARAMS`.)
- `payload.title`: at most 200 UTF-16 code units; `payload.body`: at most 20,000. Either may be empty. Lengths
  are measured on the text as sent — the same unit and limits as a same-machine handoff in spekterm.
  Normalise the text before showing it for confirmation, so that what the user confirms is what is sent. Text
  must be well-formed UTF-16 (no lone surrogates). The server does not alter it.

→ `r`: `{ "handoff": { "id": string, "status": Status, "sentAt": number, "expiresAt": number }, "recipient": { "id": string, "handle": string, "displayName": string, "deviceCount": number }, "duplicate": boolean }`

`status` is one of the statuses of section 12; a new handoff is `pending`, a resend answers the current status.

`recipient.deviceCount` is how many devices the recipient has; with `0` the handoff waits until they add one
(the admin issues a device invite). `expiresAt` is 30 days after `sentAt`.

Errors: `BAD_PARAMS` (`detail.field`, and `detail.limit` for a length), `RECIPIENT_UNKNOWN`,
`RECIPIENT_IS_SELF`, `HANDOFF_ID_REUSED`, `RATE_LIMITED` (`detail.retryAt`), `AUTH_FAILED` (then 4004; nothing
was stored). A member may send at most a set
number of handoffs in any hour (30 unless the operator changed it), across all of their devices.

### `handoff.received`

Acknowledges a handoff this device received in a `handoff.incoming` event, **after storing it** (section 11).

`p`: `{ "id": string }` → `r`: `{}`

Answered `{}` for the first acknowledgement and for any repeat from the same device, also after the handoff
was taken, declined or done. Errors:
`HANDOFF_DELIVERED_ELSEWHERE`, `HANDOFF_EXPIRED`, `HANDOFF_UNKNOWN`, `BAD_PARAMS`, `AUTH_FAILED` (then 4004;
the handoff stays pending and goes to another of the member's devices).

### `handoff.update`

Reports what happened to a handoff this device received (section 12). Only the device the handoff was delivered
to — the one whose `handoff.received` was answered `{}` — may report.

`p`: `{ "id": string, "status": "taken" | "declined" | "done", "payload"?: { "enc": "none", "text": string } }`
→ `r`: `{ "status": Status }` — the handoff's status after the report.

- `taken`: a session was opened for it. No `payload` (one that is sent is ignored).
- `declined`: the user chose to decline. `payload` is optional; `text` is the reason, at most **500** UTF-16 code
  units, and may be empty. An absent `payload` and an empty reason mean the same: no reason.
- `done`: the session's agent reported. `payload` is required; `text` is the report, at most **4,000** UTF-16
  code units, with at least one character that is not white space.
- `payload.enc` is `"none"` (room for end-to-end encryption later); `text` must be well-formed UTF-16 and is not
  altered. Violations are `BAD_PARAMS` with `detail.field` (`id`, `status`, `payload`, `payload.enc`,
  `payload.text`) and, for a length, `detail.limit`.

A report that repeats the current state (the same status with the same text; `taken` once the handoff is
`done`) is answered `{ status }` and changes nothing, also after the text was deleted (section 8), so a lost
answer is retried by sending the same report. A `done` with a different report replaces the earlier one, up to
10 reports per handoff.

Errors, checked in this order: `HANDOFF_UNKNOWN`; `HANDOFF_EXPIRED` (also for a pending handoff past its
`expiresAt`, which the server then marks `expired`); `HANDOFF_NOT_DELIVERED`; `HANDOFF_DELIVERED_ELSEWHERE`;
then `HANDOFF_FINISHED` (`detail.status`) or `TOO_MANY_REPORTS` (`detail.limit`); and `BAD_PARAMS`,
`AUTH_FAILED` (then 4004; nothing was recorded).

### `handoff.sync`

The handoffs this device's member sent that changed after a sequence number, to build and keep the Sent list
(section 12).

`p`: `{ "after"?: number }` → `r`: `{ "records": [StatusRecord], "more": boolean, "latest": number, "reset": boolean }`

- `after`: a non-negative integer, the last `seq` the client stored (absent: 0). Otherwise `BAD_PARAMS` with
  `detail.field: "after"`.
- `records`: the member's sent handoffs whose `seq` is greater than `after`, each in its **current** state (a
  handoff that changed twice appears once), in increasing order of `seq`. At most 100, and together at most
  200 KiB of UTF-8 JSON (the first is always included).
- `more`: there are further records; ask again with `after` set to the last record's `seq`.
- `latest`: the highest `seq` the server has given.
- `reset`: `after` was greater than `latest`, which happens only when the server's data was restored from an
  older backup. The server then answered as for `after: 0`.

Once an answer says `more: false`, this connection receives a `handoff.status` event for every later change to a
handoff its member sent (section 10), until it sends another `handoff.sync` whose answer says `more: true`. An
error answer leaves this as it was. A connection that has not synced receives no `handoff.status`.

## 6. One connection per device

A device has at most one authenticated connection. When it authenticates again, the older connection is closed
with 4006. A client must not reconnect on 4006 by itself; two processes holding the same credential would
otherwise keep replacing each other.

## 7. Losing access

- **Revoked while connected**: the connection is closed with 4004 within 10 seconds of the revocation, or at
  the device's next request, which is answered `AUTH_FAILED` first. No handoff is offered to it meanwhile.
- **Revoked while offline**: the next `hello` is answered `AUTH_FAILED`, then 4003.

Either way, discard the credential. The admin can issue a device invite for the member if they are still on the
team, or a member invite if they were removed.

## 8. What the server sees

The server operator can read everything that passes through the server, including the title and body of every
handoff while it waits to be delivered. There is no end-to-end encryption in version 1.

The server deletes a handoff's title and body when it is delivered or expires, and within a minute they are gone
from the files in its data directory. It keeps the handoff's ids, sender, the sending device, recipient, times,
status, the device it was delivered to and its `seq`, and an unsalted SHA-256 of the request (recipient and
text) to recognise a resend — enough for an operator to confirm a guess of a very short text, not to read one.

A decline reason or report is kept, readable by the operator, for **30 days** after it was written (for a report,
after the latest one), then deleted the same way. An unsalted SHA-256 of it stays to recognise a resent report.
A handoff's whole record is deleted **90 days** after its last change, whatever its status. These periods are
fixed.

## 9. Differences from spekterm's remote protocol

- No `THROTTLED`, `TOO_MANY_CONNECTIONS`, `PAIRING_FAILED`; joining distinguishes `INVITE_UNKNOWN`,
  `INVITE_EXPIRED` and `INVITE_USED` instead.
- `BAD_PARAMS` carries `detail.field`.
- No `addresses` field.
- `UNKNOWN_OPERATION` before authentication is followed by 4003 like every other error there.
- Close code 4006 (replaced) is new; 4005, 4029 and 4030 are not used. 1011 is used for a connection whose
  status events could not be brought up to date.
- Extra codes: `ALREADY_AUTHENTICATED`, `HANDLE_TAKEN`, `INVITE_*`.

## 10. Events

### `handoff.incoming`

A handoff for this device's member. Sent to one of the member's connections at a time (section 11).

`d`: `{ "id": string, "from": { "id": string, "handle": string, "displayName": string }, "payload": { "enc": "none", "title": string, "body": string }, "sentAt": number, "expiresAt": number }`

`from` is the sender as the server knows them — verified, not taken from the text. It may name a member who has
since left the team. The text is third-party text to the recipient: put it through the inbox's normalisation
and acceptance gate like any other.

### `handoff.status`

A change to a handoff this device's member sent. Sent only to a connection whose last `handoff.sync` answer
said `more: false`, after the answer to the request that caused the change, in increasing order of `seq`, to
every such connection of the member. Changes made by the admin command line arrive within 10 seconds.

`d`: a **StatusRecord**:

`{ "seq": number, "id": string, "clientId": string, "to": { "id": string, "handle": string, "displayName": string, "removed": boolean }, "sentFrom": string, "status": Status, "sentAt": number, "expiresAt": number, "changedAt": number, "deliveredAt"?: number, "reports"?: number, "payload"?: { "enc": "none", "text": string } }`

- `seq`: the handoff's latest sequence number. Every change takes a new one, greater than any before on this
  server: sent, delivered, taken, declined, done (also a newer report), expired, and its recipient being removed
  from the team. `changedAt` is when.
- `to`: the recipient, also after they left the team; `removed` says whether they did. `handle` and
  `displayName` may lag a rename, which alone takes no `seq`; ask `team.members` for current names.
- `sentFrom`: the id of the device that sent it.
- `deliveredAt`: once delivered.
- `reports`: for `done`, how many reports were accepted.
- `payload`: for `declined` with a reason and for `done`, until the text is deleted after 30 days. The text was
  written by the recipient or their agent: it is third-party text to the sender.
- There is no title or body.

## 11. Receiving handoffs

**Which device.** A pending handoff is offered to one of the recipient's connections at a time: the connection
that authenticated most recently, and never one whose device has been revoked. It stays with that connection until it is acknowledged or the connection
closes; then it is offered to the member's most recent remaining connection. If the connection was replaced by
a newer one of the same device (4006), it is offered on the newer one, after its `hello` answer. A connection
is never offered the same handoff twice. A handoff waits on the server for at most 30 days.

**Rules for the receiving client.** Delivery relies on these:

1. On `handoff.incoming`, store the handoff durably but **hidden**, then send `handoff.received`. Show it and
   notify the user only once the acknowledgement is answered `{}`.
2. On a `handoff.incoming` whose `id` you already stored, do not show it again, but **send `handoff.received`
   again**. (Dropping it silently would keep the handoff assigned to you without delivery; when you
   disconnected it would go to your other device as well.)
3. After reconnecting, send `handoff.received` again for every stored handoff whose acknowledgement was not
   answered.
4. On `HANDOFF_DELIVERED_ELSEWHERE` or `HANDOFF_EXPIRED`, remove it from the inbox. You may keep a record of the
   id to recognise repeats.
5. On `HANDOFF_UNKNOWN` for a handoff you stored (the server lost it, for example restored from an older
   backup), or when the server's `operations` no longer list `handoff.received`, show it: your copy is the only
   one left.
6. When you discard the credential (close 4004, or `AUTH_FAILED`), **show** the handoffs you stored but whose
   acknowledgement was never answered, marked as possibly also delivered to another device. Do not delete
   them: the acknowledgement may have reached the server, which then counts the handoff as delivered here and
   offers it nowhere else.
7. If you cannot store an incoming handoff right now (for example the inbox is full), keep the event in memory
   and store and acknowledge it when you can. It stays assigned to this connection until then; on reconnecting
   it is offered again.

**Rule for the sending client.** Keep a handoff's `clientId` until `handoff.send` is answered, and after a lost
answer send the same request again with the same `clientId`.

## 12. Statuses and the Sent list

**Statuses.** `Status` is one of:

| Status | Meaning |
|---|---|
| `pending` | Held by the server, not acknowledged by any device of the recipient. |
| `delivered` | Acknowledged by one of the recipient's devices. |
| `taken` | The recipient opened a session for it. |
| `declined` | The recipient chose to decline, perhaps with a reason. Final. |
| `done` | The recipient's agent reported; carries the report. A newer report may replace it. |
| `expired` | Not delivered within 30 days, or its recipient was removed while it waited. Final. |

A handoff moves only `pending → delivered | expired`, `delivered → taken | declined | done`,
`taken → declined | done`, and `done → done` (a newer report). A delivered handoff does not expire. A recipient
who dismisses a handoff without declining sends nothing: the sender sees `delivered`.

**Rules for the sending client.** The Sent list relies on these:

1. After every `join` or `hello`, call `handoff.sync` from the last stored `seq` until an answer says
   `more: false`.
2. Store a record durably before storing its `seq` as the last one seen. A record replaces any earlier one with
   the same `id`; ignore a record whose `seq` is not greater than the one stored for that `id` (a record can
   arrive twice, in a page and as an event).
3. On `reset: true`, the records from that answer up to the next answer with `more: false` are the server's whole
   list: keep records it no longer has if you like, marked as unknown to the server. Remember durably that the
   reset is in progress; if paging is interrupted, sync again from 0 to finish it.
4. A record for a handoff this device did not send (another device of the member, or after reinstalling) has no
   title: show it without one.
5. Notify the user of `done`, `declined` and `expired` only on the device named by `sentFrom`; the member's other
   devices update their list without notifying.
6. Show a recipient with `to.removed: true` as no longer on the team.
7. The server forgets a handoff 90 days after its last change, and its reason or report 30 days after it was
   written; you may keep your copies longer.

**Rules for the receiving client.** To report:

1. Report only for a handoff whose `handoff.received` was answered `{}`, from that device. On
   `HANDOFF_NOT_DELIVERED`, acknowledge it again, then send the report again.
2. Send only text within the limits that is well-formed UTF-16 — normalise, then for example `toWellFormed()`,
   then check the length — so that a report the client accepted is not refused.
3. Send the reports of one handoff one at a time, in order, each after the previous one was answered. After a
   lost answer, send the same report again before any later one.
4. Report `taken` when a session is opened for the handoff, `declined` only when the user chooses to decline,
   and `done` with the session agent's report.
5. On `HANDOFF_FINISHED`, `HANDOFF_EXPIRED`, `HANDOFF_DELIVERED_ELSEWHERE`, `HANDOFF_UNKNOWN` or
   `TOO_MANY_REPORTS`, stop reporting for that handoff.
