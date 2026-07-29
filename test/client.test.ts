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
