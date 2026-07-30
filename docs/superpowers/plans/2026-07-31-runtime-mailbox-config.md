# Runtime Mailbox Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `MAILBOXES` environment variable with Telegram bot commands backed by an encrypted SQLite store, so mailboxes can be added, tested, and removed at runtime without a redeploy.

**Architecture:** A long-polling receiver feeds updates to a command router gated on a single operator chat ID. Commands mutate a `mailboxes` table whose passwords are AES-256-GCM encrypted with a key derived from `MASTER_KEY`, and drive a watcher registry that starts and stops `AccountWatcher` instances live.

**Tech Stack:** Node 22, TypeScript, vitest, better-sqlite3, node:crypto, imapflow, Telegram Bot API.

## Global Constraints

- ESM, TypeScript `module: nodenext`. Local imports inside `src/` MUST use the `.js` extension even though sources are `.ts`.
- **Never log, reply with, or include in any error: a mailbox password, the bot token, or a message body.** This is a correctness requirement, not style.
- **Every command is rejected before parsing unless `message.chat.id` matches `TELEGRAM_CHAT_ID`. Unauthorized chats get NO reply at all** — an error confirms the bot is live to a prober.
- `MASTER_KEY` is required, minimum 32 characters. The process refuses to boot without it.
- TLS is always on for mailboxes: `secure` is always stored as `1`, with no command to disable it.
- Test framework is `vitest`. `npm test` must stay fast and Docker-free. Every task ends with a passing run and a commit.
- Existing behaviour that must not regress: at-least-once delivery, per-account dedup on `(accountLabel, messageId)`, first-run baselining, the two-connections-per-account cap, and the liveness-only healthcheck.

---

### Task 1: Secret encryption and `MASTER_KEY` config

**Files:**
- Create: `src/crypto/secret.ts`
- Modify: `src/config.ts`, `src/types.ts`
- Test: `test/secret.test.ts`, `test/config.test.ts`

**Interfaces:**
- Consumes: `Config` from `src/types.ts`.
- Produces:
  - `function deriveKey(masterKey: string): Buffer` — 32 bytes via HKDF-SHA256
  - `function encryptSecret(plaintext: string, key: Buffer): Buffer` — `iv ‖ authTag ‖ ciphertext`
  - `function decryptSecret(blob: Buffer, key: Buffer): string` — throws on wrong key or tampering
  - `Config` gains `masterKey: string`; `Config.mailboxes` is REMOVED.

- [ ] **Step 1: Write the failing test**

Create `test/secret.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveKey, encryptSecret, decryptSecret } from '../src/crypto/secret.js';

const KEY = deriveKey('a'.repeat(32));
const OTHER = deriveKey('b'.repeat(32));

describe('secret', () => {
  it('round-trips a password', () => {
    const blob = encryptSecret('hunter2', KEY);
    expect(decryptSecret(blob, KEY)).toBe('hunter2');
  });

  it('never stores the plaintext in the blob', () => {
    const blob = encryptSecret('hunter2', KEY);
    expect(blob.toString('utf8')).not.toContain('hunter2');
    expect(blob.toString('hex')).not.toContain(Buffer.from('hunter2').toString('hex'));
  });

  it('uses a fresh IV per call, so identical inputs differ', () => {
    expect(encryptSecret('same', KEY).equals(encryptSecret('same', KEY))).toBe(false);
  });

  it('fails with the wrong key rather than returning garbage', () => {
    const blob = encryptSecret('hunter2', KEY);
    expect(() => decryptSecret(blob, OTHER)).toThrow();
  });

  it('fails when the ciphertext is tampered with (GCM auth)', () => {
    const blob = encryptSecret('hunter2', KEY);
    blob[blob.length - 1] ^= 0xff;
    expect(() => decryptSecret(blob, KEY)).toThrow();
  });

  it('fails when the auth tag is tampered with', () => {
    const blob = encryptSecret('hunter2', KEY);
    blob[13] ^= 0xff;
    expect(() => decryptSecret(blob, KEY)).toThrow();
  });

  it('rejects a truncated blob instead of reading out of bounds', () => {
    expect(() => decryptSecret(Buffer.alloc(8), KEY)).toThrow(/too short/i);
  });

  it('derives the same key from the same master key', () => {
    expect(deriveKey('x'.repeat(40)).equals(deriveKey('x'.repeat(40)))).toBe(true);
  });

  it('derives different keys from different master keys', () => {
    expect(deriveKey('x'.repeat(40)).equals(deriveKey('y'.repeat(40)))).toBe(false);
  });

  it('handles unicode and long passwords', () => {
    const pw = 'pässwörd🔐' + 'z'.repeat(500);
    expect(decryptSecret(encryptSecret(pw, KEY), KEY)).toBe(pw);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/secret.test.ts`
Expected: FAIL — cannot resolve `../src/crypto/secret.js`.

- [ ] **Step 3: Implement `src/crypto/secret.ts`**

```ts
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Fixed application salt. Single-key deployment, so a constant salt is fine. */
const SALT = Buffer.from('imap-email-notifier-bot/v1');
const INFO = Buffer.from('mailbox-password');

/** Derives a 32-byte AES key from an arbitrary-length master key. */
export function deriveKey(masterKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(masterKey, 'utf8'), SALT, INFO, 32));
}

/** Returns `iv ‖ authTag ‖ ciphertext`. */
export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * Reverses encryptSecret. Throws if the key is wrong or the blob was
 * tampered with — GCM authenticates, so this never returns garbage that
 * could be sent to an IMAP server as a password.
 */
export function decryptSecret(blob: Buffer, key: Buffer): string {
  if (blob.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('encrypted secret is too short to be valid');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/secret.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Update `src/types.ts`**

Remove `mailboxes` from `Config` and add `masterKey`. `Account` stays exactly as it is — it is still what `AccountWatcher` consumes.

```ts
export type Config = {
  telegramBotToken: string;
  telegramChatId: string;
  masterKey: string;
  sweepIntervalSeconds: number;
  previewChars: number;
  dbPath: string;
  healthPort: number;
};
```

- [ ] **Step 6: Update `src/config.ts`**

Delete the `MAILBOXES` parsing, the `accountSchema`, the `mailboxesSchema`, the duplicate-label refinement, and the now-unused `zod` import if nothing else uses it. Add `MASTER_KEY` validation.

```ts
const MIN_MASTER_KEY_LENGTH = 32;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const telegramBotToken = requireVar(env, 'TELEGRAM_BOT_TOKEN');
  const telegramChatId = requireVar(env, 'TELEGRAM_CHAT_ID');
  const masterKey = requireVar(env, 'MASTER_KEY');

  if (masterKey.length < MIN_MASTER_KEY_LENGTH) {
    throw new Error(
      `MASTER_KEY must be at least ${MIN_MASTER_KEY_LENGTH} characters (generate one with: openssl rand -base64 32)`
    );
  }

  return {
    telegramBotToken,
    telegramChatId,
    masterKey,
    sweepIntervalSeconds: numberVar(env, 'SWEEP_INTERVAL_SECONDS', 60),
    previewChars: numberVar(env, 'PREVIEW_CHARS', 200),
    dbPath: env.DB_PATH ?? '/data/seen.db',
    healthPort: numberVar(env, 'HEALTH_PORT', 8080),
  };
}
```

- [ ] **Step 7: Rewrite `test/config.test.ts`**

Replace every `MAILBOXES` test. The password-never-in-errors test is replaced by a master-key-never-in-errors test.

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  TELEGRAM_BOT_TOKEN: '123:ABC',
  TELEGRAM_CHAT_ID: '999',
  MASTER_KEY: 'k'.repeat(32),
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.telegramBotToken).toBe('123:ABC');
    expect(cfg.masterKey).toBe('k'.repeat(32));
  });

  it('applies defaults for optional settings', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.sweepIntervalSeconds).toBe(60);
    expect(cfg.previewChars).toBe(200);
    expect(cfg.dbPath).toBe('/data/seen.db');
    expect(cfg.healthPort).toBe(8080);
  });

  it('coerces numeric overrides from strings', () => {
    const cfg = loadConfig({ ...baseEnv, SWEEP_INTERVAL_SECONDS: '15', PREVIEW_CHARS: '50' });
    expect(cfg.sweepIntervalSeconds).toBe(15);
    expect(cfg.previewChars).toBe(50);
  });

  it('throws when a required variable is missing', () => {
    const { TELEGRAM_BOT_TOKEN: _omit, ...rest } = baseEnv;
    expect(() => loadConfig(rest)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('throws when MASTER_KEY is missing', () => {
    const { MASTER_KEY: _omit, ...rest } = baseEnv;
    expect(() => loadConfig(rest)).toThrow(/MASTER_KEY/);
  });

  it('throws when MASTER_KEY is too short, and says how to make one', () => {
    expect(() => loadConfig({ ...baseEnv, MASTER_KEY: 'short' })).toThrow(/at least 32/);
    expect(() => loadConfig({ ...baseEnv, MASTER_KEY: 'short' })).toThrow(/openssl rand/);
  });

  it('never includes the master key itself in an error message', () => {
    try {
      loadConfig({ ...baseEnv, MASTER_KEY: 'sekrit' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('sekrit');
    }
  });

  it('ignores a leftover MAILBOXES variable', () => {
    const cfg = loadConfig({ ...baseEnv, MAILBOXES: '[{"label":"x"}]' });
    expect(cfg).not.toHaveProperty('mailboxes');
  });
});
```

- [ ] **Step 8: Run and commit**

Run: `npx vitest run test/secret.test.ts test/config.test.ts` — expect PASS.
The full suite and build will fail until Task 8 rewires `index.ts`; that is expected and is called out in each intervening task.

```bash
git add src/crypto/secret.ts src/config.ts src/types.ts test/secret.test.ts test/config.test.ts
git commit -m "feat: AES-256-GCM secret encryption and MASTER_KEY config"
```

---

### Task 2: Mailbox store

**Files:**
- Create: `src/store/mailboxes.ts`
- Modify: `src/store/seen.ts` (add `purgeAccount`)
- Test: `test/mailboxes.test.ts`, `test/seen.test.ts`

**Interfaces:**
- Consumes: `deriveKey`, `encryptSecret`, `decryptSecret` from `src/crypto/secret.js`; `Account` from `src/types.js`.
- Produces:
  - `type MailboxSummary = { label: string; host: string; port: number; username: string }`
  - `class MailboxStore` with `constructor(dbPath: string, key: Buffer)`, `add(account: Account): void`, `list(): MailboxSummary[]`, `get(label: string): Account | null`, `labels(): string[]`, `remove(label: string): boolean`, `close(): void`
  - `labels()` returns every label WITHOUT decrypting, so startup can restore mailboxes one at a time and report a single undecryptable one without aborting the rest
  - `SeenStore.purgeAccount(accountLabel: string): number` — deletes that account's `folder_state` and `seen_by_account` rows, returns rows deleted

`MailboxStore` opens its own connection to the same SQLite file. WAL mode supports multiple connections in one process, and this keeps `SeenStore`'s constructor unchanged so no existing test breaks.

- [ ] **Step 1: Write the failing test**

Create `test/mailboxes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailboxStore } from '../src/store/mailboxes.js';
import { deriveKey } from '../src/crypto/secret.js';
import type { Account } from '../src/types.js';

const KEY = deriveKey('m'.repeat(32));
let dir: string;
let dbPath: string;
let store: MailboxStore;

const work: Account = {
  label: 'Work', host: 'imap.example.com', port: 993,
  user: 'me@example.com', pass: 'hunter2', secure: true,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mb-'));
  dbPath = join(dir, 'test.db');
  store = new MailboxStore(dbPath, KEY);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MailboxStore', () => {
  it('round-trips an account including its password', () => {
    store.add(work);
    expect(store.get('Work')).toEqual(work);
  });

  it('returns null for an unknown label', () => {
    expect(store.get('Nope')).toBeNull();
  });

  it('lists mailboxes without exposing the password', () => {
    store.add(work);
    const listed = store.list();
    expect(listed).toEqual([
      { label: 'Work', host: 'imap.example.com', port: 993, username: 'me@example.com' },
    ]);
    expect(JSON.stringify(listed)).not.toContain('hunter2');
  });

  it('rejects a duplicate label', () => {
    store.add(work);
    expect(() => store.add({ ...work, host: 'other.example.com' })).toThrow(/already exists/i);
  });

  it('never writes the password as plaintext into the database file', () => {
    store.add(work);
    store.close();
    const raw = readFileSync(dbPath);
    expect(raw.includes(Buffer.from('hunter2'))).toBe(false);
    store = new MailboxStore(dbPath, KEY); // so afterEach can close cleanly
  });

  it('persists across reopening', () => {
    store.add(work);
    store.close();
    store = new MailboxStore(dbPath, KEY);
    expect(store.get('Work')?.pass).toBe('hunter2');
  });

  it('always stores secure as true regardless of input', () => {
    store.add({ ...work, secure: false });
    expect(store.get('Work')?.secure).toBe(true);
  });

  it('removes a mailbox and reports whether it existed', () => {
    store.add(work);
    expect(store.remove('Work')).toBe(true);
    expect(store.get('Work')).toBeNull();
    expect(store.remove('Work')).toBe(false);
  });

  it('throws when decrypting with the wrong key rather than returning junk', () => {
    store.add(work);
    store.close();
    store = new MailboxStore(dbPath, deriveKey('different'.repeat(4)));
    expect(() => store.get('Work')).toThrow();
  });

  it('keeps multiple mailboxes independent', () => {
    store.add(work);
    store.add({ ...work, label: 'Personal', user: 'me@home.example', pass: 'other-pw' });
    expect(store.get('Work')?.pass).toBe('hunter2');
    expect(store.get('Personal')?.pass).toBe('other-pw');
    expect(store.list()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/mailboxes.test.ts`
Expected: FAIL — cannot resolve `../src/store/mailboxes.js`.

- [ ] **Step 3: Implement `src/store/mailboxes.ts`**

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { decryptSecret, encryptSecret } from '../crypto/secret.js';
import type { Account } from '../types.js';

export type MailboxSummary = {
  label: string;
  host: string;
  port: number;
  username: string;
};

type Row = {
  label: string;
  host: string;
  port: number;
  username: string;
  pass_enc: Buffer;
};

export class MailboxStore {
  #db: Database.Database;
  #key: Buffer;

  constructor(dbPath: string, key: Buffer) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS mailboxes (
        label      TEXT PRIMARY KEY,
        host       TEXT NOT NULL,
        port       INTEGER NOT NULL,
        username   TEXT NOT NULL,
        secure     INTEGER NOT NULL DEFAULT 1,
        pass_enc   BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.#key = key;
  }

  /** Throws if the label already exists — the PK is the uniqueness invariant. */
  add(account: Account): void {
    const existing = this.#db
      .prepare('SELECT 1 FROM mailboxes WHERE label = ?')
      .get(account.label);
    if (existing !== undefined) {
      throw new Error(`a mailbox labelled "${account.label}" already exists`);
    }
    this.#db
      .prepare(
        `INSERT INTO mailboxes (label, host, port, username, secure, pass_enc)
         VALUES (?, ?, ?, ?, 1, ?)`
      )
      .run(
        account.label,
        account.host,
        account.port,
        account.user,
        encryptSecret(account.pass, this.#key)
      );
  }

  list(): MailboxSummary[] {
    return this.#db
      .prepare('SELECT label, host, port, username FROM mailboxes ORDER BY label')
      .all() as MailboxSummary[];
  }

  /** Decrypts the password. Throws if the key is wrong or the row was tampered with. */
  get(label: string): Account | null {
    const row = this.#db
      .prepare('SELECT label, host, port, username, pass_enc FROM mailboxes WHERE label = ?')
      .get(label) as Row | undefined;
    if (row === undefined) return null;
    return {
      label: row.label,
      host: row.host,
      port: row.port,
      user: row.username,
      pass: decryptSecret(row.pass_enc, this.#key),
      secure: true,
    };
  }

  /** All labels, without decrypting anything. */
  labels(): string[] {
    return (
      this.#db.prepare('SELECT label FROM mailboxes ORDER BY label').all() as { label: string }[]
    ).map((r) => r.label);
  }

  remove(label: string): boolean {
    return this.#db.prepare('DELETE FROM mailboxes WHERE label = ?').run(label).changes > 0;
  }

  close(): void {
    this.#db.close();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/mailboxes.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Add `purgeAccount` to `src/store/seen.ts`**

Add this method to the `SeenStore` class, above `close()`:

```ts
  /**
   * Deletes every trace of an account: its per-folder UID state and its
   * seen-message records. Called when a mailbox is removed, so that
   * re-adding the same label starts from a fresh baseline rather than
   * resuming from a stale high-water mark and flooding the operator.
   */
  purgeAccount(accountLabel: string): number {
    const purge = this.#db.transaction((label: string): number => {
      const state = this.#db
        .prepare('DELETE FROM folder_state WHERE account_label = ?')
        .run(label).changes;
      const seen = this.#db
        .prepare('DELETE FROM seen_by_account WHERE account_label = ?')
        .run(label).changes;
      return state + seen;
    });
    return purge(accountLabel);
  }
```

- [ ] **Step 6: Add tests for `purgeAccount` to `test/seen.test.ts`**

Append this describe block:

```ts
describe('purgeAccount', () => {
  it('removes folder state and seen records for one account only', () => {
    store.setFolderState('Work', 'INBOX', { uidNext: 10, uidValidity: 1 });
    store.setFolderState('Personal', 'INBOX', { uidNext: 20, uidValidity: 2 });
    store.markSeen('Work', '<a@x>');
    store.markSeen('Personal', '<b@x>');

    expect(store.purgeAccount('Work')).toBe(2);

    expect(store.getFolderState('Work', 'INBOX')).toBeNull();
    expect(store.hasSeen('Work', '<a@x>')).toBe(false);
    expect(store.getFolderState('Personal', 'INBOX')).not.toBeNull();
    expect(store.hasSeen('Personal', '<b@x>')).toBe(true);
  });

  it('returns 0 for an account with nothing stored', () => {
    expect(store.purgeAccount('Ghost')).toBe(0);
  });
});
```

- [ ] **Step 7: Run and commit**

Run: `npx vitest run test/mailboxes.test.ts test/seen.test.ts` — expect PASS.

```bash
git add src/store/mailboxes.ts src/store/seen.ts test/mailboxes.test.ts test/seen.test.ts
git commit -m "feat: encrypted mailbox store and per-account state purge"
```

---

### Task 3: Watcher registry

**Files:**
- Create: `src/imap/registry.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: `AccountWatcher` and `WatcherState` from `src/imap/watcher.js`; `Account` from `src/types.js`.
- Produces:
  - `type ManagedWatcher = { label: string; state: WatcherState; start(): Promise<void>; stop(): Promise<void> }`
  - `type WatcherFactory = (account: Account) => ManagedWatcher`
  - `class WatcherRegistry` with `constructor(factory: WatcherFactory)`, `add(account): Promise<void>`, `remove(label): Promise<boolean>`, `has(label): boolean`, `states(): { label: string; state: WatcherState }[]`, `size(): number`, `stopAll(): Promise<void>`

`ManagedWatcher` is a structural subset of `AccountWatcher` so tests can pass fakes without constructing real IMAP clients.

- [ ] **Step 1: Write the failing test**

Create `test/registry.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { WatcherRegistry, type ManagedWatcher } from '../src/imap/registry.js';
import type { Account } from '../src/types.js';
import type { WatcherState } from '../src/imap/watcher.js';

const account: Account = {
  label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true,
};

function fakeWatcher(label: string, state: WatcherState = 'ok'): ManagedWatcher & {
  started: number; stopped: number;
} {
  return {
    label,
    state,
    started: 0,
    stopped: 0,
    async start() { this.started += 1; },
    async stop() { this.stopped += 1; },
  };
}

describe('WatcherRegistry', () => {
  it('starts a watcher when a mailbox is added', async () => {
    const w = fakeWatcher('Work');
    const reg = new WatcherRegistry(() => w);
    await reg.add(account);
    expect(w.started).toBe(1);
    expect(reg.has('Work')).toBe(true);
    expect(reg.size()).toBe(1);
  });

  it('rejects adding a label that is already registered', async () => {
    const reg = new WatcherRegistry(() => fakeWatcher('Work'));
    await reg.add(account);
    await expect(reg.add(account)).rejects.toThrow(/already/i);
  });

  it('stops the watcher when a mailbox is removed', async () => {
    const w = fakeWatcher('Work');
    const reg = new WatcherRegistry(() => w);
    await reg.add(account);
    expect(await reg.remove('Work')).toBe(true);
    expect(w.stopped).toBe(1);
    expect(reg.has('Work')).toBe(false);
  });

  it('returns false when removing an unknown label', async () => {
    const reg = new WatcherRegistry(() => fakeWatcher('Work'));
    expect(await reg.remove('Ghost')).toBe(false);
  });

  it('does not leave a registration behind when start() fails', async () => {
    const reg = new WatcherRegistry(() => ({
      label: 'Work',
      state: 'starting' as WatcherState,
      async start() { throw new Error('connect failed'); },
      async stop() {},
    }));
    await expect(reg.add(account)).rejects.toThrow(/connect failed/);
    expect(reg.has('Work')).toBe(false);
  });

  it('still deregisters when stop() throws', async () => {
    const reg = new WatcherRegistry(() => ({
      label: 'Work',
      state: 'ok' as WatcherState,
      async start() {},
      async stop() { throw new Error('logout failed'); },
    }));
    await reg.add(account);
    expect(await reg.remove('Work')).toBe(true);
    expect(reg.has('Work')).toBe(false);
  });

  it('reports each watcher state', async () => {
    const reg = new WatcherRegistry((a) => fakeWatcher(a.label, a.label === 'Work' ? 'ok' : 'auth-failed'));
    await reg.add(account);
    await reg.add({ ...account, label: 'Personal' });
    expect(reg.states()).toEqual([
      { label: 'Work', state: 'ok' },
      { label: 'Personal', state: 'auth-failed' },
    ]);
  });

  it('stopAll stops every watcher and empties the registry', async () => {
    const made: ReturnType<typeof fakeWatcher>[] = [];
    const reg = new WatcherRegistry((a) => { const w = fakeWatcher(a.label); made.push(w); return w; });
    await reg.add(account);
    await reg.add({ ...account, label: 'Personal' });
    await reg.stopAll();
    expect(made.every((w) => w.stopped === 1)).toBe(true);
    expect(reg.size()).toBe(0);
  });

  it('stopAll does not let one failing stop prevent the others', async () => {
    let stopped = 0;
    const reg = new WatcherRegistry((a) => ({
      label: a.label,
      state: 'ok' as WatcherState,
      async start() {},
      async stop() {
        if (a.label === 'Bad') throw new Error('nope');
        stopped += 1;
      },
    }));
    await reg.add({ ...account, label: 'Bad' });
    await reg.add({ ...account, label: 'Good' });
    await reg.stopAll();
    expect(stopped).toBe(1);
    expect(reg.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/registry.test.ts`
Expected: FAIL — cannot resolve `../src/imap/registry.js`.

- [ ] **Step 3: Implement `src/imap/registry.ts`**

```ts
import type { WatcherState } from './watcher.js';
import type { Account } from '../types.js';

/** The structural subset of AccountWatcher the registry needs. */
export type ManagedWatcher = {
  readonly label: string;
  readonly state: WatcherState;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type WatcherFactory = (account: Account) => ManagedWatcher;

/**
 * Owns the live set of watchers, one per mailbox, so mailboxes can be
 * added and removed at runtime without restarting the process.
 */
export class WatcherRegistry {
  readonly #factory: WatcherFactory;
  readonly #watchers = new Map<string, ManagedWatcher>();

  constructor(factory: WatcherFactory) {
    this.#factory = factory;
  }

  async add(account: Account): Promise<void> {
    if (this.#watchers.has(account.label)) {
      throw new Error(`a watcher for "${account.label}" is already running`);
    }
    const watcher = this.#factory(account);
    // Register only after a successful start, so a failed start cannot
    // leave a dead entry that blocks a later retry with the same label.
    await watcher.start();
    this.#watchers.set(account.label, watcher);
  }

  async remove(label: string): Promise<boolean> {
    const watcher = this.#watchers.get(label);
    if (watcher === undefined) return false;
    // Deregister regardless of whether stop() succeeds: a watcher we can no
    // longer stop cleanly must still not be treated as live.
    this.#watchers.delete(label);
    try {
      await watcher.stop();
    } catch (err) {
      console.error(`[${label}] failed to stop cleanly: ${errorText(err)}`);
    }
    return true;
  }

  has(label: string): boolean {
    return this.#watchers.has(label);
  }

  size(): number {
    return this.#watchers.size;
  }

  states(): { label: string; state: WatcherState }[] {
    return [...this.#watchers.values()].map((w) => ({ label: w.label, state: w.state }));
  }

  async stopAll(): Promise<void> {
    const watchers = [...this.#watchers.values()];
    this.#watchers.clear();
    const results = await Promise.allSettled(watchers.map((w) => w.stop()));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(
          `[${watchers[i]?.label ?? '?'}] failed to stop cleanly: ${errorText(result.reason)}`
        );
      }
    });
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/registry.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/imap/registry.ts test/registry.test.ts
git commit -m "feat: watcher registry for runtime mailbox add/remove"
```

---

### Task 4: IMAP credential probe

**Files:**
- Create: `src/imap/probe.ts`
- Test: `test/probe.test.ts`

**Interfaces:**
- Consumes: `createClient`, `isAuthError` from `src/imap/client.js`; `Account` from `src/types.js`.
- Produces:
  - `type ProbeResult = { ok: true; folders: number } | { ok: false; reason: string }`
  - `type ProbeDeps = { connect(account: Account): Promise<{ list(): Promise<unknown[]>; logout(): Promise<void> }> }`
  - `function probeMailbox(account: Account, deps?: ProbeDeps): Promise<ProbeResult>`

- [ ] **Step 1: Write the failing test**

Create `test/probe.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { probeMailbox } from '../src/imap/probe.js';
import type { Account } from '../src/types.js';

const account: Account = {
  label: 'Work', host: 'h', port: 993, user: 'u', pass: 'sup3rs3cret', secure: true,
};

describe('probeMailbox', () => {
  it('reports success with a folder count', async () => {
    const logout = vi.fn(async () => {});
    const result = await probeMailbox(account, {
      connect: async () => ({ list: async () => [{}, {}, {}], logout }),
    });
    expect(result).toEqual({ ok: true, folders: 3 });
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('reports failure when connecting throws', async () => {
    const result = await probeMailbox(account, {
      connect: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('ECONNREFUSED') });
  });

  it('never leaks the password into the failure reason', async () => {
    const result = await probeMailbox(account, {
      connect: async () => { throw new Error('login failed for u with sup3rs3cret'); },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain('sup3rs3cret');
      expect(result.reason).toContain('***');
    }
  });

  it('logs out even when list() throws', async () => {
    const logout = vi.fn(async () => {});
    const result = await probeMailbox(account, {
      connect: async () => ({ list: async () => { throw new Error('NO permission'); }, logout }),
    });
    expect(result.ok).toBe(false);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('does not fail the probe when logout throws', async () => {
    const result = await probeMailbox(account, {
      connect: async () => ({
        list: async () => [{}],
        logout: async () => { throw new Error('already closed'); },
      }),
    });
    expect(result).toEqual({ ok: true, folders: 1 });
  });

  it('handles a non-Error throwable', async () => {
    const result = await probeMailbox(account, {
      connect: async () => { throw 'plain string'; },
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/probe.test.ts`
Expected: FAIL — cannot resolve `../src/imap/probe.js`.

- [ ] **Step 3: Implement `src/imap/probe.ts`**

```ts
import { createClient } from './client.js';
import type { Account } from '../types.js';

export type ProbeResult = { ok: true; folders: number } | { ok: false; reason: string };

type ProbeConnection = {
  list(): Promise<unknown[]>;
  logout(): Promise<void>;
};

export type ProbeDeps = {
  connect(account: Account): Promise<ProbeConnection>;
};

const realDeps: ProbeDeps = {
  async connect(account) {
    const client = createClient(account);
    await client.connect();
    return {
      list: () => client.list() as unknown as Promise<unknown[]>,
      logout: () => client.logout(),
    };
  },
};

/**
 * Redacts the password from any text before it reaches a log or a bot
 * reply. IMAP servers and libraries sometimes echo the credentials they
 * were given, so scrubbing at the boundary is the only reliable place.
 */
function scrub(text: string, secret: string): string {
  if (secret.length === 0) return text;
  return text.split(secret).join('***');
}

/**
 * Attempts a real login and folder listing without saving anything.
 * Used by /add before persisting, and by /test on an existing mailbox.
 */
export async function probeMailbox(
  account: Account,
  deps: ProbeDeps = realDeps
): Promise<ProbeResult> {
  let connection: ProbeConnection | null = null;
  try {
    connection = await deps.connect(account);
    const folders = await connection.list();
    return { ok: true, folders: folders.length };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: scrub(raw, account.pass) };
  } finally {
    if (connection !== null) {
      await connection.logout().catch(() => undefined);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/probe.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/imap/probe.ts test/probe.test.ts
git commit -m "feat: IMAP credential probe with password scrubbing"
```

---

### Task 5: Conversation state

**Files:**
- Create: `src/telegram/conversation.ts`
- Test: `test/conversation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Pending = { kind: 'password'; label: string; host: string; port: number; username: string; expiresAt: number } | { kind: 'remove-confirm'; label: string; expiresAt: number }`
  - `const PASSWORD_TTL_MS = 5 * 60_000`, `const CONFIRM_TTL_MS = 60_000`
  - `class Conversations` with `set(chatId: number, pending: Pending): void`, `take(chatId: number, now: number): Pending | null`, `clear(chatId: number): void`, `size(): number`

`take` both reads and clears, so a pending entry is single-use.

- [ ] **Step 1: Write the failing test**

Create `test/conversation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Conversations, PASSWORD_TTL_MS, type Pending } from '../src/telegram/conversation.js';

const NOW = 1_000_000;

function pwPending(expiresAt = NOW + PASSWORD_TTL_MS): Pending {
  return { kind: 'password', label: 'Work', host: 'h', port: 993, username: 'u', expiresAt };
}

describe('Conversations', () => {
  it('returns null when nothing is pending', () => {
    expect(new Conversations().take(1, NOW)).toBeNull();
  });

  it('returns a pending entry that has not expired', () => {
    const c = new Conversations();
    c.set(1, pwPending());
    expect(c.take(1, NOW)).toMatchObject({ kind: 'password', label: 'Work' });
  });

  it('is single-use — a second take returns null', () => {
    const c = new Conversations();
    c.set(1, pwPending());
    c.take(1, NOW);
    expect(c.take(1, NOW)).toBeNull();
  });

  it('returns null once expired, and does not resurrect later', () => {
    const c = new Conversations();
    c.set(1, pwPending(NOW - 1));
    expect(c.take(1, NOW)).toBeNull();
    expect(c.take(1, NOW)).toBeNull();
  });

  it('treats an entry expiring exactly now as expired', () => {
    const c = new Conversations();
    c.set(1, pwPending(NOW));
    expect(c.take(1, NOW)).toBeNull();
  });

  it('keeps chats independent', () => {
    const c = new Conversations();
    c.set(1, pwPending());
    expect(c.take(2, NOW)).toBeNull();
    expect(c.take(1, NOW)).not.toBeNull();
  });

  it('replaces a pending entry when a new one is set', () => {
    const c = new Conversations();
    c.set(1, pwPending());
    c.set(1, { kind: 'remove-confirm', label: 'Personal', expiresAt: NOW + 1000 });
    expect(c.take(1, NOW)).toMatchObject({ kind: 'remove-confirm', label: 'Personal' });
    expect(c.size()).toBe(0);
  });

  it('clear removes a pending entry', () => {
    const c = new Conversations();
    c.set(1, pwPending());
    c.clear(1);
    expect(c.take(1, NOW)).toBeNull();
  });

  it('drops the entry from storage when it expires, rather than leaking', () => {
    const c = new Conversations();
    c.set(1, pwPending(NOW - 1));
    c.take(1, NOW);
    expect(c.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/conversation.test.ts`
Expected: FAIL — cannot resolve `../src/telegram/conversation.js`.

- [ ] **Step 3: Implement `src/telegram/conversation.ts`**

```ts
/** How long a pending /add password prompt stays valid. */
export const PASSWORD_TTL_MS = 5 * 60_000;
/** How long a pending /remove confirmation stays valid. */
export const CONFIRM_TTL_MS = 60_000;

export type Pending =
  | {
      kind: 'password';
      label: string;
      host: string;
      port: number;
      username: string;
      expiresAt: number;
    }
  | { kind: 'remove-confirm'; label: string; expiresAt: number };

/**
 * In-memory, single-use state for multi-step commands.
 *
 * Expiry is essential, not tidiness: without it an abandoned /add would
 * make the bot treat an unrelated message sent an hour later as a
 * password, and then attempt an IMAP login with it.
 */
export class Conversations {
  readonly #pending = new Map<number, Pending>();

  set(chatId: number, pending: Pending): void {
    this.#pending.set(chatId, pending);
  }

  /** Returns the pending entry and clears it. Null if absent or expired. */
  take(chatId: number, now: number): Pending | null {
    const entry = this.#pending.get(chatId);
    if (entry === undefined) return null;
    this.#pending.delete(chatId);
    if (entry.expiresAt <= now) return null;
    return entry;
  }

  clear(chatId: number): void {
    this.#pending.delete(chatId);
  }

  size(): number {
    return this.#pending.size;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/conversation.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/conversation.ts test/conversation.test.ts
git commit -m "feat: expiring conversation state for multi-step commands"
```

---

### Task 6: Telegram receiver

**Files:**
- Create: `src/telegram/receiver.ts`
- Test: `test/receiver.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TelegramMessage = { message_id: number; chat: { id: number }; text?: string }`
  - `type TelegramUpdate = { update_id: number; message?: TelegramMessage }`
  - `type ReceiverOptions = { token: string; onUpdate: (u: TelegramUpdate) => Promise<void>; signal: AbortSignal; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; pollTimeoutSeconds?: number }`
  - `function runReceiver(opts: ReceiverOptions): Promise<void>` — resolves when the signal aborts
  - `class FatalTelegramError extends Error`

- [ ] **Step 1: Write the failing test**

Create `test/receiver.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runReceiver, FatalTelegramError, type TelegramUpdate } from '../src/telegram/receiver.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okUpdates = (result: TelegramUpdate[]) => jsonResponse(200, { ok: true, result });

function update(id: number, text: string, chatId = 42): TelegramUpdate {
  return { update_id: id, message: { message_id: id * 10, chat: { id: chatId }, text } };
}

/** Runs the receiver, aborting once `calls` fetches have happened. */
function runUntil(fetchImpl: typeof fetch, calls: number, onUpdate: (u: TelegramUpdate) => Promise<void>) {
  const controller = new AbortController();
  let seen = 0;
  const counting = (async (...args: Parameters<typeof fetch>) => {
    seen += 1;
    const res = await (fetchImpl as (...a: Parameters<typeof fetch>) => Promise<Response>)(...args);
    if (seen >= calls) controller.abort();
    return res;
  }) as unknown as typeof fetch;
  return runReceiver({
    token: 'T',
    onUpdate,
    signal: controller.signal,
    fetchImpl: counting,
    sleep: async () => {},
  });
}

describe('runReceiver', () => {
  it('deletes any webhook before polling', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return url.includes('deleteWebhook') ? jsonResponse(200, { ok: true }) : okUpdates([]);
    }) as unknown as typeof fetch;

    await runUntil(fetchImpl, 2, async () => {});
    expect(urls[0]).toContain('/deleteWebhook');
    expect(urls[1]).toContain('/getUpdates');
  });

  it('passes each update to onUpdate', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) =>
      url.includes('deleteWebhook')
        ? jsonResponse(200, { ok: true })
        : okUpdates([update(1, '/list'), update(2, '/status')])) as unknown as typeof fetch;

    await runUntil(fetchImpl, 2, async (u) => { seen.push(u.message?.text ?? ''); });
    expect(seen).toEqual(['/list', '/status']);
  });

  it('advances the offset past the highest handled update_id', async () => {
    const urls: string[] = [];
    let poll = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes('deleteWebhook')) return jsonResponse(200, { ok: true });
      urls.push(url);
      poll += 1;
      return okUpdates(poll === 1 ? [update(7, '/list')] : []);
    }) as unknown as typeof fetch;

    await runUntil(fetchImpl, 3, async () => {});
    expect(urls[0]).toContain('offset=0');
    expect(urls[1]).toContain('offset=8');
  });

  it('still advances the offset when a handler throws, so one bad update cannot replay forever', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      if (url.includes('deleteWebhook')) return jsonResponse(200, { ok: true });
      urls.push(url);
      return okUpdates([update(7, '/boom')]);
    }) as unknown as typeof fetch;

    await runUntil(fetchImpl, 3, async () => { throw new Error('handler exploded'); });
    expect(urls[1]).toContain('offset=8');
  });

  it('retries after a network error instead of exiting', async () => {
    let poll = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes('deleteWebhook')) return jsonResponse(200, { ok: true });
      poll += 1;
      if (poll === 1) throw new Error('ECONNRESET');
      return okUpdates([]);
    }) as unknown as typeof fetch;

    await expect(runUntil(fetchImpl, 3, async () => {})).resolves.toBeUndefined();
    expect(poll).toBeGreaterThanOrEqual(2);
  });

  it('calls deleteWebhook again on 409 Conflict', async () => {
    const urls: string[] = [];
    let poll = 0;
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.includes('deleteWebhook')) return jsonResponse(200, { ok: true });
      poll += 1;
      return poll === 1 ? jsonResponse(409, { ok: false }) : okUpdates([]);
    }) as unknown as typeof fetch;

    await runUntil(fetchImpl, 4, async () => {});
    expect(urls.filter((u) => u.includes('deleteWebhook')).length).toBeGreaterThanOrEqual(2);
  });

  it('throws FatalTelegramError on 401 rather than retrying forever', async () => {
    const fetchImpl = (async (url: string) =>
      url.includes('deleteWebhook')
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, { ok: false, description: 'Unauthorized' })) as unknown as typeof fetch;

    const controller = new AbortController();
    await expect(
      runReceiver({
        token: 'T', onUpdate: async () => {}, signal: controller.signal,
        fetchImpl, sleep: async () => {},
      })
    ).rejects.toBeInstanceOf(FatalTelegramError);
  });

  it('resolves promptly when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => okUpdates([]));
    await runReceiver({
      token: 'T', onUpdate: async () => {}, signal: controller.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {},
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never puts the bot token in a thrown error message', async () => {
    const fetchImpl = (async (url: string) =>
      url.includes('deleteWebhook')
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, { ok: false })) as unknown as typeof fetch;

    const controller = new AbortController();
    await expect(
      runReceiver({
        token: 'SUPERSECRETTOKEN', onUpdate: async () => {}, signal: controller.signal,
        fetchImpl, sleep: async () => {},
      })
    ).rejects.toThrow(expect.not.stringContaining('SUPERSECRETTOKEN') as unknown as string);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/receiver.test.ts`
Expected: FAIL — cannot resolve `../src/telegram/receiver.js`.

- [ ] **Step 3: Implement `src/telegram/receiver.ts`**

```ts
export type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  text?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type ReceiverOptions = {
  token: string;
  onUpdate: (update: TelegramUpdate) => Promise<void>;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollTimeoutSeconds?: number;
};

/** Thrown for conditions retrying cannot fix, such as a bad bot token. */
export class FatalTelegramError extends Error {}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_BACKOFF_MS = 60_000;

/**
 * Long-polls getUpdates until the signal aborts.
 *
 * Long-polling rather than a webhook because the container deliberately has
 * no public domain. deleteWebhook runs first: a webhook and getUpdates are
 * mutually exclusive, so a stale webhook would silently swallow every update.
 */
export async function runReceiver(opts: ReceiverOptions): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const pollTimeout = opts.pollTimeoutSeconds ?? 30;
  const base = `https://api.telegram.org/bot${opts.token}`;

  let offset = 0;
  let failures = 0;

  const dropWebhook = async (): Promise<void> => {
    await doFetch(`${base}/deleteWebhook`, { method: 'POST' }).catch(() => undefined);
  };

  if (opts.signal.aborted) return;
  await dropWebhook();

  while (!opts.signal.aborted) {
    let res: Response;
    try {
      res = await doFetch(`${base}/getUpdates?offset=${offset}&timeout=${pollTimeout}`, {
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal.aborted) return;
      failures += 1;
      console.error(`[telegram] poll failed: ${errorText(err)}`);
      await sleep(Math.min(2 ** failures * 500, MAX_BACKOFF_MS));
      continue;
    }

    if (res.status === 401) {
      // The token is wrong. Retrying cannot fix it, and hammering a bad
      // token is exactly what gets a bot rate-limited.
      throw new FatalTelegramError('Telegram rejected the bot token (401 Unauthorized)');
    }

    if (res.status === 409) {
      // A webhook was registered behind our back; they are mutually exclusive.
      console.error('[telegram] 409 conflict; removing webhook and resuming');
      await dropWebhook();
      continue;
    }

    if (!res.ok) {
      failures += 1;
      await sleep(Math.min(2 ** failures * 500, MAX_BACKOFF_MS));
      continue;
    }

    failures = 0;
    const payload = (await res.json().catch(() => ({ result: [] }))) as {
      result?: TelegramUpdate[];
    };
    const updates = payload.result ?? [];

    for (const update of updates) {
      // Advance past this update BEFORE handling it. A handler that throws
      // must not make the same update replay forever — the command handler
      // is responsible for reporting its own failures.
      offset = Math.max(offset, update.update_id + 1);
      try {
        await opts.onUpdate(update);
      } catch (err) {
        console.error(`[telegram] handler failed: ${errorText(err)}`);
      }
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/receiver.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/receiver.ts test/receiver.test.ts
git commit -m "feat: long-polling Telegram receiver with webhook clearing and backoff"
```

---

### Task 7: Command router

**Files:**
- Create: `src/telegram/commands.ts`
- Test: `test/commands.test.ts`

**Interfaces:**
- Consumes: `TelegramUpdate` from `src/telegram/receiver.js`; `Conversations`, `PASSWORD_TTL_MS`, `CONFIRM_TTL_MS` from `src/telegram/conversation.js`; `MailboxStore` from `src/store/mailboxes.js`; `SeenStore` from `src/store/seen.js`; `WatcherRegistry` from `src/imap/registry.js`; `probeMailbox`, `ProbeResult` from `src/imap/probe.js`; `Account` from `src/types.js`.
- Produces:
  - `type CommandDeps = { operatorChatId: string; mailboxes: MailboxStore; seen: Pick<SeenStore, 'purgeAccount'>; registry: WatcherRegistry; conversations: Conversations; probe: (a: Account) => Promise<ProbeResult>; reply: (text: string) => Promise<void>; deleteMessage: (messageId: number) => Promise<boolean>; now: () => number }`
  - `function handleUpdate(update: TelegramUpdate, deps: CommandDeps): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `test/commands.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleUpdate, type CommandDeps } from '../src/telegram/commands.js';
import { Conversations } from '../src/telegram/conversation.js';
import type { TelegramUpdate } from '../src/telegram/receiver.js';
import type { Account } from '../src/types.js';

const OPERATOR = 42;
const NOW = 1_000_000;

function msg(text: string, chatId = OPERATOR, messageId = 1): TelegramUpdate {
  return { update_id: 1, message: { message_id: messageId, chat: { id: chatId }, text } };
}

function makeDeps(overrides: Partial<CommandDeps> = {}) {
  const stored = new Map<string, Account>();
  const running = new Set<string>();
  const replies: string[] = [];
  const deleted: number[] = [];

  const deps: CommandDeps = {
    operatorChatId: String(OPERATOR),
    mailboxes: {
      add: (a: Account) => {
        if (stored.has(a.label)) throw new Error(`a mailbox labelled "${a.label}" already exists`);
        stored.set(a.label, a);
      },
      list: () => [...stored.values()].map((a) => ({
        label: a.label, host: a.host, port: a.port, username: a.user,
      })),
      get: (l: string) => stored.get(l) ?? null,
      remove: (l: string) => stored.delete(l),
    } as unknown as CommandDeps['mailboxes'],
    seen: { purgeAccount: vi.fn(() => 3) },
    registry: {
      add: async (a: Account) => { running.add(a.label); },
      remove: async (l: string) => running.delete(l),
      has: (l: string) => running.has(l),
      states: () => [...running].map((l) => ({ label: l, state: 'ok' as const })),
      size: () => running.size,
    } as unknown as CommandDeps['registry'],
    conversations: new Conversations(),
    probe: async () => ({ ok: true, folders: 5 }),
    reply: async (t: string) => { replies.push(t); },
    deleteMessage: async (id: number) => { deleted.push(id); return true; },
    now: () => NOW,
    ...overrides,
  };
  return { deps, replies, deleted, stored, running };
}

describe('authorization', () => {
  it('ignores messages from any other chat entirely', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/list', 999), deps);
    expect(replies).toEqual([]);
  });

  it('ignores an unauthorized chat even for an unknown command', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('anything at all', 999), deps);
    expect(replies).toEqual([]);
  });

  it('ignores updates with no message', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate({ update_id: 1 }, deps);
    expect(replies).toEqual([]);
  });
});

describe('/add', () => {
  it('asks for the password and does not save yet', async () => {
    const { deps, replies, stored } = makeDeps();
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    expect(replies[0]).toMatch(/password/i);
    expect(stored.size).toBe(0);
  });

  it('rejects wrong argument counts with usage', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/add Work imap.example.com'), deps);
    expect(replies[0]).toMatch(/usage/i);
  });

  it('rejects a non-numeric port', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/add Work imap.example.com notaport me@example.com'), deps);
    expect(replies[0]).toMatch(/port/i);
  });

  it('rejects a duplicate label before prompting for a password', async () => {
    const { deps, replies } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    expect(replies[0]).toMatch(/already exists/i);
  });

  it('deletes the password message, probes, saves and starts the watcher', async () => {
    const { deps, replies, deleted, stored, running } = makeDeps();
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('s3cret', OPERATOR, 77), deps);

    expect(deleted).toContain(77);
    expect(stored.get('Work')?.pass).toBe('s3cret');
    expect(running.has('Work')).toBe(true);
    expect(replies.at(-1)).toMatch(/5 folders/i);
  });

  it('does not save when the probe fails', async () => {
    const { deps, replies, stored, running } = makeDeps({
      probe: async () => ({ ok: false, reason: 'AUTHENTICATIONFAILED' }),
    });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('wrong-pw', OPERATOR, 78), deps);

    expect(stored.size).toBe(0);
    expect(running.size).toBe(0);
    expect(replies.at(-1)).toMatch(/AUTHENTICATIONFAILED/);
  });

  it('warns when the password message could not be deleted', async () => {
    const { deps, replies } = makeDeps({ deleteMessage: async () => false });
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('s3cret', OPERATOR, 79), deps);
    expect(replies.some((r) => /could not delete/i.test(r))).toBe(true);
  });

  it('never echoes the password back', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/add Work imap.example.com 993 me@example.com'), deps);
    await handleUpdate(msg('s3cret', OPERATOR, 80), deps);
    expect(replies.join('\n')).not.toContain('s3cret');
  });

  it('ignores a bare message when nothing is pending', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('just chatting'), deps);
    expect(replies[0]).toMatch(/unknown command|usage/i);
  });
});

describe('/list', () => {
  it('reports emptiness clearly', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/list'), deps);
    expect(replies[0]).toMatch(/no mailboxes/i);
  });

  it('masks the password', async () => {
    const { deps, replies } = makeDeps();
    deps.mailboxes.add({
      label: 'Work', host: 'imap.example.com', port: 993,
      user: 'me@example.com', pass: 'hunter2', secure: true,
    });
    await handleUpdate(msg('/list'), deps);
    expect(replies[0]).toContain('Work');
    expect(replies[0]).toContain('me@example.com');
    expect(replies[0]).not.toContain('hunter2');
    expect(replies[0]).toContain('••••••••');
  });
});

describe('/remove', () => {
  it('asks for confirmation and does not delete yet', async () => {
    const { deps, replies, stored } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/remove Work'), deps);
    expect(replies[0]).toMatch(/yes/i);
    expect(stored.size).toBe(1);
  });

  it('deletes the mailbox, stops the watcher and purges state on yes', async () => {
    const { deps, replies, stored, running } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/remove Work'), deps);
    await handleUpdate(msg('yes'), deps);

    expect(stored.size).toBe(0);
    expect(running.has('Work')).toBe(false);
    expect(deps.seen.purgeAccount).toHaveBeenCalledWith('Work');
    expect(replies.at(-1)).toMatch(/removed/i);
  });

  it('cancels on any other reply', async () => {
    const { deps, replies, stored } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/remove Work'), deps);
    await handleUpdate(msg('no'), deps);
    expect(stored.size).toBe(1);
    expect(replies.at(-1)).toMatch(/cancel/i);
  });

  it('reports an unknown label', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/remove Ghost'), deps);
    expect(replies[0]).toMatch(/no mailbox/i);
  });
});

describe('/status and /test', () => {
  it('reports idle when nothing is configured', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/status'), deps);
    expect(replies[0]).toMatch(/no mailboxes/i);
  });

  it('reports each watcher state', async () => {
    const { deps, replies } = makeDeps();
    await deps.registry.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/status'), deps);
    expect(replies[0]).toContain('Work');
    expect(replies[0]).toContain('ok');
  });

  it('/test reports success for a saved mailbox', async () => {
    const { deps, replies } = makeDeps();
    deps.mailboxes.add({ label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true });
    await handleUpdate(msg('/test Work'), deps);
    expect(replies[0]).toMatch(/5 folders/i);
  });

  it('/test reports an unknown label', async () => {
    const { deps, replies } = makeDeps();
    await handleUpdate(msg('/test Ghost'), deps);
    expect(replies[0]).toMatch(/no mailbox/i);
  });

  it('/test never leaks the password on failure', async () => {
    const { deps, replies } = makeDeps({
      probe: async () => ({ ok: false, reason: 'login failed' }),
    });
    deps.mailboxes.add({
      label: 'Work', host: 'h', port: 993, user: 'u', pass: 'topsecret', secure: true,
    });
    await handleUpdate(msg('/test Work'), deps);
    expect(replies[0]).not.toContain('topsecret');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/commands.test.ts`
Expected: FAIL — cannot resolve `../src/telegram/commands.js`.

- [ ] **Step 3: Implement `src/telegram/commands.ts`**

```ts
import { CONFIRM_TTL_MS, PASSWORD_TTL_MS, type Conversations } from './conversation.js';
import type { TelegramUpdate } from './receiver.js';
import type { MailboxStore } from '../store/mailboxes.js';
import type { SeenStore } from '../store/seen.js';
import type { WatcherRegistry } from '../imap/registry.js';
import type { ProbeResult } from '../imap/probe.js';
import type { Account } from '../types.js';

export type CommandDeps = {
  operatorChatId: string;
  mailboxes: MailboxStore;
  seen: Pick<SeenStore, 'purgeAccount'>;
  registry: WatcherRegistry;
  conversations: Conversations;
  probe: (account: Account) => Promise<ProbeResult>;
  reply: (text: string) => Promise<void>;
  deleteMessage: (messageId: number) => Promise<boolean>;
  now: () => number;
};

const USAGE = [
  'Commands:',
  '/add <label> <host> <port> <username> — add a mailbox',
  '/list — list configured mailboxes',
  '/remove <label> — remove a mailbox',
  '/status — connection state per mailbox',
  '/test <label> — re-test a saved mailbox',
].join('\n');

/**
 * Entry point for every Telegram update.
 *
 * The chat-ID gate runs before ANY parsing, and an unauthorized chat gets
 * no reply at all — replying would confirm to a prober that the bot is live.
 */
export async function handleUpdate(update: TelegramUpdate, deps: CommandDeps): Promise<void> {
  const message = update.message;
  if (message === undefined) return;
  if (String(message.chat.id) !== deps.operatorChatId) return;

  const text = (message.text ?? '').trim();
  if (text.length === 0) return;

  const pending = deps.conversations.take(message.chat.id, deps.now());
  if (pending !== null && !text.startsWith('/')) {
    if (pending.kind === 'password') {
      await completeAdd(pending, text, message.message_id, deps);
    } else {
      await completeRemove(pending.label, text, deps);
    }
    return;
  }

  const [command, ...args] = text.split(/\s+/);
  switch (command) {
    case '/add':
      return startAdd(args, deps);
    case '/list':
      return listMailboxes(deps);
    case '/remove':
      return startRemove(args, deps);
    case '/status':
      return showStatus(deps);
    case '/test':
      return testMailbox(args, deps);
    case '/start':
    case '/help':
      return deps.reply(USAGE);
    default:
      return deps.reply(`Unknown command.\n\n${USAGE}`);
  }
}

async function startAdd(args: string[], deps: CommandDeps): Promise<void> {
  if (args.length !== 4) {
    return deps.reply(`Usage: /add <label> <host> <port> <username>`);
  }
  const [label, host, portText, username] = args as [string, string, string, string];
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return deps.reply(`Invalid port "${portText}" — expected a number between 1 and 65535.`);
  }
  if (deps.mailboxes.get(label) !== null) {
    return deps.reply(`A mailbox labelled "${label}" already exists. Remove it first.`);
  }

  deps.conversations.set(Number(deps.operatorChatId), {
    kind: 'password',
    label,
    host,
    port,
    username,
    expiresAt: deps.now() + PASSWORD_TTL_MS,
  });

  return deps.reply(
    `Now send the password for ${username} as your next message.\n` +
      `I'll delete it as soon as I've read it. This prompt expires in 5 minutes.`
  );
}

async function completeAdd(
  pending: { label: string; host: string; port: number; username: string },
  password: string,
  messageId: number,
  deps: CommandDeps
): Promise<void> {
  const deleted = await deps.deleteMessage(messageId).catch(() => false);
  if (!deleted) {
    await deps.reply(
      'Warning: I could not delete your password message. Please delete it manually.'
    );
  }

  const account: Account = {
    label: pending.label,
    host: pending.host,
    port: pending.port,
    user: pending.username,
    pass: password,
    secure: true,
  };

  const result = await deps.probe(account);
  if (!result.ok) {
    return deps.reply(`Could not connect, so nothing was saved.\n\n${result.reason}`);
  }

  try {
    deps.mailboxes.add(account);
    await deps.registry.add(account);
  } catch (err) {
    return deps.reply(`Failed to save: ${errorText(err)}`);
  }

  return deps.reply(
    `Connected — ${result.folders} folders. Saved "${account.label}" and now watching it.\n` +
      `The first sweep records a baseline, so you'll be notified from the next email onward.`
  );
}

async function listMailboxes(deps: CommandDeps): Promise<void> {
  const boxes = deps.mailboxes.list();
  if (boxes.length === 0) {
    return deps.reply('No mailboxes configured. Add one with /add.');
  }
  const lines = boxes.map(
    (b) => `• ${b.label} — ${b.username} @ ${b.host}:${b.port} — ••••••••`
  );
  return deps.reply(`Configured mailboxes:\n${lines.join('\n')}`);
}

async function startRemove(args: string[], deps: CommandDeps): Promise<void> {
  const label = args[0];
  if (label === undefined) return deps.reply('Usage: /remove <label>');
  if (deps.mailboxes.get(label) === null) {
    return deps.reply(`No mailbox labelled "${label}".`);
  }
  deps.conversations.set(Number(deps.operatorChatId), {
    kind: 'remove-confirm',
    label,
    expiresAt: deps.now() + CONFIRM_TTL_MS,
  });
  return deps.reply(
    `Remove "${label}"? This deletes its credentials and its notification history, ` +
      `so re-adding it later starts from a fresh baseline.\n\n` +
      `Reply "yes" within 60 seconds to confirm.`
  );
}

async function completeRemove(label: string, answer: string, deps: CommandDeps): Promise<void> {
  if (answer.toLowerCase() !== 'yes') {
    return deps.reply(`Cancelled. "${label}" was not removed.`);
  }
  await deps.registry.remove(label);
  deps.mailboxes.remove(label);
  deps.seen.purgeAccount(label);
  return deps.reply(`Removed "${label}" and stopped watching it.`);
}

async function showStatus(deps: CommandDeps): Promise<void> {
  const states = deps.registry.states();
  if (states.length === 0) {
    return deps.reply('No mailboxes are being watched. Add one with /add.');
  }
  const lines = states.map((s) => `• ${s.label} — ${s.state}`);
  return deps.reply(`Watcher status:\n${lines.join('\n')}`);
}

async function testMailbox(args: string[], deps: CommandDeps): Promise<void> {
  const label = args[0];
  if (label === undefined) return deps.reply('Usage: /test <label>');
  const account = deps.mailboxes.get(label);
  if (account === null) return deps.reply(`No mailbox labelled "${label}".`);

  const result = await deps.probe(account);
  return result.ok
    ? deps.reply(`"${label}" connected — ${result.folders} folders.`)
    : deps.reply(`"${label}" failed to connect.\n\n${result.reason}`);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/commands.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/commands.ts test/commands.test.ts
git commit -m "feat: Telegram command router with operator-only gate"
```

---

### Task 8: Wire it together

**Files:**
- Modify: `src/index.ts`, `src/health.ts`
- Modify: `src/telegram/sender.ts` (add `deleteMessage`)
- Test: `test/health.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces:
  - `TelegramSender` gains `deleteMessage(chatId: string, messageId: number): Promise<boolean>`
  - `buildHealthReport` returns `status: 'ok'` with `accounts: []` when there are no watchers.

- [ ] **Step 1: Update the health report for the idle case**

In `src/health.ts`, change the healthy predicate so zero watchers is healthy:

```ts
export function buildHealthReport(
  watchers: { label: string; state: WatcherState }[]
): HealthReport {
  // Zero watchers is the normal state of a fresh install: mailboxes are
  // added at runtime via Telegram, so an empty set is idle, not unhealthy.
  const healthy = watchers.every((w) => w.state === 'ok');
  return {
    status: healthy ? 'ok' : 'degraded',
    accounts: watchers.map((w) => ({ label: w.label, state: w.state })),
  };
}
```

- [ ] **Step 2: Update the health tests**

In `test/health.test.ts`, replace the "reports degraded with no accounts at all" test:

```ts
  it('reports ok when no mailboxes are configured yet (idle, not unhealthy)', () => {
    const report = buildHealthReport([]);
    expect(report.status).toBe('ok');
    expect(report.accounts).toEqual([]);
  });
```

- [ ] **Step 3: Run the health tests**

Run: `npx vitest run test/health.test.ts`
Expected: PASS.

- [ ] **Step 4: Add `deleteMessage` to `TelegramSender`**

First introduce a base-URL field so both endpoints derive from one place. Deriving
`/deleteMessage` by string-replacing `/sendMessage` in the existing URL would work but is
fragile and reads as a hack. In `src/telegram/sender.ts`, replace the `#url` field and its
assignment:

```ts
  readonly #baseUrl: string;
```

```ts
    this.#baseUrl = `https://api.telegram.org/bot${opts.token}`;
```

Update the single existing use in `#post` from `this.#url` to
`` `${this.#baseUrl}/sendMessage` ``. Then append this method to the class:

```ts
  /**
   * Deletes a message in the operator's chat. Used to remove a password
   * the operator typed. Returns false rather than throwing — the caller
   * warns the operator to delete it manually.
   */
  async deleteMessage(chatId: string, messageId: number): Promise<boolean> {
    try {
      const res = await this.#fetch(`${this.#baseUrl}/deleteMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
```

The existing sender test asserting the posted URL is
`https://api.telegram.org/botT/sendMessage` must still pass unchanged — that is the
regression check that this refactor did not alter the send path.

- [ ] **Step 5: Add a test for `deleteMessage`**

Append to `test/sender.test.ts`:

```ts
describe('deleteMessage', () => {
  it('posts to deleteMessage and reports success', async () => {
    const calls: string[] = [];
    const sender = makeSender((async (url: string) => {
      calls.push(url);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch);

    expect(await sender.deleteMessage('42', 7)).toBe(true);
    expect(calls[0]).toContain('/deleteMessage');
    expect(calls[0]).not.toContain('/sendMessage');
  });

  it('reports false rather than throwing when Telegram refuses', async () => {
    const sender = makeSender(
      (async () => jsonResponse(400, { ok: false })) as unknown as typeof fetch
    );
    expect(await sender.deleteMessage('42', 7)).toBe(false);
  });

  it('reports false rather than throwing on a network error', async () => {
    const sender = makeSender((async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch);
    expect(await sender.deleteMessage('42', 7)).toBe(false);
  });
});
```

- [ ] **Step 6: Rewrite `main()` in `src/index.ts`**

Replace the mailbox-from-config wiring with store-backed wiring. Keep `createEmailHandler`, `shutdown`, `armPruneTimer`, and `toSafeLogger` exactly as they are.

`AbortController` is a global in Node 22 — do not import it. Add these imports:

```ts
import { deriveKey } from './crypto/secret.js';
import { MailboxStore } from './store/mailboxes.js';
import { WatcherRegistry } from './imap/registry.js';
import { probeMailbox } from './imap/probe.js';
import { Conversations } from './telegram/conversation.js';
import { runReceiver, FatalTelegramError } from './telegram/receiver.js';
import { handleUpdate } from './telegram/commands.js';
```

Then, inside `main()`, after the store and sender are constructed:

```ts
  const key = deriveKey(config.masterKey);
  const mailboxes = new MailboxStore(config.dbPath, key);

  const registry = new WatcherRegistry((account) =>
    new AccountWatcher({
      account,
      store,
      previewChars: config.previewChars,
      sweepIntervalSeconds: config.sweepIntervalSeconds,
      onEmail,
      onFatal,
    })
  );

  // Restore whatever was configured before the last restart. A mailbox
  // whose password cannot be decrypted is skipped loudly rather than
  // silently dropped — silence is indistinguishable from "mail stopped".
  for (const label of mailboxes.labels()) {
    try {
      const account = mailboxes.get(label);
      if (account !== null) await registry.add(account);
    } catch (err) {
      const detail = errorMessage(err);
      safeConsoleLogger.error(`[${label}] could not be restored: ${detail}`);
      await sender.send(
        `⚠️ Mailbox "${escapeHtml(label)}" could not be restored: ${escapeHtml(detail)}. ` +
          `If MASTER_KEY changed, remove and re-add it.`
      );
    }
  }

  const conversations = new Conversations();
  const receiverAbort = new AbortController();

  const receiverDone = runReceiver({
    token: config.telegramBotToken,
    signal: receiverAbort.signal,
    onUpdate: (update) =>
      handleUpdate(update, {
        operatorChatId: config.telegramChatId,
        mailboxes,
        seen: store,
        registry,
        conversations,
        probe: probeMailbox,
        reply: async (text) => {
          await sender.send(escapeHtml(text));
        },
        deleteMessage: (messageId) =>
          sender.deleteMessage(config.telegramChatId, messageId),
        now: () => Date.now(),
      }),
  }).catch((err: unknown) => {
    if (err instanceof FatalTelegramError) {
      safeConsoleLogger.error(`fatal: ${err.message}`);
      process.exit(1);
    }
    safeConsoleLogger.error(`receiver stopped: ${errorMessage(err)}`);
  });
```

`escapeHtml` is imported from `./mail/format.js` — replies go out through the same
HTML-mode sender as notifications, so they must be escaped for the same reason.

The health server now reports `registry.states()`:

```ts
  const health = startHealthServer(config.healthPort, () =>
    buildHealthReport(registry.states())
  );
```

Shutdown must abort the receiver and stop the registry. Extend the existing
`shutdown` call site:

```ts
    void shutdown(signal, {
      watchers: registry.states().map((s) => ({ label: s.label, stop: () => registry.remove(s.label).then(() => undefined) })),
      pruneTimer,
      health,
      store,
      exit: (code) => process.exit(code),
      onBeforeExit: async () => {
        receiverAbort.abort();
        await receiverDone;
        mailboxes.close();
      },
    });
```

Add the optional `onBeforeExit` to `ShutdownDeps` and call it inside `shutdown`'s
`try` block, before the watcher stops:

```ts
export type ShutdownDeps = {
  // ...existing fields...
  onBeforeExit?: () => Promise<void>;
};
```

```ts
    if (deps.onBeforeExit) {
      try {
        await deps.onBeforeExit();
      } catch (err) {
        logger.error(`pre-exit cleanup failed: ${errorMessage(err)}`);
      }
    }
```

- [ ] **Step 7: Verify the whole suite and build**

Run: `npm test && npm run build`
Expected: all tests pass, `tsc` clean. Fix any remaining references to the removed
`config.mailboxes`.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/health.ts src/telegram/sender.ts test/health.test.ts test/sender.test.ts
git commit -m "feat: wire runtime mailbox management into the daemon"
```

---

### Task 9: Integration test, docs, and deployment

**Files:**
- Modify: `test/integration/e2e.test.ts`
- Modify: `README.md`, `.env.example` is NOT touched (see note)
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: everything above.
- Produces: no new source interfaces.

- [ ] **Step 1: Add an integration test for the store-driven lifecycle**

Append to `test/integration/e2e.test.ts`, inside the existing describe block:

```ts
  it('starts watching a mailbox added through the store, and stops when removed', async () => {
    const { MailboxStore } = await import('../../src/store/mailboxes.js');
    const { deriveKey } = await import('../../src/crypto/secret.js');
    const { WatcherRegistry } = await import('../../src/imap/registry.js');

    const mbPath = join(dir, 'mailboxes.db');
    const mb = new MailboxStore(mbPath, deriveKey('k'.repeat(32)));
    const account = {
      label: 'Live', host: IMAP_HOST, port: IMAP_PORT,
      user: IMAP_USER, pass: IMAP_PASS, secure: false,
    };
    mb.add(account);
    expect(mb.get('Live')?.pass).toBe(IMAP_PASS);

    const started: string[] = [];
    const stopped: string[] = [];
    const registry = new WatcherRegistry((a) => ({
      label: a.label,
      state: 'ok' as const,
      async start() { started.push(a.label); },
      async stop() { stopped.push(a.label); },
    }));

    await registry.add(mb.get('Live')!);
    expect(started).toEqual(['Live']);
    expect(registry.has('Live')).toBe(true);

    await registry.remove('Live');
    mb.remove('Live');
    store.purgeAccount('Live');

    expect(stopped).toEqual(['Live']);
    expect(registry.has('Live')).toBe(false);
    expect(mb.get('Live')).toBeNull();
    expect(store.getFolderState('Live', 'INBOX')).toBeNull();

    mb.close();
  }, 60_000);
```

Reuse the existing `IMAP_HOST`/`IMAP_PORT`/`IMAP_USER`/`IMAP_PASS` constants already
defined at the top of that file, and the existing `dir` and `store` from its
`beforeEach`.

- [ ] **Step 2: Run the integration suite against a fresh GreenMail**

```bash
docker compose -f test/integration/docker-compose.test.yml down -v
docker compose -f test/integration/docker-compose.test.yml up -d
sleep 8
npm run test:integration
```

Expected: 7/7 passing. Then run each test in isolation with `-t` on a fresh
container to confirm none depends on execution order.

- [ ] **Step 3: Update `README.md`**

Replace the `MAILBOXES` row of the configuration table with `MASTER_KEY`, and replace
the setup section's step 3 with the Telegram command flow:

````markdown
### Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | yes | — | The only chat allowed to send commands |
| `MASTER_KEY` | yes | — | ≥32 chars; encrypts stored mailbox passwords. `openssl rand -base64 32` |
| `SWEEP_INTERVAL_SECONDS` | no | `60` | Non-INBOX folder check interval |
| `PREVIEW_CHARS` | no | `200` | Body preview length |
| `DB_PATH` | no | `/data/seen.db` | SQLite location |
| `HEALTH_PORT` | no | `8080` | Health server port |

### Adding a mailbox

Mailboxes are configured at runtime by messaging the bot — there is no
`MAILBOXES` variable. Send:

```
/add Work imap.hostinger.com 993 me@mydomain.com
```

The bot asks for the password as a separate message and deletes it as soon as it
has read it, then tests the credentials before saving. Other commands: `/list`,
`/remove <label>`, `/status`, `/test <label>`.

**`MASTER_KEY` is not recoverable.** If you lose or change it, stored passwords
cannot be decrypted and you must re-add each mailbox. Keep a copy wherever you keep
your other credentials.
````

- [ ] **Step 4: Update `docker-compose.yml`**

Replace the `MAILBOXES` environment line with:

```yaml
      MASTER_KEY: ${MASTER_KEY}
```

- [ ] **Step 5: Verify everything**

```bash
npm test && npm run build
```

Expected: all unit tests pass, build clean.

- [ ] **Step 6: Commit**

```bash
git add test/integration/e2e.test.ts README.md docker-compose.yml
git commit -m "feat: integration coverage and docs for runtime mailbox config"
```

**Note on `.env.example`:** a session permission rule denies all access to `.env*`
paths, so this plan does not modify it. It still lists `MAILBOXES`, which is now
obsolete. The operator must manually replace that line with
`MASTER_KEY=generate-with-openssl-rand-base64-32`.

---

## Deployment checklist (operator, after merge)

- [ ] In Coolify, **delete** the `MAILBOXES` environment variable
- [ ] **Add** `MASTER_KEY` as a secret (`openssl rand -base64 32`)
- [ ] Redeploy
- [ ] Confirm the container reaches healthy with zero mailboxes configured
- [ ] Message the bot `/add <label> <host> 993 <username>`, then send the password
- [ ] Confirm `/list` and `/status` respond, and send yourself a test email

## Verification checklist

- [ ] Adding a mailbox via Telegram starts watching it with no restart
- [ ] Removing one stops its watcher and purges its state
- [ ] Passwords never appear in logs, replies, or the database file
- [ ] Commands from another chat produce no reply at all
- [ ] `/add` does not persist a mailbox whose credentials fail
- [ ] Booting with zero mailboxes reports healthy
