import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeenStore } from '../src/store/seen.js';
import { sweep, MAX_MESSAGES_PER_SWEEP, type SweepDeps } from '../src/imap/sweeper.js';
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
  const fetchCalls: { path: string; uidFrom: number; maxMessages: number }[] = [];
  const deps: SweepDeps = {
    async list() {
      return Object.keys(folders).map((path) => ({ path }));
    },
    async status(path) {
      const f = folders[path]!;
      return { uidNext: f.uidNext, uidValidity: f.uidValidity };
    },
    async fetchSince(path, uidFrom, maxMessages) {
      fetchCalls.push({ path, uidFrom, maxMessages });
      // Mirrors the real imapSweepDeps.fetchSince behaviour: ascending UID
      // order, capped at maxMessages, so tests can exercise truncation.
      return folders[path]!.messages
        .filter((m) => m.uid >= uidFrom)
        .sort((a, b) => a.uid - b.uid)
        .slice(0, maxMessages);
    },
  };
  return { deps, fetchCalls };
}

function makeOpts(onEmail: (e: NormalizedEmail) => Promise<void>, accountLabel = 'Work') {
  return { accountLabel, mailboxAddress: 'me@work.example', previewChars: 200, store, onEmail };
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

    const result = await sweep(deps, makeOpts(async () => { throw new Error('telegram down'); }));
    expect(result.failures).toEqual([{ folder: 'INBOX', message: 'telegram down' }]);
    expect(store.getFolderState('Work', 'INBOX')!.uidNext).toBe(10);
  });

  it('continues to other folders when one folder fails, and reports the failure in the result', async () => {
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

    const result = await sweep(deps, makeOpts(onEmail));

    expect(store.getFolderState('Work', 'Fine')).toEqual({ uidNext: 4, uidValidity: 1 });
    expect(store.getFolderState('Work', 'Broken')).toBeNull();
    expect(result.foldersChecked).toBe(1);
    expect(result.failures).toEqual([{ folder: 'Broken', message: 'NO permission denied' }]);
  });

  it('delivers a message on retry after a failed send, without re-delivering messages already handled in the same batch', async () => {
    const folders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps } = makeDeps(folders);

    await sweep(deps, makeOpts(async () => {}));

    folders.INBOX.uidNext = 12;
    folders.INBOX.messages = [
      { uid: 10, source: eml('ok', 'Delivered first') },
      { uid: 11, source: eml('boom', 'Fails first time') },
    ];

    const delivered: string[] = [];
    let shouldThrow = true;
    const onEmail = vi.fn(async (email: NormalizedEmail) => {
      if (email.subject === 'Fails first time' && shouldThrow) {
        throw new Error('telegram down');
      }
      delivered.push(email.subject);
    });

    await sweep(deps, makeOpts(onEmail));
    expect(delivered).toEqual(['Delivered first']);
    // State must not have advanced, since the batch didn't fully succeed.
    expect(store.getFolderState('Work', 'INBOX')!.uidNext).toBe(10);

    shouldThrow = false;
    await sweep(deps, makeOpts(onEmail));

    // The previously-failed message is now delivered; the already-delivered
    // one is not delivered a second time.
    expect(delivered).toEqual(['Delivered first', 'Fails first time']);
    expect(store.getFolderState('Work', 'INBOX')).toEqual({ uidNext: 12, uidValidity: 1 });
  });

  it('re-baselines and self-heals when uidNext moves backward without a uidValidity change', async () => {
    const folders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps, fetchCalls } = makeDeps(folders);
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail));

    // Mailbox restore / non-compliant server: uidNext drops without uidValidity changing.
    folders.INBOX.uidNext = 4;
    folders.INBOX.messages = [{ uid: 3, source: eml('restored', 'Restored') }];

    await sweep(deps, makeOpts(onEmail));

    expect(onEmail).not.toHaveBeenCalled();
    expect(fetchCalls).toHaveLength(0);
    expect(store.getFolderState('Work', 'INBOX')).toEqual({ uidNext: 4, uidValidity: 1 });

    // The folder should now behave normally against the new baseline.
    folders.INBOX.uidNext = 5;
    folders.INBOX.messages.push({ uid: 4, source: eml('after-heal', 'After heal') });
    await sweep(deps, makeOpts(onEmail));

    expect(onEmail).toHaveBeenCalledTimes(1);
  });

  it('fetches from exactly the stored uidNext floor', async () => {
    const folders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps, fetchCalls } = makeDeps(folders);
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail));

    folders.INBOX.uidNext = 15;
    folders.INBOX.messages = [{ uid: 10, source: eml('x', 'X') }];
    await sweep(deps, makeOpts(onEmail));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.uidFrom).toBe(10);
  });

  it('notifies once per account when the same Message-ID reaches two different accounts (dedup is scoped per account, not global)', async () => {
    const workFolders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
    };
    const personalFolders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps: workDeps } = makeDeps(workFolders);
    const { deps: personalDeps } = makeDeps(personalFolders);
    const onEmail = vi.fn(async () => {});

    // Baseline both accounts first.
    await sweep(workDeps, makeOpts(onEmail, 'Work'));
    await sweep(personalDeps, makeOpts(onEmail, 'Personal'));

    // The identical message (same Message-ID) genuinely arrives in both
    // mailboxes — e.g. it was BCC'd to both, or forwarded.
    workFolders.INBOX.uidNext = 11;
    workFolders.INBOX.messages = [{ uid: 10, source: eml('shared', 'Shared message') }];
    personalFolders.INBOX.uidNext = 11;
    personalFolders.INBOX.messages = [{ uid: 10, source: eml('shared', 'Shared message') }];

    await sweep(workDeps, makeOpts(onEmail, 'Work'));
    await sweep(personalDeps, makeOpts(onEmail, 'Personal'));

    // One notification per mailbox that actually received it, not one total.
    expect(onEmail).toHaveBeenCalledTimes(2);
  });

  // --- Finding 2: a persistent markSeen failure must not cause an
  // unbounded duplicate-notification storm ---
  //
  // markSeen is a synchronous better-sqlite3 write; if it throws
  // (SQLITE_FULL, read-only volume, corruption) after onEmail already
  // resolved, folder state must not simply stay unadvanced — hasSeen would
  // keep returning false forever, and every following sweep would resend
  // the same message to Telegram indefinitely. The fix escalates the
  // failure distinctly and advances folder state past exactly the poisoned
  // message so it can never be refetched, trading the "seen" record for
  // that one message for a hard stop on the resend storm.

  it('escalates a persistent markSeen failure instead of resending forever, sending exactly once across several sweeps', async () => {
    const folders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps } = makeDeps(folders);
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail));

    folders.INBOX.uidNext = 11;
    folders.INBOX.messages = [{ uid: 10, source: eml('poison', 'Poison') }];

    vi.spyOn(store, 'markSeen').mockImplementation(() => {
      throw new Error('SQLITE_FULL: database or disk is full');
    });

    const result1 = await sweep(deps, makeOpts(onEmail));
    expect(onEmail).toHaveBeenCalledTimes(1);
    expect(result1.failures).toHaveLength(1);
    // The failure must be clearly distinguishable from an ordinary onEmail
    // failure (e.g. "telegram down") so an operator can tell storage is
    // broken rather than the notification path.
    expect(result1.failures[0]!.message).toMatch(/storage failure/i);
    expect(store.getFolderState('Work', 'INBOX')!.uidNext).toBe(11);

    // Repeated sweeps: the message and the underlying markSeen failure are
    // both unchanged, but folder state already advanced past uid 10, so
    // there is nothing left to refetch and no further send happens.
    await sweep(deps, makeOpts(onEmail));
    await sweep(deps, makeOpts(onEmail));

    expect(onEmail).toHaveBeenCalledTimes(1);
  });

  it('stops the folder at the poisoned message but still delivers later messages in the batch once the storage failure clears', async () => {
    const folders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps } = makeDeps(folders);
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail));

    folders.INBOX.uidNext = 13;
    folders.INBOX.messages = [
      { uid: 10, source: eml('first', 'First') },
      { uid: 11, source: eml('poison', 'Poison') },
      { uid: 12, source: eml('third', 'Third') },
    ];

    const realMarkSeen = store.markSeen.bind(store);
    const spy = vi.spyOn(store, 'markSeen').mockImplementation((accountLabel, messageId) => {
      if (messageId.includes('poison')) throw new Error('SQLITE_FULL: database or disk is full');
      return realMarkSeen(accountLabel, messageId);
    });

    const result = await sweep(deps, makeOpts(onEmail));

    // "First" was delivered and marked seen normally; "Poison" was sent
    // (onEmail already resolved before markSeen threw) but the folder must
    // stop there — "Third" is left untouched for a later sweep rather than
    // being fetched-and-discarded.
    const subjects = onEmail.mock.calls.map((c) => (c[0] as NormalizedEmail).subject);
    expect(subjects).toEqual(['First', 'Poison']);
    expect(result.failures).toHaveLength(1);
    expect(store.getFolderState('Work', 'INBOX')!.uidNext).toBe(12); // poison uid + 1, not 13

    // Storage recovers: markSeen works again.
    spy.mockRestore();

    await sweep(deps, makeOpts(onEmail));

    const subjectsAfterRecovery = onEmail.mock.calls.map((c) => (c[0] as NormalizedEmail).subject);
    expect(subjectsAfterRecovery).toEqual(['First', 'Poison', 'Third']); // delivered exactly once each
    expect(store.getFolderState('Work', 'INBOX')!.uidNext).toBe(13);

    // No further sends on later sweeps: everything has been handled.
    await sweep(deps, makeOpts(onEmail));
    expect(onEmail).toHaveBeenCalledTimes(3);
  });

  // --- Finding 3: fetchSince must be batch-capped, and a truncated batch
  // must advance folder state only to (highest processed uid) + 1, never
  // to current.uidNext ---
  //
  // Without a cap, a user bulk-archiving hundreds of messages makes the next
  // sweep buffer every one of their full raw sources into memory at once.
  // Capping the batch is only safe if folder state advances to match what
  // was actually processed; advancing all the way to current.uidNext after
  // a truncated batch would silently skip every message beyond the cap.

  it('caps a single sweep at MAX_MESSAGES_PER_SWEEP and advances state only past the highest uid actually processed', async () => {
    const totalNew = MAX_MESSAGES_PER_SWEEP + 5;
    const folders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps, fetchCalls } = makeDeps(folders);
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail)); // baseline

    folders.INBOX.uidNext = 10 + totalNew;
    folders.INBOX.messages = Array.from({ length: totalNew }, (_, i) => ({
      uid: 10 + i,
      source: eml(`m${i}`, `Subject ${i}`),
    }));

    const result = await sweep(deps, makeOpts(onEmail));

    expect(fetchCalls.at(-1)!.maxMessages).toBe(MAX_MESSAGES_PER_SWEEP);
    expect(onEmail).toHaveBeenCalledTimes(MAX_MESSAGES_PER_SWEEP);
    // Advances only to (highest processed uid) + 1 = 10 + MAX, NOT to
    // current.uidNext (10 + totalNew) — the bug this fix prevents.
    expect(store.getFolderState('Work', 'INBOX')!.uidNext).toBe(10 + MAX_MESSAGES_PER_SWEEP);
    expect(result.failures).toEqual([]);

    // The following sweep resumes exactly where the truncated batch left
    // off: every remaining message is delivered, none is skipped, none is
    // delivered twice.
    await sweep(deps, makeOpts(onEmail));

    expect(onEmail).toHaveBeenCalledTimes(totalNew);
    const subjects = onEmail.mock.calls.map((c) => (c[0] as NormalizedEmail).subject);
    const expectedSubjects = Array.from({ length: totalNew }, (_, i) => `Subject ${i}`);
    expect(subjects).toEqual(expectedSubjects); // in order, no gap, no duplicate
    expect(store.getFolderState('Work', 'INBOX')!.uidNext).toBe(10 + totalNew);
  });

  it('advances to current.uidNext exactly as before when the batch is not truncated', async () => {
    const folders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps } = makeDeps(folders);
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail));

    folders.INBOX.uidNext = 13;
    folders.INBOX.messages = [
      { uid: 10, source: eml('a', 'A') },
      { uid: 11, source: eml('b', 'B') },
      { uid: 12, source: eml('c', 'C') },
    ];

    const result = await sweep(deps, makeOpts(onEmail));

    expect(onEmail).toHaveBeenCalledTimes(3);
    expect(result.failures).toEqual([]);
    expect(store.getFolderState('Work', 'INBOX')).toEqual({ uidNext: 13, uidValidity: 1 });
  });

  it('still notifies only once when the same Message-ID appears twice under the same account (e.g. moved between folders)', async () => {
    const folders = {
      INBOX: { uidNext: 10, uidValidity: 1, messages: [] as { uid: number; source: Buffer }[] },
      Archive: { uidNext: 5, uidValidity: 2, messages: [] as { uid: number; source: Buffer }[] },
    };
    const { deps } = makeDeps(folders);
    const onEmail = vi.fn(async () => {});

    await sweep(deps, makeOpts(onEmail, 'Work'));

    folders.INBOX.uidNext = 11;
    folders.INBOX.messages = [{ uid: 10, source: eml('same-account', 'Same account twice') }];
    await sweep(deps, makeOpts(onEmail, 'Work'));

    folders.Archive.uidNext = 6;
    folders.Archive.messages = [{ uid: 5, source: eml('same-account', 'Same account twice') }];
    await sweep(deps, makeOpts(onEmail, 'Work'));

    expect(onEmail).toHaveBeenCalledTimes(1);
  });
});
