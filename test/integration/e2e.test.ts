// End-to-end test against a REAL IMAP server (GreenMail), not the mocked
// SweepDeps used by test/sweeper.test.ts. Start GreenMail first:
//
//   docker compose -f test/integration/docker-compose.test.yml up -d
//   npm run test:integration
//   docker compose -f test/integration/docker-compose.test.yml down
//
// This suite proves properties the mocked unit suite cannot: real UID
// semantics from the server, real STATUS behavior, and that the sweeper's
// uidNext short-circuit actually avoids a real FETCH call.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
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

const IMAP_HOST = '127.0.0.1';
const IMAP_PORT = 3143;
const IMAP = { host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user: 'tester', pass: 'testpass' } };
const SMTP = { host: '127.0.0.1', port: 3025, secure: false };
const START_COMMAND = 'docker compose -f test/integration/docker-compose.test.yml up -d';

let dir: string;
let store: SeenStore;
let client: ImapFlow;
let testCounter = 0;

/**
 * Connects to GreenMail, retrying until the server genuinely accepts a
 * login or the deadline passes. GreenMail's container reports "started"
 * well before its IMAP listener is ready to authenticate, so a fixed sleep
 * before the first connect is not reliable; polling a real login is.
 */
async function connectWithRetry(timeoutMs: number): Promise<ImapFlow> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const candidate = new ImapFlow({ ...IMAP, logger: false });
    try {
      await candidate.connect();
      return candidate;
    } catch (err) {
      lastErr = err;
      await candidate.logout().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `GreenMail IMAP server was not reachable at ${IMAP_HOST}:${IMAP_PORT} after ${timeoutMs}ms.\n` +
      `Start it first with:\n\n    ${START_COMMAND}\n\n` +
      `Last connection error: ${detail}`
  );
}

async function sendMail(subject: string, messageId: string): Promise<void> {
  const transport = nodemailer.createTransport(SMTP);
  try {
    await transport.sendMail({
      from: 'Alice <alice@example.com>',
      to: 'tester@localhost',
      subject,
      text: 'This is the body of the test message.',
      messageId,
    });
  } finally {
    transport.close();
  }
}

/** Polls until `path` reports at least `count` messages, or times out. */
async function waitForCount(path: string, count: number): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const status = await client.status(path, { messages: true });
    if ((status.messages ?? 0) >= count) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${count} messages in ${path}`);
}

async function currentCount(path: string): Promise<number> {
  const status = await client.status(path, { messages: true });
  return status.messages ?? 0;
}

/** Unique per test-run AND per call, so retries within a test never collide. */
function uniqueId(label: string): string {
  testCounter += 1;
  return `<e2e-${label}-${Date.now()}-${testCounter}-${Math.random().toString(36).slice(2)}@example.com>`;
}

beforeAll(async () => {
  client = await connectWithRetry(30_000);
}, 40_000);

afterAll(async () => {
  // client is left undefined if beforeAll's connectWithRetry threw (GreenMail
  // unreachable); in that case the actionable error from beforeAll is the
  // only failure that should be reported, not a confusing follow-on
  // TypeError here.
  if (client) await client.logout().catch(() => undefined);
});

// A fresh SeenStore (and therefore a fresh, empty folder_state/seen_by_account)
// per test means each test's first sweep() re-baselines against whatever is
// currently in the real mailbox — including leftover mail from earlier tests
// in this same suite run — and notifies nothing for it. That is what makes
// these tests independent of execution order despite sharing one GreenMail
// mailbox: no test depends on the mailbox being empty, only on its own sweep
// baseline being fresh.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  store = new SeenStore(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function collector(accountLabel = 'Test') {
  const received: NormalizedEmail[] = [];
  return {
    received,
    opts: {
      accountLabel,
      previewChars: 200,
      store,
      onEmail: async (email: NormalizedEmail) => {
        received.push(email);
      },
    },
  };
}

describe('end to end against a real IMAP server (GreenMail)', () => {
  it('notifies nothing on the baseline sweep, then delivers a new message exactly once with correct fields', async () => {
    const deps = imapSweepDeps(client);
    const baseline = collector();
    await sweep(deps, baseline.opts);
    expect(baseline.received).toHaveLength(0);

    const id = uniqueId('baseline-deliver');
    const before = await currentCount('INBOX');
    await sendMail('Integration test message', id);
    await waitForCount('INBOX', before + 1);

    const run = collector();
    const result = await sweep(deps, run.opts);
    expect(result.failures).toEqual([]);

    const delivered = run.received.filter((e) => e.messageId === id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.subject).toBe('Integration test message');
    expect(delivered[0]!.from).toContain('alice@example.com');
    expect(delivered[0]!.preview).toContain('body of the test message');
  });

  it('does not re-notify and does not fetch when a sweep finds nothing new (uidNext short-circuit)', async () => {
    const deps = imapSweepDeps(client);
    const baseline = collector();
    await sweep(deps, baseline.opts);

    const id = uniqueId('no-refetch');
    const before = await currentCount('INBOX');
    await sendMail('Message for no-refetch test', id);
    await waitForCount('INBOX', before + 1);

    const delivery = collector();
    await sweep(deps, delivery.opts);
    expect(delivery.received.filter((e) => e.messageId === id)).toHaveLength(1);

    // Nothing new has arrived since. The sweeper must short-circuit on the
    // uidNext comparison before ever calling fetchSince — a real FETCH here
    // would be wasted IMAP traffic on every idle sweep in production.
    const fetchSpy = vi.spyOn(deps, 'fetchSince');
    const quiet = collector();
    const result = await sweep(deps, quiet.opts);

    expect(quiet.received).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
    fetchSpy.mockRestore();
  });

  it('does not re-notify a message copied into another folder under the same account', async () => {
    const deps = imapSweepDeps(client);
    await client.mailboxCreate('Archive').catch(() => undefined);

    const baseline = collector('SameAccount');
    await sweep(deps, baseline.opts);

    const id = uniqueId('copy-dedup');
    const before = await currentCount('INBOX');
    await sendMail('Message that will be copied', id);
    await waitForCount('INBOX', before + 1);

    const first = collector('SameAccount');
    await sweep(deps, first.opts);
    expect(first.received.filter((e) => e.messageId === id)).toHaveLength(1);

    const archiveBefore = await currentCount('Archive');
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageCopy({ header: { 'message-id': id } }, 'Archive');
    } finally {
      lock.release();
    }
    await waitForCount('Archive', archiveBefore + 1);

    // Same account label ('SameAccount') on both sweeps: dedup is per
    // account, so this is the case the brief calls out as the one that must
    // produce zero additional notifications.
    const after = collector('SameAccount');
    await sweep(deps, after.opts);
    expect(after.received.filter((e) => e.messageId === id)).toHaveLength(0);
  });

  it('delivers every message from a real multi-message UID range with no gap and no duplicate', async () => {
    const deps = imapSweepDeps(client);
    const baseline = collector();
    await sweep(deps, baseline.opts);

    const ids = [
      uniqueId('uid-range-1'),
      uniqueId('uid-range-2'),
      uniqueId('uid-range-3'),
      uniqueId('uid-range-4'),
      uniqueId('uid-range-5'),
    ];
    const before = await currentCount('INBOX');
    for (const [i, id] of ids.entries()) {
      await sendMail(`UID range message ${i + 1}`, id);
    }
    await waitForCount('INBOX', before + ids.length);

    const run = collector();
    await sweep(deps, run.opts);

    const receivedIds = run.received.map((e) => e.messageId).filter((id) => ids.includes(id));
    // No duplicates.
    expect(new Set(receivedIds).size).toBe(receivedIds.length);
    // No gaps: every sent id was delivered exactly once.
    expect(receivedIds.sort()).toEqual([...ids].sort());

    // A repeat sweep must not re-deliver any of them (validates the
    // `uid < uidFrom` guard against a real server's `uidFrom:*` response,
    // which always returns at least one message even when nothing is new).
    const repeat = collector();
    await sweep(deps, repeat.opts);
    expect(repeat.received.filter((e) => ids.includes(e.messageId))).toHaveLength(0);
  });

  it('produces Telegram-safe escaped HTML under the size limit for a subject with <, >, and &', async () => {
    const deps = imapSweepDeps(client);
    const baseline = collector();
    await sweep(deps, baseline.opts);

    const id = uniqueId('escaping');
    const before = await currentCount('INBOX');
    await sendMail('Subject with <angle> & ampersand', id);
    await waitForCount('INBOX', before + 1);

    const run = collector();
    await sweep(deps, run.opts);

    const email = run.received.find((e) => e.messageId === id);
    expect(email).toBeDefined();

    const html = formatEmail(email!);
    expect(html).toContain('&lt;angle&gt;');
    expect(html).toContain('&amp; ampersand');
    expect(html).not.toContain('<angle>');
    expect(html.length).toBeLessThanOrEqual(4096);
  });

  it('retries and eventually delivers a message whose first send attempt failed (at-least-once, no lost mail)', async () => {
    const deps = imapSweepDeps(client);
    const baseline = collector('Retry');
    await sweep(deps, baseline.opts);

    const okId = uniqueId('retry-ok');
    const failId = uniqueId('retry-fail');
    const before = await currentCount('INBOX');
    await sendMail('Delivered on first try', okId);
    await sendMail('Fails once then delivers', failId);
    await waitForCount('INBOX', before + 2);

    const delivered: NormalizedEmail[] = [];
    const firstAttempt = {
      accountLabel: 'Retry',
      previewChars: 200,
      store,
      onEmail: async (email: NormalizedEmail) => {
        if (email.messageId === failId) {
          throw new Error('simulated telegram outage');
        }
        delivered.push(email);
      },
    };

    const firstResult = await sweep(deps, firstAttempt);
    // The folder sweep failed overall (because the batch didn't complete),
    // and that failure is surfaced rather than swallowed.
    expect(firstResult.failures.length).toBeGreaterThan(0);
    expect(delivered.map((e) => e.messageId)).toContain(okId);
    expect(delivered.map((e) => e.messageId)).not.toContain(failId);

    const secondAttempt = {
      accountLabel: 'Retry',
      previewChars: 200,
      store,
      onEmail: async (email: NormalizedEmail) => {
        delivered.push(email);
      },
    };
    const secondResult = await sweep(deps, secondAttempt);
    expect(secondResult.failures).toEqual([]);

    // failId is now delivered, exactly once overall; okId was not re-sent.
    const failDeliveries = delivered.filter((e) => e.messageId === failId);
    const okDeliveries = delivered.filter((e) => e.messageId === okId);
    expect(failDeliveries).toHaveLength(1);
    expect(okDeliveries).toHaveLength(1);
  });
});
