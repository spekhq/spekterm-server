# Running spekterm-server

One container, one data directory, one port. The server accepts connections and makes none of its own.

**Before you start: whoever runs the server can read everything that passes through it**, including the text of
every handoff between teammates. There is no end-to-end encryption. Run it on a machine the whole team trusts.

## 1. Build and run

```sh
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

spekterm only connects over `wss://`, so the server needs TLS one way or the other.

## 2a. Behind a reverse proxy (recommended)

Let the proxy hold a certificate from a public authority (for example Caddy or Traefik with ACME) and forward
WebSocket traffic to the container's port. Caddy, for instance:

```
team.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

The proxy must forward `/connect` as a WebSocket upgrade and keep idle connections open for at least a minute
(the server pings every 30 seconds). Invites carry no certificate fingerprint; spekterm checks the certificate
against the system's trust store.

## 2b. TLS served by the server, with a self-signed certificate

For a private network without a public name. Make a long-lived certificate, because replacing it means every
device has to join again:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -keyout tls.key -out tls.crt -subj /CN=team.lan -addext subjectAltName=DNS:team.lan
chmod 644 tls.crt tls.key   # the server runs as uid 1000 and must be able to read both
docker run -d --name spekterm-server -v spekterm-data:/data -v "$PWD":/certs:ro -p 8443:8080 \
  -e TLS_CERT=/certs/tls.crt -e TLS_KEY=/certs/tls.key -e PUBLIC_URL=wss://team.lan:8443 spekterm-server
```

Invites then carry the certificate's fingerprint (`fp`), and spekterm trusts exactly that certificate. With a
certificate from a **private authority** (mkcert, step-ca) that teammates' systems do not trust, create invites
with `--pin` to pin it the same way.

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

## 5. Backups and upgrades

The whole state is the SQLite database in the volume. To back up, stop the container and copy the volume's
contents. A newer server upgrades the database at startup; an older server refuses to start on a database a
newer one has written, and leaves it unchanged, so you can go back by restoring the backup.

The server tells spekterm which protocol versions it speaks; spekterm says so plainly when the two do not
match.
