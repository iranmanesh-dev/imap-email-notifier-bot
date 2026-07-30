import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeenStore } from '../src/store/seen.js';
import { AccountWatcher } from '../src/imap/watcher.js';
import type { Account } from '../src/types.js';

const account: Account = {
  label: 'Work',
  host: 'localhost',
  port: 993,
  user: 'me@example.com',
  pass: 'secret',
  secure: true,
};

function withStore<T>(fn: (store: SeenStore) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'watcher-'));
  const store = new SeenStore(join(dir, 'test.db'));
  return fn(store).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

describe('AccountWatcher', () => {
  it('sweeps once on start and reports ok', async () => {
    await withStore(async (store) => {
      const runSweep = vi.fn(async () => {});
      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { runSweep, connect: async () => {}, disconnect: async () => {}, sleep: async () => {} },
      });

      await watcher.start();
      expect(runSweep).toHaveBeenCalledTimes(1);
      expect(watcher.state).toBe('ok');
      await watcher.stop();
      expect(watcher.state).toBe('stopped');
    });
  });

  it('marks the account auth-failed and calls onFatal without retrying', async () => {
    await withStore(async (store) => {
      const authError = Object.assign(new Error('bad password'), { authenticationFailed: true });
      const connect = vi.fn(async () => { throw authError; });
      const onFatal = vi.fn(async () => {});

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal,
        deps: { connect, runSweep: async () => {}, disconnect: async () => {}, sleep: async () => {} },
      });

      await watcher.start();

      expect(watcher.state).toBe('auth-failed');
      expect(connect).toHaveBeenCalledTimes(1);
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(onFatal.mock.calls[0]![0]).toBe(account);
      await watcher.stop();
    });
  });

  it('retries a non-auth connection failure with backoff and recovers', async () => {
    await withStore(async (store) => {
      let attempts = 0;
      const connect = vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('ECONNREFUSED');
      });
      const slept: number[] = [];

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: {
          connect,
          runSweep: async () => {},
          disconnect: async () => {},
          sleep: async (ms: number) => { slept.push(ms); },
        },
      });

      await watcher.start();

      expect(connect).toHaveBeenCalledTimes(3);
      expect(watcher.state).toBe('ok');
      expect(slept.length).toBeGreaterThanOrEqual(2);
      expect(slept[1]!).toBeGreaterThan(slept[0]!); // backoff grows
      await watcher.stop();
    });
  });

  it('never sleeps longer than the five minute cap', async () => {
    await withStore(async (store) => {
      let attempts = 0;
      const slept: number[] = [];
      const connect = vi.fn(async () => {
        attempts += 1;
        if (attempts < 15) throw new Error('ECONNREFUSED');
      });

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: {
          connect,
          runSweep: async () => {},
          disconnect: async () => {},
          sleep: async (ms: number) => { slept.push(ms); },
        },
      });

      await watcher.start();
      expect(Math.max(...slept)).toBeLessThanOrEqual(300_000);
      await watcher.stop();
    });
  });

  it('does not reconnect after stop() is called', async () => {
    await withStore(async (store) => {
      const connect = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: {
          connect,
          runSweep: async () => {},
          disconnect: async () => {},
          sleep: async () => { await watcher.stop(); },
        },
      });

      await watcher.start();
      expect(watcher.state).toBe('stopped');
      expect(connect.mock.calls.length).toBeLessThanOrEqual(2);
    });
  });

  it('sweeps again when the idler signals activity', async () => {
    await withStore(async (store) => {
      const runSweep = vi.fn(async () => {});
      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { runSweep, connect: async () => {}, disconnect: async () => {}, sleep: async () => {} },
      });

      await watcher.start();
      expect(runSweep).toHaveBeenCalledTimes(1);

      await watcher.triggerSweep();
      expect(runSweep).toHaveBeenCalledTimes(2);

      await watcher.stop();
    });
  });

  it('does not run two sweeps concurrently', async () => {
    await withStore(async (store) => {
      let active = 0;
      let maxActive = 0;
      const runSweep = vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
      });

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { runSweep, connect: async () => {}, disconnect: async () => {}, sleep: async () => {} },
      });

      await watcher.start();
      await Promise.all([watcher.triggerSweep(), watcher.triggerSweep(), watcher.triggerSweep()]);

      expect(maxActive).toBe(1);
      await watcher.stop();
    });
  });

  // --- Bounded reconnect cap (not in the original brief) ---
  //
  // isAuthError has a false negative: a server that rejects a bad password
  // with a bare "NO Login failed" (no RFC 5530 response code, no
  // authenticationFailed flag) never trips isAuthError. Without a cap, that
  // produces an infinite reconnect loop against a mailbox with wrong
  // credentials, risking an IP block. These tests cover the cap that bounds
  // that loop instead.

  it('gives up after MAX_CONSECUTIVE_FAILURES consecutive connection failures and calls onFatal once', async () => {
    await withStore(async (store) => {
      const connect = vi.fn(async () => {
        throw new Error('NO Login failed'); // no auth signal isAuthError can see
      });
      const onFatal = vi.fn(async () => {});

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal,
        deps: {
          connect,
          runSweep: async () => {},
          disconnect: async () => {},
          sleep: async () => {},
        },
      });

      await watcher.start();

      expect(connect).toHaveBeenCalledTimes(20);
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(onFatal.mock.calls[0]![0]).toBe(account);
      expect(String(onFatal.mock.calls[0]![1])).toMatch(/20/);
      expect(watcher.state).toBe('connect-failed');
      await watcher.stop();
    });
  });

  it('resets the consecutive-failure counter on a successful connect, so a later outage does not hit the cap prematurely', async () => {
    await withStore(async (store) => {
      let connectCalls = 0;
      const connect = vi.fn(async () => {
        connectCalls += 1;
        // Phase 1 (during start()): fail 12 times, then succeed on the 13th call.
        if (connectCalls <= 12) throw new Error('ECONNREFUSED');
        // Phase 2 (after the sweep-triggered reconnect below): fail 12 more
        // times, then succeed again on the 26th call overall. If the
        // consecutive-failure counter were not reset by the phase 1 success,
        // these cumulative 24 failures would exceed the cap of 20 and the
        // account would wrongly give up before reaching call 26.
        if (connectCalls >= 14 && connectCalls <= 25) throw new Error('ECONNREFUSED');
      });
      const onFatal = vi.fn(async () => {});

      let sweepCalls = 0;
      const runSweep = vi.fn(async () => {
        sweepCalls += 1;
        // First sweep (from start()) succeeds; the second, manually
        // triggered sweep fails once, forcing a fresh reconnect episode.
        if (sweepCalls === 2) throw new Error('sweep broke');
      });

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal,
        deps: { connect, runSweep, disconnect: async () => {}, sleep: async () => {} },
      });

      await watcher.start();
      expect(watcher.state).toBe('ok');

      await watcher.triggerSweep(); // fails, triggers a fresh reconnect episode

      expect(onFatal).not.toHaveBeenCalled();
      expect(watcher.state).not.toBe('connect-failed');
      expect(connect).toHaveBeenCalledTimes(26);

      await watcher.stop();
    });
  });
});
