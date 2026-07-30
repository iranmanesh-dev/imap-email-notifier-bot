# Runtime Mailbox Configuration — Design

**Date:** 2026-07-31
**Status:** Approved design, pending implementation plan
**Supersedes:** the `MAILBOXES` environment variable from
`2026-07-28-email-telegram-notifier-design.md`

## Purpose

Let the operator add, inspect, test, and remove IMAP mailboxes at runtime through
Telegram bot commands, instead of editing a `MAILBOXES` environment variable and
redeploying the container.

## Success criteria

1. Adding a mailbox via Telegram starts watching it without a restart or redeploy.
2. Removing a mailbox stops its watcher and deletes its stored state.
3. Mailbox passwords are never stored in plaintext and never appear in any log line,
   error message, or bot reply.
4. Commands from any chat other than the configured operator are ignored entirely.
5. A mailbox whose credentials fail is never persisted — `/add` tests before saving.
6. Booting with zero mailboxes is a normal, healthy state.

## Scope decisions

These were settled explicitly during design:

- **Interface: Telegram bot commands.** Not an HTTP API (needs a public domain and its
  own auth), not a web UI (roughly doubles the project), not a hand-edited config file
  (not meaningfully "managed").
- **Single-tenant.** The bot serves exactly one operator. Multi-tenant was considered and
  rejected: it would make the operator custodian of other people's IMAP passwords, which
  usually grant full mailbox access and are often the account-reset vector for everything
  else the user owns. It would also create GDPR data-processor obligations and near-certain
  provider IP blocking. Users who want their own notifier self-host the public repo.
- **`MAILBOXES` is removed entirely.** No seeding, no merge, no precedence rules. The
  store is the single source of truth.
- **Commands:** `/add`, `/list`, `/remove`, `/status`, `/test`. No pause/resume — more
  state to model and more ways to be confused about why mail stopped.

## Constraints

- The container has **no public domain** (deliberately — `/healthz` exposes mailbox
  labels). So updates must be received by long-polling, not a webhook.
- The bot previously accepted **no** incoming commands. The original spec called that out
  as a security property. This design knowingly gives it up in exchange for runtime
  configuration, and compensates with a strict chat-ID gate.
- Mailbox passwords must survive container restarts, so they live on the `/data` volume
  alongside the dedup database.

## Architecture

```
Telegram ──getUpdates──► receiver ──► command router (chat-ID gate)
                                          │
                    ┌─────────────────────┼──────────────────┐
                    ▼                     ▼                  ▼
              mailbox store         watcher registry    IMAP probe
             (encrypted pass)      (start/stop live)   (/test, no save)
                    │                     │
                    └────── SQLite ───────┘
```

`main()` no longer reads mailboxes from the environment. It loads them from the store,
hands them to the registry, and starts the receiver alongside the existing health server.

### New modules

| Module | Responsibility | Depends on |
|---|---|---|
| `src/telegram/receiver.ts` | Long-poll `getUpdates`, track offset, abort on SIGTERM | fetch |
| `src/telegram/commands.ts` | Parse and dispatch; chat-ID gate | store, registry, probe |
| `src/telegram/conversation.ts` | In-memory state for the two-step `/add` flow | — |
| `src/store/mailboxes.ts` | CRUD over the `mailboxes` table | better-sqlite3, secret |
| `src/crypto/secret.ts` | AES-256-GCM encrypt/decrypt | node:crypto |
| `src/imap/registry.ts` | Owns `Map<label, AccountWatcher>`; `add()`/`remove()` | AccountWatcher |

### Receiving updates

Long-polling: `getUpdates` with `timeout=30` and an `offset` one past the last handled
`update_id`. On startup the receiver calls `deleteWebhook` first — a webhook and
`getUpdates` are mutually exclusive, and a stale webhook would silently swallow every
update. An `AbortController` cancels the in-flight poll on shutdown so SIGTERM does not
wait up to 30 seconds.

The receiver is independent of `TelegramSender`. The sender keeps its serialized,
rate-limited queue for outbound notifications; the receiver only polls.

## Data model

```sql
CREATE TABLE IF NOT EXISTS mailboxes (
  label         TEXT PRIMARY KEY,
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL,
  username      TEXT NOT NULL,
  secure        INTEGER NOT NULL DEFAULT 1,
  pass_enc      BLOB NOT NULL,   -- iv ‖ authTag ‖ ciphertext
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`label` is the primary key, which enforces at the storage layer the uniqueness invariant
that `config.ts` currently enforces with a zod refinement. That invariant is load-bearing:
two mailboxes sharing a label would share `folder_state` rows and silently lose mail for
both.

## Encryption

- `MASTER_KEY` is a required environment variable, minimum 32 characters. The process
  refuses to boot without it, matching how required config already behaves.
- A 32-byte key is derived via HKDF-SHA256 with a fixed application salt, so any
  sufficiently long input works (`openssl rand -base64 32` is the documented way to
  produce one).
- **AES-256-GCM**, fresh 12-byte IV per record. Stored as `iv ‖ authTag ‖ ciphertext`.
  GCM authenticates, so a tampered row fails to decrypt rather than yielding garbage that
  would be sent to an IMAP server as a password.
- Decrypted passwords exist only in memory and are passed directly to ImapFlow. They
  appear in no log line, no error message, and no bot reply.
- **`MASTER_KEY` is not recoverable.** Losing it makes every stored password
  undecryptable and requires re-adding each mailbox. This is documented in the README.

## Command flows

All commands are rejected before parsing unless `message.chat.id` equals
`TELEGRAM_CHAT_ID`. Unauthorized chats receive **no reply at all** — an error would
confirm to a prober that the bot is live.

### `/add <label> <host> <port> <username>`

Two steps, so the password never appears in a command echo:

1. The bot stores a pending entry and replies asking for the password as the next message.
2. On receiving it, the bot immediately calls `deleteMessage` on the user's message, then
   tests the credentials, then saves and starts a watcher.

If `deleteMessage` fails — Telegram refuses beyond 48 hours — the bot says so explicitly
and tells the operator to delete it manually, rather than leaving it silently in place.

Pending password state **expires after 5 minutes**. Without expiry, an abandoned `/add`
would make the bot treat an unrelated later message as a password and attempt an IMAP
login with it.

`/add` always tests before saving, so a mailbox that cannot authenticate is never
persisted.

**TLS is always on.** The `secure` column exists because `Account` requires the field, but
there is no command syntax to disable it and it is always stored as `1`. Every provider
this targets uses implicit TLS on port 993, and offering a plaintext-IMAP toggle over a
chat interface would be a footgun that transmits the password in the clear. A future
change can add it if a real need appears.

### `/list`

Label, host, port, username, and `••••••••`. The password is never shown, in any form.

### `/remove <label>`

The bot replies naming the mailbox and what will be deleted, and waits for the operator to
reply with the literal word `yes`. Any other reply, or 60 seconds of silence, cancels it.
Confirmation uses the same conversation-state mechanism as the `/add` password step.

On confirmation it stops the watcher and deletes the mailbox row, its `folder_state` rows,
and its `seen_by_account` rows.

Deleting the state is deliberate: keeping it would make a later re-add of the same label
resume from a stale high-water mark and potentially flood the operator with everything
that arrived in between. Deleting means a re-add gets a fresh baseline and notifies
nothing, exactly like adding it the first time.

### `/status`

Each watcher's live state (`ok`, `reconnecting`, `auth-failed`, `connect-failed`). This
matters more than it sounds: the health endpoint has no public domain, so this is the
operator's only view into connection health.

### `/test <label>`

Re-tests an already-saved mailbox without changing it. Useful after a password rotation.

## Error handling

| Failure | Response |
|---|---|
| `getUpdates` network error | Backoff and retry. The receiver must never take the process down. |
| `409 Conflict` on poll | A webhook exists; call `deleteWebhook` and resume |
| `401` on poll | Fatal — the bot token is wrong and retrying cannot fix it |
| Password fails to decrypt | Skip that mailbox, log loudly, send a Telegram alert. Never silent — silence is indistinguishable from "mail stopped arriving". |
| `/add` connection test fails | Do not save. Report the IMAP error with the password scrubbed. |
| Duplicate label | Rejected by the primary key; reported clearly |
| Store write fails | Wrapped in a transaction so a mailbox is never half-added |
| Unknown command | Brief usage reply (authorized chat only) |

No command reply ever contains a stack trace or a credential.

## Health reporting change

Booting with zero mailboxes becomes normal — it is the state after the first deploy of
this change. `buildHealthReport` currently treats zero watchers as `degraded`; that branch
was previously unreachable because config rejected an empty `MAILBOXES`. It must now
report `ok` with an explicit idle indication. A fresh install is empty, not unhealthy.

## Testing

**Unit:**
- `secret.ts` — encrypt/decrypt round-trip; wrong key fails; tampered ciphertext fails
  (GCM auth); IV differs per call.
- `commands.ts` — the chat-ID gate stays silent for other chats; malformed input; unknown
  commands; every command's happy path with a stubbed store and registry.
- `conversation.ts` — pending state expires after 5 minutes; a second `/add` replaces a
  pending one.
- `mailboxes.ts` — CRUD; duplicate label rejected; password is not readable as plaintext
  in the stored blob.
- `registry.ts` — `add()` starts a watcher, `remove()` stops it, removing an unknown label
  is a no-op.
- `receiver.ts` — with an injected `fetch`, mirroring `TelegramSender`'s existing pattern:
  offset advances, `409` triggers `deleteWebhook`, `401` is fatal, network errors retry.

**Integration (GreenMail):** add a mailbox through the store, assert a watcher starts and
delivers a message; remove it, assert the watcher stops and no further notifications
arrive.

## Deployment changes

Three edits in Coolify, no infrastructure change:

1. **Delete** `MAILBOXES`
2. **Add** `MASTER_KEY` as a secret
3. Redeploy

The `/data` volume already persists, so the `mailboxes` table lands beside the dedup
database. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are unchanged and still required.

## Out of scope

- Multi-tenant operation (see Scope decisions).
- Pause/resume per mailbox.
- Key rotation tooling. Changing `MASTER_KEY` means re-adding mailboxes.
- Editing an existing mailbox in place — remove and re-add.
- Any HTTP or web management surface.
