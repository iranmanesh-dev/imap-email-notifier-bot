import { ImapFlow } from 'imapflow';
import { createClient, imapSweepDeps, isAuthError } from './client.js';
import { sweep } from './sweeper.js';
import type { SeenStore } from '../store/seen.js';
import type { Account, NormalizedEmail } from '../types.js';

export type WatcherState =
  | 'starting'
  | 'ok'
  | 'reconnecting'
  | 'auth-failed'
  | 'connect-failed'
  | 'stopped';

export type WatcherTestDeps = {
  runSweep?: () => Promise<void>;
  connect?: () => Promise<void>;
  disconnect?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
};

export type WatcherOptions = {
  account: Account;
  store: SeenStore;
  previewChars: number;
  sweepIntervalSeconds: number;
  onEmail: (email: NormalizedEmail) => Promise<void>;
  onFatal: (account: Account, message: string) => Promise<void>;
  deps?: WatcherTestDeps;
};

const MAX_BACKOFF_MS = 300_000;
const IDLE_REFRESH_MS = 9 * 60_000;
const IDLE_WATCHDOG_MS = 12 * 60_000;

// isAuthError has a known false negative: ImapFlow only sets
// `authenticationFailed` for config-level problems. A genuine bad-password
// rejection arrives as a plain LOGIN NO response and only carries an
// AUTHENTICATIONFAILED code if the server follows RFC 5530 — a bare
// "NO Login failed" trips neither signal. Without a hard cap that means an
// infinite reconnect loop against a mailbox with wrong credentials, which
// risks the server blocking this host's IP. We do not attempt to pattern
// match error text (fragile, and prone to false positives that would
// permanently disable working mailboxes); instead we bound the number of
// consecutive connection failures and give up loudly once the bound is hit.
const MAX_CONSECUTIVE_FAILURES = 20;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class AccountWatcher {
  readonly #opts: WatcherOptions;
  readonly #sleep: (ms: number) => Promise<void>;

  #state: WatcherState = 'starting';
  #stopped = false;
  #sweepChain: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #sweepClient: ImapFlow | null = null;
  #idleClient: ImapFlow | null = null;
  #lastIdleActivity = Date.now();
  #consecutiveFailures = 0;

  constructor(opts: WatcherOptions) {
    this.#opts = opts;
    this.#sleep = opts.deps?.sleep ?? defaultSleep;
  }

  get state(): WatcherState {
    return this.#state;
  }

  get label(): string {
    return this.#opts.account.label;
  }

  async start(): Promise<void> {
    const connected = await this.#connectWithRetry();
    if (!connected) return;

    this.#state = 'ok';
    await this.triggerSweep();
    if (this.#stopped) return;

    this.#timer = setInterval(() => {
      void this.triggerSweep();
    }, this.#opts.sweepIntervalSeconds * 1000);
  }

  /** Queues a sweep. Concurrent calls are serialized, never overlapped. */
  triggerSweep(): Promise<void> {
    const next = this.#sweepChain.then(() => this.#runSweep());
    this.#sweepChain = next.catch(() => undefined);
    return next;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    this.#timer = null;
    this.#idleTimer = null;

    const disconnect = this.#opts.deps?.disconnect;
    if (disconnect) {
      await disconnect();
    } else {
      await this.#sweepClient?.logout().catch(() => undefined);
      await this.#idleClient?.logout().catch(() => undefined);
    }
    this.#sweepClient = null;
    this.#idleClient = null;
    this.#state = 'stopped';
  }

  async #connectWithRetry(): Promise<boolean> {
    let attempt = 0;
    while (!this.#stopped) {
      try {
        await this.#connect();
        this.#consecutiveFailures = 0;
        return true;
      } catch (err) {
        if (isAuthError(err)) {
          this.#state = 'auth-failed';
          const message = `Authentication failed for ${this.#opts.account.label}. Check the mailbox credentials; this account is now stopped.`;
          console.error(`[${this.#opts.account.label}] ${message}`);
          await this.#opts.onFatal(this.#opts.account, message);
          return false;
        }

        this.#consecutiveFailures += 1;
        console.error(
          `[${this.#opts.account.label}] connection failed: ${(err as Error).message}; retrying`
        );

        if (this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.#state = 'connect-failed';
          const message = `Account ${this.#opts.account.label} gave up after ${this.#consecutiveFailures} consecutive connection failures; check credentials or host settings.`;
          console.error(`[${this.#opts.account.label}] ${message}`);
          await this.#opts.onFatal(this.#opts.account, message);
          return false;
        }

        this.#state = 'reconnecting';
        const base = Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
        const jitter = base * 0.2 * Math.random();
        await this.#sleep(Math.min(base + jitter, MAX_BACKOFF_MS));
        attempt += 1;
      }
    }
    return false;
  }

  async #connect(): Promise<void> {
    const override = this.#opts.deps?.connect;
    if (override) {
      await override();
      return;
    }

    this.#sweepClient = createClient(this.#opts.account);
    await this.#sweepClient.connect();

    this.#idleClient = createClient(this.#opts.account);
    await this.#idleClient.connect();
    await this.#idleClient.mailboxOpen('INBOX');

    // ImapFlow idles automatically on an open mailbox and emits `exists`
    // when the server reports new messages. That is our early-sweep signal.
    this.#idleClient.on('exists', () => {
      this.#lastIdleActivity = Date.now();
      void this.triggerSweep();
    });
    this.#idleClient.on('error', (err: Error) => {
      console.error(`[${this.#opts.account.label}] idler error: ${err.message}`);
    });

    this.#lastIdleActivity = Date.now();
    this.#startIdleWatchdog();
  }

  #startIdleWatchdog(): void {
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    this.#idleTimer = setInterval(() => {
      void this.#checkIdleHealth();
    }, IDLE_REFRESH_MS);
  }

  async #checkIdleHealth(): Promise<void> {
    if (this.#stopped) return;
    const silent = Date.now() - this.#lastIdleActivity;
    const alive = this.#idleClient?.usable === true;

    if (alive && silent < IDLE_WATCHDOG_MS) {
      // Touch the connection so the server and any NAT in between keep it open.
      await this.#idleClient?.noop().catch(() => undefined);
      this.#lastIdleActivity = Date.now();
      return;
    }

    console.error(`[${this.#opts.account.label}] idler stale; reconnecting it`);
    await this.#idleClient?.logout().catch(() => undefined);
    this.#idleClient = null;
    try {
      await this.#connect();
    } catch (err) {
      console.error(
        `[${this.#opts.account.label}] idler reconnect failed: ${(err as Error).message}`
      );
    }
  }

  async #runSweep(): Promise<void> {
    if (this.#stopped || this.#state === 'auth-failed' || this.#state === 'connect-failed') {
      return;
    }

    const override = this.#opts.deps?.runSweep;
    try {
      if (override) {
        await override();
      } else {
        if (!this.#sweepClient?.usable) throw new Error('sweep client not connected');
        const result = await sweep(imapSweepDeps(this.#sweepClient), {
          accountLabel: this.#opts.account.label,
          previewChars: this.#opts.previewChars,
          store: this.#opts.store,
          onEmail: this.#opts.onEmail,
        });

        // foldersChecked counts only *successful* folders. If every folder
        // in the sweep failed, sweep() itself did not throw (each folder's
        // error was caught and recorded individually), but a 100% failure
        // rate strongly suggests the connection itself is broken rather
        // than a handful of unlucky folders. Treat that the same as a
        // thrown error: tear down the client and reconnect. A partial
        // failure (some folders ok, some not) is just logged and left for
        // the next sweep to retry.
        if (result.foldersChecked === 0 && result.failures.length > 0) {
          throw new Error(
            `all ${result.failures.length} folder(s) failed during sweep; treating connection as broken`
          );
        }

        if (result.failures.length > 0) {
          console.error(
            `[${this.#opts.account.label}] sweep completed with ${result.failures.length} folder failure(s): ${result.failures
              .map((f) => `${f.folder}: ${f.message}`)
              .join('; ')}`
          );
        }
      }
      this.#state = 'ok';
    } catch (err) {
      this.#state = 'reconnecting';
      console.error(`[${this.#opts.account.label}] sweep failed: ${(err as Error).message}`);
      await this.#sweepClient?.logout().catch(() => undefined);
      this.#sweepClient = null;
      await this.#connectWithRetry();
    }
  }
}
