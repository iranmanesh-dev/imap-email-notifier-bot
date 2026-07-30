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
 * Owns the live set of watchers, one per mailbox, so mailboxes can be
 * added and removed at runtime without restarting the process.
 */
export class WatcherRegistry {
  readonly #factory: WatcherFactory;
  readonly #watchers = new Map<string, ManagedWatcher>();
  readonly #inFlight = new Set<string>();

  constructor(factory: WatcherFactory) {
    this.#factory = factory;
  }

  async add(account: Account): Promise<void> {
    if (this.#watchers.has(account.label) || this.#inFlight.has(account.label)) {
      throw new Error(`a watcher for "${account.label}" is already running`);
    }
    this.#inFlight.add(account.label);
    try {
      const watcher = this.#factory(account);
      // Register only after a successful start, so a failed start cannot
      // leave a dead entry that blocks a later retry with the same label.
      await watcher.start();
      this.#watchers.set(account.label, watcher);
    } finally {
      this.#inFlight.delete(account.label);
    }
  }

  async remove(label: string): Promise<boolean> {
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

  has(label: string): boolean {
    return this.#watchers.has(label);
  }

  size(): number {
    return this.#watchers.size;
  }

  states(): { label: string; state: WatcherState }[] {
    return [...this.#watchers.values()].map((w) => ({ label: w.label, state: w.state }));
  }

  async stopAll(): Promise<void> {
    const watchers = [...this.#watchers.values()];
    this.#watchers.clear();
    const results = await Promise.allSettled(watchers.map((w) => w.stop()));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        console.error(
          `[${watchers[i]?.label ?? '?'}] failed to stop cleanly: ${errorText(result.reason)}`
        );
      }
    });
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
