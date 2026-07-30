import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { SeenStore } from './store/seen.js';
import { TelegramSender } from './telegram/sender.js';
import type { SendOutcome } from './telegram/sender.js';
import { formatEmail, escapeHtml } from './mail/format.js';
import { AccountWatcher } from './imap/watcher.js';
import type { WatcherState } from './imap/watcher.js';
import { buildHealthReport, startHealthServer } from './health.js';
import { deriveKey } from './crypto/secret.js';
import { MailboxStore } from './store/mailboxes.js';
import { WatcherRegistry } from './imap/registry.js';
import { probeMailbox } from './imap/probe.js';
import { Conversations } from './telegram/conversation.js';
import { runReceiver, FatalTelegramError } from './telegram/receiver.js';
import { handleUpdate } from './telegram/commands.js';
import type { Account, NormalizedEmail } from './types.js';

const PRUNE_AFTER_DAYS = 30;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Minimal shape `createEmailHandler` needs from TelegramSender, so tests can pass a stub. */
export type EmailSender = {
  send(html: string): Promise<SendOutcome>;
};

export type EmailHandlerLogger = {
  log: (message: string) => void;
  error: (message: string) => void;
};

const consoleLogger: EmailHandlerLogger = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wraps a logger so that a throw from the logger itself (e.g. `console.error`
 * raising EPIPE when stdout/the log pipe has gone away — a normal Docker/
 * Coolify occurrence) can never escape. Logging is inherently best-effort:
 * every call site in this module goes through this wrapper exactly once, so
 * a future edit that adds another `logger.log`/`logger.error` call cannot
 * reintroduce an unguarded path out of a "must never throw" function.
 */
function toSafeLogger(logger: EmailHandlerLogger): EmailHandlerLogger {
  return {
    log: (message) => {
      try {
        logger.log(message);
      } catch {
        // Deliberately swallowed: logging must never be able to wedge the
        // caller (onEmail, shutdown) forever.
      }
    },
    error: (message) => {
      try {
        logger.error(message);
      } catch {
        // Same as above.
      }
    },
  };
}

/**
 * The safe wrapper around the raw console, used by every logging call site
 * in this module outside of createEmailHandler/shutdown (which each wrap
 * their own injected logger). No `console.log`/`console.error` call anywhere
 * in main()'s startup, steady-state, or shutdown paths should be raw: a
 * throw from the console (EPIPE on a closed stdout is the standing example
 * in this codebase) must never be able to take the process down.
 */
const safeConsoleLogger: EmailHandlerLogger = toSafeLogger(consoleLogger);

/**
 * Builds the sweeper's onEmail callback. Extracted from main() (rather than
 * an inline closure, as the original design had it) so it is independently
 * testable: the sweeper marks a message as seen only AFTER onEmail resolves,
 * and does not advance folder state when onEmail throws. That combination
 * means a throwing onEmail would retry the same message forever and block
 * every later message in that folder behind it — so it is critical this
 * handler NEVER rejects, no matter what goes wrong internally.
 *
 * `sender.send()` already returns 'sent' | 'dropped' rather than throwing
 * for the cases it understands, so the happy path is safe by construction.
 * The try/catch below exists for everything else: a bug in formatEmail, an
 * out-of-memory while building a huge preview, or any other unexpected
 * throw. Never logs the email body or any credentials.
 *
 * The logger itself is wrapped via `toSafeLogger` before use: a throw from
 * `logger.log`/`logger.error` (e.g. EPIPE on a closed stdout) is just as
 * capable of wedging this folder forever as a throw from `sender.send`, so
 * it gets the same "never propagate" treatment.
 */
export function createEmailHandler(
  sender: EmailSender,
  logger: EmailHandlerLogger = consoleLogger
): (email: NormalizedEmail) => Promise<void> {
  const safeLogger = toSafeLogger(logger);
  return async (email: NormalizedEmail): Promise<void> => {
    const subject = email.subject.slice(0, 60);
    try {
      const outcome = await sender.send(formatEmail(email));
      if (outcome === 'dropped') {
        safeLogger.error(
          `[${email.accountLabel}/${email.folder}] dropped notification: "${subject}"`
        );
      } else {
        safeLogger.log(`[${email.accountLabel}/${email.folder}] sent: "${subject}"`);
      }
    } catch (err) {
      // ANY unexpected throw is caught, logged, and swallowed here rather
      // than propagated: propagating it would wedge this folder forever.
      safeLogger.error(
        `[${email.accountLabel}/${email.folder}] onEmail failed unexpectedly for "${subject}": ${errorMessage(
          err
        )}`
      );
    }
  };
}

/** How long `onBeforeExit` waits for the Telegram receiver before giving up on it. */
const RECEIVER_SHUTDOWN_TIMEOUT_MS = 2000;

/**
 * Belt-and-braces outer bound `shutdown` itself applies around a
 * caller-supplied `onBeforeExit`, independent of whatever internal bound
 * that callback may or may not apply to itself. Strictly larger than
 * `RECEIVER_SHUTDOWN_TIMEOUT_MS` so, in the shipped shape (main()'s
 * `onBeforeExit` already races `receiverDone` against that shorter timeout),
 * this outer one is not expected to be the one that fires — it exists so the
 * "always exits" contract holds even for a future caller whose own
 * `onBeforeExit` is not itself bounded.
 */
export const ONBEFORE_EXIT_TIMEOUT_MS = 5000;

/**
 * Waits for `promise` to settle, but gives up and resolves anyway after
 * `timeoutMs` if it hasn't. Used by main()'s `onBeforeExit` so a stuck
 * receiver cannot block shutdown past the container's SIGTERM grace period:
 * `receiverAbort.abort()` cancels the in-flight `fetch`, but two paths in
 * `runReceiver`'s loop ignore the signal — the non-abortable backoff sleep
 * (up to 60s) and an in-flight `onUpdate` (which can be mid-`probeMailbox`,
 * which has no timeout of its own). Without a bound here, `shutdown` would
 * stall awaiting the receiver forever, so the watchers, health server, and
 * both SQLite stores would never get a clean close before Docker SIGKILLs —
 * exactly what the fault-tolerant `shutdown` design exists to prevent.
 *
 * The timer is unref'd so a settled receiver does not itself keep the
 * process alive waiting for this timeout to fire; both call sites in
 * `shutdown`/`main()` invoke this before the health server closes and before
 * the watchers stop, so those still-open handles keep the event loop alive
 * long enough for an unref'd timer to fire regardless.
 */
export async function withShutdownTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
  logger: EmailHandlerLogger = consoleLogger
): Promise<void> {
  const safeLogger = toSafeLogger(logger);
  let settled = false;

  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });

  await Promise.race([promise.then(() => { settled = true; }), timeout]);

  if (!settled) {
    safeLogger.error(
      `receiver did not settle within ${timeoutMs}ms of abort; continuing shutdown anyway`
    );
  }
}

/** Minimal shape `shutdown` needs from an AccountWatcher, so tests can pass a stub. */
export type ShutdownWatcher = {
  label: string;
  stop(): Promise<void>;
};

export type ShutdownDeps = {
  watchers: ShutdownWatcher[];
  pruneTimer: NodeJS.Timeout;
  health: { close(): Promise<void> };
  store: { close(): void };
  /**
   * Closed after the watchers stop and the health server closes, alongside
   * `store` — not from within `onBeforeExit`. `onBeforeExit` runs while an
   * `onUpdate` handler may still be mid-`probeMailbox`; closing the mailbox
   * store there would let that in-flight command resume against an
   * already-closed database. Deferring the close to here maximises the
   * window such a command has to finish before the database goes away.
   */
  mailboxStore?: { close(): void };
  exit: (code: number) => void;
  logger?: EmailHandlerLogger;
  onBeforeExit?: () => Promise<void>;
};

/**
 * Stops every watcher, closes the health server, and closes the store, then
 * always calls `exit(0)` — no matter what fails along the way. Extracted
 * from main() (mirroring the createEmailHandler extraction) so it is
 * independently testable via an injected `exit` callback instead of a real
 * `process.exit`.
 *
 * This must be resilient rather than a straight-line await chain: a
 * better-sqlite3 handle throwing on close(), a watcher's logout() rejecting,
 * or the health server's close() rejecting would otherwise stop `exit(0)`
 * from ever running — hanging the container on SIGTERM until Docker
 * escalates to SIGKILL, and skipping a clean WAL checkpoint. Each step is
 * isolated so one failure cannot prevent the others, and the whole body runs
 * inside try/finally so `exit(0)` always fires.
 */
export async function shutdown(signal: string, deps: ShutdownDeps): Promise<void> {
  const logger = toSafeLogger(deps.logger ?? consoleLogger);
  try {
    logger.log(`received ${signal}, shutting down`);
    clearInterval(deps.pruneTimer);

    if (deps.onBeforeExit) {
      try {
        // Bounded even though the shipped onBeforeExit already bounds
        // itself (Finding 1's withShutdownTimeout around receiverDone):
        // this is shutdown()'s own guarantee, so a future caller supplying
        // an unbounded onBeforeExit cannot stall exit(0) either. Both the
        // health server and the watchers are still open at this point (they
        // close later, below), so the event loop stays alive long enough
        // for this timer to fire regardless of its unref().
        await withShutdownTimeout(deps.onBeforeExit(), ONBEFORE_EXIT_TIMEOUT_MS, logger);
      } catch (err) {
        logger.error(`pre-exit cleanup failed: ${errorMessage(err)}`);
      }
    }

    const stopResults = await Promise.allSettled(deps.watchers.map((w) => w.stop()));
    stopResults.forEach((result, i) => {
      if (result.status === 'rejected') {
        const label = deps.watchers[i]?.label ?? `#${i}`;
        logger.error(`watcher "${label}" failed to stop cleanly: ${errorMessage(result.reason)}`);
      }
    });

    try {
      await deps.health.close();
    } catch (err) {
      logger.error(`health server failed to close cleanly: ${errorMessage(err)}`);
    }

    try {
      deps.store.close();
    } catch (err) {
      logger.error(`store failed to close cleanly: ${errorMessage(err)}`);
    }

    if (deps.mailboxStore) {
      try {
        deps.mailboxStore.close();
      } catch (err) {
        logger.error(`mailbox store failed to close cleanly: ${errorMessage(err)}`);
      }
    }
  } finally {
    deps.exit(0);
  }
}

/** Minimal shape `armPruneTimer` needs from a SeenStore, so tests can pass a stub. */
export type PruneStore = { prune(days: number): number };

/**
 * Runs an immediate prune, then arms a periodic timer for subsequent runs.
 * Extracted (mirroring the createEmailHandler/shutdown/startAllWatchers
 * extractions) after a review finding: a bare `setInterval` only fires its
 * first tick after `intervalMs` has elapsed. In a redeploy-heavy Coolify
 * setup, the process may be restarted well before a full 24h passes, so the
 * documented 30-day retention bound could go unenforced indefinitely.
 * Running prune once immediately closes that gap.
 */
export function armPruneTimer(store: PruneStore, days: number, intervalMs: number): NodeJS.Timeout {
  const runPrune = (): void => {
    const removed = store.prune(days);
    if (removed > 0) safeConsoleLogger.log(`pruned ${removed} seen-message records`);
  };
  runPrune();
  return setInterval(runPrune, intervalMs);
}

/** Minimal shape `restoreMailboxes` needs from the WatcherRegistry. */
export type RestorableRegistry = {
  add(account: Account): Promise<void>;
};

export type RestoreDeps = {
  labels: () => string[];
  get: (label: string) => Account | null;
  registry: RestorableRegistry;
  /** Sends an operator-visible alert. Never allowed to break the restore. */
  alert: (message: string) => Promise<void>;
  logger?: EmailHandlerLogger;
};

/**
 * Restores every persisted mailbox CONCURRENTLY and never rejects, no matter
 * how many (or how badly) individual mailboxes fail. Adapted from the former
 * `startAllWatchers`, which this replaces outright rather than sitting
 * alongside as a second variant.
 *
 * Two separate hazards are covered here, and both have bitten this file
 * before:
 *
 * 1. Concurrency. `registry.add()` awaits `AccountWatcher.start()`, which
 *    awaits `#connectWithRetry` — up to `MAX_CONSECUTIVE_FAILURES` attempts
 *    with backoff capped at 300s, i.e. roughly 58 minutes for a single bad
 *    mailbox, plus ImapFlow's ~90s connect timeout per attempt. Restoring
 *    mailboxes one-at-a-time meant one mailbox with a rotated password (the
 *    bare `NO Login failed` case `isAuthError` provably cannot detect — see
 *    watcher.ts) delayed every OTHER mailbox behind it for an hour.
 *    `Promise.allSettled` over the whole set makes each mailbox's fate its
 *    own.
 *
 * 2. Logging. The failure log goes through the safe logger, because a raw
 *    `console.error` throwing (EPIPE on a closed stdout is the standing
 *    example in this codebase) would propagate synchronously out of the
 *    surrounding loop and out of the caller.
 *
 * The caller is expected NOT to await this — see `startDaemon`.
 */
export async function restoreMailboxes(deps: RestoreDeps): Promise<void> {
  const safeLogger = toSafeLogger(deps.logger ?? consoleLogger);

  let labels: string[];
  try {
    labels = deps.labels();
  } catch (err) {
    safeLogger.error(`could not list saved mailboxes to restore: ${errorMessage(err)}`);
    return;
  }

  await Promise.allSettled(
    labels.map(async (label) => {
      try {
        // `get()` decrypts, so it throws on a wrong/rotated MASTER_KEY or a
        // tampered row. A mailbox that cannot be decrypted is skipped LOUDLY
        // rather than silently dropped — silence is indistinguishable from
        // "mail stopped arriving".
        const account = deps.get(label);
        if (account === null) return;
        await deps.registry.add(account);
      } catch (err) {
        const detail = errorMessage(err);
        safeLogger.error(`[${label}] could not be restored: ${detail}`);
        await deps
          .alert(
            `⚠️ Mailbox "${escapeHtml(label)}" could not be restored: ${escapeHtml(detail)}. ` +
              `If MASTER_KEY changed, remove and re-add it.`
          )
          .catch((alertErr: unknown) => {
            safeLogger.error(
              `[${label}] could not send the restore-failure alert: ${errorMessage(alertErr)}`
            );
          });
      }
    })
  );
}

export type DaemonDeps = {
  healthPort: number;
  states: () => { label: string; state: WatcherState }[];
  /** Starts the Telegram long-poll loop. Returns the promise for its lifetime. */
  startReceiver: () => Promise<void>;
  /** Restores persisted mailboxes. Started, deliberately never awaited. */
  restore: () => Promise<void>;
  armPrune: () => NodeJS.Timeout;
  logger?: EmailHandlerLogger;
};

export type StartedDaemon = {
  health: { port: number; close(): Promise<void> };
  pruneTimer: NodeJS.Timeout;
  receiverDone: Promise<void>;
  /** Never rejects. Exposed for tests; boot itself must not await it. */
  restoreDone: Promise<void>;
};

/**
 * Brings the daemon up in the ONLY order that is safe, and returns promptly.
 *
 * The ordering here is load-bearing, not stylistic. A previous arrangement
 * ran the mailbox restore first and awaited it, which meant one unreachable
 * mailbox held the health port unbound for the better part of an hour. With
 * the container healthcheck at `--start-period=45s --interval=30s
 * --retries=3`, the orchestrator declared the container unhealthy at ~2m15s
 * and restarted it — into the same stall, forever. Every healthy mailbox
 * stopped delivering, and the operator could not `/remove` the broken one
 * because the receiver had not started either.
 *
 * So:
 *   1. The Telegram receiver starts first. The operator can always reach the
 *      bot, even when every mailbox is down — that is the only way out of a
 *      bad-credentials situation.
 *   2. The health server binds next, and this awaits the actual `listening`
 *      event rather than assuming `listen()` took effect synchronously.
 *   3. The prune timer is armed, so retention is enforced regardless of what
 *      the mailboxes are doing.
 *   4. Only then is the restore kicked off — detached. `registry.add`
 *      resolving is not required for correctness: `#connectWithRetry`
 *      returns `false` instead of throwing on its terminal paths, and each
 *      watcher self-heals through its own timers afterwards.
 */
export async function startDaemon(deps: DaemonDeps): Promise<StartedDaemon> {
  const safeLogger = toSafeLogger(deps.logger ?? consoleLogger);

  const receiverDone = deps.startReceiver();

  const health = startHealthServer(deps.healthPort, () => buildHealthReport(deps.states()));
  try {
    await health.ready;
  } catch (err) {
    // startHealthServer's own 'error' handler has already logged this and
    // called exit(1). Swallow it here so the failure path is that exit, not
    // an exception thrown out of boot before it can happen.
    safeLogger.error(`health server did not bind: ${errorMessage(err)}`);
  }

  const pruneTimer = deps.armPrune();

  // Deliberately NOT awaited: see the contract above.
  const restoreDone = deps.restore().catch((err: unknown) => {
    safeLogger.error(`mailbox restore failed unexpectedly: ${errorMessage(err)}`);
  });

  return { health, pruneTimer, receiverDone, restoreDone };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const store = new SeenStore(config.dbPath);
  const sender = new TelegramSender({
    token: config.telegramBotToken,
    chatId: config.telegramChatId,
  });

  const onEmail = createEmailHandler(sender);

  const onFatal = async (account: Account, message: string): Promise<void> => {
    // `message` is built entirely by AccountWatcher from the account label
    // and a description of the failure mode; it never includes the mailbox
    // password. `account` itself is intentionally unused beyond that.
    void account;
    await sender.send(`⚠️ <b>Email notifier</b>\n${message}`);
  };

  const key = deriveKey(config.masterKey);
  const mailboxes = new MailboxStore(config.dbPath, key);

  const registry = new WatcherRegistry((account) =>
    new AccountWatcher({
      account,
      store,
      previewChars: config.previewChars,
      sweepIntervalSeconds: config.sweepIntervalSeconds,
      onEmail,
      onFatal,
    })
  );

  // Trimmed once here and reused for both the operator-chat-id comparison in
  // handleUpdate and the deleteMessage call: trailing whitespace in the env
  // var would make every `String(chat.id) !== operatorChatId` comparison
  // fail, turning the bot into a silent brick with no diagnostic.
  const operatorChatId = config.telegramChatId.trim();
  const conversations = new Conversations();
  const receiverAbort = new AbortController();

  let started: StartedDaemon | null = null;
  let shuttingDown = false;

  /**
   * The single entry point into shutdown. Takes the intended exit code so
   * callers other than SIGTERM/SIGINT can request a non-zero exit without
   * bypassing the clean-shutdown sequence.
   */
  const beginShutdown = (reason: string, code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const daemon = started;
    if (daemon === null) {
      // Fatal before startDaemon returned: there is nothing constructed yet
      // to unwind, so there is nothing a shutdown() call could clean up.
      process.exit(code);
      return;
    }
    void shutdown(reason, {
      watchers: registry
        .states()
        .map((s) => ({ label: s.label, stop: () => registry.remove(s.label).then(() => undefined) })),
      pruneTimer: daemon.pruneTimer,
      health: daemon.health,
      store,
      mailboxStore: mailboxes,
      exit: (c) => process.exit(c),
      onBeforeExit: async () => {
        receiverAbort.abort();
        // Bounded: receiverDone may not settle promptly (an in-flight
        // backoff sleep or a probeMailbox call ignore the abort signal).
        // mailboxes.close() is deliberately NOT called here — it is passed
        // as `mailboxStore` above and closed later in shutdown()'s main
        // sequence (after watchers stop and the health server closes), so
        // an in-flight command that resumes after this bounded wait still
        // has the longest practical window to finish before the database
        // goes away.
        await withShutdownTimeout(daemon.receiverDone, RECEIVER_SHUTDOWN_TIMEOUT_MS, safeConsoleLogger);
      },
    });
  };

  started = await startDaemon({
    healthPort: config.healthPort,
    states: () => registry.states(),
    startReceiver: () =>
      runReceiver({
        token: config.telegramBotToken,
        signal: receiverAbort.signal,
        onUpdate: (update) =>
          handleUpdate(update, {
            operatorChatId,
            mailboxes,
            seen: store,
            registry,
            conversations,
            probe: probeMailbox,
            reply: async (text) => {
              // commands.ts deliberately emits no markup, but TelegramSender
              // always sends with parse_mode: 'HTML' — a label or hostname
              // containing '<' or '&' would otherwise produce a Telegram 400.
              await sender.send(escapeHtml(text));
            },
            deleteMessage: (messageId) => sender.deleteMessage(operatorChatId, messageId),
            now: () => Date.now(),
          }),
      }).catch((err: unknown) => {
        if (err instanceof FatalTelegramError) {
          safeConsoleLogger.error(`fatal: ${err.message}`);
          process.exit(1);
        }
        safeConsoleLogger.error(`receiver stopped: ${errorMessage(err)}`);
      }),
    // Detached inside startDaemon: a mailbox that cannot connect must not
    // hold the health port, the receiver, or the signal handlers hostage.
    restore: () =>
      restoreMailboxes({
        labels: () => mailboxes.labels(),
        get: (label) => mailboxes.get(label),
        registry,
        alert: async (message) => {
          await sender.send(message);
        },
      }),
    armPrune: () => armPruneTimer(store, PRUNE_AFTER_DAYS, PRUNE_INTERVAL_MS),
  });

  safeConsoleLogger.log(
    `health on :${config.healthPort}; restoring saved mailboxes in the background`
  );

  process.on('SIGTERM', () => beginShutdown('SIGTERM', 0));
  process.on('SIGINT', () => beginShutdown('SIGINT', 0));
}

// Guard direct execution vs. being imported (e.g. by tests that only want
// createEmailHandler/shutdown). Without this, importing this module would
// call main() as a side effect: loadConfig() would throw on missing env vars
// in the test environment and process.exit(1) would kill the test run.
//
// Compared via pathToFileURL rather than a raw `file://${process.argv[1]}`
// template: the naive template does not URL-encode argv[1], so a path
// containing a space or non-ASCII character (or certain symlinked
// invocations) would never match. That failure mode is silent — main()
// would just never run: no watchers, no log output, no non-zero exit, and
// the health port never binds, so the container would look alive while
// doing nothing. pathToFileURL performs the same encoding Node used to
// produce import.meta.url in the first place, so the comparison is exact.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    // Routed through the safe logger for the same reason as every other
    // console call in this module: this is the last-resort boot-failure
    // path, and a throw here (e.g. EPIPE) must not prevent the process.exit
    // that follows it.
    safeConsoleLogger.error(`fatal: ${errorMessage(err)}`);
    process.exit(1);
  });
}
