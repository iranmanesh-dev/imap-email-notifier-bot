import { describe, it, expect, vi, afterEach } from 'vitest';
import { createClient, imapSweepDeps, isAuthError } from '../src/imap/client.js';
import type { Account } from '../src/types.js';
import type { ImapFlow } from 'imapflow';

function fakeClient(overrides: Record<string, unknown>): ImapFlow {
  return overrides as unknown as ImapFlow;
}

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

describe('createClient - security-critical config', () => {
  it('disables IMAP protocol logging (logger: false, emitLogs: false)', () => {
    const client = createClient(account) as unknown as Record<string, unknown>;
    expect(client.emitLogs).toBe(false);
    const options = client.options as Record<string, unknown>;
    expect(options.logger).toBe(false);
    expect(options.emitLogs).toBe(false);
  });

  it('passes host, port, secure and auth through from the Account', () => {
    const client = createClient(account) as unknown as Record<string, unknown>;
    expect(client.host).toBe(account.host);
    expect(client.port).toBe(account.port);
    expect(client.secureConnection).toBe(account.secure);
    const options = client.options as { auth?: { user?: string; pass?: string } };
    expect(options.auth?.user).toBe(account.user);
    expect(options.auth?.pass).toBe(account.pass);
  });
});

describe('imapSweepDeps.status', () => {
  it('rejects when uidNext is missing from the STATUS response', async () => {
    const client = fakeClient({
      status: async () => ({ path: 'INBOX', uidValidity: 12345n }),
    });
    const deps = imapSweepDeps(client);
    await expect(deps.status('INBOX')).rejects.toThrow(/uidNext/);
  });

  it('rejects when uidValidity is missing from the STATUS response', async () => {
    const client = fakeClient({
      status: async () => ({ path: 'INBOX', uidNext: 40 }),
    });
    const deps = imapSweepDeps(client);
    await expect(deps.status('INBOX')).rejects.toThrow(/uidValidity/);
  });

  it('returns numeric uidNext/uidValidity when both are present', async () => {
    const client = fakeClient({
      status: async () => ({ path: 'INBOX', uidNext: 40, uidValidity: 12345n }),
    });
    const deps = imapSweepDeps(client);
    await expect(deps.status('INBOX')).resolves.toEqual({ uidNext: 40, uidValidity: 12345 });
  });
});

describe('imapSweepDeps.fetchSince', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips a message missing a source, logs a warning naming the folder and uid (no message content), and still returns the rest', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const release = vi.fn();

    async function* fetchGenerator() {
      yield { uid: 5, source: undefined };
      yield { uid: 6, source: Buffer.from('secret body content') };
    }

    const client = fakeClient({
      getMailboxLock: async () => ({ path: 'INBOX', release }),
      fetch: () => fetchGenerator(),
    });

    const deps = imapSweepDeps(client);
    const result = await deps.fetchSince('INBOX', 5);

    expect(result).toEqual([{ uid: 6, source: Buffer.from('secret body content') }]);
    expect(release).toHaveBeenCalledOnce();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0]?.join(' ') ?? '';
    expect(logged).toContain('INBOX');
    expect(logged).toContain('5');
    expect(logged).not.toContain('secret body content');
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
