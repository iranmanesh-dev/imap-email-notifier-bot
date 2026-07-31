# Email → Telegram Notifier — Design

**Date:** 2026-07-28
**Status:** Approved design, pending implementation plan

## Purpose

Notify the user on Telegram whenever an email arrives in any folder of any of their
Hostinger mailboxes. One Telegram message per email, containing sender, subject, and a
short body preview.

## Success criteria

1. A message arriving in INBOX produces a Telegram notification within ~5 seconds.
2. A message arriving in any other folder produces one within ~60 seconds.
3. No email produces two notifications, including when it is moved between folders.
   **Amended during implementation by explicit user decision:** deduplication is scoped
   *per account*. The same email arriving in two configured mailboxes notifies twice —
   once per mailbox, each labelled with its own account. Within a single account it still
   notifies exactly once, including across folder moves. Two known, accepted exceptions
   are documented under "Deduplication" below.
4. First boot against a mailbox notifies nothing; only mail arriving after startup is sent.
5. A dropped IMAP connection delays notifications but never loses them.
6. The container survives restarts, redeploys, and mail-server outages without manual work.

## Constraints

- **Provider:** Hostinger mail, plain IMAP over TLS. `imap.hostinger.com:993`, or
  `imap.titan.email:993` on Titan plans. No OAuth.
- **Concurrent IMAP connections** are capped by the provider (roughly 10–15 per account),
  so the design must not scale connections with folder count.
- **Telegram Bot API** throttles to approximately 1 message/second sustained per chat and
  returns `429` with a `retry_after` field when exceeded.
- **Deployment:** Docker on the user's VPS, managed by Coolify.
- **Stack:** Node.js 22 + TypeScript.

## Prerequisites (one-time manual setup)

1. **Create the bot.** Message [@BotFather](https://t.me/BotFather) on Telegram, send
   `/newbot`, follow the prompts. It returns a token like `123456789:AAH...`. This is
   `TELEGRAM_BOT_TOKEN`.
2. **Get the chat ID.** Send any message to your new bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read
   `result[0].message.chat.id`. This is `TELEGRAM_CHAT_ID`.
3. **Mailbox credentials.** The IMAP host, port, username, and password for each Hostinger
   mailbox to watch.

## Architecture

A single Node process, one container. For each configured account it maintains two IMAP
connections:

- an **idler**, parked in IMAP IDLE on INBOX, for low-latency delivery;
- a **sweeper**, waking every `SWEEP_INTERVAL_SECONDS` to run `STATUS (UIDNEXT)` across
  **all** folders — INBOX included.

Both feed one pipeline.

```
                    ┌─ idler (INBOX, IDLE) ──┐
account A ──────────┤                        ├──► new UIDs
                    └─ sweeper (STATUS all) ─┘        │
                                                      ▼
                                            fetch envelope + body
                                                      │
                                                      ▼
                                          parse ──► dedup (SQLite)
                                                      │ unseen
                                                      ▼
                                              format ──► send queue ──► Telegram
```

### Why this shape

`STATUS` does not require selecting a folder and is cheap, so one connection can check
dozens of folders per sweep. Only folders whose `UIDNEXT` advanced since the last
recorded value are then `SELECT`ed and fetched. Connection count stays at **2 per
account** regardless of folder count, which is what keeps the design inside the
provider's connection cap.

### The sweeper covers INBOX deliberately

The idler is a latency optimisation, not the source of truth. If IDLE dies silently — a
NAT or firewall dropping the TCP connection without a FIN, the classic failure mode for
long-lived IMAP connections — INBOX mail arrives up to 60 seconds late rather than never.
This removes the single point of failure that most notifier apps of this kind have.

## Modules

Each module has one responsibility and is testable in isolation.

| Module | Responsibility | Depends on |
|---|---|---|
| `src/config.ts` | Parse and validate env into a typed `Config` (zod) | — |
| `src/imap/watcher.ts` | Own one account: compose an idler and a sweeper, supervise reconnects, emit `NewMessage` events | ImapFlow, sweeper, store |
| `src/imap/idler.ts` | Hold one IDLE connection on INBOX, emit "folder changed" | ImapFlow |
| `src/imap/sweeper.ts` | `STATUS (UIDNEXT)` across folders, diff against stored state, fetch changed | ImapFlow, store |
| `src/mail/parse.ts` | Raw RFC822 source → `NormalizedEmail` | mailparser |
| `src/mail/format.ts` | `NormalizedEmail` → escaped Telegram HTML string | — |
| `src/store/seen.ts` | `Message-ID` dedup set + per-folder last-seen UID state | better-sqlite3 |
| `src/telegram/sender.ts` | Serialized send queue, rate limiting, retry/backoff | fetch |
| `src/health.ts` | HTTP `/healthz` reporting per-account connection state | node:http |
| `src/index.ts` | Wiring, startup, graceful shutdown on SIGTERM | all |

### Core type

```ts
type NormalizedEmail = {
  messageId: string;      // RFC822 Message-ID; dedup key
  accountLabel: string;   // e.g. "Work"
  folder: string;         // e.g. "INBOX", "Archive"
  from: string;           // display name + address
  subject: string;
  preview: string;        // first PREVIEW_CHARS of plaintext body
  date: Date;
};
```

## Behaviour

### First run

The first time the app sees a given account+folder pair, it records the folder's current
`UIDNEXT` as a baseline and sends **no** notifications. Without this, first boot would
push the entire mailbox history to Telegram.

### Deduplication

Every notified message is recorded in SQLite as `(accountLabel, messageId)` and checked
before sending. This is what makes "watch every folder" usable: a message moved from INBOX
to Archive appears as a new arrival in Archive, and dedup suppresses the second
notification. It also guarantees that a restart, a redeploy, or an overlapping
idler/sweeper detection never re-notifies.

The key is scoped by account (user decision, see success criterion 3), so each mailbox that
genuinely receives an email gets its own labelled notification. Without this the winning
mailbox was decided by whichever account's sweep ran first, making the account label on the
notification arbitrary.

Messages lacking a `Message-ID` header fall back to a synthetic key of
`sha256(accountLabel + raw RFC822 source)`. Deriving it from the raw bytes rather than
header fields keeps it stable across re-reads; wall-clock time is deliberately excluded,
because an earlier version folded in `new Date()` and produced a different key on every
read, re-notifying forever.

Entries are pruned after 30 days to bound database growth. Prune runs once at startup and
then every 24 hours, so a redeploy-heavy environment still enforces the bound.

**Two accepted exceptions to "exactly once":**

1. **At-least-once on crash.** `markSeen` is called only *after* a successful send, so a
   process kill between the two yields one duplicate on restart. This is deliberate: the
   alternative ordering silently *loses* the email whenever a send fails, which is strictly
   worse.
2. **Message-ID-less mail moved between folders.** The synthetic key hashes the raw source,
   which some IMAP servers alter between fetches (header refolding, added `X-` headers), so
   such a message can be re-notified. Affects only mail with no `Message-ID` header. The
   alternative — hashing selected header fields — would let two genuinely distinct messages
   collide and be silently suppressed, trading a duplicate for a loss.

### Message format

> **Superseded.** The layout below is the original design. The shipped format is the
> hashtag layout shown in the README ("What a notification looks like"); the escaping and
> per-field truncation requirements stated in this section still apply unchanged.

One Telegram message per email, `parse_mode: HTML`:

```
📬 <b>{subject}</b>
From: {from}
{accountLabel} › {folder}

{preview}
```

**Every interpolated field is HTML-escaped.** A subject containing `<` or `&` will
otherwise cause Telegram to reject the entire message. This is a correctness requirement,
not formatting polish.

If the assembled message exceeds Telegram's 4096-character limit, the preview is
truncated with an ellipsis until it fits.

## Failure handling

| Failure | Response |
|---|---|
| IMAP connection drop | Exponential backoff with jitter, capped at 5 minutes; sweeper continues to cover |
| IDLE stale/silent | Re-issue IDLE every 9 minutes (RFC 2177 caps at 29); watchdog tears down and reconnects the idler after 12 minutes with no server traffic |
| IMAP auth failure | Fatal for that account: log, send one Telegram alert, stop retrying. Never hot-loop against the provider. |
| Telegram `429` | Honour `retry_after`; queue holds and resumes |
| Telegram `5xx` | Exponential backoff, then park the message and continue |
| Telegram `400` | Retry once as plain text; if it still fails, drop and log. A malformed subject must not wedge the queue. |
| Message > 4096 chars | Truncate preview to fit |
| SQLite unavailable | Fatal at startup — running without dedup would spam the user |

Other accounts continue running when one account fails.

## Configuration

All configuration is environment variables; nothing sensitive is baked into the image.

```
TELEGRAM_BOT_TOKEN=123456789:AAH...
TELEGRAM_CHAT_ID=987654321
MAILBOXES='[{"label":"Work","host":"imap.hostinger.com","port":993,
             "user":"me@example.com","pass":"..."}]'
SWEEP_INTERVAL_SECONDS=60
PREVIEW_CHARS=200
DB_PATH=/data/seen.db
HEALTH_PORT=8080
```

`MAILBOXES` is a JSON array, so N accounts need no code change. Config is validated with
zod at boot; invalid config fails immediately and loudly rather than at the first email.

## Deployment

- Multi-stage **`node:22-bookworm-slim`** build (not alpine — `better-sqlite3` ships
  prebuilt binaries for glibc only, so musl would force a full C++ toolchain into the
  image anyway), running as a non-root user. The build compiles the native binding from
  source and fails the build if it does not load, because the bundled prebuild requires a
  newer glibc than bookworm ships and would otherwise produce a silently broken image.
- SQLite in WAL mode at `DB_PATH`, backed by a Coolify persistent volume mounted at `/data`.
- `restart: unless-stopped`.
- Coolify healthcheck against `/healthz`. **The check is liveness-only: any HTTP response
  means alive.** It deliberately does NOT fail on a degraded account, because every
  degraded state is one a restart makes worse — a restart resets the reconnect backoff,
  retries an unchanged wrong password, and zeroes the consecutive-failure cap, turning a
  bounded 20-attempt limit into an unbounded loop across restarts. No failure exists that a
  restart fixes but a "did it respond at all" check misses, since a wedged process fails to
  respond anyway. Degraded state is surfaced through the `/healthz` response body, the
  `onFatal` Telegram alert, and stderr.
- Secrets supplied as Coolify environment variables. `.env` is git-ignored and never committed.

## Security

- Passwords are never logged, and never included in error messages or health output.
- Message bodies are never logged.
- The bot only ever sends to the single configured `TELEGRAM_CHAT_ID`; it accepts no
  incoming commands, so there is no command surface to abuse.

## Testing

**Unit:**
- `format.ts` — HTML escaping of hostile subjects and sender names; truncation at the
  4096 boundary.
- `parse.ts` — fixture `.eml` files: plaintext, HTML-only, missing `Message-ID`,
  non-UTF-8 charsets.
- `seen.ts` — dedup returns false on repeat; first-run baseline suppresses history.
- `sender.ts` — with fake timers: rate limiting, `429` `retry_after` handling, `400`
  plain-text fallback, queue ordering.
- `config.ts` — invalid `MAILBOXES` JSON fails at boot with a clear message.

**Integration:**
A GreenMail IMAP server in a container. Append a message, assert exactly one correctly
formatted notification against a stubbed Telegram endpoint. Append the same message to a
second folder, assert silence. Kill and restore the connection, assert the sweeper still
delivers.

No live Hostinger credentials appear in any test.

## Out of scope

- Attachment forwarding.
- Replying to email from Telegram.
- Per-sender or per-folder filtering rules.
- Multiple Telegram recipients or topic routing.
- Providers other than IMAP (Gmail API, Microsoft Graph).
