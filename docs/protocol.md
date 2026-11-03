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
could be read). Version 1 as of this document sends no events; clients must ignore event kinds they do not
know.

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
| `AUTH_FAILED` | The device is not on the team: unknown, revoked, removed with its member, or a wrong secret. |
| `INVITE_UNKNOWN` | No such invite: never issued, cancelled, or for a member who was removed since. |
| `INVITE_EXPIRED` | The invite has expired. |
| `INVITE_USED` | The invite was already used. |
| `HANDLE_TAKEN` | Another member has this handle. The invite is still good; ask for another handle. |
| `INTERNAL` | Anything else. |

### Close codes

| Code | When | Client |
|---|---|---|
| 1001 | The server is shutting down. | Reconnect with backoff. |
| 1003 | A binary frame was sent. | A client bug; do not retry automatically. |
| 1009 | A frame over 256 KiB was sent. | A client bug; do not retry automatically. |
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

Objects used in results:

- **Server**: `{ "name": "spekterm-server", "version": string }` — the server software and its version.
- **Team**: `{ "name": string }`.
- **Member**: `{ "id": string, "handle": string, "displayName": string, "deviceCount": number }` — `deviceCount`
  is the number of this member's devices that are not revoked, this one included.
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
Store it in the platform's protected storage, never in a file an agent can read. The connection is now
authenticated as the new device.

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
freed, and their unused device invites are cancelled. Use `member.deviceCount` from `join` / `hello` to tell the
user beforehand which of the two will happen.

`p`: `{}` → `r`: `{ "memberRemoved": boolean }`

## 6. One connection per device

A device has at most one authenticated connection. When it authenticates again, the older connection is closed
with 4006. A client must not reconnect on 4006 by itself; two processes holding the same credential would
otherwise keep replacing each other.

## 7. Losing access

- **Revoked while connected**: the connection is closed with 4004 within 10 seconds of the revocation.
- **Revoked while offline**: the next `hello` is answered `AUTH_FAILED`, then 4003.

Either way, discard the credential. The admin can issue a device invite for the member if they are still on the
team, or a member invite if they were removed.

## 8. What the server sees

The server operator can read everything that passes through the server, including, from the next protocol
additions on, handoff contents. There is no end-to-end encryption in version 1.

## 9. Differences from spekterm's remote protocol

- No `THROTTLED`, `TOO_MANY_CONNECTIONS`, `PAIRING_FAILED`; joining distinguishes `INVITE_UNKNOWN`,
  `INVITE_EXPIRED` and `INVITE_USED` instead.
- `BAD_PARAMS` carries `detail.field`.
- No `addresses` field.
- `UNKNOWN_OPERATION` before authentication is followed by 4003 like every other error there.
- Close code 4006 (replaced) is new; 4005, 4029 and 4030 are not used.
- Extra codes: `ALREADY_AUTHENTICATED`, `HANDLE_TAKEN`, `INVITE_*`.
