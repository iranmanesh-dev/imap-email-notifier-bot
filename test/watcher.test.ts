import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImapFlow } from 'imapflow';
import { SeenStore } from '../src/store/seen.js';
import { AccountWatcher } from '../src/imap/watcher.js';
import type { Account } from '../src/types.js';
import { sweep } from '../src/imap/sweeper.js';

vi.mock('../src/imap/sweeper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/imap/sweeper.js')>();
  return {
    ...actual,
    sweep: vi.fn(),
  };
});

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

beforeEach(() => {
  vi.mocked(sweep).mockReset();
  vi.mocked(sweep).mockResolvedValue({ foldersChecked: 1, failures: [] });
});

// --- Fake client factory for tests that exercise the REAL #connect /
// #connectSweep / #connectIdle paths (not the deps.connect override), so we
// can observe connection lifecycle: how many clients are ever created, which
// ones got logged out, and whether the idle client's 'exists' listener
// actually fires a sweep.

type FakeClientRecord = {
  usable: boolean;
  loggedOut: boolean;
  connectCalls: number;
  logoutCalls: number;
  noopCalls: number;
  emit: (event: string, ...args: unknown[]) => void;
  /** Resolves this client's in-flight connect() call, if deferConnect held it open. */
  resolveConnect: () => void;
  rejectConnect: (err: Error) => void;
};

function createTrackedClientFactory(
  opts: { failConnect?: () => boolean; deferConnect?: () => boolean } = {}
) {
  const records: FakeClientRecord[] = [];

  const factory = vi.fn((_account: Account) => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    let resolveConnect: (() => void) | null = null;
    let rejectConnect: ((err: Error) => void) | null = null;

    const record: FakeClientRecord = {
      usable: true,
      loggedOut: false,
      connectCalls: 0,
      logoutCalls: 0,
      noopCalls: 0,
      emit: (event, ...args) => {
        for (const cb of listeners.get(event) ?? []) cb(...args);
      },
      resolveConnect: () => resolveConnect?.(),
      rejectConnect: (err: Error) => rejectConnect?.(err),
    };

    const client = {
      get usable() {
        return record.usable;
      },
      connect: vi.fn(async () => {
        record.connectCalls += 1;
        if (opts.failConnect?.()) throw new Error('ECONNREFUSED');
        if (opts.deferConnect?.()) {
          await new Promise<void>((resolve, reject) => {
            resolveConnect = resolve;
            rejectConnect = reject;
          });
        }
      }),
      mailboxOpen: vi.fn(async () => {}),
      noop: vi.fn(async () => {
        record.noopCalls += 1;
      }),
      logout: vi.fn(async () => {
        record.loggedOut = true;
        record.logoutCalls += 1;
      }),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        const list = listeners.get(event) ?? [];
        list.push(cb);
        listeners.set(event, list);
        return client;
      }),
    };

    records.push(record);
    return client as unknown as ImapFlow;
  });

  return { factory, records };
}

/**
 * Advances the microtask queue without touching real or fake timers, so
 * promise chains inside the watcher (which never use timers on the success
 * path — only `sleep`, which tests stub as instant) can be driven forward
 * deterministically to a specific await point.
 */
async function flushMicrotasks(iterations = 20): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
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

  it('triggerSweep() can be invoked manually and runs the sweep again', async () => {
    // Renamed from "sweeps again when the idler signals activity": this test
    // only calls triggerSweep() directly, so it would pass even if the
    // idler's 'exists' listener were never wired up. The test below,
    // "the idle client's exists event triggers a real sweep", covers the
    // actual event wiring using the real (non-overridden) connect path.
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

  // --- Bounded reconnect cap (round 1) ---
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

  // --- Round 2: connection-leak and lifecycle coverage ---
  //
  // All tests above inject deps.connect/deps.runSweep, so the real bodies of
  // #connect/#connectSweep/#connectIdle, the idle watchdog, and the
  // SweepResult branch never execute. The tests below drive the REAL
  // connection path via an injectable client factory, so a live-connection
  // leak (or a listener that never fires) actually fails the suite.

  it('opens exactly one sweep client and one idle client on initial connect', async () => {
    await withStore(async (store) => {
      const { factory, records } = createTrackedClientFactory();

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { createClientImpl: factory, sleep: async () => {} },
      });

      await watcher.start();

      expect(records.length).toBe(2);
      expect(records.filter((r) => !r.loggedOut).length).toBe(2);

      await watcher.stop();
    });
  });

  it('replaces only the idle client on a stale-idler cycle, logging out the old one and leaving the sweep client untouched', async () => {
    vi.useFakeTimers();
    try {
      await withStore(async (store) => {
        const { factory, records } = createTrackedClientFactory();

        const watcher = new AccountWatcher({
          account,
          store,
          previewChars: 200,
          sweepIntervalSeconds: 3600,
          onEmail: async () => {},
          onFatal: async () => {},
          deps: { createClientImpl: factory, sleep: async () => {} },
        });

        await watcher.start();
        expect(records.length).toBe(2);
        const [sweepRecord, idleRecord] = records;

        idleRecord!.usable = false; // simulate a dropped idle connection
        await vi.advanceTimersByTimeAsync(9 * 60_000); // one IDLE_REFRESH_MS tick

        expect(records.length).toBe(3); // a replacement idle client was created
        expect(idleRecord!.loggedOut).toBe(true); // the stale one was logged out
        expect(sweepRecord!.loggedOut).toBe(false); // sweep client untouched
        expect(records.filter((r) => !r.loggedOut).length).toBe(2); // still exactly 2 live

        await watcher.stop();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces only the sweep client on a sweep-triggered reconnect, logging out the old one, leaving the idle client untouched, and recovering to ok', async () => {
    await withStore(async (store) => {
      const { factory, records } = createTrackedClientFactory();

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { createClientImpl: factory, sleep: async () => {} },
      });

      await watcher.start();
      const [sweepRecord, idleRecord] = records;

      sweepRecord!.usable = false; // simulate the sweep connection dying
      await watcher.triggerSweep();

      expect(records.length).toBe(3); // a replacement sweep client was created
      expect(sweepRecord!.loggedOut).toBe(true); // the dead one was logged out
      expect(idleRecord!.loggedOut).toBe(false); // idle client untouched
      expect(records.filter((r) => !r.loggedOut).length).toBe(2); // still exactly 2 live
      expect(watcher.state).toBe('ok'); // recovers instead of staying 'reconnecting'

      await watcher.stop();
    });
  });

  it('stops all further connection attempts after reaching connect-failed, even across an idle-watchdog tick', async () => {
    vi.useFakeTimers();
    try {
      await withStore(async (store) => {
        const failFlag = { value: false };
        const { factory, records } = createTrackedClientFactory({ failConnect: () => failFlag.value });
        const onFatal = vi.fn(async () => {});

        const watcher = new AccountWatcher({
          account,
          store,
          previewChars: 200,
          sweepIntervalSeconds: 3600,
          onEmail: async () => {},
          onFatal,
          deps: { createClientImpl: factory, sleep: async () => {} },
        });

        await watcher.start();
        expect(watcher.state).toBe('ok');

        // Force the stale-idler branch, not the healthy noop() branch: if we
        // left the idle client "usable", it would never matter whether the
        // terminal-state guard existed, because #checkIdleHealth would take
        // the noop() path regardless and the assertions below would pass
        // either way. Making the idle client genuinely stale means only the
        // terminal-state guard (not incidental healthiness) can be why no
        // reconnect attempt happens.
        const idleRecord = records[1]!;
        idleRecord.usable = false;

        records[0]!.usable = false; // sweep connection dies
        failFlag.value = true; // every future connect attempt now fails

        await watcher.triggerSweep(); // discovers the broken client, retries to the cap

        expect(watcher.state).toBe('connect-failed');
        expect(onFatal).toHaveBeenCalledTimes(1);

        const factoryCallsAtTerminal = factory.mock.calls.length;

        await vi.advanceTimersByTimeAsync(9 * 60_000); // one idle-watchdog period

        expect(factory.mock.calls.length).toBe(factoryCallsAtTerminal); // no reconnect attempt
        expect(idleRecord.noopCalls).toBe(0); // and the healthy branch didn't run either
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() clears the idle watchdog timer so no tick occurs afterward', async () => {
    // Counting clearInterval() calls is non-discriminating: the pre-fix
    // code already called it exactly twice in stop() regardless of whether
    // the idle timer reference was tracked correctly. Assert the actual
    // effect instead — advancing past a full IDLE_REFRESH_MS period after
    // stop() must not touch the (now-defunct) idle client or the factory.
    vi.useFakeTimers();
    try {
      await withStore(async (store) => {
        const { factory, records } = createTrackedClientFactory();

        const watcher = new AccountWatcher({
          account,
          store,
          previewChars: 200,
          sweepIntervalSeconds: 3600,
          onEmail: async () => {},
          onFatal: async () => {},
          deps: { createClientImpl: factory, sleep: async () => {} },
        });

        await watcher.start();
        const idleRecord = records[1]!;
        await watcher.stop();

        const factoryCallsAfterStop = factory.mock.calls.length;

        await vi.advanceTimersByTimeAsync(9 * 60_000); // one IDLE_REFRESH_MS period

        expect(idleRecord.noopCalls).toBe(0); // no watchdog tick touched anything
        expect(factory.mock.calls.length).toBe(factoryCallsAfterStop); // no reconnect attempt
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the idle client's exists event triggers a real sweep", async () => {
    await withStore(async (store) => {
      const { factory, records } = createTrackedClientFactory();

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { createClientImpl: factory, sleep: async () => {} },
      });

      await watcher.start();
      expect(sweep).toHaveBeenCalledTimes(1); // the initial sweep from start()

      const idleRecord = records[1]!;
      idleRecord.emit('exists');
      // triggerSweep() serializes via the same queue as the fire-and-forget
      // call the 'exists' listener makes, so awaiting this call guarantees
      // the emitted sweep has already run by the time we assert.
      await watcher.triggerSweep();

      expect(sweep).toHaveBeenCalledTimes(3); // 1 initial + 1 from 'exists' + 1 explicit

      await watcher.stop();
    });
  });

  it('reconnects the sweep client when the real sweep reports every folder failed', async () => {
    await withStore(async (store) => {
      vi.mocked(sweep).mockResolvedValueOnce({
        foldersChecked: 0,
        failures: [{ folder: 'INBOX', message: 'boom' }],
      });

      const { factory, records } = createTrackedClientFactory();

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { createClientImpl: factory, sleep: async () => {} },
      });

      await watcher.start();

      const sweepRecord = records[0]!;
      expect(sweepRecord.loggedOut).toBe(true); // all-fail result drove a reconnect
      expect(records.length).toBe(3); // replacement sweep client created
      expect(watcher.state).toBe('ok');

      await watcher.stop();
    });
  });

  it('does not reconnect when the real sweep reports only a partial folder failure', async () => {
    await withStore(async (store) => {
      vi.mocked(sweep).mockResolvedValueOnce({
        foldersChecked: 2,
        failures: [{ folder: 'Archive', message: 'boom' }],
      });

      const { factory, records } = createTrackedClientFactory();

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { createClientImpl: factory, sleep: async () => {} },
      });

      await watcher.start();

      const sweepRecord = records[0]!;
      expect(sweepRecord.loggedOut).toBe(false); // partial failure: no reconnect
      expect(records.length).toBe(2); // no replacement client
      expect(watcher.state).toBe('ok');

      await watcher.stop();
    });
  });

  // --- Round 3: stop() racing an in-flight connect ---
  //
  // Neither #connectSweep nor #connectIdle re-checked #stopped after their
  // awaits. If stop() ran while one of them was awaiting client.connect(),
  // stop() would log out an already-null field and clear the timer, then
  // the in-flight connect would resume, assign the now-live client to the
  // field, and (for the idle client) re-arm a fresh watchdog interval —
  // an open connection and a live interval both outliving stop().

  it('does not leak a client or re-arm the idle watchdog if stop() runs while #connectIdle is awaiting connect()', async () => {
    await withStore(async (store) => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const { factory, records } = createTrackedClientFactory({ deferConnect: () => true });

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { createClientImpl: factory, sleep: async () => {} },
      });

      const startPromise = watcher.start();
      await flushMicrotasks();
      expect(records.length).toBe(1); // only the sweep client so far, still connecting
      records[0]!.resolveConnect(); // let #connectSweep finish

      await flushMicrotasks();
      expect(records.length).toBe(2); // #connectIdle has created the idle client...
      expect(records[1]!.connectCalls).toBe(1); // ...and is awaiting its connect()

      const stopPromise = watcher.stop(); // races the in-flight idle connect
      await flushMicrotasks();

      records[1]!.resolveConnect(); // release the idle connect() only now, after stop() ran

      await startPromise;
      await stopPromise;

      expect(records.length).toBe(2); // no extra client was created
      expect(records[1]!.loggedOut).toBe(true); // the late-arriving idle client was logged out
      expect(records.filter((r) => !r.loggedOut).length).toBe(0); // zero live connections
      // Neither the periodic sweep timer nor the idle watchdog was ever
      // armed: start() bails on #stopped before scheduling its timer, and
      // #connectIdle returns before calling #startIdleWatchdog.
      expect(setIntervalSpy).not.toHaveBeenCalled();

      setIntervalSpy.mockRestore();
    });
  });

  it('does not leak a client if stop() runs while #connectSweep is awaiting connect() during a sweep-triggered reconnect', async () => {
    await withStore(async (store) => {
      const deferFlag = { value: false };
      const { factory, records } = createTrackedClientFactory({
        deferConnect: () => deferFlag.value,
      });

      const watcher = new AccountWatcher({
        account,
        store,
        previewChars: 200,
        sweepIntervalSeconds: 3600,
        onEmail: async () => {},
        onFatal: async () => {},
        deps: { createClientImpl: factory, sleep: async () => {} },
      });

      await watcher.start(); // both clients connect normally; deferFlag still false
      expect(records.length).toBe(2);

      records[0]!.usable = false; // sweep connection dies
      deferFlag.value = true; // the reconnect's client.connect() will now pause

      const sweepPromise = watcher.triggerSweep(); // discovers the broken client, reconnects
      await flushMicrotasks();
      expect(records.length).toBe(3); // a replacement sweep client is being created
      expect(records[2]!.connectCalls).toBe(1); // and is awaiting its connect()

      const stopPromise = watcher.stop(); // races the in-flight reconnect
      await flushMicrotasks();

      records[2]!.resolveConnect(); // release the reconnect's connect() only now

      await sweepPromise;
      await stopPromise;

      expect(records.length).toBe(3); // no further extras created
      expect(records[2]!.loggedOut).toBe(true); // the late-arriving replacement was logged out
      expect(records.filter((r) => !r.loggedOut).length).toBe(0); // zero live connections
      expect(watcher.state).toBe('stopped');
    });
  });
});
