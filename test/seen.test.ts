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
    expect(store.hasSeen('Work', '<a@x>')).toBe(false);
  });

  it('reports a marked message as seen', () => {
    store.markSeen('Work', '<a@x>');
    expect(store.hasSeen('Work', '<a@x>')).toBe(true);
  });

  it('returns true only on the first mark', () => {
    expect(store.markSeen('Work', '<a@x>')).toBe(true);
    expect(store.markSeen('Work', '<a@x>')).toBe(false);
  });

  it('persists across reopening the database', () => {
    const path = join(dir, 'persist.db');
    const first = new SeenStore(path);
    first.markSeen('Work', '<a@x>');
    first.close();

    const second = new SeenStore(path);
    expect(second.hasSeen('Work', '<a@x>')).toBe(true);
    second.close();
  });

  it('treats the same message id under two different accounts as distinct (one notification per mailbox)', () => {
    store.markSeen('Work', '<a@x>');
    expect(store.hasSeen('Work', '<a@x>')).toBe(true);
    expect(store.hasSeen('Personal', '<a@x>')).toBe(false);

    expect(store.markSeen('Personal', '<a@x>')).toBe(true);
    expect(store.hasSeen('Personal', '<a@x>')).toBe(true);
  });

  it('treats the same message id under the same account as the same, even if marked twice', () => {
    expect(store.markSeen('Work', '<a@x>')).toBe(true);
    expect(store.markSeen('Work', '<a@x>')).toBe(false);
    expect(store.hasSeen('Work', '<a@x>')).toBe(true);
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
    store.markSeen('Work', '<a@x>');
    expect(store.prune(30)).toBe(0);
    expect(store.hasSeen('Work', '<a@x>')).toBe(true);
  });

  /** SQLite datetime string (`YYYY-MM-DD HH:MM:SS`) for N days before now. */
  function daysAgo(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  }

  it('deletes entries older than the cutoff', () => {
    store.markSeen('Work', '<old@x>', daysAgo(40));
    expect(store.prune(30)).toBe(1);
    expect(store.hasSeen('Work', '<old@x>')).toBe(false);
  });

  it('keeps entries just inside the cutoff', () => {
    store.markSeen('Work', '<recent@x>', daysAgo(29));
    expect(store.prune(30)).toBe(0);
    expect(store.hasSeen('Work', '<recent@x>')).toBe(true);
  });

  it('prunes per-account entries independently of other accounts sharing the same message id', () => {
    store.markSeen('Work', '<shared@x>', daysAgo(40));
    store.markSeen('Personal', '<shared@x>');
    expect(store.prune(30)).toBe(1);
    expect(store.hasSeen('Work', '<shared@x>')).toBe(false);
    expect(store.hasSeen('Personal', '<shared@x>')).toBe(true);
  });
});

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
