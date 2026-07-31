import { menuKeyboard, resolveToken } from './keyboards.js';
import type { InlineKeyboard } from './sender.js';
import { cancellationNotice, type Conversations, type Pending } from './conversation.js';
import type { MailboxStore } from '../store/mailboxes.js';
import type { SeenStore } from '../store/seen.js';
import type { WatcherRegistry } from '../imap/registry.js';
import type { ProbeResult } from '../imap/probe.js';
import type { Account } from '../types.js';
import { escapeHtml } from '../mail/format.js';

/**
 * Primitives shared by the button surface's two halves.
 *
 * `callbacks.ts` (the gate and the actions) and `wizard.ts` (the guided add
 * flow) both need `show`, `renderMenu` and `restoreOrCancel`, and callbacks
 * dispatches into the wizard. Keeping these here rather than in either half
 * is what stops that from being a circular import.
 */

export type CallbackDeps = {
  operatorChatId: string;
  mailboxes: MailboxStore;
  seen: Pick<SeenStore, 'purgeAccount'>;
  registry: WatcherRegistry;
  conversations: Conversations;
  probe: (account: Account) => Promise<ProbeResult>;
  // No `text` parameter: Telegram's optional toast was never populated by
  // any call site, and a parameter nothing supplies reads as a feature that
  // exists. TelegramSender.answerCallbackQuery still accepts one if a toast
  // is ever actually wanted.
  answer: (callbackQueryId: string) => Promise<boolean>;
  edit: (messageId: number, html: string, keyboard?: InlineKeyboard) => Promise<boolean>;
  reply: (html: string, keyboard?: InlineKeyboard) => Promise<void>;
  now: () => number;
};

export const MENU_TEXT = '📬 <b>Mailboxes</b>\nChoose an action.';

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Renders content into the tapped message, falling back to a new message.
 *
 * Telegram refuses to edit messages older than 48 hours, so without the
 * fallback a button tapped on a day-old menu would silently do nothing.
 *
 * `deps.edit` must therefore report true whenever the message now DISPLAYS
 * the requested content — not merely when an edit was performed. Telegram
 * 400s a no-op edit with "message is not modified", and treating that as a
 * refusal made double-tapping Back append a duplicate menu every time.
 * Only the sender can see that description, so the distinction is made
 * there (see TelegramSender.editMessageText) and the contract is stated
 * here, where the fallback depends on it.
 */
export async function show(
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
 * Reads the saved labels, or reports why it could not.
 *
 * labels() hits SQLite and can throw. Unguarded, that throw lands in
 * handleCallback's catch — which logs, clears the spinner and says nothing,
 * leaving the operator with a button that visibly did nothing at all. Same
 * guard buildStatusReport applies for the same call.
 */
export async function readLabels(
  deps: CallbackDeps,
  messageId: number | undefined
): Promise<string[] | null> {
  try {
    return deps.mailboxes.labels();
  } catch (err) {
    await show(
      deps,
      messageId,
      `Could not read the saved mailbox list: ${escapeHtml(errorText(err))}`,
      menuKeyboard()
    );
    return null;
  }
}

/**
 * Resolves a token to a live label, or reports a stale button.
 *
 * Telegram keeps old messages tappable indefinitely, so a button referring
 * to a since-deleted mailbox is normal, not exceptional. A callback is never
 * treated as evidence that its target still exists.
 *
 * A null return means "do not act": either the mailbox is gone, or the list
 * could not be read at all. Both have already been reported.
 */
export async function resolveOrReport(
  deps: CallbackDeps,
  messageId: number | undefined,
  token: string
): Promise<string | null> {
  const labels = await readLabels(deps, messageId);
  if (labels === null) return null;
  const label = resolveToken(token, labels);
  if (label === null) {
    await show(deps, messageId, 'That mailbox no longer exists.', menuKeyboard());
  }
  return label;
}

/**
 * Puts back a pending entry a quick-pick consumed but did not match — or
 * cancels it, when putting it back would be dangerous.
 *
 * The four quick-picks are exempt from the blanket cancel-on-tap rule
 * because they consume their own step, so they alone decide what happens to
 * a MISMATCHED entry. That decision differs by kind:
 *
 * - `wizard-*`: restore it. The operator's setup is live, they tapped a
 *   button on a stale message, and destroying their place would be the
 *   worse failure. Restored unchanged, so a tap cannot extend its TTL.
 * - `password` / `remove-confirm`: cancel it, with the shared notice.
 *   Restoring these reproduces the exact Critical this file was fixed for:
 *   the operator is shown a menu — every cue saying the context moved on —
 *   while a password prompt stays armed, so their next ordinary message is
 *   deleted from Telegram and transmitted as a password to a real IMAP
 *   server. A live wizard step is worth protecting; an armed password
 *   prompt behind a menu screen is not.
 */
export async function restoreOrCancel(
  deps: CallbackDeps,
  chatId: number,
  pending: Pending
): Promise<void> {
  if (pending.kind === 'password' || pending.kind === 'remove-confirm') {
    await deps.reply(escapeHtml(cancellationNotice(pending)));
    return;
  }
  deps.conversations.set(chatId, pending);
}
