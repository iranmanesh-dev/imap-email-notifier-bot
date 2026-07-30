# IMAP Email Notifier Bot

A self-hosted Telegram bot that notifies you of **every email** arriving in **any folder**
of **any number of IMAP mailboxes**. One small container, no third-party service in the
middle, no polling API limits.

Works with any IMAP provider — there is no provider-specific code. Tested against
Hostinger and a real IMAP server in CI:

| Provider | Host | Port |
|---|---|---|
| Hostinger | `imap.hostinger.com` | 993 |
| Hostinger (Titan plans) | `imap.titan.email` | 993 |
| Gmail / Workspace | `imap.gmail.com` | 993 (needs an [App Password](https://support.google.com/accounts/answer/185833)) |
| Outlook / Microsoft 365 | `outlook.office365.com` | 993 |
| iCloud | `imap.mail.me.com` | 993 (needs an app-specific password) |
| Fastmail | `imap.fastmail.com` | 993 |
| Self-hosted / cPanel | your mail host | 993 |

### How it works

An IMAP `IDLE` connection parked on INBOX gives near-instant delivery, while a cheap
`STATUS (UIDNEXT)` sweep covers every other folder on a timer. That keeps it at **two IMAP
connections per account regardless of folder count** — important because most providers cap
concurrent connections around 10–15. The idler is only a latency optimisation: if it dies,
mail arrives a sweep later rather than never.

Notifications are deduplicated in SQLite on `(account, Message-ID)`, so a message moved
between folders notifies once, while the same message arriving in two different mailboxes
notifies once per mailbox.

### Design notes worth knowing

- **Delivery is at-least-once.** A message is marked seen only *after* Telegram accepts it,
  so a crash between the two yields one duplicate rather than a silently lost email.
- **First run notifies nothing.** It records a baseline so booting against an existing
  mailbox doesn't dump your history into Telegram.
- **The healthcheck is liveness-only.** A degraded account never triggers a container
  restart, because a restart can't fix an unreachable host or a wrong password — it only
  resets the backoff and the failure cap.

The full design rationale, including the failure modes each decision guards against, is in
[`docs/superpowers/specs/`](docs/superpowers/specs/).

## Setup

1. **Create a Telegram bot.** Message [@BotFather](https://t.me/BotFather), send
   `/newbot`, and copy the token it returns.
2. **Find your chat ID.** Send any message to your new bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read
   `result[0].message.chat.id`.
3. **Create a `.env` file** next to `docker-compose.yml` with exactly these three
   variables:

   ```bash
   TELEGRAM_BOT_TOKEN=<the token BotFather gave you>
   TELEGRAM_CHAT_ID=<the chat id from step 2>
   MASTER_KEY=<a fresh secret, at least 32 characters>
   ```

   Generate `MASTER_KEY` with `openssl rand -base64 32`. Every other variable in
   [Configuration](#configuration) is optional and has a working default.

   There is no `MAILBOXES` variable — mailboxes are added at runtime by messaging the
   bot (see [Adding a mailbox](#adding-a-mailbox) below), and a fresh install
   legitimately starts with zero mailboxes configured.

   > **Note:** the `.env.example` file in this repository is out of date. It still lists a
   > `MAILBOXES` variable, which has been removed and is ignored, and it does not mention
   > `MASTER_KEY`, which is required. Use the three variables above rather than copying
   > that file — copying it verbatim fails at boot with
   > `fatal: Missing required environment variable MASTER_KEY`.

## Run locally

```bash
npm install
npm test
npm run build
DB_PATH=./data/seen.db node dist/index.js
```

## Run with Docker

```bash
docker compose up -d --build
```

(`docker compose up --build` builds the image itself — there's no need to
`docker build` separately first.)

The image runs as the non-root `node` user, on `node:22-bookworm-slim` (glibc,
not alpine — `better-sqlite3`'s prebuilt binaries require glibc).

**Platform note:** verified on both `linux/arm64` (native) and `linux/amd64`
(via `docker buildx build --platform linux/amd64`, emulated with QEMU) — both
produce a real from-source compile (`CC`/`CXX`/`SOLINK_MODULE` in the build
log, not just `TOUCH ... stamp`) and the compiled module loads successfully.
The Dockerfile's native-module fix (`rm -rf prebuilds` + compile from source)
is architecture-neutral by construction: it doesn't depend on anything
arm64-specific, and the same toolchain (python3/make/g++) is installed
regardless of target arch. If a future dependency bump ever reintroduces a
build that only touches stamp files instead of actually compiling, the
`node -e require(...)` gate in the Dockerfile will fail the build outright
rather than shipping a broken image.

### Volume permissions

`DB_PATH` (default `/data/seen.db`) must live on a volume so the dedup database
survives redeploys. Because the container runs as `node`, that path must be
writable by `node` (uid 1000):

- **Named volumes** (as in `docker-compose.yml`, and how Coolify provisions
  persistent storage for Compose-based resources) work out of the box: the
  image pre-creates `/data` and `chown`s it to `node` before the volume is
  ever mounted, and Docker seeds a brand-new named volume from the image's
  existing directory content — ownership included. No extra steps needed.
- **Bind mounts** of a host directory are different: Docker does not touch
  the ownership of an existing host path. If you bind-mount a host directory
  that Docker or root created (the common default), `node` inside the
  container will fail to write `seen.db` with a SQLite permissions error at
  boot. Fix by pre-creating the host directory and running
  `chown -R 1000:1000 <host-path>` before starting the container, or by
  using a named volume instead.

## Deploy on Coolify

Coolify auto-detects the image-defined `HEALTHCHECK` in the Dockerfile
("Custom Healthcheck Found") and uses it directly — there is no separate
healthcheck UI step to configure in either mode below.

**Option A — Docker Compose** (recommended; matches `docker-compose.yml` in
this repo):

1. New Resource → Docker Compose → point at this repository.
2. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `MASTER_KEY` as environment
   variables. Mark them as secrets. `MASTER_KEY` must be at least 32 characters
   (`openssl rand -base64 32`) and is not recoverable — see
   [Adding a mailbox](#adding-a-mailbox).
3. Deploy. The `/data` volume is already declared in `docker-compose.yml`
   (`notifier-data:/data`) — no extra volume configuration needed in the UI.

**Option B — Dockerfile only** (no compose file):

1. New Resource → Dockerfile → point at this repository.
2. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `MASTER_KEY` as environment
   variables. Mark them as secrets. `MASTER_KEY` must be at least 32 characters
   (`openssl rand -base64 32`) and is not recoverable — see
   [Adding a mailbox](#adding-a-mailbox).
3. Add a persistent volume mounted at `/data` yourself — this mode has no
   compose file to declare it, so skipping this step means the dedup database
   does not survive a redeploy.
4. Deploy.

**What "healthy" means here:** the container's healthcheck reports pure
liveness — did `/healthz` respond at all — not whether every mailbox is
currently connected. **A freshly deployed container with zero mailboxes added
is expected and reports healthy**; add mailboxes afterwards by messaging the
bot (see [Adding a mailbox](#adding-a-mailbox)). A single degraded or
reconnecting mailbox does **not**
turn the container unhealthy and does **not** trigger a restart (see the
`HEALTHCHECK` comment in the Dockerfile for why a restart would make things
worse, not better, for every degraded state this app can be in). If you want
to know when a mailbox is actually degraded, use one of:

- the `/healthz` response body itself, e.g. `curl http://<host>:8080/healthz`
  → `{"status":"degraded","accounts":[{"label":"Work","state":"reconnecting"}]}`;
- the Telegram alert the app sends you when an account hits a fatal state
  (wrong password, exhausted retries);
- container stderr (`docker logs` / Coolify's log viewer).

## Behaviour

- The first run against a mailbox notifies nothing — it records a baseline so your
  history is not dumped into Telegram.
- Every notified `Message-ID` is remembered, so mail moved between folders notifies once.
- INBOX is near-instant; other folders are checked every `SWEEP_INTERVAL_SECONDS`.
- A wrong password stops that one account and sends you a Telegram alert. Other
  accounts keep running.
- An unreachable IMAP host is retried with exponential backoff (capped at 5
  minutes between attempts, up to 20 consecutive failures per account) rather
  than treated as fatal — the process keeps running and `/healthz` reports
  503 for that account until it reconnects or exhausts the retry budget.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | yes | — | The only chat allowed to send commands |
| `MASTER_KEY` | yes | — | ≥32 chars; encrypts stored mailbox passwords. `openssl rand -base64 32` |
| `SWEEP_INTERVAL_SECONDS` | no | `60` | Non-INBOX folder check interval |
| `PREVIEW_CHARS` | no | `200` | Body preview length |
| `DB_PATH` | no | `/data/seen.db` | SQLite location |
| `HEALTH_PORT` | no | `8080` | Health server port |

Invalid configuration (a missing required variable, or a `MASTER_KEY` shorter than 32
characters) makes the process print `fatal: ...` to stderr and exit 1 immediately at
boot — it never starts with a partially-valid configuration.

### Adding a mailbox

Mailboxes are configured at runtime by messaging the bot — there is no `MAILBOXES`
variable, and a fresh install legitimately starts with zero mailboxes configured. Send:

```
/add Work imap.hostinger.com 993 me@mydomain.com
```

The bot asks for the password as a separate message and deletes it as soon as it has
read it, then tests the credentials before saving. Other commands: `/list`,
`/remove <label>`, `/status`, `/test <label>`.

**`MASTER_KEY` is not recoverable.** It encrypts every stored mailbox password. If you
lose it or change it, stored passwords can no longer be decrypted and you must re-add
each mailbox from scratch. Keep a copy wherever you keep your other credentials.

Note that `/data` now holds those encrypted mailbox credentials as well as the dedup
database, so treat volume backups, snapshots and volume clones as credential material —
store them with the same care as `MASTER_KEY` itself, and keep the two apart.
