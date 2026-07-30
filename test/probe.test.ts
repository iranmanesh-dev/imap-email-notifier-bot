import { describe, it, expect, vi } from 'vitest';
import { probeMailbox } from '../src/imap/probe.js';
import type { Account } from '../src/types.js';

const account: Account = {
  label: 'Work', host: 'h', port: 993, user: 'u', pass: 'sup3rs3cret', secure: true,
};

describe('probeMailbox', () => {
  it('reports success with a folder count', async () => {
    const logout = vi.fn(async () => {});
    const result = await probeMailbox(account, {
      connect: async () => ({ list: async () => [{}, {}, {}], logout }),
    });
    expect(result).toEqual({ ok: true, folders: 3 });
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('reports failure when connecting throws', async () => {
    const result = await probeMailbox(account, {
      connect: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('ECONNREFUSED') });
  });

  it('never leaks the password into the failure reason', async () => {
    const result = await probeMailbox(account, {
      connect: async () => { throw new Error('login failed for u with sup3rs3cret'); },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain('sup3rs3cret');
      expect(result.reason).toContain('***');
    }
  });

  it('logs out even when list() throws', async () => {
    const logout = vi.fn(async () => {});
    const result = await probeMailbox(account, {
      connect: async () => ({ list: async () => { throw new Error('NO permission'); }, logout }),
    });
    expect(result.ok).toBe(false);
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('does not fail the probe when logout throws', async () => {
    const result = await probeMailbox(account, {
      connect: async () => ({
        list: async () => [{}],
        logout: async () => { throw new Error('already closed'); },
      }),
    });
    expect(result).toEqual({ ok: true, folders: 1 });
  });

  it('handles a non-Error throwable', async () => {
    const result = await probeMailbox(account, {
      connect: async () => { throw 'plain string'; },
    });
    expect(result.ok).toBe(false);
  });
});
