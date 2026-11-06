# Running spekterm-server

One container, one data directory, one port. The server accepts connections and makes none of its own.

**Before you start: whoever runs the server can read everything that passes through it**, including the text of
every handoff between teammates while it waits to be delivered. There is no end-to-end encryption. Run it on a
machine the whole team trusts.

## 1. Build and run

```sh
git clone https://github.com/spekhq/spekterm-server.git
cd spekterm-server
docker build -t spekterm-server .
docker volume create spekterm-data
docker run -d --name spekterm-server --restart unless-stopped \
  -v spekterm-data:/data -p 8080:8080 \
  -e PUBLIC_URL=wss://team.example.com \
  spekterm-server
```

| Variable | Meaning |
|---|---|
| `PUBLIC_URL` | The address teammates connect to: `wss://host` or `wss://host:port`, no path. Needed to create invites. |
| `PORT` | The port inside the container. Default `8080`. |
| `DATA_DIR` | Where the database lives. Default `/data` (the volume). |
| `TLS_CERT`, `TLS_KEY` | PEM certificate chain and key, if the server serves TLS itself (section 2b). Both or neither. |
| `HANDOFF_RATE_PER_HOUR` | The most handoffs one member may send in any hour, across their devices. Default `30` (1–10000). Stops a looping agent from flooding a teammate. |
| `RELAY` | `on` to relay members' phones to their own desktops (section 7). Default `off`. |
| `RELAY_MAX_TUNNELS` | The most relay tunnels at once. Default `32` (1–1000). |
| `RELAY_KIB_PER_SECOND` | The most KiB per second each direction of a tunnel carries. Default `512` (0–1048576; `0` means no cap). |

spekterm only connects over `wss://`, so the server needs TLS one way or the other.

## 1b. Without Docker

For a machine that cannot run containers, such as a NAS model without a container package (Synology's ARM "j"
models have no Container Manager): run it on Node directly. It needs Node 22.22 or later and nothing else; the
one dependency is plain JavaScript and the database is Node's built-in SQLite, so ARM is fine.

```sh
git clone https://github.com/spekhq/spekterm-server.git
cd spekterm-server
npm ci --omit=dev
mkdir -p ~/spekterm-data && chmod 700 ~/spekterm-data
PUBLIC_URL=wss://team.lan:8443 PORT=8443 DATA_DIR=~/spekterm-data \
  TLS_CERT=~/spekterm-certs/tls.crt TLS_KEY=~/spekterm-certs/tls.key npm start
```

- **The data directory holds every waiting handoff's text**: keep it, and the TLS key, readable only by the
  user that runs the server. (The `chmod 644` in section 2b is for the container's user only.)
- **Admin commands** run with the same environment variables as the server: `DATA_DIR` finds the database,
  `PUBLIC_URL` and `TLS_CERT` go into invites. Where this guide says
  `docker exec spekterm-server spekterm-server-admin …`, run `npm run admin -- …` (or `bin/spekterm-server-admin …`)
  in the checkout instead. A small script that sets the variables and runs the command saves mistakes.
- **Nothing restarts it for you.** Use the system's service manager (a systemd unit with `Restart=always`), or on
  a NAS a boot-time task that starts a loop restarting the server when it exits. `SIGTERM` stops it cleanly.
- **Health check**: `curl -k https://127.0.0.1:8443/healthz` answers 200 (there is no container health check).
- **Backups and upgrades** as in section 6, with "stop the process, copy the data directory" and
  "`git pull`, `npm ci --omit=dev`, restart" in place of the container steps.
- On a NAS, the system already uses ports such as 80, 443, 5000 and 5001: pick another one. Synology's Node.js
  package may not put `npm` on the path; run `node <node dir>/../lib/node_modules/npm/bin/npm-cli.js` instead.

## 2a. Behind a reverse proxy (recommended)

Let the proxy hold a certificate from a public authority (for example Caddy or Traefik with ACME) and forward
WebSocket traffic to the container's port. Caddy, for instance:

```
team.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

The proxy must forward `/connect` (and `/relay`, if you turn relaying on) as a WebSocket upgrade and keep idle
connections open for at least a minute (the server pings every 30 seconds). Caddy's `reverse_proxy` above
forwards every path, both included. Invites carry no certificate fingerprint; spekterm checks the certificate
against the system's trust store.

## 2b. TLS served by the server, with a self-signed certificate

For a private network without a public name. Make a long-lived certificate, because replacing it means every
device has to join again:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -keyout tls.key -out tls.crt -subj /CN=team.lan -addext subjectAltName=DNS:team.lan
chmod 644 tls.crt tls.key   # the server runs as uid 1000 and must be able to read both
docker run -d --name spekterm-server --restart unless-stopped \
  -v spekterm-data:/data -v "$PWD":/certs:ro -p 8443:8080 \
  -e TLS_CERT=/certs/tls.crt -e TLS_KEY=/certs/tls.key -e PUBLIC_URL=wss://team.lan:8443 spekterm-server
```

Invites then carry the certificate's fingerprint (`fp`), and spekterm trusts exactly that certificate. With a
certificate from a **private authority** (mkcert, step-ca) that teammates' systems do not trust, create invites
with `--pin` to pin it the same way.

A pinned certificate is checked by its fingerprint alone, not by name, so `PUBLIC_URL` may be an IP address (a
fixed one: the address is in every invite and in every device). It is the one address every device uses, in
the office and away from it. If teammates also connect from inside the same network, check that the address
works from there too: some routers do not pass a connection to their own public address back inside.

The certificate is read at startup: **restart the container after replacing it.** Replacing a pinned
certificate locks every device out; each member needs a new invite.

## 3. The first invite

```sh
docker exec spekterm-server spekterm-server-admin team name "Billing crew"
docker exec spekterm-server spekterm-server-admin invite create
```

Send the printed `spekterm://join?…` link to the person joining, privately: it is single use, expires after 7
days (`--expires 12h` … `30d`), and anyone holding it can join. They paste it into spekterm → Settings → Team.

## 4. Day to day

| Command (`docker exec spekterm-server spekterm-server-admin …`) | Does |
|---|---|
| `invite create --member sam` | Invite for a new device of `sam` (a second machine, a replaced laptop). |
| `invite list`, `invite cancel <id>` | See and cancel open invites. Codes are never shown again. |
| `member list` | Members, their devices and when each was last seen. |
| `member rename sam "Sam W."` | Fix a display name. |
| `device revoke <device-id>` | Revoke one device (lost or replaced machine). Its connection closes within 10 seconds. The member stays. |
| `member remove sam` | Remove a member and all of their devices. |

A member who chooses "leave" in spekterm on their only device is removed as if by `member remove`. To come back
they need a new member invite.

**A device whose join answer was lost** (the connection dropped while joining): the invite is used up and the
device never got its credential. Find the device in `member list` (recent "joined", no later "last seen"),
`device revoke` it, and send a new invite (`--member` if the member exists).

## 5. What the server keeps

A handoff's title and body stay in the database only while it waits for the recipient: at most 30 days, or
until the recipient is removed. Once it is delivered or expires they are deleted, and within a minute they are
gone from the files in the data directory (deleted space is zeroed and the write-ahead log truncated; a backup
copy you took earlier still has them). What stays is who sent what to whom and when, its status, and an unsalted
hash of the request used to recognise a resend.

When the recipient declines with a reason or their agent reports back, that text is kept for **30 days** after it
was written, so the sender's devices can fetch it, and is then deleted the same way; an unsalted hash of it stays to
recognise a resent report. A handoff's whole record is deleted **90 days** after its last change. These periods
are fixed. Restoring an older backup can make a device miss status changes made after that backup.

## 6. Backups and upgrades

The whole state is the SQLite database in the volume. To back up, stop the container and copy the volume's
contents. A newer server upgrades the database at startup; an older server refuses to start on a database a
newer one has written, and leaves it unchanged, so you can go back by restoring the backup.

The server tells spekterm which protocol versions it speaks; spekterm says so plainly when the two do not
match.

## 7. Relaying phones

spekterm's remote access connects a phone directly to its owner's desktop. Away from the desktop's network that
needs a VPN or a port forward. With `RELAY=on`, the server can stand in: the phone and the desktop each connect
to the server, and the server passes the bytes between them.

- **Off until you turn it on**, and each member also has to turn it on in spekterm for their desktop.
- **Blind.** What crosses is the phone's TLS to the desktop, pinned to the desktop's certificate. You cannot read
  or change it. You see which desktop is reached through which grant, when, from where, for how long and how many
  bytes; the log shows tunnel and grant ids, durations and byte counts.
- **Only a member's own phone to that member's own desktop.** The desktop gives each of its paired phones a grant;
  `member list` shows them under the desktop. Revoking the device or removing the member ends them.
- **No push.** The desktop has to be running and connected for its phone to reach it.
- **Load.** Unlike handoffs, a watched terminal streams continuously. Measured on a Synology DS218j (two ARMv7
  cores, 500 MB of memory, Node 22), in the server process:

  | Load | CPU of one core |
  |---|---|
  | 20 idle tunnels (about 160 KiB of memory each) | 0.2 % |
  | 1 tunnel, 64 KiB/s in 1 KiB messages | 6 % |
  | 1 tunnel, 512 KiB/s in 1 KiB messages (the default cap) | 13–16 % |
  | 2 tunnels at the default cap | 26 % |
  | 1 tunnel to a phone on a slow link (kernel socket memory, an upper bound) | 4 %, under 4 MiB |

  The defaults (32 tunnels, 512 KiB/s per tunnel and direction) come from these numbers. On a machine without
  AES instructions (many ARM boards), ChaCha20 is cheaper; the server prefers it when it serves TLS itself. Behind
  a reverse proxy, prefer `TLS_CHACHA20_POLY1305_SHA256` there if your proxy allows it.
- **On other hardware**, measure before changing the limits:

  ```sh
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
    -keyout /tmp/bench.key -out /tmp/bench.crt -subj /CN=bench
  node scripts/relay-bench.mjs node_modules/ws /tmp/bench.crt /tmp/bench.key          # default cipher
  node scripts/relay-bench.mjs node_modules/ws /tmp/bench.crt /tmp/bench.key chacha   # ChaCha20 preferred
  ```

  It runs on 127.0.0.1 only, for a few minutes, and prints the server process's CPU and memory per scenario.

