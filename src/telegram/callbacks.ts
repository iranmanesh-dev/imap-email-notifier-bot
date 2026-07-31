import {
  backKeyboard, cancelKeyboard, decodeAction, hostPickKeyboard, mailboxKeyboard, menuKeyboard,
  portPickKeyboard,
  type CallbackAction,
} from './keyboards.js';
import type { InlineKeyboard } from './sender.js';
import type { TelegramUpdate } from './receiver.js';
import { WIZARD_TTL_MS, type Conversations } from './conversation.js';
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
    // shows a spinner on the button until it times out. A plain try/catch is
    // used rather than `.catch()` on the returned promise, because `.catch`
    // only handles rejection — an `answer` implementation that throws
    // synchronously would throw before `.catch` is ever reached and escape
    // this `finally`, discarding whatever outcome we already have.
    try {
      await deps.answer(query.id);
    } catch {
      // Answering is cosmetic and must never fail the surrounding handler.
    }
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
    case 'add':
      return startWizard(deps, messageId);
    case 'cancel':
      deps.conversations.clear(Number(deps.operatorChatId));
      return renderMenu(deps, messageId);
    case 'host':
      return applyHost(deps, messageId, action.value);
    case 'port':
      return applyPort(deps, messageId, action.value);
    case 'type-host':
      return show(deps, messageId, 'Send the IMAP host as your next message.', cancelKeyboard());
    case 'type-port':
      return show(deps, messageId, 'Send the port number as your next message.', cancelKeyboard());
    default:
      // remove and test actions are added in Task 7.
      return renderMenu(deps, messageId);
  }
}

export async function startWizard(deps: CallbackDeps, messageId: number | undefined): Promise<void> {
  deps.conversations.set(Number(deps.operatorChatId), {
    kind: 'wizard-label',
    expiresAt: deps.now() + WIZARD_TTL_MS,
  });
  await show(
    deps,
    messageId,
    'What should this mailbox be called? Send a short label, e.g. <b>Work</b>.',
    cancelKeyboard()
  );
}

/**
 * A quick-pick only makes sense while its step is pending. Tapping a stale
 * host button from an old message must not invent a wizard out of nothing.
 */
async function applyHost(
  deps: CallbackDeps,
  messageId: number | undefined,
  host: string
): Promise<void> {
  const pending = deps.conversations.take(Number(deps.operatorChatId), deps.now());
  if (pending === null) {
    return renderMenu(deps, messageId);
  }
  if (pending.kind !== 'wizard-host') {
    // A stray tap on a stale host button while a DIFFERENT step (or no
    // wizard at all) is pending must not destroy that other step. take()
    // already removed it above, so put it back exactly as it was before
    // falling through to the menu.
    deps.conversations.set(Number(deps.operatorChatId), pending);
    return renderMenu(deps, messageId);
  }
  deps.conversations.set(Number(deps.operatorChatId), {
    kind: 'wizard-port',
    label: pending.label,
    host,
    expiresAt: deps.now() + WIZARD_TTL_MS,
  });
  await show(deps, messageId, `Host: <b>${escapeHtml(host)}</b>\n\nWhich port?`, portPickKeyboard());
}

async function applyPort(
  deps: CallbackDeps,
  messageId: number | undefined,
  port: number
): Promise<void> {
  const pending = deps.conversations.take(Number(deps.operatorChatId), deps.now());
  if (pending === null) {
    return renderMenu(deps, messageId);
  }
  if (pending.kind !== 'wizard-port') {
    // Same reasoning as applyHost: a stray port tap must not destroy a
    // different pending step. Restore what was actually there.
    deps.conversations.set(Number(deps.operatorChatId), pending);
    return renderMenu(deps, messageId);
  }
  deps.conversations.set(Number(deps.operatorChatId), {
    kind: 'wizard-username',
    label: pending.label,
    host: pending.host,
    port,
    expiresAt: deps.now() + WIZARD_TTL_MS,
  });
  await show(
    deps,
    messageId,
    `Port: <b>${port}</b>\n\nSend the username or email address for this mailbox.`,
    cancelKeyboard()
  );
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
