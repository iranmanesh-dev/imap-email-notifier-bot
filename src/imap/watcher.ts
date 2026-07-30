import type { ImapFlow } from 'imapflow';
import { createClient, imapSweepDeps, isAuthError } from './client.js';
import { sweep, errorMessage } from './sweeper.js';
import { scrubSecret } from '../scrub.js';
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

/**
 * How long stop() waits for an already-running sweep to finish before giving
 * up on it.
 *
 * Bounded rather than unbounded because the tail of a sweep can be parked on
 * a Telegram send (>=1.1s throttle per message, up to 5 attempts with 30s
 * backoff), and /remove must stay responsive: a stuck send must not block
 * removal indefinitely. Long enough that the ordinary case — a handful of
 * remaining messages, or a single slow send — drains completely.
 */
export const SWEEP_DRAIN_TIMEOUT_MS = 5000;

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

  /**
   * Formats a caught value for logging with this account's password removed.
   * Every `console.error` in this class that interpolates an error goes
   * through here: `registry.add(account)` is called with the plaintext
   * password in `account.pass`, and a server that echoes a rejected LOGIN
   * back would otherwise put it straight into the container log on every
   * retry.
   */
  #logSafe(err: unknown): string {
    return scrubSecret(errorMessage(err), this.#opts.account.pass);
  }

  async start(): Promise<void> {
    const connected = await this.#connectWithRetry(() => this.#connect());
    // Also bail if #stopped raced in during that connect: #connectSweep/
    // #connectIdle already discard the client they were holding in that
    // case, but without this check we would still overwrite a 'stopped'
    // state with 'ok' and arm a sweep-interval timer that would outlive
    // stop().
    if (!connected || this.#stopped) return;

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

    // Drain BEFORE tearing the clients down. Logging the IMAP client out
    // cannot stop a sweep that is already past fetchSince: everything after
    // it (onEmail, markSeen, setFolderState) is local work plus Telegram,
    // with no IMAP call left to fail. Callers rely on stop() meaning "no
    // more writes are coming from this watcher" — WatcherRegistry.remove()
    // awaits stop(), and commands.ts purges the account's seen-state
    // immediately afterwards. Without this wait, that purge raced the
    // sweep's own setFolderState and the stale high-water mark came back.
    await this.#drainSweep();

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
   * Waits for the current sweep chain to settle, bounded by
   * SWEEP_DRAIN_TIMEOUT_MS. `#sweepChain` never rejects (triggerSweep stores
   * the caught form), so this only ever resolves.
   *
   * Any sweep queued but not yet started returns immediately once
   * `#stopped` is set, so in practice this waits for at most the one sweep
   * that was already running. Reconnects cannot extend it either:
   * `#connectWithRetry` loops on `while (!this.#stopped)` and so returns at
   * once rather than sleeping through its backoff.
   */
  async #drainSweep(): Promise<void> {
    let settled = false;
    const drained = this.#sweepChain.then(() => {
      settled = true;
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SWEEP_DRAIN_TIMEOUT_MS);
      // unref'd so a drain that finishes early cannot hold the event loop
      // open for the remainder of the window during shutdown; cleared below
      // for the same reason.
      timer.unref?.();
    });

    try {
      await Promise.race([drained, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (!settled) {
      console.error(
        `[${this.#opts.account.label}] in-flight sweep did not finish within ${SWEEP_DRAIN_TIMEOUT_MS}ms of stop(); abandoning it, so a few of its remaining writes may still land`
      );
    }
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
          `[${this.#opts.account.label}] connection failed: ${this.#logSafe(err)}; retrying`
        );

        if (this.#consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.#state = 'connect-failed';
          this.#stopIdleWatchdog();
          const message = `Account ${this.#opts.account.label} gave up after ${this.#consecutiveFailures} consecutive connection failures; check credentials or host settings.`;
          console.error(`[${this.#opts.account.label}] ${message}`);
          await this.#opts.onFatal(this.#opts.account, message);
          return false;
        }

        // Gate on !#stopped: stop() can flip #stopped while connectFn()
        // above was in flight, and this write must not clobber the
        // 'stopped' state it sets afterward.
        if (!this.#stopped) this.#state = 'reconnecting';
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
    if (this.#stopped) return; // stop() raced in; #connectSweep already discarded its client
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
    // Attach 'error' immediately after connect(), before any other await.
    // ImapFlow's emitError() ends in an unguarded `this.emit('error', err)`;
    // on an EventEmitter with zero 'error' listeners that throws and takes
    // down the whole process. The socket-timeout path (the classic
    // NAT/firewall silent-drop failure mode for long-lived IMAP connections)
    // bypasses ImapFlow's own allowlist of swallowed codes and calls
    // emitError directly for any non-IDLE connection, so the sweep client
    // needs this listener just as much as the idle client does. Never logs
    // more than the account label and error message.
    client.on('error', (err: Error) => {
      console.error(`[${this.#opts.account.label}] sweep client error: ${this.#logSafe(err)}`);
    });
    if (this.#stopped) {
      // stop() ran while client.connect() was in flight. stop() has already
      // logged out whatever #sweepClient held (null, at this point) and
      // cleared the timers; if we assigned this freshly connected client
      // now, it would silently outlive stop() as an orphaned connection
      // that nothing ever logs out. Discard it instead of adopting it.
      await client.logout().catch(() => undefined);
      return;
    }
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
    // Attach 'error' immediately after connect(), before any other await
    // (in particular before mailboxOpen('INBOX')). That call is itself an
    // await point during which ImapFlow can already emit 'error' (e.g. the
    // same socket-timeout path described in #connectSweep); leaving the
    // window between connect() and this listener unprotected would still
    // let a drop in exactly that window crash the process.
    client.on('error', (err: Error) => {
      console.error(`[${this.#opts.account.label}] idler error: ${this.#logSafe(err)}`);
    });
    if (this.#stopped) {
      // Same race as #connectSweep: stop() ran while we were connecting.
      // Discard this client rather than adopting it and re-arming the
      // watchdog on a connection nothing will ever log out again.
      await client.logout().catch(() => undefined);
      return;
    }
    await client.mailboxOpen('INBOX');
    if (this.#stopped) {
      await client.logout().catch(() => undefined);
      return;
    }

    // ImapFlow idles automatically on an open mailbox and emits `exists`
    // when the server reports new messages. That is our early-sweep signal.
    client.on('exists', () => {
      this.#lastIdleActivity = Date.now();
      void this.triggerSweep();
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
      // Routed through #connectWithRetry (not called directly) so this
      // reconnect is classified and counted exactly like any other
      // connection attempt: isAuthError gets a chance to fire, and repeated
      // failures count toward MAX_CONSECUTIVE_FAILURES instead of retrying
      // forever, uncapped and unclassified, once every IDLE_REFRESH_MS.
      await this.#connectWithRetry(() => this.#connectIdle());
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
              .map((f) => `${f.folder}: ${scrubSecret(f.message, this.#opts.account.pass)}`)
              .join('; ')}`
          );
        }
      }
      // Gate on !#stopped: stop() flips #stopped before it starts draining
      // this chain, so the sweep it is waiting on runs its remaining lines
      // (this one included) with #stopped already true. Without this guard a
      // straggling write here would clobber the terminal 'stopped' state and
      // a shut-down account would keep reporting as 'ok' or 'reconnecting'.
      // The guard is also the last line of defense for a sweep that outran
      // SWEEP_DRAIN_TIMEOUT_MS and was abandoned.
      if (!this.#stopped) this.#state = 'ok';
    } catch (err) {
      if (!this.#stopped) this.#state = 'reconnecting';
      console.error(`[${this.#opts.account.label}] sweep failed: ${this.#logSafe(err)}`);
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
