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
const IMAP_USER = 'tester';
const IMAP_PASS = 'testpass';
const IMAP = { host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user: IMAP_USER, pass: IMAP_PASS } };
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

/** Looks up the server-assigned UID for a message by its Message-ID. */
async function uidFor(path: string, messageId: string): Promise<number> {
  const lock = await client.getMailboxLock(path);
  try {
    const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
    if (uids === false || uids.length === 0) {
      throw new Error(`no UID found for message ${messageId} in ${path}`);
    }
    return uids[0]!;
  } finally {
    lock.release();
  }
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
    // Isolation-safe: failures is asserted empty above, so this only requires
    // INBOX itself (always present on any mailbox, never created by another
    // test) to have been swept successfully — it does not depend on any
    // other test having created an extra mailbox.
    expect(result.foldersChecked).toBeGreaterThan(0);

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
    // Guards against this passing vacuously: with zero folders returned by
    // deps.list(), there would trivially be no fetch and no notification too.
    // Isolation-safe for the same reason as the previous test: failures is
    // empty, so this only requires INBOX itself to have succeeded, not any
    // mailbox created by another test.
    expect(result.foldersChecked).toBeGreaterThan(0);
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

    // The sweeper sorts fetched messages by UID and aborts the folder on the
    // first throw (see sweeper.ts), so this test's behaviour depends on
    // okId's UID being lower than failId's. Sequential, awaited sends make
    // that true in practice, but assert it explicitly against the real
    // server rather than leaving it as an invisible assumption — this is
    // what would catch a regression if the sends were ever parallelised.
    const okUid = await uidFor('INBOX', okId);
    const failUid = await uidFor('INBOX', failId);
    expect(okUid).toBeLessThan(failUid);

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
    // INBOX itself is the folder that fails here — that's the point of this
    // test — so `foldersChecked` (which only counts successes) is 0 for a
    // mailbox where INBOX is the only folder, and asserting it's >0 would
    // make this test depend on some other test having created an extra
    // (successfully-swept) mailbox like Archive first. Assert what's actually
    // true instead: the failure names INBOX (proving it was listed, selected,
    // and genuinely attempted), and the total attempted — checked plus
    // failed — is non-zero, which is the real anti-vacuity guard for a sweep
    // whose only folder is expected to fail.
    expect(firstResult.failures).toContainEqual(expect.objectContaining({ folder: 'INBOX' }));
    expect(firstResult.foldersChecked + firstResult.failures.length).toBeGreaterThan(0);

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
    // Isolation-safe: failures is empty here (every folder succeeds on this
    // retry sweep), so this only requires INBOX itself to have succeeded,
    // not any mailbox created by another test.
    expect(secondResult.foldersChecked).toBeGreaterThan(0);

    // failId is now delivered, exactly once overall; okId was not re-sent.
    const failDeliveries = delivered.filter((e) => e.messageId === failId);
    const okDeliveries = delivered.filter((e) => e.messageId === okId);
    expect(failDeliveries).toHaveLength(1);
    expect(okDeliveries).toHaveLength(1);
  });

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

    // Seed real per-account state in the SeenStore, as production would have
    // accumulated it from real sweeps, so purgeAccount has something genuine
    // to prove it purges. A fake watcher factory never calls
    // setFolderState/markSeen itself, so without this seeding the assertions
    // below would be vacuously true even if purgeAccount did nothing.
    store.setFolderState('Live', 'INBOX', { uidNext: 42, uidValidity: 7 });
    store.markSeen('Live', '<live-message@example.com>');
    expect(store.getFolderState('Live', 'INBOX')).toEqual({ uidNext: 42, uidValidity: 7 });
    expect(store.hasSeen('Live', '<live-message@example.com>')).toBe(true);

    // A second, untouched account proves purgeAccount('Live') is scoped to
    // its own label and does not collaterally wipe another account's state.
    store.setFolderState('Other', 'INBOX', { uidNext: 99, uidValidity: 3 });
    store.markSeen('Other', '<other-message@example.com>');

    await registry.remove('Live');
    mb.remove('Live');
    const purged = store.purgeAccount('Live');

    expect(stopped).toEqual(['Live']);
    expect(registry.has('Live')).toBe(false);
    expect(mb.get('Live')).toBeNull();
    // Non-zero purge count: a no-op purgeAccount could not satisfy this.
    expect(purged).toBeGreaterThan(0);
    expect(store.getFolderState('Live', 'INBOX')).toBeNull();
    expect(store.hasSeen('Live', '<live-message@example.com>')).toBe(false);

    // Cross-account isolation: 'Other' is untouched by purging 'Live'.
    expect(store.getFolderState('Other', 'INBOX')).toEqual({ uidNext: 99, uidValidity: 3 });
    expect(store.hasSeen('Other', '<other-message@example.com>')).toBe(true);

    mb.close();
  }, 60_000);
});
