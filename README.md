# Email → Telegram Notifier

Sends a Telegram message for every email arriving in any folder of any configured
IMAP mailbox.

## Setup

1. **Create a Telegram bot.** Message [@BotFather](https://t.me/BotFather), send
   `/newbot`, and copy the token it returns.
2. **Find your chat ID.** Send any message to your new bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read
   `result[0].message.chat.id`.
3. **Copy `.env.example` to `.env`** and fill in the token, chat ID, and mailboxes.

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
2. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `MAILBOXES` as environment
   variables. Mark them as secrets.
3. Deploy. The `/data` volume is already declared in `docker-compose.yml`
   (`notifier-data:/data`) — no extra volume configuration needed in the UI.

**Option B — Dockerfile only** (no compose file):

1. New Resource → Dockerfile → point at this repository.
2. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `MAILBOXES` as environment
   variables. Mark them as secrets.
3. Add a persistent volume mounted at `/data` yourself — this mode has no
   compose file to declare it, so skipping this step means the dedup database
   does not survive a redeploy.
4. Deploy.

**What "healthy" means here:** the container's healthcheck reports pure
liveness — did `/healthz` respond at all — not whether every mailbox is
currently connected. A single degraded or reconnecting mailbox does **not**
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
| `TELEGRAM_CHAT_ID` | yes | — | Chat to send notifications to |
| `MAILBOXES` | yes | — | JSON array of `{label, host, port, user, pass, secure?}` |
| `SWEEP_INTERVAL_SECONDS` | no | `60` | Non-INBOX folder check interval |
| `PREVIEW_CHARS` | no | `200` | Body preview length |
| `DB_PATH` | no | `/data/seen.db` | SQLite location (WAL mode) |
| `HEALTH_PORT` | no | `8080` | Health server port (the image's `HEALTHCHECK` reads this same variable, so overriding it cannot desync the healthcheck from the actual port) |

Invalid configuration (missing required variable, malformed `MAILBOXES` JSON, or
a `MAILBOXES` entry failing validation) makes the process print
`fatal: ...` to stderr and exit 1 immediately at boot — it never starts with a
partially-valid configuration.
