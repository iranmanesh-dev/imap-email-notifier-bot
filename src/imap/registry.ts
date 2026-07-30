import type { WatcherState } from './watcher.js';
import type { Account } from '../types.js';

/** The structural subset of AccountWatcher the registry needs. */
export type ManagedWatcher = {
  readonly label: string;
  readonly state: WatcherState;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export type WatcherFactory = (account: Account) => ManagedWatcher;

/**
 * An add() that has not finished starting yet.
 *
 * These are tracked with enough state to be *cancelled*, because an add can
 * stay in flight for a long time: AccountWatcher.start() retries a failing
 * connection for up to ~58 minutes, and since the mailbox restore was
 * detached from boot, the operator can issue commands throughout that whole
 * window.
 */
type InFlightAdd = {
  /** Set by remove()/stopAll(): when start() finishes, do not register it. */
  cancelled: boolean;
  /** Populated as soon as the factory returns, before start() is awaited. */
  watcher: ManagedWatcher | null;
  /** Guards against stopping the same watcher twice. */
  stopped: boolean;
};

/**
 * Owns the live set of watchers, one per mailbox, so mailboxes can be
 * added and removed at runtime without restarting the process.
 */
export class WatcherRegistry {
  readonly #factory: WatcherFactory;
  readonly #watchers = new Map<string, ManagedWatcher>();
  readonly #inFlight = new Map<string, InFlightAdd>();

  constructor(factory: WatcherFactory) {
    this.#factory = factory;
  }

  async add(account: Account): Promise<void> {
    if (this.#watchers.has(account.label) || this.#inFlight.has(account.label)) {
      throw new Error(`a watcher for "${account.label}" is already running`);
    }
    const pending: InFlightAdd = { cancelled: false, watcher: null, stopped: false };
    this.#inFlight.set(account.label, pending);
    try {
      const watcher = this.#factory(account);
      // Recorded before the await so a concurrent remove() can reach the
      // watcher and stop it — which is also what makes start() return
      // promptly instead of sleeping out its remaining backoff.
      pending.watcher = watcher;
      // Register only after a successful start, so a failed start cannot
      // leave a dead entry that blocks a later retry with the same label.
      await watcher.start();
      if (pending.cancelled) {
        // Removed (or shut down) while we were starting. Registering now
        // would produce a watcher for a mailbox whose credentials and
        // seen-state have already been deleted: it would keep delivering
        // notifications and re-writing state, while /list no longer showed
        // it and /remove could no longer name it.
        await this.#stopPending(account.label, pending);
        return;
      }
      this.#watchers.set(account.label, watcher);
    } finally {
      this.#inFlight.delete(account.label);
    }
  }

  /** Stops an in-flight add's watcher at most once, never throwing. */
  async #stopPending(label: string, pending: InFlightAdd): Promise<void> {
    if (pending.watcher === null || pending.stopped) return;
    pending.stopped = true;
    try {
      await pending.watcher.stop();
    } catch (err) {
      console.error(`[${label}] failed to stop cleanly: ${errorText(err)}`);
    }
  }

  /**
   * Awaiting `stop()` here is load-bearing, not a formality: AccountWatcher's
   * stop() drains its in-flight sweep (bounded) before resolving, and callers
   * such as the /remove command purge the account's seen-state the moment
   * this resolves. Anything that stops awaiting stop() would reopen the race
   * where a straggling sweep writes its high-water mark back after the purge.
   *
   * Always returns true for a known label, even if stop() failed: a watcher
   * we can no longer stop cleanly must still not be treated as live, and the
   * caller has already been told the mailbox is going away.
   */
  async remove(label: string): Promise<boolean> {
    // An add that is still starting counts as present. Returning false here
    // used to make the caller believe there was nothing to stop, delete the
    // credentials anyway, and then get a live watcher registered behind its
    // back moments later.
    const pending = this.#inFlight.get(label);
    if (pending !== undefined) {
      pending.cancelled = true;
      // Awaited, for the same reason the registered path awaits stop(): the
      // caller purges this account's seen-state as soon as we resolve, and a
      // watcher still inside start() has already run its first sweep.
      await this.#stopPending(label, pending);
      // The #inFlight entry is deliberately left for add()'s own finally to
      // clear. Removing it here would let a re-/add with the same label
      // create a second watcher while this one is still unwinding, undoing
      // the concurrent-add protection.
      return true;
    }

    const watcher = this.#watchers.get(label);
    if (watcher === undefined) return false;
    // Deregister regardless of whether stop() succeeds: a watcher we can no
    // longer stop cleanly must still not be treated as live.
    this.#watchers.delete(label);
    try {
      await watcher.stop();
    } catch (err) {
      console.error(`[${label}] failed to stop cleanly: ${errorText(err)}`);
    }
    return true;
  }

  /** True while the label is registered OR still being started. */
  has(label: string): boolean {
    return this.#watchers.has(label) || this.#inFlight.has(label);
  }

  /** Counts only fully-registered watchers. */
  size(): number {
    return this.#watchers.size;
  }

  /**
   * Includes mailboxes whose add is still in flight, reported with the
   * watcher's own state (falling back to 'starting' before the factory has
   * run). Without them, a mailbox stuck in a long reconnect was invisible to
   * /status and to shutdown, which snapshots this list.
   *
   * Cancelled entries are excluded: they are being torn down and are not
   * live watchers, so reporting them would resurrect the mailbox the
   * operator just removed.
   */
  states(): { label: string; state: WatcherState }[] {
    const registered = [...this.#watchers.values()].map((w) => ({
      label: w.label,
      state: w.state,
    }));
    const starting = [...this.#inFlight.entries()]
      .filter(([label, pending]) => !pending.cancelled && !this.#watchers.has(label))
      .map(([label, pending]) => ({
        label,
        state: pending.watcher?.state ?? ('starting' as WatcherState),
      }));
    return [...registered, ...starting];
  }

  async stopAll(): Promise<void> {
    // Cancel in-flight adds FIRST, so one that completes during this
    // teardown cannot register itself after the map below is cleared and
    // outlive the shutdown that was supposed to stop it.
    const targets: { label: string; stop: Promise<void> }[] = [];
    for (const [label, pending] of this.#inFlight) {
      pending.cancelled = true;
      if (pending.watcher !== null && !pending.stopped) {
        pending.stopped = true;
        targets.push({ label, stop: pending.watcher.stop() });
      }
    }

    const watchers = [...this.#watchers.values()];
    this.#watchers.clear();
    for (const watcher of watchers) {
      targets.push({ label: watcher.label, stop: watcher.stop() });
    }

    const results = await Promise.allSettled(targets.map((t) => t.stop));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(
          `[${targets[i]?.label ?? '?'}] failed to stop cleanly: ${errorText(result.reason)}`
        );
      }
    });
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
