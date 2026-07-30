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

  it('always stores secure as true regardless of input', async () => {
    // Asserting store.get('Work')?.secure alone cannot fail: get() builds
    // its return value with a hardcoded `secure: true` and never reads the
    // column. Query the column directly so this test observes what was
    // actually persisted.
    store.add({ ...work, secure: false });

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT secure FROM mailboxes WHERE label = ?').get('Work') as
        | { secure: number }
        | undefined;
      expect(row?.secure).toBe(1);
    } finally {
      db.close();
    }

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
