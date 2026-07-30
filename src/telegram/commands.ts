import { CONFIRM_TTL_MS, PASSWORD_TTL_MS, type Conversations } from './conversation.js';
import type { TelegramUpdate } from './receiver.js';
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
  reply: (text: string) => Promise<void>;
  deleteMessage: (messageId: number) => Promise<boolean>;
  now: () => number;
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
  if (String(message.chat.id) !== deps.operatorChatId) return;

  const text = (message.text ?? '').trim();
  if (text.length === 0) return;

  const pending = deps.conversations.take(message.chat.id, deps.now());
  if (pending !== null && !text.startsWith('/')) {
    if (pending.kind === 'password') {
      await completeAdd(pending, text, message.message_id, deps);
    } else {
      await completeRemove(pending.label, text, deps);
    }
    return;
  }

  const [command, ...args] = text.split(/\s+/);
  switch (command) {
    case '/add':
      return startAdd(args, deps);
    case '/list':
      return listMailboxes(deps);
    case '/remove':
      return startRemove(args, deps);
    case '/status':
      return showStatus(deps);
    case '/test':
      return testMailbox(args, deps);
    case '/start':
    case '/help':
      return deps.reply(USAGE);
    default:
      return deps.reply(`Unknown command.\n\n${USAGE}`);
  }
}

async function startAdd(args: string[], deps: CommandDeps): Promise<void> {
  if (args.length !== 4) {
    return deps.reply(`Usage: /add <label> <host> <port> <username>`);
  }
  const [label, host, portText, username] = args as [string, string, string, string];
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return deps.reply(`Invalid port "${portText}" — expected a number between 1 and 65535.`);
  }
  if (deps.mailboxes.get(label) !== null) {
    return deps.reply(`A mailbox labelled "${label}" already exists. Remove it first.`);
  }

  deps.conversations.set(Number(deps.operatorChatId), {
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

  const result = await deps.probe(account);
  if (!result.ok) {
    return deps.reply(`Could not connect, so nothing was saved.\n\n${result.reason}`);
  }

  try {
    deps.mailboxes.add(account);
    await deps.registry.add(account);
  } catch (err) {
    return deps.reply(`Failed to save: ${errorText(err)}`);
  }

  return deps.reply(
    `Connected — ${result.folders} folders. Saved "${account.label}" and now watching it.\n` +
      `The first sweep records a baseline, so you'll be notified from the next email onward.`
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

async function startRemove(args: string[], deps: CommandDeps): Promise<void> {
  const label = args[0];
  if (label === undefined) return deps.reply('Usage: /remove <label>');
  if (deps.mailboxes.get(label) === null) {
    return deps.reply(`No mailbox labelled "${label}".`);
  }
  deps.conversations.set(Number(deps.operatorChatId), {
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
  await deps.registry.remove(label);
  deps.mailboxes.remove(label);
  deps.seen.purgeAccount(label);
  return deps.reply(`Removed "${label}" and stopped watching it.`);
}

async function showStatus(deps: CommandDeps): Promise<void> {
  const states = deps.registry.states();
  if (states.length === 0) {
    return deps.reply('No mailboxes are being watched. Add one with /add.');
  }
  const lines = states.map((s) => `• ${s.label} — ${s.state}`);
  return deps.reply(`Watcher status:\n${lines.join('\n')}`);
}

async function testMailbox(args: string[], deps: CommandDeps): Promise<void> {
  const label = args[0];
  if (label === undefined) return deps.reply('Usage: /test <label>');
  const account = deps.mailboxes.get(label);
  if (account === null) return deps.reply(`No mailbox labelled "${label}".`);

  const result = await deps.probe(account);
  return result.ok
    ? deps.reply(`"${label}" connected — ${result.folders} folders.`)
    : deps.reply(`"${label}" failed to connect.\n\n${result.reason}`);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
