import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { SeenStore } from './store/seen.js';
import { TelegramSender } from './telegram/sender.js';
import type { SendOutcome } from './telegram/sender.js';
import { formatEmail } from './mail/format.js';
import { AccountWatcher } from './imap/watcher.js';
import { buildHealthReport, startHealthServer } from './health.js';
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
  exit: (code: number) => void;
  logger?: EmailHandlerLogger;
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

/** Minimal shape `startAllWatchers` needs from an AccountWatcher, so tests can pass a stub. */
export type StartableWatcher = {
  label: string;
  start(): Promise<void>;
};

/**
 * Starts every watcher concurrently and never rejects, no matter how many
 * (or how badly) individual starts fail. Extracted from main() (mirroring
 * the createEmailHandler/shutdown extractions) after a review finding: the
 * previous inline version logged a failed start via a raw `console.error`
 * inside a `Promise.allSettled` forEach. Had that raw call thrown (EPIPE on
 * closed stdout is the standing example in this codebase), the throw would
 * have propagated synchronously out of the forEach and out of main() itself
 * — hitting the bottom-level `.catch` -> `process.exit(1)` and killing every
 * already-started healthy watcher, before the SIGTERM/SIGINT handlers were
 * even registered. That would have defeated the entire point of using
 * `allSettled` here in the first place.
 *
 * `Promise.allSettled` alone already guarantees every watcher's `start()` is
 * invoked and awaited regardless of any other watcher's outcome; routing the
 * failure log through the safe logger closes the remaining gap, so nothing
 * in this function can throw synchronously and stop main() from reaching
 * its next statement.
 */
export async function startAllWatchers(
  watchers: StartableWatcher[],
  logger: EmailHandlerLogger = consoleLogger
): Promise<void> {
  const safeLogger = toSafeLogger(logger);
  const startResults = await Promise.allSettled(watchers.map((w) => w.start()));
  startResults.forEach((result, i) => {
    if (result.status === 'rejected') {
      const label = watchers[i]?.label ?? `#${i}`;
      safeLogger.error(`[${label}] failed to start: ${errorMessage(result.reason)}`);
    }
  });
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

  const watchers = config.mailboxes.map(
    (account) =>
      new AccountWatcher({
        account,
        store,
        previewChars: config.previewChars,
        sweepIntervalSeconds: config.sweepIntervalSeconds,
        onEmail,
        onFatal,
      })
  );

  const health = startHealthServer(config.healthPort, () =>
    buildHealthReport(watchers.map((w) => ({ label: w.label, state: w.state })))
  );

  const pruneTimer = armPruneTimer(store, PRUNE_AFTER_DAYS, PRUNE_INTERVAL_MS);

  safeConsoleLogger.log(`watching ${watchers.length} mailbox(es); health on :${config.healthPort}`);

  // One account's failure to start must never take down the others: each
  // watcher's own error paths are self-contained today (auth-failed /
  // connect-failed are handled internally and never reject start()), but
  // that safety rests on onFatal's sender.send() never throwing — a
  // condition worth not depending on. startAllWatchers keeps every healthy
  // account running even if one does reject, and never throws itself; the
  // health endpoint already reports the failed account's state
  // independently.
  await startAllWatchers(watchers);

  let shuttingDown = false;
  const onSignal = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown(signal, {
      watchers,
      pruneTimer,
      health,
      store,
      exit: (code) => process.exit(code),
    });
  };

  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
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
