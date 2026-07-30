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
 */
export function createEmailHandler(
  sender: EmailSender,
  logger: EmailHandlerLogger = consoleLogger
): (email: NormalizedEmail) => Promise<void> {
  return async (email: NormalizedEmail): Promise<void> => {
    const subject = email.subject.slice(0, 60);
    try {
      const outcome = await sender.send(formatEmail(email));
      if (outcome === 'dropped') {
        logger.error(
          `[${email.accountLabel}/${email.folder}] dropped notification: "${subject}"`
        );
      } else {
        logger.log(`[${email.accountLabel}/${email.folder}] sent: "${subject}"`);
      }
    } catch (err) {
      // ANY unexpected throw is caught, logged, and swallowed here rather
      // than propagated: propagating it would wedge this folder forever.
      logger.error(
        `[${email.accountLabel}/${email.folder}] onEmail failed unexpectedly for "${subject}": ${
          (err as Error).message
        }`
      );
    }
  };
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

  const pruneTimer = setInterval(() => {
    const removed = store.prune(PRUNE_AFTER_DAYS);
    if (removed > 0) console.log(`pruned ${removed} seen-message records`);
  }, PRUNE_INTERVAL_MS);

  console.log(`watching ${watchers.length} mailbox(es); health on :${config.healthPort}`);
  await Promise.all(watchers.map((w) => w.start()));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`received ${signal}, shutting down`);
    clearInterval(pruneTimer);
    await Promise.all(watchers.map((w) => w.stop()));
    await health.close();
    store.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Guard direct execution vs. being imported (e.g. by tests that only want
// `createEmailHandler`). Without this, importing this module would call
// main() as a side effect: loadConfig() would throw on missing env vars in
// the test environment and process.exit(1) would kill the test run.
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(`fatal: ${(err as Error).message}`);
    process.exit(1);
  });
}
