import type { ImapFlow } from 'imapflow';
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
  /**
   * Overrides how a raw IMAP client is constructed. Defaults to the real
   * createClient. Lets tests observe the actual connection lifecycle
   * (#connectSweep / #connectIdle / the idle watchdog) with fake clients,
   * instead of only exercising deps.connect/deps.runSweep short-circuits.
   */
  createClientImpl?: (account: Account) => ImapFlow;
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
  readonly #createClientImpl: (account: Account) => ImapFlow;

  #state: WatcherState = 'starting';
  #stopped = false;
  #sweepChain: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #idleHealthInFlight = false;
  #sweepClient: ImapFlow | null = null;
  #idleClient: ImapFlow | null = null;
  #lastIdleActivity = Date.now();
  #consecutiveFailures = 0;

  constructor(opts: WatcherOptions) {
    this.#opts = opts;
    this.#sleep = opts.deps?.sleep ?? defaultSleep;
    this.#createClientImpl = opts.deps?.createClientImpl ?? createClient;
  }

  get state(): WatcherState {
    return this.#state;
  }

  get label(): string {
    return this.#opts.account.label;
  }

  async start(): Promise<void> {
    const connected = await this.#connectWithRetry(() => this.#connect());
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
    this.#stopIdleWatchdog();
    this.#timer = null;

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

  /**
   * Generic connect-with-retry loop. `connectFn` decides WHAT to (re)connect
   * — the initial full connect, just the sweep client, or just the idle
   * client — while this method owns the shared concerns: auth-is-fatal,
   * the consecutive-failure cap, and capped/jittered backoff between
   * attempts. `#consecutiveFailures` is an instance field (not local to this
   * call) so it accumulates across separate reconnect episodes and is only
   * reset by an actual successful connect, anywhere.
   */
  async #connectWithRetry(connectFn: () => Promise<void>): Promise<boolean> {
    let attempt = 0;
    while (!this.#stopped) {
      try {
        await connectFn();
        this.#consecutiveFailures = 0;
        return true;
      } catch (err) {
        if (isAuthError(err)) {
          this.#state = 'auth-failed';
          this.#stopIdleWatchdog();
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
          this.#stopIdleWatchdog();
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

  /** Initial connect only: establishes both the sweep and idle clients. */
  async #connect(): Promise<void> {
    const override = this.#opts.deps?.connect;
    if (override) {
      await override();
      return;
    }
    await this.#connectSweep();
    await this.#connectIdle();
  }

  /**
   * (Re)establishes the sweep client only, never touching the idle client.
   * Logs out whatever sweep client is currently held before replacing it —
   * every call site that reconnects the sweep client goes through here, so
   * there is never a moment where two sweep clients are alive at once.
   */
  async #connectSweep(): Promise<void> {
    // Tests may reconnect only via deps.connect (no createClientImpl at
    // all); honor that override here too, since #connectSweep can be
    // invoked directly (from #runSweep's catch) without going through
    // #connect() first.
    const override = this.#opts.deps?.connect;
    if (override) {
      await override();
      return;
    }
    if (this.#sweepClient) {
      await this.#sweepClient.logout().catch(() => undefined);
      this.#sweepClient = null;
    }
    const client = this.#createClientImpl(this.#opts.account);
    await client.connect();
    this.#sweepClient = client;
  }

  /**
   * (Re)establishes the idle client only, never touching the sweep client.
   * Same orphan-prevention rule as #connectSweep: log out the old client
   * before the new one replaces it. Also (re)arms the idle watchdog, since
   * every idle client — fresh or replaced — needs its own watchdog cycle.
   */
  async #connectIdle(): Promise<void> {
    // Same reasoning as #connectSweep: honor deps.connect when
    // #connectIdle is invoked directly (from #checkIdleHealth) without
    // going through #connect() first.
    const override = this.#opts.deps?.connect;
    if (override) {
      await override();
      return;
    }
    if (this.#idleClient) {
      await this.#idleClient.logout().catch(() => undefined);
      this.#idleClient = null;
    }
    const client = this.#createClientImpl(this.#opts.account);
    await client.connect();
    await client.mailboxOpen('INBOX');

    // ImapFlow idles automatically on an open mailbox and emits `exists`
    // when the server reports new messages. That is our early-sweep signal.
    client.on('exists', () => {
      this.#lastIdleActivity = Date.now();
      void this.triggerSweep();
    });
    client.on('error', (err: Error) => {
      console.error(`[${this.#opts.account.label}] idler error: ${err.message}`);
    });

    this.#idleClient = client;
    this.#lastIdleActivity = Date.now();
    this.#startIdleWatchdog();
  }

  #startIdleWatchdog(): void {
    this.#stopIdleWatchdog();
    this.#idleTimer = setInterval(() => {
      void this.#checkIdleHealth();
    }, IDLE_REFRESH_MS);
  }

  #stopIdleWatchdog(): void {
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    this.#idleTimer = null;
  }

  async #checkIdleHealth(): Promise<void> {
    // Terminal states must stop the idle cycle entirely: otherwise a
    // known-bad-credentials account would keep issuing a fresh LOGIN every
    // IDLE_REFRESH_MS forever, which is exactly the provider-IP-block
    // scenario the connection cap exists to prevent. #stopIdleWatchdog() at
    // the point of transition into these states (see #connectWithRetry)
    // means this timer should already be cleared and not fire again — this
    // check is the second line of defense in case a tick is already queued.
    if (this.#stopped || this.#state === 'auth-failed' || this.#state === 'connect-failed') {
      return;
    }
    // Re-entrancy guard: a slow reconnect must not overlap with the next tick.
    if (this.#idleHealthInFlight) return;
    this.#idleHealthInFlight = true;

    try {
      const silent = Date.now() - this.#lastIdleActivity;
      const alive = this.#idleClient?.usable === true;

      if (alive && silent < IDLE_WATCHDOG_MS) {
        // Touch the connection so the server and any NAT in between keep it open.
        await this.#idleClient?.noop().catch(() => undefined);
        this.#lastIdleActivity = Date.now();
        return;
      }

      console.error(`[${this.#opts.account.label}] idler stale; reconnecting it`);
      try {
        await this.#connectIdle();
      } catch (err) {
        console.error(
          `[${this.#opts.account.label}] idler reconnect failed: ${(err as Error).message}`
        );
      }
    } finally {
      this.#idleHealthInFlight = false;
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
      // Gate on !#stopped: stop() does not await this sweep chain, so an
      // in-flight sweep can still be running when stop() flips #state to
      // 'stopped'. Without this guard a straggling write here would clobber
      // that terminal state and a shut-down account would keep reporting
      // as 'ok' or 'reconnecting'.
      if (!this.#stopped) this.#state = 'ok';
    } catch (err) {
      if (!this.#stopped) this.#state = 'reconnecting';
      console.error(`[${this.#opts.account.label}] sweep failed: ${(err as Error).message}`);
      // Only the sweep client is suspect here; #connectSweep leaves the
      // idle client (and its watchdog) completely alone.
      const reconnected = await this.#connectWithRetry(() => this.#connectSweep());
      // A reconnect-only success does not itself prove a sweep will
      // succeed, but it does mean the account is no longer degraded from
      // the caller's point of view: the next timer tick or idle signal
      // will run a real sweep against the fresh client. Reporting 'ok'
      // here (instead of leaving it stuck at 'reconnecting' until that
      // next sweep) avoids a false "still degraded" reading that could
      // trip an external healthcheck/restart policy on nothing more than
      // a transient blip that already recovered.
      if (reconnected && !this.#stopped) {
        this.#state = 'ok';
      }
    }
  }
}
