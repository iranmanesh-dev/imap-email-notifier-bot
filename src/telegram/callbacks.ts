import {
  backKeyboard, cancelKeyboard, confirmRemoveKeyboard, decodeAction, hostPickKeyboard,
  mailboxKeyboard, menuKeyboard, portPickKeyboard, resolveToken,
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
import { scrubSecret } from '../scrub.js';

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
    case 'remove':
      return confirmRemove(deps, messageId, action.token);
    case 'remove-confirm':
      return doRemove(deps, messageId, action.token);
    case 'test':
      return doTest(deps, messageId, action.token);
    default:
      return renderMenu(deps, messageId);
  }
}

/**
 * Resolves a token to a live label, or reports a stale button.
 *
 * Telegram keeps old messages tappable indefinitely, so a button referring
 * to a since-deleted mailbox is normal, not exceptional. A callback is never
 * treated as evidence that its target still exists.
 */
async function resolveOrReport(
  deps: CallbackDeps,
  messageId: number | undefined,
  token: string
): Promise<string | null> {
  const label = resolveToken(token, deps.mailboxes.labels());
  if (label === null) {
    await show(deps, messageId, 'That mailbox no longer exists.', menuKeyboard());
  }
  return label;
}

async function confirmRemove(
  deps: CallbackDeps,
  messageId: number | undefined,
  token: string
): Promise<void> {
  const label = await resolveOrReport(deps, messageId, token);
  if (label === null) return;
  await show(
    deps,
    messageId,
    `Remove <b>${escapeHtml(label)}</b>?\nThis deletes its credentials and notification history.`,
    confirmRemoveKeyboard(token)
  );
}

async function doRemove(
  deps: CallbackDeps,
  messageId: number | undefined,
  token: string
): Promise<void> {
  const label = await resolveOrReport(deps, messageId, token);
  if (label === null) return;

  // No stop-failure branch here on purpose, mirroring commands.ts's
  // completeRemove: WatcherRegistry.remove() deregisters the watcher first
  // and swallows any stop() failure internally, so it cannot report one —
  // and it should not: the watcher is already gone from the registry by
  // then, so refusing to delete the credentials because a logout failed
  // would leave the operator with a mailbox that is no longer watched but
  // still stored. The boolean distinguishes "stopped a running watcher"
  // from "there was nothing to stop", so the final message can be truthful.
  const wasWatched = await deps.registry.remove(label);

  try {
    deps.mailboxes.remove(label);
  } catch (err) {
    // The watcher is already stopped at this point, but the credentials and
    // seen-state are both still there. A bare "Removed" here would be a
    // lie — the mailbox is still stored and (from the operator's view still
    // "configured") — and silence via handleCallback's catch would be
    // indistinguishable from success.
    return show(
      deps,
      messageId,
      `Stopped watching <b>${escapeHtml(label)}</b>, but failed to remove its stored ` +
        `credentials: ${escapeHtml(errorText(err))}\nIts notification history was not purged ` +
        `either. You may need to remove it manually.`,
      backKeyboard()
    );
  }

  try {
    deps.seen.purgeAccount(label);
  } catch (err) {
    // Credentials ARE gone here — only the seen-state purge failed. A later
    // re-add would otherwise silently inherit the old high-water mark and
    // suppress notifications the operator expects to see from a "fresh"
    // mailbox.
    return show(
      deps,
      messageId,
      `Removed <b>${escapeHtml(label)}</b> and stopped watching it, but failed to purge its ` +
        `notification history: ${escapeHtml(errorText(err))}`,
      backKeyboard()
    );
  }

  await show(
    deps,
    messageId,
    wasWatched
      ? `Removed <b>${escapeHtml(label)}</b> and stopped watching it.`
      : `Removed <b>${escapeHtml(label)}</b>. It was not being watched, so there was nothing to stop.`,
    menuKeyboard()
  );
}

async function doTest(
  deps: CallbackDeps,
  messageId: number | undefined,
  token: string
): Promise<void> {
  const label = await resolveOrReport(deps, messageId, token);
  if (label === null) return;

  let account: Account | null;
  try {
    account = deps.mailboxes.get(label);
  } catch (err) {
    // Decryption can fail if MASTER_KEY changed. Report it — silence here is
    // indistinguishable from "mail stopped arriving" — and give the same
    // recovery hint commands.ts's testMailbox gives: this is the message
    // someone sees precisely when they are trying to diagnose this exact
    // situation.
    return show(
      deps,
      messageId,
      `Could not read <b>${escapeHtml(label)}</b>: ${escapeHtml(errorText(err))}\n` +
        `If MASTER_KEY changed, that mailbox can no longer be decrypted — remove it and add it again.`,
      backKeyboard()
    );
  }
  if (account === null) {
    return show(deps, messageId, 'That mailbox no longer exists.', menuKeyboard());
  }

  const result = await deps.probe(account);
  // probeMailbox already scrubs its own reason, but this is the last place
  // that can still guarantee it before the text reaches the operator, and
  // `probe` is an injected dependency — the same defense-in-depth commands.ts
  // applies in testMailbox.
  const text = result.ok
    ? `<b>${escapeHtml(label)}</b> connected — ${result.folders} folders.`
    : `<b>${escapeHtml(label)}</b> failed to connect.\n\n${escapeHtml(scrubSecret(result.reason, account.pass))}`;
  await show(deps, messageId, text, backKeyboard());
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
