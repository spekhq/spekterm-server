# spekterm-server — Product Requirements

> Status: **approved** · 2026-11-03
>
> This document says what spekterm-server is and why. How it is built (module layout, storage schema, the
> exact wire format) belongs in `docs/protocol.md` and in the changes that implement it.

## Contents

1. Summary
2. The problem
3. Goals
4. Non-goals (v1)
5. Concepts
6. How it is used
7. Trust model
8. The connection between spekterm and the server
9. Operating the server
10. What changes in spekterm
11. Milestones
12. Risks
13. Open questions

---

## 1. Summary

**spekterm-server is a small server that a team runs for itself so that spekterm users can hand work to
each other.** One person's agent writes a handoff addressed to a teammate; the teammate's spekterm shows it
in the inbox at once if it is open, or the next time it connects if it is not. The teammate reads it, picks
which of their own repositories it belongs in, and gets an agent session that is ready to start. The sender
sees what happened to it: delivered, taken, done.

It is **self-hosted** (one container per team), **open source under MIT**, and spekterm's connection to it
is **off until the user turns it on**. It is a mailbox, a team directory and a presence signal. It runs no
agents and has no access to anyone's repositories.

## 2. The problem

### 2.1 Within one machine, handoff already works

spekterm already lets an agent hand work to another repository on the same machine: the agent writes a
handoff, spekterm opens a session in the target repository with the handoff as its first prompt, the two
sessions remember each other, the child reports when it is done, and the parent learns the outcome from a
receipt. That is the "handoff feel" this product extends.

### 2.2 Across people, a request is a chat message, and chat messages get ignored

When the work belongs to someone else, because they know that codebase and the sender does not, the request
today is a sentence in chat ("could you fix X in billing-service?"). It fails at several points:

| Where it fails | What happens |
|---|---|
| It is not seen | It is buried in chat. |
| It is seen, but starting is costly | The recipient has to rebuild the context: what is needed, why, what the sender's side expects. |
| It is seen once and forgotten | Nothing brings it back. |
| The sender cannot tell which of these happened | There is no status, so the sender cannot follow up. |

A handoff addresses most of these: it arrives in the inbox with a count and a notification, it turns into a
session with the context already written, it stays until it is dealt with, and its status comes back to the
sender.

### 2.3 Why a server

- **Teammates cannot reach each other's desktops.** People work from home, on different networks. spekterm's
  remote access is a listener that needs the client to reach it, which works for one's own phone on a LAN or
  over Tailscale but not between two people's home machines.
- **Existing chat integrations cost too much to set up.** spekterm can already turn Slack mentions into inbox
  items, but each person has to create a Slack app, choose scopes and handle tokens. In practice teammates do
  not do it. It is also read-only, so nothing comes back to the sender.
- **The handoff feel needs both ends to be spekterm.** Receipts, the session lifecycle and the completion
  report live in spekterm. The middle only has to store and forward.

spekterm's PRD earlier ruled out a relay (2026-09-29), but what it ruled out was a **paid, hosted** relay for
the **same person across machines**, which first-party tooling now covers. This server is a different
thing: **free, self-hosted, between different people**, which nothing else covers.

## 3. Goals

- **G1 — Hand work to a person, not to a repository.** The sender addresses a teammate. The recipient decides
  which of their repositories the work belongs in. The sender never needs to know the recipient's folders.
- **G2 — It arrives.** While the recipient's spekterm is connected, a handoff appears in its inbox within
  seconds. While it is not, the server holds the handoff and delivers it on the next connection.
- **G3 — The sender sees what happened.** Delivered, taken (accepted into a session), done (with the
  recipient agent's report), or declined, when the recipient chooses to say so.
- **G4 — The sender sees who is on the team, and who is around.** A team directory, and a presence signal
  each member can turn off.
- **G5 — Any spekterm user can have it.** One container, a short setup guide, no third-party accounts or
  tokens. Joining a team is pasting one invite link.

## 4. Non-goals (v1)

| Not in v1 | Why |
|---|---|
| **Push notifications** (FCM, UnifiedPush) | A self-hosted server cannot send FCM to the official Android app without the app's Firebase credentials, so it would need an official push gateway. Deferred; v1 notifies only through a connected desktop. |
| **Relaying the phone's remote access** | The protocol reserves room for it (§8.4), but it is a different load (continuous terminal and conversation streams), carries one person's traffic over a team server, and would double the scope. |
| **An official hosted instance** | Self-hosting keeps each team's handoffs on its own machine and keeps the maintainer out of everyone's data. |
| **Opening a session without the recipient's approval** | A teammate's handoff is third-party text to the recipient (§7.2). |
| **Handoffs to a group or to "whoever is free"** | v1 addresses one person. Groups raise ownership questions ("who took it?") that should be designed on their own. |
| **Attachments, diffs, files** | v1 carries text. The recipient's agent works in the recipient's own checkout. |
| **Federation between servers** | One server is one team. |
| **A web interface for handing off** | spekterm is the client. The server has an admin command line only. |

## 5. Concepts

| Concept | Meaning |
|---|---|
| **Team** | The people who share one server. v1: one server serves one team. |
| **Member** | A person on the team, with a display name and a handle unique within the team. |
| **Admin** | Whoever can run the server's admin command line: creates invites, removes members (§13.1). |
| **Device** | One spekterm installation signed in as a member. A member may have several (work laptop, home desktop). |
| **Invite** | A single-use link that lets one person join the team. It expires. |
| **Handoff** | A title and a body, written by the sender's agent and confirmed by the sender, addressed to one member. |
| **Status** | Where a handoff is: `pending` (held by the server), `delivered` (reached one of the recipient's devices), `taken` (accepted into a session), `done` (the session's agent reported completion), `declined`, or `expired`. |
| **Report** | The short result the recipient's agent writes when it finishes, sent back to the sender. |
| **Presence** | Whether a member has a connected device, as far as that member allows others to see. |

## 6. How it is used

The example: Alex works in `api-server` and needs a change in `billing-service`, which Sam knows well.

### 6.1 Joining

1. An admin runs the server's invite command and sends the link to Sam.
2. Sam opens spekterm → Settings → Team, pastes the link, and chooses a display name.
3. Sam's spekterm connects and appears in the team directory.

### 6.2 Sending

1. Alex tells the agent in `api-server`: "Hand the billing-side change to Sam."
2. The agent knows which teammates it can hand off to (spekterm tells it when the session starts) and writes
   a handoff addressed to Sam, describing **what is needed and why** in terms of Alex's side, not in terms of
   files in `billing-service`, which it cannot see.
3. **spekterm asks Alex before anything leaves the machine**: it shows the recipient, the title and the full
   body, with **Send** and **Discard**. The body is about to go to another person; Alex reads it first.
4. On **Send**, the agent's receipt says the handoff was sent. Alex's spekterm lists it among **Sent** handoffs
   with its status.

### 6.3 Receiving

1. If Sam's spekterm is open, the handoff appears in the inbox within seconds, with a count and a desktop
   notification, exactly like any other inbox item. If it is closed, it appears when Sam next opens it.
2. The item shows **who** sent it, verified by the server, not taken from the text.
3. Sam reads the body, chooses the folder (`billing-service`), and accepts. spekterm opens an agent session
   there with the handoff as its context and the first prompt **filled in but not sent**: Sam presses Enter.
4. Alex's status turns to **taken**.

Sam may also decline, optionally with a sentence of reason. Dismissing the item without declining leaves
Alex's status at **delivered**: a dismissal is not announced unless Sam chooses to say so.

### 6.4 Coming back

1. When Sam's agent finishes, it writes its report, as a handed-off agent does on one machine today.
2. Sam's spekterm sends the report to the server; Alex's status turns to **done** and Alex gets a
   notification with the summary.
3. If Alex's spekterm is closed, the status and the report wait on the server.

### 6.5 Following up

Alex's **Sent** list shows every handoff with its status and how long it has been there. A handoff that is
still **delivered** after a while is Alex's cue to talk to Sam. spekterm does not nag Sam on Alex's behalf.

## 7. Trust model

### 7.1 What the server is trusted with

The server is run by the team, for the team. It is trusted to **store and forward** and to **vouch for who
sent what**. It therefore sees:

- the team directory and presence,
- each handoff's sender, recipient, times and status,
- **each handoff's title, body and report**, in v1: there is no end-to-end encryption (§13.1). The setup
  guide says so, so that every member knows the operator can read them.

It is **not** trusted to make anyone's spekterm do anything else. The only effects a server can cause on a
desktop are: an item appears in the inbox, a sent handoff's status changes, the directory and presence
change. That list is an allow-list in the protocol (§8.2), and spekterm rejects anything outside it. In
particular, a server can never open a session, type into a terminal, read a file, or reach the remote-access
listener.

### 7.2 The recipient: a teammate's handoff is third-party text

On one machine, a handoff opens without asking because the user's own agent wrote it. Across people, the
body was written by someone else's agent, so for the recipient it is third-party text, like a Slack mention:

- It goes through the inbox's **acceptance gate**: the recipient reads the full body before accepting.
- The recipient **chooses the folder**.
- The first prompt is **filled in, never sent**.
- The text is normalized as the inbox does today. Its **length limit is the same as a same-machine
  handoff's** (currently 20,000 characters, the amount the receiving agent can read in one go), not the
  inbox's 4,000-character limit for other third-party text such as Slack. A handoff is the same kind of
  thing whether it crosses a repository or a person, so the sender's agent works with one limit, and a
  body that fits on one machine is never refused for going to a teammate. The cost is that the recipient
  may have a longer text to read before accepting; the 4,000 limit for other sources does not change.
  The server enforces the same limit, so an oversized body is refused at send time, not at delivery.
- The **sender's identity** is a verified field supplied by the server, never parsed from the text.

### 7.3 The sender: nothing leaves without the user seeing it

A handoff to a teammate carries context from the sender's work (paths, snippets, plans) to another person.
The agent can write it, but **spekterm sends it only after the user confirms** it on the desktop. There is no
setting that sends automatically in v1.

### 7.4 Credentials

- Each device has its own credential, issued when it joins, stored **only as a hash** on the server and
  revocable on its own.
- On the desktop the credential lives in spekterm's secrets file (mode 0600, as its Slack token). spekterm never
  hands it to a terminal or an agent, but any program running as the same user can read that file, agents'
  shell commands included (§13.1).
- Invites are single use and expire (default 7 days).

### 7.5 Transport

- **TLS only.** The server is expected behind a normal TLS terminator (for example a reverse proxy with an
  ACME certificate). spekterm refuses an address that is not `wss`.
- An invite may carry the certificate's fingerprint. If it does, spekterm pins it, which lets a team run with
  a self-signed certificate on a private network.

### 7.6 Abuse within a team

The team is small and its members are known, so v1 relies on admin removal, plus per-member rate limits
(handoffs per hour) so that a looping agent cannot flood a teammate's inbox.

## 8. The connection between spekterm and the server

### 8.1 Shape

spekterm opens **one outbound WebSocket over TLS** to the server while the feature is on and keeps it open,
reconnecting with backoff. Everything flows over it: the server pushes new handoffs, status changes,
directory and presence; spekterm sends handoffs, acknowledgements, status changes and reports.

This is spekterm's first long-lived outbound connection that it opens on its own. It is off by default, it
goes only to the address the user entered, and spekterm's documentation of its network behavior says so.

### 8.2 Messages (outline)

The exact format lives in `docs/protocol.md`, with a test that holds the document and the server's accepted
operations to the same list, as spekterm does for its remote protocol.

| Direction | Message | Purpose |
|---|---|---|
| desktop → server | `hello` | Authenticate the device, negotiate the protocol version, resume from the last seen event. |
| desktop → server | `handoff.send` | Send a confirmed handoff to a member. |
| desktop → server | `handoff.received` | Acknowledge that an item is safely in the inbox (moves it to `delivered`). |
| desktop → server | `handoff.update` | `taken`, `declined` (with an optional reason), `done` (with the report). |
| desktop → server | `presence.set` | Visible or hidden. |
| server → desktop | `handoff.incoming` | A handoff for this member. |
| server → desktop | `handoff.status` | A status change on a handoff this member sent. |
| server → desktop | `team.directory` | Members, display names, presence. |

### 8.3 Delivery guarantees

- A handoff is held until **one** of the recipient's devices acknowledges it, then removed from the other
  devices' queues. It is delivered into one inbox, not into every machine the recipient owns.
- Every message carries an id; both sides drop duplicates, so a reconnect never makes a second inbox item or
  a second notification.
- A handoff not delivered within the retention period (default 30 days) becomes `expired`, and the sender is
  told.

### 8.4 Reserved for later

The protocol keeps room for **additional channel types** on the same connection. The one in mind is a blind
relay for the phone's remote access (the phone's TLS to the desktop tunneled through the server, still
pinned to the desktop), for a later version.

It also keeps room for **end-to-end encryption**: a handoff's title, body and report travel as one payload
with an encryption marker, which v1 always sets to "not encrypted". Adding encryption later is a new marker
value, not a new message format.

## 9. Operating the server

- **One container**, one data directory (SQLite), one port. Node 22, matching spekterm's toolchain.
- **Admin command line** inside the container: create an invite, list members and devices, remove a member,
  revoke a device.
- **Retention.** Bodies and reports are deleted a fixed time after a handoff reaches a final state (default
  30 days); only the metadata needed for the sender's list is kept longer, and it is bounded too.
- **Backups** are a copy of the data directory.
- **Upgrades.** The server states the protocol versions it speaks; spekterm says plainly when its version and
  the server's do not meet, instead of failing silently.
- **No outbound connections** from the server in v1. It accepts connections and makes none.

## 10. What changes in spekterm

These are done in the spekterm repository, in their own OpenSpec changes, after this PRD is approved. Listed
here so the boundary is clear.

- **Settings → Team**: join with an invite link, the server address, this device's name, presence visibility,
  leave the team.
- **Handoff to a person**: the outbox accepts a teammate as a target. The agent's introduction points to a
  teammates file (the rules and the list live in the file), so the introduction's fixed size budget (the CLI
  keeps only a preview past 10,000 characters) grows by a line, not by the team.
- **Send confirmation** (§7.3) and agent receipts for the new outcomes (waiting for confirmation, sent,
  discarded, refused).
- **Inbox**: a new source, "teammate", going through the existing acceptance gate, folder choice and filled
  prompt, with the same-machine handoff's body limit instead of the third-party one (§7.2). Decline with an
  optional reason.
- **Sent list**: the sender's handoffs to teammates and their status; a notification on **done**.
- **Report back**: when a session that came from a teammate's handoff reports completion, the report goes to
  the server.
- **spekterm's own PRD** (§7.6 and §10) is revised: the relay ruled out on 2026-09-29 was a paid, hosted,
  same-person relay; a free, self-hosted relay between people is now in scope.
- **Network documentation**: the website's "Data and network" page and spekterm's network-surface test
  account for the new outbound connection.

A paired phone needs no change to see these items: they are ordinary inbox items, which remote access
already lists.

## 11. Milestones

| | Delivers |
|---|---|
| **M0** | `docs/protocol.md`; server skeleton with teams, invites, devices, the connection and the admin command line. |
| **M1** | Send and receive: a handoff confirmed on one desktop arrives in another desktop's inbox, now or on the next connection. |
| **M2** | The way back: `taken`, `declined`, `done` with the report; the sender's list and notification. |
| **M3** | Directory and presence. |

M1 alone already addresses "it was not seen". M2 is what addresses "the sender cannot tell".

## 12. Risks

| Risk | Mitigation |
|---|---|
| **Requests are still ignored.** A tool cannot make someone care. | Lower the cost of starting (a ready session) and make the state visible to the sender; the social part stays social. |
| **Nobody runs the server.** Self-hosting is a hurdle for small teams. | One container, a guide that fits on a page, sensible defaults, no external dependencies. |
| **Presence feels like surveillance.** | Each member can hide; presence means only "a device is connected". |
| **The agent introduction outgrows its budget.** | Teammates are not listed in the introduction; it points to a teammates file, so its size does not grow with the team. |
| **Version skew** between desktops and the server. | Versioned protocol, explicit "incompatible" state in spekterm. |
| **The handoff body reveals more than the sender meant.** | The sender confirms the full text before it is sent (§7.3). |

## 13. Open questions

1. **How the sender's agent learns the outcome later.** A receipt covers the send; does the sending session
   also hear about `taken` and `done` (for example through its relations file), or only the user? Decide in
   M2, which delivers those statuses.
2. **Repository name.** `spekterm-server`, under `spekhq`.

### 13.1 Decided (2026-11-03)

- **One team per server** in v1, as drafted.
- **A dismissal tells the sender nothing**; only a decline does (§6.3).
- **`done` follows the recipient agent's report** and does not need the recipient to confirm, as on one
  machine today.
- **A handoff is delivered to one of the recipient's devices** (§8.3), accepted as a trade-off: it may land
  on a machine the recipient is not using at the moment.
- **A teammate handoff has the same body limit as a same-machine handoff** (§7.2).
- **No end-to-end encryption in v1**; the protocol reserves room for it (§8.4). The operator is the team
  itself and bodies are deleted after retention, so the threat is small. Encryption that actually holds
  against a dishonest server needs key verification between people and handling for each member's several
  devices (adding, revoking), which is about a milestone of its own; without verification it would only look
  safe. It would also stop the server from checking the body limit (§7.2). Revisit if teams want to run the
  server on a machine they do not trust, or to share one server between teams.
- **The admin is whoever runs the admin command line** in v1. There is no admin operation over the
  connection, so no member carries an admin flag; access to the container is the control. A later version
  that adds admin operations to spekterm adds the flag then (server-foundation, design D9).
- **Leaving from a member's last device leaves the team**: the member is removed, the handle freed and their
  device invites cancelled, so "leave the team" in Settings (§10) means what it says and no member without
  devices keeps receiving handoffs. The admin revoking a device does not remove the member, so a lost
  machine can be replaced with a device invite (server-foundation, design D10).
- **The device secret stays in spekterm's secrets file** (0600), not the OS keyring (2026-11-03). Accepted
  consequence: an agent's shell command can read it and, with it, connect as the user and send handoffs
  without the desktop's confirmation (§7.3); the hourly rate (§7.6) and revoking the device are the limits.
