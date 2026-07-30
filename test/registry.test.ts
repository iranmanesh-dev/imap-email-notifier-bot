import { describe, it, expect, vi } from 'vitest';
import { WatcherRegistry, type ManagedWatcher } from '../src/imap/registry.js';
import type { Account } from '../src/types.js';
import type { WatcherState } from '../src/imap/watcher.js';

const account: Account = {
  label: 'Work', host: 'h', port: 993, user: 'u', pass: 'p', secure: true,
};

function fakeWatcher(label: string, state: WatcherState = 'ok'): ManagedWatcher & {
  started: number; stopped: number;
} {
  return {
    label,
    state,
    started: 0,
    stopped: 0,
    async start() { this.started += 1; },
    async stop() { this.stopped += 1; },
  };
}

describe('WatcherRegistry', () => {
  it('starts a watcher when a mailbox is added', async () => {
    const w = fakeWatcher('Work');
    const reg = new WatcherRegistry(() => w);
    await reg.add(account);
    expect(w.started).toBe(1);
    expect(reg.has('Work')).toBe(true);
    expect(reg.size()).toBe(1);
  });

  it('rejects adding a label that is already registered', async () => {
    const reg = new WatcherRegistry(() => fakeWatcher('Work'));
    await reg.add(account);
    await expect(reg.add(account)).rejects.toThrow(/already/i);
  });

  it('stops the watcher when a mailbox is removed', async () => {
    const w = fakeWatcher('Work');
    const reg = new WatcherRegistry(() => w);
    await reg.add(account);
    expect(await reg.remove('Work')).toBe(true);
    expect(w.stopped).toBe(1);
    expect(reg.has('Work')).toBe(false);
  });

  it('returns false when removing an unknown label', async () => {
    const reg = new WatcherRegistry(() => fakeWatcher('Work'));
    expect(await reg.remove('Ghost')).toBe(false);
  });

  it('does not leave a registration behind when start() fails', async () => {
    let startedWithRegistration = false;
    const reg = new WatcherRegistry(() => ({
      label: 'Work',
      state: 'starting' as WatcherState,
      async start() {
        // Assert that the registry does not already contain this label at start time
        startedWithRegistration = reg.has('Work');
        throw new Error('connect failed');
      },
      async stop() {},
    }));
    await expect(reg.add(account)).rejects.toThrow(/connect failed/);
    expect(startedWithRegistration).toBe(false); // Verify it was not registered before start
    expect(reg.has('Work')).toBe(false);
  });

  it('still deregisters when stop() throws', async () => {
    const reg = new WatcherRegistry(() => ({
      label: 'Work',
      state: 'ok' as WatcherState,
      async start() {},
      async stop() { throw new Error('logout failed'); },
    }));
    await reg.add(account);
    expect(await reg.remove('Work')).toBe(true);
    expect(reg.has('Work')).toBe(false);
  });

  it('reports each watcher state', async () => {
    const reg = new WatcherRegistry((a) => fakeWatcher(a.label, a.label === 'Work' ? 'ok' : 'auth-failed'));
    await reg.add(account);
    await reg.add({ ...account, label: 'Personal' });
    expect(reg.states()).toEqual([
      { label: 'Work', state: 'ok' },
      { label: 'Personal', state: 'auth-failed' },
    ]);
  });

  it('stopAll stops every watcher and empties the registry', async () => {
    const made: ReturnType<typeof fakeWatcher>[] = [];
    const reg = new WatcherRegistry((a) => { const w = fakeWatcher(a.label); made.push(w); return w; });
    await reg.add(account);
    await reg.add({ ...account, label: 'Personal' });
    await reg.stopAll();
    expect(made.every((w) => w.stopped === 1)).toBe(true);
    expect(reg.size()).toBe(0);
  });

  it('stopAll does not let one failing stop prevent the others', async () => {
    let stopped = 0;
    const reg = new WatcherRegistry((a) => ({
      label: a.label,
      state: 'ok' as WatcherState,
      async start() {},
      async stop() {
        if (a.label === 'Bad') throw new Error('nope');
        stopped += 1;
      },
    }));
    await reg.add({ ...account, label: 'Bad' });
    await reg.add({ ...account, label: 'Good' });
    await reg.stopAll();
    expect(stopped).toBe(1);
    expect(reg.size()).toBe(0);
  });

  it('concurrent adds for the same label create only one watcher', async () => {
    let factoryCalls = 0;
    const reg = new WatcherRegistry((a) => {
      factoryCalls += 1;
      return fakeWatcher(a.label);
    });
    const results = await Promise.allSettled([
      reg.add(account),
      reg.add(account),
    ]);
    expect(factoryCalls).toBe(1); // Factory called exactly once
    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected'); // Second call rejected
    expect(reg.size()).toBe(1);
  });

  it('after concurrent-add rejection, a later add with the same label succeeds', async () => {
    // Simulate a race where two adds for the same label happen concurrently
    const reg = new WatcherRegistry((a) => fakeWatcher(a.label));
    const results = await Promise.allSettled([
      reg.add(account),
      reg.add(account),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
    expect(reg.size()).toBe(1);

    // After the race resolves and the label is registered, remove it
    await reg.remove('Work');
    expect(reg.size()).toBe(0);

    // Now a new add should succeed (proving in-flight was cleared from the failed attempt)
    await reg.add(account);
    expect(reg.has('Work')).toBe(true);
  });

  it('a failed start() clears the in-flight entry so retry works', async () => {
    let attempts = 0;
    const reg = new WatcherRegistry(() => ({
      label: 'Work',
      state: 'starting' as WatcherState,
      async start() {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
        // Second attempt succeeds
      },
      async stop() {},
    }));
    // First attempt fails
    await expect(reg.add(account)).rejects.toThrow(/network down/);
    expect(reg.has('Work')).toBe(false);
    expect(attempts).toBe(1);
    // Second attempt should work (in-flight was cleared)
    await reg.add(account);
    expect(reg.has('Work')).toBe(true);
    expect(attempts).toBe(2);
  });
});
