import {
  CONFIRM_TTL_MS, PASSWORD_TTL_MS, WIZARD_TTL_MS, cancellationNotice, type Conversations,
} from './conversation.js';
import { cancelKeyboard, hostPickKeyboard, menuKeyboard } from './keyboards.js';
import { PLAIN_STATUS, buildStatusReport } from './status.js';
import { scrubSecret } from '../scrub.js';
import type { TelegramUpdate } from './receiver.js';
import type { InlineKeyboard } from './sender.js';
import type { MailboxStore } from '../store/mailboxes.js';
import type { SeenStore } from '../store/seen.js';
import type { WatcherRegistry } from '../imap/registry.js';
import type { ProbeResult } from '../imap/probe.js';
import type { Account } from '../types.js';

export type CommandDeps = {
  operatorChatId: string;
  mailboxes: MailboxStore;
  seen: Pick<SeenStore, 'purgeAccount'>;
  registry: WatcherRegistry;
  conversations: Conversations;
  probe: (account: Account) => Promise<ProbeResult>;
  // Optional so all pre-existing callers/tests (which pass none) keep
  // working unchanged; only the wizard's host prompt currently uses it.
  reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
  deleteMessage: (messageId: number) => Promise<boolean>;
  now: () => number;
  // Optional so all pre-existing callers/tests (which pass none) keep
  // working unchanged. Renders the button menu for /start, /help and /menu.
  menu?: () => Promise<void>;
};

const USAGE = [
  'Commands:',
  '/add <label> <host> <port> <username> — add a mailbox',
  '/list — list configured mailboxes',
  '/remove <label> — remove a mailbox',
  '/status — connection state per mailbox',
  '/test <label> — re-test a saved mailbox',
].join('\n');

/**
 * Entry point for every Telegram update.
 *
 * The chat-ID gate runs before ANY parsing, and an unauthorized chat gets
 * no reply at all — replying would confirm to a prober that the bot is live.
 */
export async function handleUpdate(update: TelegramUpdate, deps: CommandDeps): Promise<void> {
  const message = update.message;
  if (message === undefined) return;
  // The receiver only validates `update_id`, so `chat` is not guaranteed to
  // exist at runtime despite the type. Fail closed and stay silent.
  if (message.chat?.id === undefined) return;
  if (String(message.chat.id) !== deps.operatorChatId) return;

  const text = (message.text ?? '').trim();
  if (text.length === 0) return;

  const pending = deps.conversations.take(message.chat.id, deps.now());
  if (pending !== null) {
    if (!text.startsWith('/')) {
      if (pending.kind === 'wizard-label') {
        // The same pre-check /add does, at the only step that can make it.
        // Without it the operator walks all five steps, sends a password,
        // has it deleted and a real IMAP login run — and only then does
        // mailboxes.add throw "already exists", with nothing saved.
        // `take()` above already consumed the pending entry, so an unguarded
        // throw here would leave the operator with no reply AND no wizard
        // step to continue from — the flow would simply die mid-way with a
        // silent Telegram. Restore the step on failure and say so.
        let existing: string[];
        try {
          existing = deps.mailboxes.labels();
        } catch (err) {
          deps.conversations.set(message.chat.id, {
            kind: 'wizard-label', expiresAt: deps.now() + WIZARD_TTL_MS,
          });
          return deps.reply(
            `Could not read the saved mailboxes to check that label: ${errorText(err)}\n` +
              `Send the label again to retry.`,
            cancelKeyboard()
          );
        }
        if (existing.includes(text)) {
          // Stay on the label step so another label can simply be sent.
          deps.conversations.set(message.chat.id, {
            kind: 'wizard-label', expiresAt: deps.now() + WIZARD_TTL_MS,
          });
          return deps.reply(
            `A mailbox labelled "${text}" already exists. Send a different label, ` +
              `or remove that one first.`,
            cancelKeyboard()
          );
        }
        deps.conversations.set(message.chat.id, {
          kind: 'wizard-host', label: text, expiresAt: deps.now() + WIZARD_TTL_MS,
        });
        return deps.reply(
          'Which IMAP host? Send it as your next message, e.g. imap.hostinger.com',
          hostPickKeyboard()
        );
      }
      if (pending.kind === 'wizard-host') {
        deps.conversations.set(message.chat.id, {
          kind: 'wizard-port', label: pending.label, host: text, expiresAt: deps.now() + WIZARD_TTL_MS,
        });
        return deps.reply('Which port? Send a number — 993 is standard.');
      }
      if (pending.kind === 'wizard-port') {
        const port = Number(text);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          // Re-prompt WITHOUT advancing, so a typo cannot skip a field.
          deps.conversations.set(message.chat.id, {
            kind: 'wizard-port', label: pending.label, host: pending.host,
            expiresAt: deps.now() + WIZARD_TTL_MS,
          });
          return deps.reply('That is not a valid port. Send a number between 1 and 65535.');
        }
        deps.conversations.set(message.chat.id, {
          kind: 'wizard-username', label: pending.label, host: pending.host, port,
          expiresAt: deps.now() + WIZARD_TTL_MS,
        });
        return deps.reply('Send the username or email address for this mailbox.');
      }
      if (pending.kind === 'wizard-username') {
        deps.conversations.set(message.chat.id, {
          kind: 'password', label: pending.label, host: pending.host, port: pending.port,
          username: text, expiresAt: deps.now() + PASSWORD_TTL_MS,
        });
        return deps.reply(
          'Now send the password. I will delete your message as soon as I have read it.'
        );
      }
      if (pending.kind === 'password') {
        await completeAdd(pending, text, message.message_id, deps);
      } else if (pending.kind === 'remove-confirm') {
        await completeRemove(pending.label, text, deps);
      }
      return;
    }
    // A `/`-prefixed message during a pending flow must be treated as a
    // command, not as the pending answer — otherwise a mistyped command
    // mid-flow would be stored as a password or a removal confirmation.
    // The pending state is already discarded (take() is single-use); tell
    // the operator so they can't mistake this for "password accepted".
    // The wording lives in conversation.ts because handleCallback applies
    // the identical rule to a button tap arriving mid-flow.
    await deps.reply(cancellationNotice(pending));
  }

  const [command, ...args] = text.split(/\s+/);
  switch (command) {
    case '/add':
      return startAdd(args, message.chat.id, deps);
    case '/list':
      return listMailboxes(deps);
    case '/remove':
      return startRemove(args, message.chat.id, deps);
    case '/status':
      return showStatus(deps);
    case '/test':
      return testMailbox(args, deps);
    case '/start':
    case '/help':
    case '/menu':
      if (deps.menu !== undefined) await deps.menu();
      return deps.reply(USAGE);
    default:
      return deps.reply(`Unknown command.\n\n${USAGE}`);
  }
}

// `chatId` is threaded through from the incoming message rather than
// re-derived from deps.operatorChatId. Conversations are read back with
// message.chat.id (see handleUpdate), so keying them on
// Number(operatorChatId) was only correct indirectly -- via the chat-id gate
// -- and any drift between the two representations (whitespace, a non-
// numeric id) would silently strand every pending flow.
async function startAdd(args: string[], chatId: number, deps: CommandDeps): Promise<void> {
  if (args.length !== 4) {
    return deps.reply(`Usage: /add <label> <host> <port> <username>`);
  }
  const [label, host, portText, username] = args as [string, string, string, string];
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return deps.reply(`Invalid port "${portText}" — expected a number between 1 and 65535.`);
  }
  if (deps.mailboxes.labels().includes(label)) {
    return deps.reply(`A mailbox labelled "${label}" already exists. Remove it first.`);
  }

  deps.conversations.set(chatId, {
    kind: 'password',
    label,
    host,
    port,
    username,
    expiresAt: deps.now() + PASSWORD_TTL_MS,
  });

  return deps.reply(
    `Now send the password for ${username} as your next message.\n` +
      `I'll delete it as soon as I've read it. This prompt expires in 5 minutes.`
  );
}

async function completeAdd(
  pending: { label: string; host: string; port: number; username: string },
  password: string,
  messageId: number,
  deps: CommandDeps
): Promise<void> {
  const deleted = await deps.deleteMessage(messageId).catch(() => false);
  if (!deleted) {
    await deps.reply(
      'Warning: I could not delete your password message. Please delete it manually.'
    );
  }

  const account: Account = {
    label: pending.label,
    host: pending.host,
    port: pending.port,
    user: pending.username,
    pass: password,
    secure: true,
  };

  // Every terminal message below carries the menu. completeAdd is where a
  // BUTTON-driven add lands (its last two steps are typed), so ending
  // without a keyboard leaves the operator with no way back — while the
  // spec says the menu is shown after any action completes.
  const result = await deps.probe(account);
  if (!result.ok) {
    // Scrubbed again here even though probeMailbox already scrubs its own
    // reason. `probe` is an injected dependency, and this is the boundary
    // where text actually leaves for Telegram — the last place that can
    // still guarantee it. Cheap, and it makes the guarantee local.
    return deps.reply(
      `Could not connect, so nothing was saved.\n\n${scrubSecret(result.reason, password)}`,
      menuKeyboard()
    );
  }

  try {
    deps.mailboxes.add(account);
  } catch (err) {
    // Failed before persisting anything — nothing to clean up.
    return deps.reply(`Failed to save: ${scrubSecret(errorText(err), password)}`, menuKeyboard());
  }

  try {
    await deps.registry.add(account);
  } catch (err) {
    // The mailbox WAS persisted here — a bare "Failed to save" would be a
    // lie, and would leave an orphaned, unwatched mailbox the operator
    // believes doesn't exist, blocking a later /add with the same label.
    return deps.reply(
      `Saved "${account.label}", but failed to start watching it: ` +
        `${scrubSecret(errorText(err), password)}\n` +
        `It is not being monitored. Run /remove "${account.label}" and add it again, ` +
        `or restart the bot to retry starting the watcher.`,
      menuKeyboard()
    );
  }

  return deps.reply(
    `Connected — ${result.folders} folders. Saved "${account.label}" and now watching it.\n` +
      `The first sweep records a baseline, so you'll be notified from the next email onward.`,
    menuKeyboard()
  );
}

async function listMailboxes(deps: CommandDeps): Promise<void> {
  const boxes = deps.mailboxes.list();
  if (boxes.length === 0) {
    return deps.reply('No mailboxes configured. Add one with /add.');
  }
  const lines = boxes.map(
    (b) => `• ${b.label} — ${b.username} @ ${b.host}:${b.port} — ••••••••`
  );
  return deps.reply(`Configured mailboxes:\n${lines.join('\n')}`);
}

async function startRemove(args: string[], chatId: number, deps: CommandDeps): Promise<void> {
  const label = args[0];
  if (label === undefined) return deps.reply('Usage: /remove <label>');
  if (!deps.mailboxes.labels().includes(label)) {
    return deps.reply(`No mailbox labelled "${label}".`);
  }
  deps.conversations.set(chatId, {
    kind: 'remove-confirm',
    label,
    expiresAt: deps.now() + CONFIRM_TTL_MS,
  });
  return deps.reply(
    `Remove "${label}"? This deletes its credentials and its notification history, ` +
      `so re-adding it later starts from a fresh baseline.\n\n` +
      `Reply "yes" within 60 seconds to confirm.`
  );
}

async function completeRemove(label: string, answer: string, deps: CommandDeps): Promise<void> {
  if (answer.toLowerCase() !== 'yes') {
    return deps.reply(`Cancelled. "${label}" was not removed.`);
  }

  // No stop-failure branch here on purpose. WatcherRegistry.remove()
  // deregisters the watcher first and swallows any stop() failure
  // internally, so it cannot report one — and it should not: the watcher is
  // already gone from the registry by then, so refusing to delete the
  // credentials because a logout failed would leave the operator with a
  // mailbox that is no longer watched but still stored.
  //
  // Awaiting it IS significant though: AccountWatcher.stop() drains its
  // in-flight sweep (bounded) before resolving, which is what stops that
  // sweep's trailing setFolderState from landing after the purge below and
  // resurrecting the stale high-water mark.
  // The boolean distinguishes "stopped a running (or still-starting)
  // watcher" from "there was nothing to stop", so the confirmation below
  // can be truthful. Either way the credentials and history still go.
  const wasWatched = await deps.registry.remove(label);

  try {
    deps.mailboxes.remove(label);
  } catch (err) {
    return deps.reply(
      `Stopped watching "${label}", but failed to remove its stored credentials: ` +
        `${errorText(err)}\nIts notification history was not purged either. ` +
        `You may need to remove it manually.`
    );
  }

  try {
    deps.seen.purgeAccount(label);
  } catch (err) {
    return deps.reply(
      `Removed "${label}" and stopped watching it, but failed to purge its ` +
        `notification history: ${errorText(err)}`
    );
  }

  return deps.reply(
    wasWatched
      ? `Removed "${label}" and stopped watching it.`
      : `Removed "${label}". It was not being watched, so there was nothing to stop.`
  );
}

/**
 * The reconciliation and wording live in status.ts because the button
 * surface renders the identical report — see buildStatusReport for why
 * reporting the registry alone was wrong.
 */
async function showStatus(deps: CommandDeps): Promise<void> {
  const report = buildStatusReport(deps, PLAIN_STATUS);
  if (report.warning !== null) await deps.reply(report.warning);
  if (report.empty) return deps.reply('No mailboxes are being watched. Add one with /add.');
  return deps.reply(report.text);
}

async function testMailbox(args: string[], deps: CommandDeps): Promise<void> {
  const label = args[0];
  if (label === undefined) return deps.reply('Usage: /test <label>');

  // get() decrypts the stored password, so it throws on a wrong or rotated
  // MASTER_KEY and on a tampered row. Unwrapped, that throw escapes
  // handleUpdate entirely and the operator gets no reply — only a line in
  // the container log they may never see. That is the worst possible
  // outcome for the one command whose whole purpose is diagnosing exactly
  // this situation.
  let account: Account | null;
  try {
    account = deps.mailboxes.get(label);
  } catch (err) {
    // No password to scrub against here: the failure IS the decryption, so
    // nothing in this path ever holds the plaintext.
    return deps.reply(
      `Could not read the stored credentials for "${label}": ${errorText(err)}\n` +
        `If MASTER_KEY changed, that mailbox can no longer be decrypted — ` +
        `remove it and add it again.`
    );
  }
  if (account === null) return deps.reply(`No mailbox labelled "${label}".`);

  const result = await deps.probe(account);
  return result.ok
    ? deps.reply(`"${label}" connected — ${result.folders} folders.`)
    : deps.reply(`"${label}" failed to connect.\n\n${scrubSecret(result.reason, account.pass)}`);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
