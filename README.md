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
docker build -t email-notifier .
docker compose up -d
```

The image runs as the non-root `node` user, on `node:22-bookworm-slim` (glibc,
not alpine — `better-sqlite3`'s prebuilt binaries require glibc).

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

1. New Resource → Docker Compose (or Dockerfile) → point at this repository.
2. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `MAILBOXES` as environment
   variables. Mark them as secrets.
3. Add a persistent volume mounted at `/data` so the dedup database survives redeploys.
4. Set the healthcheck to `GET /healthz` on port 8080 (200 = every mailbox `ok`,
   503 = at least one mailbox degraded/reconnecting/failed).
5. Deploy.

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
| `HEALTH_PORT` | no | `8080` | Health server port |

Invalid configuration (missing required variable, malformed `MAILBOXES` JSON, or
a `MAILBOXES` entry failing validation) makes the process print
`fatal: ...` to stderr and exit 1 immediately at boot — it never starts with a
partially-valid configuration.
