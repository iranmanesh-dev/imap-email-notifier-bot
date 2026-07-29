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
