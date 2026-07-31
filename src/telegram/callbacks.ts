import {
  backKeyboard, decodeAction, mailboxKeyboard, menuKeyboard,
  type CallbackAction,
} from './keyboards.js';
import type { InlineKeyboard } from './sender.js';
import type { TelegramUpdate } from './receiver.js';
import type { Conversations } from './conversation.js';
import type { MailboxStore } from '../store/mailboxes.js';
import type { SeenStore } from '../store/seen.js';
import type { WatcherRegistry } from '../imap/registry.js';
import type { ProbeResult } from '../imap/probe.js';
import type { Account } from '../types.js';
import { escapeHtml } from '../mail/format.js';

export type CallbackDeps = {
  operatorChatId: string;
  mailboxes: MailboxStore;
  seen: Pick<SeenStore, 'purgeAccount'>;
  registry: WatcherRegistry;
  conversations: Conversations;
  probe: (account: Account) => Promise<ProbeResult>;
  answer: (callbackQueryId: string, text?: string) => Promise<boolean>;
  edit: (messageId: number, html: string, keyboard?: InlineKeyboard) => Promise<boolean>;
  reply: (html: string, keyboard?: InlineKeyboard) => Promise<void>;
  now: () => number;
};

const MENU_TEXT = '📬 <b>Mailboxes</b>\nChoose an action.';

/**
 * Renders content into the tapped message, falling back to a new message.
 *
 * Telegram refuses to edit messages older than 48 hours, so without the
 * fallback a button tapped on a day-old menu would silently do nothing.
 */
async function show(
  deps: CallbackDeps,
  messageId: number | undefined,
  html: string,
  keyboard?: InlineKeyboard
): Promise<void> {
  if (messageId !== undefined && (await deps.edit(messageId, html, keyboard))) return;
  await deps.reply(html, keyboard);
}

export async function renderMenu(deps: CallbackDeps, messageId?: number): Promise<void> {
  await show(deps, messageId, MENU_TEXT, menuKeyboard());
}

/**
 * Entry point for every button tap.
 *
 * The operator-chat gate runs before ANY parsing and before the callback is
 * answered — an unauthorized chat gets nothing at all, because even an error
 * reply confirms to a prober that the bot is live.
 */
export async function handleCallback(update: TelegramUpdate, deps: CallbackDeps): Promise<void> {
  const query = update.callback_query;
  if (query === undefined) return;

  const chatId = query.message?.chat?.id;
  if (chatId === undefined || String(chatId) !== deps.operatorChatId) return;

  const messageId = query.message?.message_id;
  try {
    const action = query.data === undefined ? null : decodeAction(query.data);
    if (action === null) {
      await renderMenu(deps, messageId);
      return;
    }
    await dispatch(action, deps, messageId);
  } catch (err) {
    console.error(`[telegram] callback failed: ${errorText(err)}`);
  } finally {
    // Must happen on every path, including a throw, or the operator's client
    // shows a spinner on the button until it times out.
    await deps.answer(query.id).catch(() => false);
  }
}

async function dispatch(
  action: CallbackAction,
  deps: CallbackDeps,
  messageId: number | undefined
): Promise<void> {
  switch (action.kind) {
    case 'menu':
      return renderMenu(deps, messageId);
    case 'list':
      return showList(deps, messageId);
    case 'status':
      return showStatus(deps, messageId);
    case 'remove-pick':
      return showPicker(deps, messageId, 'remove');
    case 'test-pick':
      return showPicker(deps, messageId, 'test');
    default:
      // Wizard, remove and test actions are added in later tasks.
      return renderMenu(deps, messageId);
  }
}

async function showList(deps: CallbackDeps, messageId: number | undefined): Promise<void> {
  const boxes = deps.mailboxes.list();
  if (boxes.length === 0) {
    return show(deps, messageId, 'No mailboxes configured yet.', menuKeyboard());
  }
  const lines = boxes.map(
    (b) => `• <b>${escapeHtml(b.label)}</b> — ${escapeHtml(b.username)} @ ${escapeHtml(b.host)}:${b.port} — ••••••••`
  );
  return show(deps, messageId, `Configured mailboxes:\n${lines.join('\n')}`, backKeyboard());
}

async function showStatus(deps: CallbackDeps, messageId: number | undefined): Promise<void> {
  const states = deps.registry.states();
  if (states.length === 0) {
    return show(deps, messageId, 'No mailboxes are being watched.', menuKeyboard());
  }
  const lines = states.map((s) => `• <b>${escapeHtml(s.label)}</b> — ${escapeHtml(s.state)}`);
  return show(deps, messageId, `Watcher status:\n${lines.join('\n')}`, backKeyboard());
}

async function showPicker(
  deps: CallbackDeps,
  messageId: number | undefined,
  target: 'remove' | 'test'
): Promise<void> {
  const labels = deps.mailboxes.labels();
  if (labels.length === 0) {
    return show(deps, messageId, 'No mailboxes configured yet.', menuKeyboard());
  }
  const verb = target === 'remove' ? 'remove' : 'test';
  return show(deps, messageId, `Which mailbox would you like to ${verb}?`, mailboxKeyboard(labels, target));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
