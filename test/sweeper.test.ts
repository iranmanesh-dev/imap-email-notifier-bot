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
