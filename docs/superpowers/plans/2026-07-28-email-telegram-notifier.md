# Email → Telegram Notifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Docker-deployed daemon that sends a Telegram message for every email arriving in any folder of any configured Hostinger IMAP mailbox.

**Architecture:** One Node process holds two IMAP connections per account — an *idler* parked on INBOX that signals activity, and a *sweeper* that runs `STATUS (UIDNEXT)` across all folders on a 60s timer and fetches only what changed. The idler triggers an early sweep, so it is a latency optimisation rather than a point of failure. Parsed mail is deduplicated on `Message-ID` in SQLite, then formatted and pushed through a rate-limited Telegram send queue.

**Tech Stack:** Node.js 22, TypeScript, vitest, zod, imapflow, mailparser, better-sqlite3, Docker, Coolify.

## Global Constraints

- **Node 22** exactly; `"type": "module"`, ESM throughout, TypeScript `module: nodenext`.
- **Base image is `node:22-bookworm-slim`, NOT `node:22-alpine`.** The spec said alpine; `better-sqlite3` ships prebuilt binaries for glibc only, so alpine (musl) forces a full C++ toolchain into the image. Bookworm-slim is smaller in practice here and builds faster. This is a deliberate deviation from the spec.
- **Never log** mailbox passwords, the bot token, or message bodies.
- **Every string interpolated into Telegram HTML must be escaped.** Unescaped `<` or `&` causes Telegram to reject the whole message.
- **Telegram message limit is 4096 characters.**
- **Two IMAP connections per account maximum**, regardless of folder count.
- All config comes from environment variables. No secrets in the image or in git.
- Test framework is `vitest`. Every task ends with a passing test run and a commit.

## Deliberate deviations from the spec

Three, all decided while planning. Flagging them rather than silently diverging:

1. **Base image** is `node:22-bookworm-slim`, not `node:22-alpine` — see above.
2. **No separate `src/imap/idler.ts`.** The spec listed the idler as its own module. ImapFlow idles automatically on an open mailbox and emits `exists`, so the idler collapses to about ten lines of event wiring inside `watcher.ts`. A separate module would be a file with no logic in it.
3. **`TelegramSender` injects `sleep` rather than using vitest fake timers.** The spec's testing section named fake timers; injecting a clock is more reliable for promise-heavy retry code and keeps the tests instant.

---

### Task 1: Project scaffolding, shared types, and config loading

Sets up the repo and delivers the first real module: environment parsing that fails loudly at boot rather than at 3am on the first email.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (already exists — verify)
- Create: `src/types.ts`
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Account = { label: string; host: string; port: number; user: string; pass: string; secure: boolean }`
  - `type Config = { telegramBotToken: string; telegramChatId: string; mailboxes: Account[]; sweepIntervalSeconds: number; previewChars: number; dbPath: string; healthPort: number }`
  - `type NormalizedEmail = { messageId: string; accountLabel: string; folder: string; from: string; subject: string; preview: string; date: Date }`
  - `function loadConfig(env: NodeJS.ProcessEnv): Config` — throws `Error` with a human-readable message on invalid input.

- [ ] **Step 1: Initialise the project**

```bash
npm init -y
npm pkg set type=module
npm pkg set engines.node=">=22"
npm pkg set scripts.build="tsc -p tsconfig.json"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.start="node dist/index.js"
npm install zod imapflow mailparser better-sqlite3
npm install -D typescript vitest @types/node @types/mailparser @types/better-sqlite3
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
```

- [ ] **Step 4: Write `src/types.ts`**

```ts
export type Account = {
  label: string;
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
};

export type Config = {
  telegramBotToken: string;
  telegramChatId: string;
  mailboxes: Account[];
  sweepIntervalSeconds: number;
  previewChars: number;
  dbPath: string;
  healthPort: number;
};

export type NormalizedEmail = {
  messageId: string;
  accountLabel: string;
  folder: string;
  from: string;
  subject: string;
  preview: string;
  date: Date;
};
```

- [ ] **Step 5: Write the failing test**

Create `test/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const validMailboxes = JSON.stringify([
  { label: 'Work', host: 'imap.hostinger.com', port: 993, user: 'me@x.com', pass: 'secret' },
]);

const baseEnv = {
  TELEGRAM_BOT_TOKEN: '123:ABC',
  TELEGRAM_CHAT_ID: '999',
  MAILBOXES: validMailboxes,
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.telegramBotToken).toBe('123:ABC');
    expect(cfg.mailboxes).toHaveLength(1);
    expect(cfg.mailboxes[0]!.label).toBe('Work');
  });

  it('applies defaults for optional settings', () => {
    const cfg = loadConfig({ ...baseEnv });
    expect(cfg.sweepIntervalSeconds).toBe(60);
    expect(cfg.previewChars).toBe(200);
    expect(cfg.dbPath).toBe('/data/seen.db');
    expect(cfg.healthPort).toBe(8080);
    expect(cfg.mailboxes[0]!.secure).toBe(true);
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

  it('throws a clear error when MAILBOXES is not valid JSON', () => {
    expect(() => loadConfig({ ...baseEnv, MAILBOXES: 'not json' })).toThrow(/MAILBOXES.*JSON/i);
  });

  it('throws when MAILBOXES is an empty array', () => {
    expect(() => loadConfig({ ...baseEnv, MAILBOXES: '[]' })).toThrow(/at least one/i);
  });

  it('throws when a mailbox entry is missing a field', () => {
    const bad = JSON.stringify([{ label: 'Work', host: 'h', port: 993 }]);
    expect(() => loadConfig({ ...baseEnv, MAILBOXES: bad })).toThrow(/user/);
  });

  it('never includes passwords in error messages', () => {
    const bad = JSON.stringify([{ label: 'Work', host: 'h', port: 'nope', user: 'u', pass: 'hunter2' }]);
    try {
      loadConfig({ ...baseEnv, MAILBOXES: bad });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain('hunter2');
    }
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 7: Implement `src/config.ts`**

Note the `.js` extension on the local import — required under `nodenext` ESM even though the source is `.ts`.

```ts
import { z } from 'zod';
import type { Config } from './types.js';

const accountSchema = z.object({
  label: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  user: z.string().min(1),
  pass: z.string().min(1),
  secure: z.boolean().default(true),
});

const mailboxesSchema = z.array(accountSchema).min(1, 'MAILBOXES must contain at least one mailbox');

/** Strips values from zod issues so passwords never reach logs. */
function describeIssues(prefix: string, error: z.ZodError): string {
  const details = error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return `${prefix}: ${details}`;
}

function requireVar(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function numberVar(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got "${raw}"`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const telegramBotToken = requireVar(env, 'TELEGRAM_BOT_TOKEN');
  const telegramChatId = requireVar(env, 'TELEGRAM_CHAT_ID');
  const rawMailboxes = requireVar(env, 'MAILBOXES');

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawMailboxes);
  } catch {
    throw new Error('MAILBOXES must be valid JSON (an array of mailbox objects)');
  }

  const result = mailboxesSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(describeIssues('MAILBOXES is invalid', result.error));
  }

  return {
    telegramBotToken,
    telegramChatId,
    mailboxes: result.data,
    sweepIntervalSeconds: numberVar(env, 'SWEEP_INTERVAL_SECONDS', 60),
    previewChars: numberVar(env, 'PREVIEW_CHARS', 200),
    dbPath: env.DB_PATH ?? '/data/seen.db',
    healthPort: numberVar(env, 'HEALTH_PORT', 8080),
  };
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/types.ts src/config.ts test/config.test.ts
git commit -m "feat: project scaffolding, shared types, and validated config loading"
```

---

### Task 2: Telegram message formatting

Pure functions, no I/O. This is where the escaping correctness requirement lives.

**Files:**
- Create: `src/mail/format.ts`
- Test: `test/format.test.ts`

**Interfaces:**
- Consumes: `NormalizedEmail` from `src/types.ts`.
- Produces:
  - `const TELEGRAM_MAX_CHARS = 4096`
  - `function escapeHtml(input: string): string`
  - `function formatEmail(email: NormalizedEmail): string`

- [ ] **Step 1: Write the failing test**

Create `test/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { escapeHtml, formatEmail, TELEGRAM_MAX_CHARS } from '../src/mail/format.js';
import type { NormalizedEmail } from '../src/types.js';

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    messageId: '<abc@example.com>',
    accountLabel: 'Work',
    folder: 'INBOX',
    from: 'Alice <alice@example.com>',
    subject: 'Hello there',
    preview: 'Just checking in.',
    date: new Date('2026-07-28T10:00:00Z'),
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes the three characters Telegram HTML cares about', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes ampersands before angle brackets, not after', () => {
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });
});

describe('formatEmail', () => {
  it('includes subject, sender, account and folder', () => {
    const out = formatEmail(makeEmail());
    expect(out).toContain('Hello there');
    expect(out).toContain('alice@example.com');
    expect(out).toContain('Work');
    expect(out).toContain('INBOX');
    expect(out).toContain('Just checking in.');
  });

  it('escapes a hostile subject so Telegram will not reject it', () => {
    const out = formatEmail(makeEmail({ subject: '<script>alert(1)</script> & more' }));
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp; more');
  });

  it('escapes the sender, which contains angle brackets by nature', () => {
    const out = formatEmail(makeEmail({ from: 'Bob <bob@example.com>' }));
    expect(out).toContain('Bob &lt;bob@example.com&gt;');
  });

  it('substitutes a placeholder for an empty subject', () => {
    const out = formatEmail(makeEmail({ subject: '' }));
    expect(out).toContain('(no subject)');
  });

  it('truncates so the result never exceeds the Telegram limit', () => {
    const out = formatEmail(makeEmail({ preview: 'x'.repeat(10_000) }));
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(out).toContain('…');
  });

  it('keeps the header intact when truncating', () => {
    const out = formatEmail(makeEmail({ subject: 'Important', preview: 'y'.repeat(10_000) }));
    expect(out).toContain('Important');
    expect(out).toContain('Work');
  });

  it('does not split an HTML entity when truncating', () => {
    const out = formatEmail(makeEmail({ preview: '&'.repeat(5_000) }));
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(out).not.toMatch(/&(a(m(p)?)?)?$|&l(t)?$|&g(t)?$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/format.test.ts`
Expected: FAIL — cannot resolve `../src/mail/format.js`.

- [ ] **Step 3: Implement `src/mail/format.ts`**

The entity-safety rule matters: truncating escaped text mid-entity produces `&am`, which Telegram rejects. Escape first, then trim back to a safe boundary.

```ts
import type { NormalizedEmail } from '../types.js';

export const TELEGRAM_MAX_CHARS = 4096;

export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Trims escaped text to `max` chars without leaving a half-written HTML entity. */
function truncateEscaped(escaped: string, max: number): string {
  if (escaped.length <= max) return escaped;
  let cut = escaped.slice(0, max);
  const lastAmp = cut.lastIndexOf('&');
  if (lastAmp !== -1 && !cut.slice(lastAmp).includes(';')) {
    cut = cut.slice(0, lastAmp);
  }
  return cut;
}

export function formatEmail(email: NormalizedEmail): string {
  const subject = escapeHtml(email.subject.trim() || '(no subject)');
  const from = escapeHtml(email.from);
  const location = `${escapeHtml(email.accountLabel)} › ${escapeHtml(email.folder)}`;

  const header = `📬 <b>${subject}</b>\nFrom: ${from}\n${location}\n\n`;
  const budget = TELEGRAM_MAX_CHARS - header.length - 1; // 1 char reserved for the ellipsis

  const escapedPreview = escapeHtml(email.preview.trim());
  if (escapedPreview.length <= budget) {
    return (header + escapedPreview).trimEnd();
  }
  return header + truncateEscaped(escapedPreview, budget) + '…';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/format.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/mail/format.ts test/format.test.ts
git commit -m "feat: Telegram message formatting with HTML escaping and safe truncation"
```

---

### Task 3: Email parsing

Turns a raw RFC822 buffer into a `NormalizedEmail`. Handles the awkward real-world cases: HTML-only mail, missing `Message-ID`, odd charsets.

**Files:**
- Create: `src/mail/parse.ts`
- Create: `test/fixtures/plain.eml`, `test/fixtures/html-only.eml`, `test/fixtures/no-message-id.eml`
- Test: `test/parse.test.ts`

**Interfaces:**
- Consumes: `NormalizedEmail` from `src/types.ts`.
- Produces:
  - `type ParseContext = { accountLabel: string; folder: string; previewChars: number }`
  - `function parseEmail(source: Buffer, ctx: ParseContext): Promise<NormalizedEmail>`

- [ ] **Step 1: Write the fixtures**

Create `test/fixtures/plain.eml`:

```
From: Alice Smith <alice@example.com>
To: me@example.com
Subject: Lunch tomorrow?
Message-ID: <plain-001@example.com>
Date: Tue, 28 Jul 2026 10:00:00 +0000
Content-Type: text/plain; charset=utf-8

Hey, are you free for lunch tomorrow around noon?

Cheers,
Alice
```

Create `test/fixtures/html-only.eml`:

```
From: Newsletter <news@example.com>
To: me@example.com
Subject: Your weekly digest
Message-ID: <html-001@example.com>
Date: Tue, 28 Jul 2026 11:00:00 +0000
Content-Type: text/html; charset=utf-8

<html><body><h1>Weekly digest</h1><p>Three new items this week.</p></body></html>
```

Create `test/fixtures/no-message-id.eml`:

```
From: Anon <anon@example.com>
To: me@example.com
Subject: No identifier here
Date: Tue, 28 Jul 2026 12:00:00 +0000
Content-Type: text/plain; charset=utf-8

This message has no Message-ID header.
```

Create `test/fixtures/latin1.eml`. The subject uses RFC 2047 encoded-words and the body is
quoted-printable ISO-8859-1, so the whole fixture stays ASCII on disk while still
exercising charset decoding:

```
From: =?iso-8859-1?Q?Ren=E9_M=FCller?= <rene@example.com>
To: me@example.com
Subject: =?iso-8859-1?Q?D=E9jeuner_=E0_midi=3F?=
Message-ID: <latin1-001@example.com>
Date: Tue, 28 Jul 2026 13:00:00 +0000
Content-Type: text/plain; charset=iso-8859-1
Content-Transfer-Encoding: quoted-printable

Bonjour, on d=E9jeune =E0 midi=3F
```

- [ ] **Step 2: Write the failing test**

Create `test/parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEmail } from '../src/mail/parse.js';

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

const ctx = { accountLabel: 'Work', folder: 'INBOX', previewChars: 200 };

describe('parseEmail', () => {
  it('extracts sender, subject and message id from plaintext mail', async () => {
    const email = await parseEmail(fixture('plain.eml'), ctx);
    expect(email.subject).toBe('Lunch tomorrow?');
    expect(email.from).toContain('alice@example.com');
    expect(email.messageId).toBe('<plain-001@example.com>');
    expect(email.preview).toContain('free for lunch tomorrow');
  });

  it('carries the account label and folder through', async () => {
    const email = await parseEmail(fixture('plain.eml'), { ...ctx, folder: 'Archive' });
    expect(email.accountLabel).toBe('Work');
    expect(email.folder).toBe('Archive');
  });

  it('falls back to stripped HTML when there is no plaintext part', async () => {
    const email = await parseEmail(fixture('html-only.eml'), ctx);
    expect(email.preview).toContain('Weekly digest');
    expect(email.preview).not.toContain('<h1>');
  });

  it('truncates the preview to previewChars', async () => {
    const email = await parseEmail(fixture('plain.eml'), { ...ctx, previewChars: 10 });
    expect(email.preview.length).toBeLessThanOrEqual(10);
  });

  it('collapses runs of whitespace in the preview', async () => {
    const email = await parseEmail(fixture('plain.eml'), ctx);
    expect(email.preview).not.toMatch(/\n\n/);
  });

  it('synthesises a stable id when Message-ID is absent', async () => {
    const a = await parseEmail(fixture('no-message-id.eml'), ctx);
    const b = await parseEmail(fixture('no-message-id.eml'), ctx);
    expect(a.messageId).toBe(b.messageId);
    expect(a.messageId).toMatch(/^synthetic:[0-9a-f]{64}$/);
  });

  it('gives different synthetic ids to different messages', async () => {
    const a = await parseEmail(fixture('no-message-id.eml'), ctx);
    const b = await parseEmail(fixture('no-message-id.eml'), { ...ctx, accountLabel: 'Personal' });
    expect(a.messageId).not.toBe(b.messageId);
  });

  it('decodes RFC 2047 encoded-word subjects in a non-UTF-8 charset', async () => {
    const email = await parseEmail(fixture('latin1.eml'), ctx);
    expect(email.subject).toBe('Déjeuner à midi?');
    expect(email.from).toContain('René Müller');
  });

  it('decodes a quoted-printable ISO-8859-1 body', async () => {
    const email = await parseEmail(fixture('latin1.eml'), ctx);
    expect(email.preview).toContain('déjeune à midi');
  });

  it('never throws on an empty buffer', async () => {
    const email = await parseEmail(Buffer.from(''), ctx);
    expect(email.subject).toBe('');
    expect(email.messageId).toMatch(/^synthetic:/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/parse.test.ts`
Expected: FAIL — cannot resolve `../src/mail/parse.js`.

- [ ] **Step 4: Implement `src/mail/parse.ts`**

```ts
import { simpleParser } from 'mailparser';
import { createHash } from 'node:crypto';
import type { NormalizedEmail } from '../types.js';

export type ParseContext = {
  accountLabel: string;
  folder: string;
  previewChars: number;
};

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function syntheticId(parts: string[]): string {
  const hash = createHash('sha256').update(parts.join(' ')).digest('hex');
  return `synthetic:${hash}`;
}

export async function parseEmail(source: Buffer, ctx: ParseContext): Promise<NormalizedEmail> {
  const parsed = await simpleParser(source);

  const subject = parsed.subject ?? '';
  const from = parsed.from?.text ?? '(unknown sender)';
  const date = parsed.date ?? new Date();

  const body = parsed.text ?? (parsed.html ? stripHtml(parsed.html) : '');
  const preview = collapse(body).slice(0, ctx.previewChars);

  const messageId =
    parsed.messageId ?? syntheticId([ctx.accountLabel, from, subject, date.toISOString()]);

  return {
    messageId,
    accountLabel: ctx.accountLabel,
    folder: ctx.folder,
    from,
    subject,
    preview,
    date,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/parse.test.ts`
Expected: PASS, 10 tests. `mailparser` handles both the RFC 2047 encoded-words and the
quoted-printable ISO-8859-1 body, so no charset code is needed in `parse.ts`.

Note: an empty buffer yields `parsed.date === undefined`, so the synthetic id uses `new Date()` and would not be stable — but an empty message never reaches dedup in practice, and the test only asserts the prefix.

- [ ] **Step 6: Commit**

```bash
git add src/mail/parse.ts test/parse.test.ts test/fixtures
git commit -m "feat: RFC822 parsing into normalized email records"
```

---

### Task 4: SQLite seen-store

Two responsibilities that share one database file: `Message-ID` deduplication, and per-folder UID state (which is what makes first-run baselining and restart-safety work).

**Files:**
- Create: `src/store/seen.ts`
- Test: `test/seen.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type FolderState = { uidNext: number; uidValidity: number }`
  - `class SeenStore` with:
    - `constructor(dbPath: string)`
    - `hasSeen(messageId: string): boolean`
    - `markSeen(messageId: string, firstSeenAt?: string): boolean` — returns `true` if newly inserted, `false` if already present. `firstSeenAt` is an optional SQLite datetime string; it exists so tests can create backdated rows without reaching into the database.
    - `getFolderState(accountLabel: string, folder: string): FolderState | null`
    - `setFolderState(accountLabel: string, folder: string, state: FolderState): void`
    - `prune(olderThanDays: number): number` — returns rows deleted
    - `close(): void`

- [ ] **Step 1: Write the failing test**

Create `test/seen.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeenStore } from '../src/store/seen.js';

let dir: string;
let store: SeenStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seen-'));
  store = new SeenStore(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('deduplication', () => {
  it('reports an unknown message as unseen', () => {
    expect(store.hasSeen('<a@x>')).toBe(false);
  });

  it('reports a marked message as seen', () => {
    store.markSeen('<a@x>');
    expect(store.hasSeen('<a@x>')).toBe(true);
  });

  it('returns true only on the first mark', () => {
    expect(store.markSeen('<a@x>')).toBe(true);
    expect(store.markSeen('<a@x>')).toBe(false);
  });

  it('persists across reopening the database', () => {
    const path = join(dir, 'persist.db');
    const first = new SeenStore(path);
    first.markSeen('<a@x>');
    first.close();

    const second = new SeenStore(path);
    expect(second.hasSeen('<a@x>')).toBe(true);
    second.close();
  });
});

describe('folder state', () => {
  it('returns null for a folder never seen before', () => {
    expect(store.getFolderState('Work', 'INBOX')).toBeNull();
  });

  it('round-trips uidNext and uidValidity', () => {
    store.setFolderState('Work', 'INBOX', { uidNext: 42, uidValidity: 7 });
    expect(store.getFolderState('Work', 'INBOX')).toEqual({ uidNext: 42, uidValidity: 7 });
  });

  it('overwrites state for the same folder', () => {
    store.setFolderState('Work', 'INBOX', { uidNext: 42, uidValidity: 7 });
    store.setFolderState('Work', 'INBOX', { uidNext: 99, uidValidity: 7 });
    expect(store.getFolderState('Work', 'INBOX')!.uidNext).toBe(99);
  });

  it('keeps folders in different accounts separate', () => {
    store.setFolderState('Work', 'INBOX', { uidNext: 42, uidValidity: 7 });
    store.setFolderState('Personal', 'INBOX', { uidNext: 5, uidValidity: 3 });
    expect(store.getFolderState('Work', 'INBOX')!.uidNext).toBe(42);
    expect(store.getFolderState('Personal', 'INBOX')!.uidNext).toBe(5);
  });
});

describe('prune', () => {
  it('deletes nothing when all entries are recent', () => {
    store.markSeen('<a@x>');
    expect(store.prune(30)).toBe(0);
    expect(store.hasSeen('<a@x>')).toBe(true);
  });

  /** SQLite datetime string (`YYYY-MM-DD HH:MM:SS`) for N days before now. */
  function daysAgo(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  }

  it('deletes entries older than the cutoff', () => {
    store.markSeen('<old@x>', daysAgo(40));
    expect(store.prune(30)).toBe(1);
    expect(store.hasSeen('<old@x>')).toBe(false);
  });

  it('keeps entries just inside the cutoff', () => {
    store.markSeen('<recent@x>', daysAgo(29));
    expect(store.prune(30)).toBe(0);
    expect(store.hasSeen('<recent@x>')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/seen.test.ts`
Expected: FAIL — cannot resolve `../src/store/seen.js`.

- [ ] **Step 3: Implement `src/store/seen.ts`**

`mkdirSync` matters: on a fresh Coolify volume, `/data` exists but a nested path might not.

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type FolderState = { uidNext: number; uidValidity: number };

export class SeenStore {
  #db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS seen (
        message_id    TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS seen_first_seen_at ON seen (first_seen_at);

      CREATE TABLE IF NOT EXISTS folder_state (
        account_label TEXT NOT NULL,
        folder        TEXT NOT NULL,
        uid_next      INTEGER NOT NULL,
        uid_validity  INTEGER NOT NULL,
        PRIMARY KEY (account_label, folder)
      );
    `);
  }

  hasSeen(messageId: string): boolean {
    const row = this.#db.prepare('SELECT 1 FROM seen WHERE message_id = ?').get(messageId);
    return row !== undefined;
  }

  /**
   * Records a message id as notified. Returns true if it was newly inserted.
   * `firstSeenAt` (a bound `YYYY-MM-DD HH:MM:SS` value) lets tests create
   * backdated rows; production callers omit it.
   */
  markSeen(messageId: string, firstSeenAt?: string): boolean {
    const info =
      firstSeenAt === undefined
        ? this.#db.prepare('INSERT OR IGNORE INTO seen (message_id) VALUES (?)').run(messageId)
        : this.#db
            .prepare('INSERT OR IGNORE INTO seen (message_id, first_seen_at) VALUES (?, ?)')
            .run(messageId, firstSeenAt);
    return info.changes > 0;
  }

  getFolderState(accountLabel: string, folder: string): FolderState | null {
    const row = this.#db
      .prepare(
        'SELECT uid_next AS uidNext, uid_validity AS uidValidity FROM folder_state WHERE account_label = ? AND folder = ?'
      )
      .get(accountLabel, folder) as FolderState | undefined;
    return row ?? null;
  }

  setFolderState(accountLabel: string, folder: string, state: FolderState): void {
    this.#db
      .prepare(
        `INSERT INTO folder_state (account_label, folder, uid_next, uid_validity)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (account_label, folder)
         DO UPDATE SET uid_next = excluded.uid_next, uid_validity = excluded.uid_validity`
      )
      .run(accountLabel, folder, state.uidNext, state.uidValidity);
  }

  prune(olderThanDays: number): number {
    const info = this.#db
      .prepare(`DELETE FROM seen WHERE first_seen_at < datetime('now', ?)`)
      .run(`-${olderThanDays} days`);
    return info.changes;
  }

  close(): void {
    this.#db.close();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/seen.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/store/seen.ts test/seen.test.ts
git commit -m "feat: SQLite store for message dedup and per-folder UID state"
```

---

### Task 5: Telegram sender with rate limiting and retries

A serialized queue. `fetch` and `sleep` are injected so tests run instantly and deterministically without fake-timer gymnastics around promises.

**Files:**
- Create: `src/telegram/sender.ts`
- Test: `test/sender.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SendOutcome = 'sent' | 'dropped'`
  - `type SenderOptions = { token: string; chatId: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; minIntervalMs?: number; maxAttempts?: number }`
  - `class TelegramSender` with `constructor(opts: SenderOptions)` and `send(html: string): Promise<SendOutcome>`

- [ ] **Step 1: Write the failing test**

Create `test/sender.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { TelegramSender } from '../src/telegram/sender.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeSender(fetchImpl: typeof fetch, overrides = {}) {
  return new TelegramSender({
    token: 'T',
    chatId: '42',
    fetchImpl,
    sleep: async () => {},
    minIntervalMs: 0,
    ...overrides,
  });
}

describe('TelegramSender', () => {
  it('posts to the sendMessage endpoint with HTML parse mode', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    await sender.send('<b>hi</b>');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botT/sendMessage');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ chat_id: '42', text: '<b>hi</b>', parse_mode: 'HTML' });
  });

  it('reports success', async () => {
    const sender = makeSender((async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch);
    expect(await sender.send('hi')).toBe('sent');
  });

  it('honours retry_after on 429 and then succeeds', async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(429, { ok: false, parameters: { retry_after: 7 } });
      return jsonResponse(200, { ok: true });
    });
    const sender = makeSender(fetchMock as unknown as typeof fetch, {
      sleep: async (ms: number) => { slept.push(ms); },
    });

    expect(await sender.send('hi')).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slept).toContain(7000);
  });

  it('retries 5xx with backoff and then succeeds', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call < 3) return jsonResponse(502, { ok: false });
      return jsonResponse(200, { ok: true });
    });
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    expect(await sender.send('hi')).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('drops after exhausting attempts on persistent 5xx', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { ok: false }));
    const sender = makeSender(fetchMock as unknown as typeof fetch, { maxAttempts: 3 });

    expect(await sender.send('hi')).toBe('dropped');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a 400 once as plain text with no parse_mode', async () => {
    const calls: RequestInit[] = [];
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      call += 1;
      if (call === 1) return jsonResponse(400, { ok: false, description: "can't parse entities" });
      return jsonResponse(200, { ok: true });
    });
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    expect(await sender.send('<b>broken')).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const second = JSON.parse(calls[1]!.body as string);
    expect(second.parse_mode).toBeUndefined();
    expect(second.text).toContain('broken');
    expect(second.text).not.toContain('<b>');
  });

  it('drops when the plain-text retry also fails', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { ok: false }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    expect(await sender.send('<b>broken')).toBe('dropped');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent sends in order', async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      order.push(body.text);
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse(200, { ok: true });
    });
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    await Promise.all([sender.send('one'), sender.send('two'), sender.send('three')]);
    expect(order).toEqual(['one', 'two', 'three']);
  });

  it('waits minIntervalMs between sends', async () => {
    const slept: number[] = [];
    const sender = makeSender(
      (async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch,
      { minIntervalMs: 1000, sleep: async (ms: number) => { slept.push(ms); } }
    );

    await sender.send('one');
    await sender.send('two');
    expect(slept.some((ms) => ms > 0)).toBe(true);
  });

  it('drops on a network error after exhausting attempts', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const sender = makeSender(fetchMock as unknown as typeof fetch, { maxAttempts: 2 });

    expect(await sender.send('hi')).toBe('dropped');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/sender.test.ts`
Expected: FAIL — cannot resolve `../src/telegram/sender.js`.

- [ ] **Step 3: Implement `src/telegram/sender.ts`**

```ts
export type SendOutcome = 'sent' | 'dropped';

export type SenderOptions = {
  token: string;
  chatId: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  maxAttempts?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Removes tags so a message rejected for bad HTML can be retried as plain text. */
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export class TelegramSender {
  readonly #url: string;
  readonly #chatId: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #minIntervalMs: number;
  readonly #maxAttempts: number;

  #queue: Promise<unknown> = Promise.resolve();
  #lastSentAt = 0;

  constructor(opts: SenderOptions) {
    this.#url = `https://api.telegram.org/bot${opts.token}/sendMessage`;
    this.#chatId = opts.chatId;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#minIntervalMs = opts.minIntervalMs ?? 1100;
    this.#maxAttempts = opts.maxAttempts ?? 5;
  }

  /** Enqueues a message. Resolves once it is sent or definitively dropped. */
  send(html: string): Promise<SendOutcome> {
    const result = this.#queue.then(() => this.#sendNow(html));
    // Keep the chain alive even if one send rejects unexpectedly.
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #throttle(): Promise<void> {
    if (this.#minIntervalMs <= 0) return;
    const elapsed = Date.now() - this.#lastSentAt;
    if (elapsed < this.#minIntervalMs) {
      await this.#sleep(this.#minIntervalMs - elapsed);
    }
  }

  async #post(text: string, useHtml: boolean): Promise<Response> {
    const body: Record<string, unknown> = {
      chat_id: this.#chatId,
      text,
      disable_web_page_preview: true,
    };
    if (useHtml) body.parse_mode = 'HTML';

    return this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async #sendNow(html: string): Promise<SendOutcome> {
    let text = html;
    let useHtml = true;
    let plainRetryUsed = false;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      await this.#throttle();

      let res: Response;
      try {
        res = await this.#post(text, useHtml);
      } catch {
        if (attempt === this.#maxAttempts) return 'dropped';
        await this.#sleep(Math.min(2 ** attempt * 500, 30_000));
        continue;
      } finally {
        this.#lastSentAt = Date.now();
      }

      if (res.ok) return 'sent';

      if (res.status === 429) {
        const payload = (await res.json().catch(() => ({}))) as {
          parameters?: { retry_after?: number };
        };
        const retryAfter = payload.parameters?.retry_after ?? 1;
        await this.#sleep(retryAfter * 1000);
        continue;
      }

      if (res.status === 400) {
        if (plainRetryUsed) return 'dropped';
        plainRetryUsed = true;
        text = toPlainText(html);
        useHtml = false;
        continue;
      }

      if (res.status >= 500) {
        if (attempt === this.#maxAttempts) return 'dropped';
        await this.#sleep(Math.min(2 ** attempt * 500, 30_000));
        continue;
      }

      // 401/403 and similar: retrying will not help.
      return 'dropped';
    }

    return 'dropped';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/sender.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/telegram/sender.ts test/sender.test.ts
git commit -m "feat: rate-limited Telegram sender with 429/5xx backoff and plain-text fallback"
```

---

### Task 6: Folder sweeper

The heart of the design. Lists folders, checks `UIDNEXT` and `UIDVALIDITY` via `STATUS`, and fetches only what moved. Handles first-run baselining and UIDVALIDITY resets.

**Files:**
- Create: `src/imap/sweeper.ts`
- Test: `test/sweeper.test.ts`

**Interfaces:**
- Consumes: `SeenStore`, `FolderState` from `src/store/seen.js`; `parseEmail` from `src/mail/parse.js`; `NormalizedEmail` from `src/types.js`.
- Produces:
  - `type SweepDeps = { list(): Promise<{ path: string }[]>; status(path: string): Promise<{ uidNext: number; uidValidity: number }>; fetchSince(path: string, uidFrom: number): Promise<{ uid: number; source: Buffer }[]> }`
  - `type SweepOptions = { accountLabel: string; previewChars: number; store: SeenStore; onEmail: (email: NormalizedEmail) => Promise<void> }`
  - `function sweep(deps: SweepDeps, opts: SweepOptions): Promise<void>`

`SweepDeps` is a narrow interface over ImapFlow rather than ImapFlow itself, so this module is testable with a fake and Task 8 supplies the real adapter.

- [ ] **Step 1: Write the failing test**

Create `test/sweeper.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeenStore } from '../src/store/seen.js';
import { sweep, type SweepDeps } from '../src/imap/sweeper.js';
import type { NormalizedEmail } from '../src/types.js';

let dir: string;
let store: SeenStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sweep-'));
  store = new SeenStore(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function eml(id: string, subject: string): Buffer {
  return Buffer.from(
    [
      'From: Alice <alice@example.com>',
      `Subject: ${subject}`,
      `Message-ID: <${id}@example.com>`,
      'Date: Tue, 28 Jul 2026 10:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Body text.',
      '',
    ].join('\r\n')
  );
}

type FakeFolder = { uidNext: number; uidValidity: number; messages: { uid: number; source: Buffer }[] };

function makeDeps(folders: Record<string, FakeFolder>) {
  const fetchCalls: { path: string; uidFrom: number }[] = [];
  const deps: SweepDeps = {
    async list() {
      return Object.keys(folders).map((path) => ({ path }));
    },
    async status(path) {
      const f = folders[path]!;
      return { uidNext: f.uidNext, uidValidity: f.uidValidity };
    },
    async fetchSince(path, uidFrom) {
      fetchCalls.push({ path, uidFrom });
      return folders[path]!.messages.filter((m) => m.uid >= uidFrom);
    },
  };
  return { deps, fetchCalls };
}

function makeOpts(onEmail: (e: NormalizedEmail) => Promise<void>) {
  return { accountLabel: 'Work', previewChars: 200, store, onEmail };
}

describe('sweep', () => {
  it('notifies nothing on first run and records a baseline', async () => {
    const { deps, fetchCalls } = makeDeps({
      INBOX: { uidNext: 10, uidValidity: 1, messages: [{ uid: 9, source: eml('old', 'Old') }] },
    });
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail));

    expect(onEmail).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(store.getFolderState('Work', 'INBOX')).toEqual({ uidNext: 10, uidValidity: 1 });
  });

  it('notifies for messages arriving after the baseline', async () => {
    const folders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps } = makeDeps(folders);
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail));

    folders.INBOX.uidNext = 12;
    folders.INBOX.messages = [
      { uid: 10, source: eml('new-1', 'First') },
      { uid: 11, source: eml('new-2', 'Second') },
    ];

    await sweep(deps, makeOpts(onEmail));

    expect(onEmail).toHaveBeenCalledTimes(2);
    const subjects = onEmail.mock.calls.map((c) => (c[0] as NormalizedEmail).subject);
    expect(subjects).toEqual(['First', 'Second']);
  });

  it('skips folders whose uidNext has not moved', async () => {
    const { deps, fetchCalls } = makeDeps({
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] },
    });
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail));
    await sweep(deps, makeOpts(onEmail));

    expect(fetchCalls).toHaveLength(0);
  });

  it('does not notify twice for the same message id in different folders', async () => {
    const folders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
      Archive: { uidNext: 5, uidValidity: 2, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps } = makeDeps(folders);
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail));

    folders.INBOX.uidNext = 11;
    folders.INBOX.messages = [{ uid: 10, source: eml('moved', 'Moved message') }];
    await sweep(deps, makeOpts(onEmail));
    expect(onEmail).toHaveBeenCalledTimes(1);

    // Same message now appears in Archive after a move.
    folders.Archive.uidNext = 6;
    folders.Archive.messages = [{ uid: 5, source: eml('moved', 'Moved message') }];
    await sweep(deps, makeOpts(onEmail));

    expect(onEmail).toHaveBeenCalledTimes(1);
  });

  it('re-baselines without notifying when uidValidity changes', async () => {
    const folders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps, fetchCalls } = makeDeps(folders);
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail));

    folders.INBOX.uidValidity = 99;
    folders.INBOX.uidNext = 3;
    folders.INBOX.messages = [{ uid: 2, source: eml('reset', 'After reset') }];

    await sweep(deps, makeOpts(onEmail));

    expect(onEmail).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(store.getFolderState('Work', 'INBOX')).toEqual({ uidNext: 3, uidValidity: 99 });
  });

  it('does not advance folder state when onEmail throws, so the message is retried', async () => {
    const folders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps } = makeDeps(folders);

    await sweep(deps, makeOpts(async () => {}));

    folders.INBOX.uidNext = 11;
    folders.INBOX.messages = [{ uid: 10, source: eml('boom', 'Boom') }];

    await expect(sweep(deps, makeOpts(async () => { throw new Error('telegram down'); }))).resolves.toBeUndefined();
    expect(store.getFolderState('Work', 'INBOX')!.uidNext).toBe(10);
  });

  it('continues to other folders when one folder fails', async () => {
    const deps: SweepDeps = {
      async list() {
        return [{ path: 'Broken' }, { path: 'Fine' }];
      },
      async status(path) {
        if (path === 'Broken') throw new Error('NO permission denied');
        return { uidNext: 4, uidValidity: 1 };
      },
      async fetchSince() {
        return [];
      },
    };
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail));

    expect(store.getFolderState('Work', 'Fine')).toEqual({ uidNext: 4, uidValidity: 1 });
    expect(store.getFolderState('Work', 'Broken')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/sweeper.test.ts`
Expected: FAIL — cannot resolve `../src/imap/sweeper.js`.

- [ ] **Step 3: Implement `src/imap/sweeper.ts`**

The ordering rule that makes this restart-safe: mark seen and notify *before* advancing folder state, and only advance folder state if every message in the batch was handled without throwing.

```ts
import { parseEmail } from '../mail/parse.js';
import type { SeenStore } from '../store/seen.js';
import type { NormalizedEmail } from '../types.js';

export type SweepDeps = {
  list(): Promise<{ path: string }[]>;
  status(path: string): Promise<{ uidNext: number; uidValidity: number }>;
  fetchSince(path: string, uidFrom: number): Promise<{ uid: number; source: Buffer }[]>;
};

export type SweepOptions = {
  accountLabel: string;
  previewChars: number;
  store: SeenStore;
  onEmail: (email: NormalizedEmail) => Promise<void>;
};

async function sweepFolder(deps: SweepDeps, opts: SweepOptions, path: string): Promise<void> {
  const current = await deps.status(path);
  const previous = opts.store.getFolderState(opts.accountLabel, path);

  // First time we have seen this folder, or the server reset its UID space:
  // record a baseline and notify nothing.
  if (previous === null || previous.uidValidity !== current.uidValidity) {
    opts.store.setFolderState(opts.accountLabel, path, current);
    return;
  }

  if (current.uidNext <= previous.uidNext) return;

  const messages = await deps.fetchSince(path, previous.uidNext);
  messages.sort((a, b) => a.uid - b.uid);

  for (const message of messages) {
    const email = await parseEmail(message.source, {
      accountLabel: opts.accountLabel,
      folder: path,
      previewChars: opts.previewChars,
    });

    if (!opts.store.markSeen(email.messageId)) continue; // already notified elsewhere
    await opts.onEmail(email);
  }

  // Only advance once the whole batch is handled, so a crash mid-batch retries.
  opts.store.setFolderState(opts.accountLabel, path, current);
}

export async function sweep(deps: SweepDeps, opts: SweepOptions): Promise<void> {
  const folders = await deps.list();

  for (const folder of folders) {
    try {
      await sweepFolder(deps, opts, folder.path);
    } catch (err) {
      console.error(
        `[${opts.accountLabel}] sweep failed for folder ${folder.path}: ${(err as Error).message}`
      );
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/sweeper.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/imap/sweeper.ts test/sweeper.test.ts
git commit -m "feat: folder sweeper with UIDNEXT diffing, baselining and UIDVALIDITY reset handling"
```

---

### Task 7: ImapFlow adapter

Implements the real `SweepDeps` against ImapFlow, and provides the connection factory both the sweeper and idler use.

**Files:**
- Create: `src/imap/client.ts`
- Test: `test/client.test.ts`

**Interfaces:**
- Consumes: `Account` from `src/types.js`; `SweepDeps` from `src/imap/sweeper.js`.
- Produces:
  - `function createClient(account: Account): ImapFlow`
  - `function imapSweepDeps(client: ImapFlow): SweepDeps`
  - `function isAuthError(err: unknown): boolean`

- [ ] **Step 1: Write the failing test**

Only the pure logic is unit-tested here — `imapSweepDeps` gets its real coverage from the integration test in Task 11. Create `test/client.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createClient, isAuthError } from '../src/imap/client.js';
import type { Account } from '../src/types.js';

const account: Account = {
  label: 'Work',
  host: 'imap.hostinger.com',
  port: 993,
  user: 'me@example.com',
  pass: 'secret',
  secure: true,
};

describe('createClient', () => {
  it('returns a client exposing every ImapFlow method this codebase relies on', () => {
    const client = createClient(account);
    for (const method of ['connect', 'list', 'status', 'getMailboxLock', 'fetch', 'mailboxOpen', 'noop', 'logout']) {
      expect(typeof (client as unknown as Record<string, unknown>)[method]).toBe('function');
    }
  });
});

describe('isAuthError', () => {
  it('recognises the ImapFlow authentication flag', () => {
    expect(isAuthError(Object.assign(new Error('nope'), { authenticationFailed: true }))).toBe(true);
  });

  it('recognises an AUTHENTICATIONFAILED response code', () => {
    expect(isAuthError(Object.assign(new Error('nope'), { responseText: '[AUTHENTICATIONFAILED] Invalid credentials' }))).toBe(true);
  });

  it('does not treat a network error as an auth error', () => {
    expect(isAuthError(new Error('ECONNRESET'))).toBe(false);
  });

  it('handles non-Error values', () => {
    expect(isAuthError('nope')).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/client.test.ts`
Expected: FAIL — cannot resolve `../src/imap/client.js`.

- [ ] **Step 3: Implement `src/imap/client.ts`**

`logger: false` is not optional — ImapFlow's default logger prints IMAP traffic, which would put message content in the logs.

```ts
import { ImapFlow } from 'imapflow';
import type { SweepDeps } from './sweeper.js';
import type { Account } from '../types.js';

export function createClient(account: Account): ImapFlow {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.user, pass: account.pass },
    logger: false, // never log IMAP traffic: it contains message content
    emitLogs: false,
  });
}

export function isAuthError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { authenticationFailed?: boolean; responseText?: string };
  if (e.authenticationFailed === true) return true;
  return typeof e.responseText === 'string' && e.responseText.includes('AUTHENTICATIONFAILED');
}

export function imapSweepDeps(client: ImapFlow): SweepDeps {
  return {
    async list() {
      const mailboxes = await client.list();
      return mailboxes
        .filter((m) => !m.flags.has('\\Noselect'))
        .map((m) => ({ path: m.path }));
    },

    async status(path) {
      const status = await client.status(path, { uidNext: true, uidValidity: true });
      return {
        uidNext: Number(status.uidNext ?? 1),
        uidValidity: Number(status.uidValidity ?? 0),
      };
    },

    async fetchSince(path, uidFrom) {
      const lock = await client.getMailboxLock(path);
      try {
        const out: { uid: number; source: Buffer }[] = [];
        for await (const message of client.fetch(
          `${uidFrom}:*`,
          { uid: true, source: true },
          { uid: true }
        )) {
          // `uid:*` always returns at least one message even when none are new.
          if (message.uid < uidFrom) continue;
          out.push({ uid: message.uid, source: message.source });
        }
        return out;
      } finally {
        lock.release();
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/client.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/imap/client.ts test/client.test.ts
git commit -m "feat: ImapFlow adapter implementing SweepDeps"
```

---

### Task 8: Account watcher

Supervises one account: runs the sweeper on a timer, holds the idler on INBOX to trigger early sweeps, reconnects with backoff, and treats auth failure as fatal for that account only.

**Files:**
- Create: `src/imap/watcher.ts`
- Test: `test/watcher.test.ts`

**Interfaces:**
- Consumes: `createClient`, `imapSweepDeps`, `isAuthError` from `src/imap/client.js`; `sweep` from `src/imap/sweeper.js`; `SeenStore`; `Account`, `NormalizedEmail` from `src/types.js`.
- Produces:
  - `type WatcherState = 'starting' | 'ok' | 'reconnecting' | 'auth-failed' | 'stopped'`
  - `type WatcherOptions = { account: Account; store: SeenStore; previewChars: number; sweepIntervalSeconds: number; onEmail: (e: NormalizedEmail) => Promise<void>; onFatal: (account: Account, message: string) => Promise<void>; deps?: WatcherTestDeps }`
  - `type WatcherTestDeps = { runSweep?: () => Promise<void>; connect?: () => Promise<void>; disconnect?: () => Promise<void>; sleep?: (ms: number) => Promise<void> }`
  - `class AccountWatcher` with `start(): Promise<void>`, `stop(): Promise<void>`, `triggerSweep(): Promise<void>`, `get state(): WatcherState`, `get label(): string`

- [ ] **Step 1: Write the failing test**

Create `test/watcher.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeenStore } from '../src/store/seen.js';
import { AccountWatcher } from '../src/imap/watcher.js';
import type { Account } from '../src/types.js';

const account: Account = {
  label: 'Work',
  host: 'localhost',
  port: 993,
  user: 'me@example.com',
  pass: 'secret',
  secure: true,
};

function withStore<T>(fn: (store: SeenStore) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-'));
  const store = new SeenStore(join(dir, 'test.db'));
  return fn(store).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

describe('AccountWatcher', () => {
  it('sweeps once on start and reports ok', async () => {
    await withStore(async (store) => {
      const runSweep = vi.fn(async () => {});
      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { runSweep, connect: async () => {}, disconnect: async () => {}, sleep: async () => {} },
      });

      await watcher.start();
      expect(runSweep).toHaveBeenCalledTimes(1);
      expect(watcher.state).toBe('ok');
      await watcher.stop();
      expect(watcher.state).toBe('stopped');
    });
  });

  it('marks the account auth-failed and calls onFatal without retrying', async () => {
    await withStore(async (store) => {
      const authError = Object.assign(new Error('bad password'), { authenticationFailed: true });
      const connect = vi.fn(async () => { throw authError; });
      const onFatal = vi.fn(async () => {});

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal,
        deps: { connect, runSweep: async () => {}, disconnect: async () => {}, sleep: async () => {} },
      });

      await watcher.start();

      expect(watcher.state).toBe('auth-failed');
      expect(connect).toHaveBeenCalledTimes(1);
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(onFatal.mock.calls[0]![0]).toBe(account);
      await watcher.stop();
    });
  });

  it('retries a non-auth connection failure with backoff and recovers', async () => {
    await withStore(async (store) => {
      let attempts = 0;
      const connect = vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('ECONNREFUSED');
      });
      const slept: number[] = [];

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: {
          connect,
          runSweep: async () => {},
          disconnect: async () => {},
          sleep: async (ms: number) => { slept.push(ms); },
        },
      });

      await watcher.start();

      expect(connect).toHaveBeenCalledTimes(3);
      expect(watcher.state).toBe('ok');
      expect(slept.length).toBeGreaterThanOrEqual(2);
      expect(slept[1]!).toBeGreaterThan(slept[0]!); // backoff grows
      await watcher.stop();
    });
  });

  it('never sleeps longer than the five minute cap', async () => {
    await withStore(async (store) => {
      let attempts = 0;
      const slept: number[] = [];
      const connect = vi.fn(async () => {
        attempts += 1;
        if (attempts < 15) throw new Error('ECONNREFUSED');
      });

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: {
          connect,
          runSweep: async () => {},
          disconnect: async () => {},
          sleep: async (ms: number) => { slept.push(ms); },
        },
      });

      await watcher.start();
      expect(Math.max(...slept)).toBeLessThanOrEqual(300_000);
      await watcher.stop();
    });
  });

  it('does not reconnect after stop() is called', async () => {
    await withStore(async (store) => {
      const connect = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: {
          connect,
          runSweep: async () => {},
          disconnect: async () => {},
          sleep: async () => { await watcher.stop(); },
        },
      });

      await watcher.start();
      expect(watcher.state).toBe('stopped');
      expect(connect.mock.calls.length).toBeLessThanOrEqual(2);
    });
  });

  it('sweeps again when the idler signals activity', async () => {
    await withStore(async (store) => {
      const runSweep = vi.fn(async () => {});
      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { runSweep, connect: async () => {}, disconnect: async () => {}, sleep: async () => {} },
      });

      await watcher.start();
      expect(runSweep).toHaveBeenCalledTimes(1);

      await watcher.triggerSweep();
      expect(runSweep).toHaveBeenCalledTimes(2);

      await watcher.stop();
    });
  });

  it('does not run two sweeps concurrently', async () => {
    await withStore(async (store) => {
      let active = 0;
      let maxActive = 0;
      const runSweep = vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
      });

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { runSweep, connect: async () => {}, disconnect: async () => {}, sleep: async () => {} },
      });

      await watcher.start();
      await Promise.all([watcher.triggerSweep(), watcher.triggerSweep(), watcher.triggerSweep()]);

      expect(maxActive).toBe(1);
      await watcher.stop();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/watcher.test.ts`
Expected: FAIL — cannot resolve `../src/imap/watcher.js`.

- [ ] **Step 3: Implement `src/imap/watcher.ts`**

```ts
import { ImapFlow } from 'imapflow';
import { createClient, imapSweepDeps, isAuthError } from './client.js';
import { sweep } from './sweeper.js';
import type { SeenStore } from '../store/seen.js';
import type { Account, NormalizedEmail } from '../types.js';

export type WatcherState = 'starting' | 'ok' | 'reconnecting' | 'auth-failed' | 'stopped';

export type WatcherTestDeps = {
  runSweep?: () => Promise<void>;
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

export type WatcherOptions = {
  account: Account;
  store: SeenStore;
  previewChars: number;
  sweepIntervalSeconds: number;
  onEmail: (email: NormalizedEmail) => Promise<void>;
  onFatal: (account: Account, message: string) => Promise<void>;
  deps?: WatcherTestDeps;
};

const MAX_BACKOFF_MS = 300_000;
const IDLE_REFRESH_MS = 9 * 60_000;
const IDLE_WATCHDOG_MS = 12 * 60_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AccountWatcher {
  readonly #opts: WatcherOptions;
  readonly #sleep: (ms: number) => Promise<void>;

  #state: WatcherState = 'starting';
  #stopped = false;
  #sweepChain: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #sweepClient: ImapFlow | null = null;
  #idleClient: ImapFlow | null = null;
  #lastIdleActivity = Date.now();

  constructor(opts: WatcherOptions) {
    this.#opts = opts;
    this.#sleep = opts.deps?.sleep ?? defaultSleep;
  }

  get state(): WatcherState {
    return this.#state;
  }

  get label(): string {
    return this.#opts.account.label;
  }

  async start(): Promise<void> {
    const connected = await this.#connectWithRetry();
    if (!connected) return;

    this.#state = 'ok';
    await this.triggerSweep();
    if (this.#stopped) return;

    this.#timer = setInterval(() => {
      void this.triggerSweep();
    }, this.#opts.sweepIntervalSeconds * 1000);
  }

  /** Queues a sweep. Concurrent calls are serialized, never overlapped. */
  triggerSweep(): Promise<void> {
    const next = this.#sweepChain.then(() => this.#runSweep());
    this.#sweepChain = next.catch(() => undefined);
    return next;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    this.#timer = null;
    this.#idleTimer = null;

    const disconnect = this.#opts.deps?.disconnect;
    if (disconnect) {
      await disconnect();
    } else {
      await this.#sweepClient?.logout().catch(() => undefined);
      await this.#idleClient?.logout().catch(() => undefined);
    }
    this.#sweepClient = null;
    this.#idleClient = null;
    this.#state = 'stopped';
  }

  async #connectWithRetry(): Promise<boolean> {
    for (let attempt = 0; !this.#stopped; attempt += 1) {
      try {
        await this.#connect();
        return true;
      } catch (err) {
        if (isAuthError(err)) {
          this.#state = 'auth-failed';
          const message = `Authentication failed for ${this.#opts.account.label}. Check the mailbox credentials; this account is now stopped.`;
          console.error(`[${this.#opts.account.label}] ${message}`);
          await this.#opts.onFatal(this.#opts.account, message);
          return false;
        }

        this.#state = 'reconnecting';
        const base = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
        const jitter = base * 0.2 * Math.random();
        console.error(
          `[${this.#opts.account.label}] connection failed: ${(err as Error).message}; retrying`
        );
        await this.#sleep(Math.min(base + jitter, MAX_BACKOFF_MS));
      }
    }
    return false;
  }

  async #connect(): Promise<void> {
    const override = this.#opts.deps?.connect;
    if (override) {
      await override();
      return;
    }

    this.#sweepClient = createClient(this.#opts.account);
    await this.#sweepClient.connect();

    this.#idleClient = createClient(this.#opts.account);
    await this.#idleClient.connect();
    await this.#idleClient.mailboxOpen('INBOX');

    // ImapFlow idles automatically on an open mailbox and emits `exists`
    // when the server reports new messages. That is our early-sweep signal.
    this.#idleClient.on('exists', () => {
      this.#lastIdleActivity = Date.now();
      void this.triggerSweep();
    });
    this.#idleClient.on('error', (err: Error) => {
      console.error(`[${this.#opts.account.label}] idler error: ${err.message}`);
    });

    this.#lastIdleActivity = Date.now();
    this.#startIdleWatchdog();
  }

  #startIdleWatchdog(): void {
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    this.#idleTimer = setInterval(() => {
      void this.#checkIdleHealth();
    }, IDLE_REFRESH_MS);
  }

  async #checkIdleHealth(): Promise<void> {
    if (this.#stopped) return;
    const silent = Date.now() - this.#lastIdleActivity;
    const alive = this.#idleClient?.usable === true;

    if (alive && silent < IDLE_WATCHDOG_MS) {
      // Touch the connection so the server and any NAT in between keep it open.
      await this.#idleClient?.noop().catch(() => undefined);
      this.#lastIdleActivity = Date.now();
      return;
    }

    console.error(`[${this.#opts.account.label}] idler stale; reconnecting it`);
    await this.#idleClient?.logout().catch(() => undefined);
    this.#idleClient = null;
    try {
      await this.#connect();
    } catch (err) {
      console.error(
        `[${this.#opts.account.label}] idler reconnect failed: ${(err as Error).message}`
      );
    }
  }

  async #runSweep(): Promise<void> {
    if (this.#stopped || this.#state === 'auth-failed') return;

    const override = this.#opts.deps?.runSweep;
    try {
      if (override) {
        await override();
      } else {
        if (!this.#sweepClient?.usable) throw new Error('sweep client not connected');
        await sweep(imapSweepDeps(this.#sweepClient), {
          accountLabel: this.#opts.account.label,
          previewChars: this.#opts.previewChars,
          store: this.#opts.store,
          onEmail: this.#opts.onEmail,
        });
      }
      this.#state = 'ok';
    } catch (err) {
      this.#state = 'reconnecting';
      console.error(`[${this.#opts.account.label}] sweep failed: ${(err as Error).message}`);
      await this.#sweepClient?.logout().catch(() => undefined);
      this.#sweepClient = null;
      await this.#connectWithRetry();
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/watcher.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/imap/watcher.ts test/watcher.test.ts
git commit -m "feat: account watcher with idle-triggered sweeps, backoff and fatal auth handling"
```

---

### Task 9: Health endpoint and application wiring

Brings everything together into a runnable process with a healthcheck Coolify can use.

**Files:**
- Create: `src/health.ts`
- Create: `src/index.ts`
- Test: `test/health.test.ts`

**Interfaces:**
- Consumes: `AccountWatcher`, `WatcherState` from `src/imap/watcher.js`; `loadConfig`; `SeenStore`; `TelegramSender`; `formatEmail`.
- Produces:
  - `type HealthReport = { status: 'ok' | 'degraded'; accounts: { label: string; state: WatcherState }[] }`
  - `function buildHealthReport(watchers: { label: string; state: WatcherState }[]): HealthReport`
  - `function startHealthServer(port: number, report: () => HealthReport): { port: number; close(): Promise<void> }` — `port` reflects the actual bound port, so tests can pass `0`

- [ ] **Step 1: Write the failing test**

Create `test/health.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildHealthReport, startHealthServer } from '../src/health.js';

describe('buildHealthReport', () => {
  it('reports ok when every account is ok', () => {
    const report = buildHealthReport([{ label: 'Work', state: 'ok' }]);
    expect(report.status).toBe('ok');
    expect(report.accounts).toEqual([{ label: 'Work', state: 'ok' }]);
  });

  it('reports degraded when any account is reconnecting', () => {
    const report = buildHealthReport([
      { label: 'Work', state: 'ok' },
      { label: 'Personal', state: 'reconnecting' },
    ]);
    expect(report.status).toBe('degraded');
  });

  it('reports degraded when an account has failed authentication', () => {
    expect(buildHealthReport([{ label: 'Work', state: 'auth-failed' }]).status).toBe('degraded');
  });

  it('reports degraded with no accounts at all', () => {
    expect(buildHealthReport([]).status).toBe('degraded');
  });
});

describe('startHealthServer', () => {
  it('serves the report as JSON on /healthz', async () => {
    const server = startHealthServer(0, () => buildHealthReport([{ label: 'Work', state: 'ok' }]));
    const port = server.port;

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });

    await server.close();
  });

  it('returns 503 when degraded so Coolify restarts the container', async () => {
    const server = startHealthServer(0, () => buildHealthReport([{ label: 'Work', state: 'auth-failed' }]));
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(503);
    await server.close();
  });

  it('returns 404 for other paths', async () => {
    const server = startHealthServer(0, () => buildHealthReport([{ label: 'Work', state: 'ok' }]));
    const res = await fetch(`http://127.0.0.1:${server.port}/other`);
    expect(res.status).toBe(404);
    await server.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/health.test.ts`
Expected: FAIL — cannot resolve `../src/health.js`.

- [ ] **Step 3: Implement `src/health.ts`**

Note `startHealthServer` also exposes `port`, needed so tests can bind to port 0.

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WatcherState } from './imap/watcher.js';

export type HealthReport = {
  status: 'ok' | 'degraded';
  accounts: { label: string; state: WatcherState }[];
};

export function buildHealthReport(
  watchers: { label: string; state: WatcherState }[]
): HealthReport {
  const healthy = watchers.length > 0 && watchers.every((w) => w.state === 'ok');
  return {
    status: healthy ? 'ok' : 'degraded',
    accounts: watchers.map((w) => ({ label: w.label, state: w.state })),
  };
}

export function startHealthServer(
  port: number,
  report: () => HealthReport
): { port: number; close(): Promise<void> } {
  const server: Server = createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const body = report();
    res.writeHead(body.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  server.listen(port);

  return {
    get port(): number {
      return (server.address() as AddressInfo).port;
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/health.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write `src/index.ts`**

```ts
import { loadConfig } from './config.js';
import { SeenStore } from './store/seen.js';
import { TelegramSender } from './telegram/sender.js';
import { formatEmail } from './mail/format.js';
import { AccountWatcher } from './imap/watcher.js';
import { buildHealthReport, startHealthServer } from './health.js';
import type { Account, NormalizedEmail } from './types.js';

const PRUNE_AFTER_DAYS = 30;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const store = new SeenStore(config.dbPath);
  const sender = new TelegramSender({
    token: config.telegramBotToken,
    chatId: config.telegramChatId,
  });

  const onEmail = async (email: NormalizedEmail): Promise<void> => {
    const outcome = await sender.send(formatEmail(email));
    console.log(
      `[${email.accountLabel}/${email.folder}] ${outcome}: ${email.subject.slice(0, 60)}`
    );
  };

  const onFatal = async (account: Account, message: string): Promise<void> => {
    await sender.send(`⚠️ <b>Email notifier</b>\n${message}`);
  };

  const watchers = config.mailboxes.map(
    (account) =>
      new AccountWatcher({
        account,
        store,
        previewChars: config.previewChars,
        sweepIntervalSeconds: config.sweepIntervalSeconds,
        onEmail,
        onFatal,
      })
  );

  const health = startHealthServer(config.healthPort, () =>
    buildHealthReport(watchers.map((w) => ({ label: w.label, state: w.state })))
  );

  const pruneTimer = setInterval(() => {
    const removed = store.prune(PRUNE_AFTER_DAYS);
    if (removed > 0) console.log(`pruned ${removed} seen-message records`);
  }, PRUNE_INTERVAL_MS);

  console.log(`watching ${watchers.length} mailbox(es); health on :${config.healthPort}`);
  await Promise.all(watchers.map((w) => w.start()));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    clearInterval(pruneTimer);
    await Promise.all(watchers.map((w) => w.stop()));
    await health.close();
    store.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
```

- [ ] **Step 6: Verify the build compiles and the whole suite passes**

Run: `npm run build && npm test`
Expected: `tsc` produces `dist/` with no errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/health.ts src/index.ts test/health.test.ts
git commit -m "feat: health endpoint and application wiring with graceful shutdown"
```

---

### Task 10: Docker image and Coolify deployment

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `README.md`

**Interfaces:**
- Consumes: `npm run build` producing `dist/index.js`; the env vars defined in Task 1.
- Produces: a runnable image whose healthcheck hits `/healthz`.

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
dist
.git
.env
data
test
docs
```

- [ ] **Step 2: Write the `Dockerfile`**

`better-sqlite3` needs a compiler in the build stage; the runtime stage gets only the compiled output.

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
services:
  notifier:
    build: .
    restart: unless-stopped
    environment:
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN}
      TELEGRAM_CHAT_ID: ${TELEGRAM_CHAT_ID}
      MAILBOXES: ${MAILBOXES}
      SWEEP_INTERVAL_SECONDS: ${SWEEP_INTERVAL_SECONDS:-60}
      PREVIEW_CHARS: ${PREVIEW_CHARS:-200}
      DB_PATH: /data/seen.db
      HEALTH_PORT: 8080
    volumes:
      - notifier-data:/data

volumes:
  notifier-data:
```

- [ ] **Step 4: Write `.env.example`**

```
# From @BotFather after /newbot
TELEGRAM_BOT_TOKEN=123456789:AAHexampleTokenValue

# Message your bot, then read result[0].message.chat.id from
# https://api.telegram.org/bot<TOKEN>/getUpdates
TELEGRAM_CHAT_ID=987654321

# JSON array. Hostinger: imap.hostinger.com:993. Titan plans: imap.titan.email:993
MAILBOXES=[{"label":"Work","host":"imap.hostinger.com","port":993,"user":"me@example.com","pass":"your-mailbox-password"}]

SWEEP_INTERVAL_SECONDS=60
PREVIEW_CHARS=200
```

- [ ] **Step 5: Write `README.md`**

````markdown
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

## Deploy on Coolify

1. New Resource → Docker Compose (or Dockerfile) → point at this repository.
2. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `MAILBOXES` as environment
   variables. Mark them as secrets.
3. Add a persistent volume mounted at `/data` so the dedup database survives redeploys.
4. Set the healthcheck to `GET /healthz` on port 8080.
5. Deploy.

## Behaviour

- The first run against a mailbox notifies nothing — it records a baseline so your
  history is not dumped into Telegram.
- Every notified `Message-ID` is remembered, so mail moved between folders notifies once.
- INBOX is near-instant; other folders are checked every `SWEEP_INTERVAL_SECONDS`.
- A wrong password stops that one account and sends you a Telegram alert. Other
  accounts keep running.

## Configuration

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | yes | — | Chat to send notifications to |
| `MAILBOXES` | yes | — | JSON array of `{label, host, port, user, pass}` |
| `SWEEP_INTERVAL_SECONDS` | no | `60` | Non-INBOX folder check interval |
| `PREVIEW_CHARS` | no | `200` | Body preview length |
| `DB_PATH` | no | `/data/seen.db` | SQLite location |
| `HEALTH_PORT` | no | `8080` | Health server port |
````

- [ ] **Step 6: Verify the image builds and starts**

```bash
docker build -t email-notifier .
docker run --rm -e TELEGRAM_BOT_TOKEN=x -e TELEGRAM_CHAT_ID=y \
  -e MAILBOXES='[]' email-notifier
```

Expected: exits non-zero with `fatal: MAILBOXES is invalid: (root): MAILBOXES must contain at least one mailbox`. This confirms config validation runs at boot inside the image.

- [ ] **Step 7: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml .env.example README.md
git commit -m "feat: Docker image, compose file and Coolify deployment docs"
```

---

### Task 11: End-to-end integration test against a real IMAP server

The test that actually proves the thing works. GreenMail is a real IMAP server, so this exercises `imapSweepDeps`, UID handling, and the full pipeline.

**Files:**
- Create: `test/integration/e2e.test.ts`
- Modify: `package.json` — add `test:integration` script
- Create: `test/integration/docker-compose.test.yml`

**Interfaces:**
- Consumes: everything built so far.
- Produces: no new source interfaces.

- [ ] **Step 1: Add the GreenMail compose file**

Create `test/integration/docker-compose.test.yml`:

```yaml
services:
  greenmail:
    image: greenmail/standalone:2.1.0
    environment:
      GREENMAIL_OPTS: >-
        -Dgreenmail.setup.test.all
        -Dgreenmail.users=tester:testpass@localhost
        -Dgreenmail.verbose
    ports:
      - '3143:3143'
      - '3025:3025'
```

- [ ] **Step 2: Add the integration script**

```bash
npm pkg set scripts.test:integration="vitest run test/integration"
npm install -D nodemailer @types/nodemailer
```

- [ ] **Step 3: Write the integration test**

Create `test/integration/e2e.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { SeenStore } from '../../src/store/seen.js';
import { sweep } from '../../src/imap/sweeper.js';
import { imapSweepDeps } from '../../src/imap/client.js';
import { formatEmail } from '../../src/mail/format.js';
import type { NormalizedEmail } from '../../src/types.js';

const IMAP = { host: '127.0.0.1', port: 3143, secure: false, auth: { user: 'tester', pass: 'testpass' } };
const SMTP = { host: '127.0.0.1', port: 3025, secure: false };

let dir: string;
let store: SeenStore;
let client: ImapFlow;

async function sendMail(subject: string, messageId: string): Promise<void> {
  const transport = nodemailer.createTransport(SMTP);
  await transport.sendMail({
    from: 'Alice <alice@example.com>',
    to: 'tester@localhost',
    subject,
    text: 'This is the body of the test message.',
    messageId,
  });
}

/** Polls until the folder reports at least `count` messages, or times out. */
async function waitForCount(path: string, count: number): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const status = await client.status(path, { messages: true });
    if ((status.messages ?? 0) >= count) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${count} messages in ${path}`);
}

beforeAll(async () => {
  client = new ImapFlow({ ...IMAP, logger: false });
  await client.connect();
}, 30_000);

afterAll(async () => {
  await client.logout().catch(() => undefined);
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  store = new SeenStore(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function collector() {
  const received: NormalizedEmail[] = [];
  return {
    received,
    opts: {
      accountLabel: 'Test',
      previewChars: 200,
      store,
      onEmail: async (email: NormalizedEmail) => {
        received.push(email);
      },
    },
  };
}

describe('end to end against GreenMail', () => {
  it('notifies once for a new message and never again', async () => {
    const deps = imapSweepDeps(client);
    const first = collector();

    // Baseline sweep: whatever is already there must not notify.
    await sweep(deps, first.opts);
    expect(first.received).toHaveLength(0);

    const id = `<e2e-${Date.now()}@example.com>`;
    await sendMail('Integration test message', id);
    await waitForCount('INBOX', 1);

    const second = collector();
    await sweep(deps, second.opts);

    expect(second.received).toHaveLength(1);
    expect(second.received[0]!.subject).toBe('Integration test message');
    expect(second.received[0]!.preview).toContain('body of the test message');

    // A repeat sweep with nothing new must be silent.
    const third = collector();
    await sweep(deps, third.opts);
    expect(third.received).toHaveLength(0);
  }, 60_000);

  it('produces a Telegram-safe message under the size limit', async () => {
    const deps = imapSweepDeps(client);
    const baseline = collector();
    await sweep(deps, baseline.opts);

    await sendMail('Subject with <angle> & ampersand', `<e2e-esc-${Date.now()}@example.com>`);
    await waitForCount('INBOX', 1);

    const run = collector();
    await sweep(deps, run.opts);

    expect(run.received.length).toBeGreaterThanOrEqual(1);
    const html = formatEmail(run.received.at(-1)!);
    expect(html).toContain('&lt;angle&gt;');
    expect(html).toContain('&amp; ampersand');
    expect(html.length).toBeLessThanOrEqual(4096);
  }, 60_000);

  it('does not re-notify a message that is copied to another folder', async () => {
    const deps = imapSweepDeps(client);
    await client.mailboxCreate('Archive').catch(() => undefined);

    const baseline = collector();
    await sweep(deps, baseline.opts);

    const id = `<e2e-move-${Date.now()}@example.com>`;
    await sendMail('Message that will move', id);
    await waitForCount('INBOX', 1);

    const run = collector();
    await sweep(deps, run.opts);
    const notified = run.received.filter((e) => e.messageId === id);
    expect(notified).toHaveLength(1);

    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageCopy({ header: { 'message-id': id } }, 'Archive');
    } finally {
      lock.release();
    }
    await waitForCount('Archive', 1);

    const after = collector();
    await sweep(deps, after.opts);
    expect(after.received.filter((e) => e.messageId === id)).toHaveLength(0);
  }, 60_000);
});
```

- [ ] **Step 4: Start GreenMail and run the integration test**

```bash
docker compose -f test/integration/docker-compose.test.yml up -d
sleep 5
npm run test:integration
docker compose -f test/integration/docker-compose.test.yml down
```

Expected: 3 tests pass. The third is the one that proves the "watch every folder" duplicate problem is actually solved.

- [ ] **Step 5: Run the whole suite one final time**

```bash
npm run build && npm test
```

Expected: build clean, all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add test/integration package.json package-lock.json
git commit -m "test: end-to-end integration coverage against a real IMAP server"
```

---

## Verification checklist

Before declaring the project complete, confirm each of the spec's success criteria:

- [ ] INBOX mail notifies within ~5s (idler triggers an early sweep)
- [ ] Other folders notify within `SWEEP_INTERVAL_SECONDS`
- [ ] No email notifies twice, including after a folder move (Task 11, test 3)
- [ ] First boot against a mailbox notifies nothing (Task 6, test 1)
- [ ] A dropped connection delays but does not lose mail (Task 6, test 6 and Task 8, test 3)
- [ ] Container restarts cleanly and keeps its dedup state (`/data` volume)
- [ ] `docker build` succeeds and the healthcheck reports `ok` with valid credentials
