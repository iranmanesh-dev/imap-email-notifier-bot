import {
  backKeyboard, cancelKeyboard, confirmRemoveKeyboard, decodeAction, hostPickKeyboard,
  mailboxKeyboard, menuKeyboard, portPickKeyboard, resolveToken,
  type CallbackAction,
} from './keyboards.js';
import type { InlineKeyboard } from './sender.js';
import type { TelegramUpdate } from './receiver.js';
import {
  WIZARD_TTL_MS, cancellationNotice, type Conversations, type Pending,
} from './conversation.js';
import type { MailboxStore } from '../store/mailboxes.js';
import type { SeenStore } from '../store/seen.js';
import type { WatcherRegistry } from '../imap/registry.js';
import type { ProbeResult } from '../imap/probe.js';
import type { Account } from '../types.js';
import { escapeHtml } from '../mail/format.js';
import { HTML_STATUS, buildStatusReport } from './status.js';
import { scrubSecret } from '../scrub.js';

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

const MENU_TEXT = '📬 <b>Mailboxes</b>\nChoose an action.';

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
    // `chatId` is threaded through from the tapped message rather than
    // re-derived from deps.operatorChatId, for the reason commands.ts gives
    // at startAdd: conversations are read back with message.chat.id, so
    // keying them on Number(operatorChatId) was only correct indirectly —
    // via the chat-id gate above — and any drift between the two
    // representations would silently strand every pending flow.
    await cancelPendingUnlessOwned(action, deps, chatId);
    if (action === null) {
      await renderMenu(deps, messageId);
      return;
    }
    await dispatch(action, deps, chatId, messageId);
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

/**
 * Actions that take responsibility for the pending conversation themselves.
 *
 * `cancel` clears it deliberately, `add` deliberately restarts the wizard,
 * and the four wizard quick-picks consume their own step (advancing it, or
 * restoring it untouched when the tap was on a stale keyboard). Sweeping
 * these into the blanket rule below would cancel the very flow they exist
 * to drive.
 */
function ownsPendingFlow(action: CallbackAction | null): boolean {
  if (action === null) return false;
  switch (action.kind) {
    case 'cancel':
    case 'add':
    case 'host':
    case 'port':
    case 'type-host':
    case 'type-port':
      return true;
    default:
      return false;
  }
}

/**
 * Applies the typed surface's interrupt rule to a button tap.
 *
 * commands.ts already treats a `/`-command arriving mid-flow as a
 * deliberate change of subject: it discards the pending entry and says so.
 * A button tap is the same signal from the same operator, but it used to
 * leave `password` / `remove-confirm` / `wizard-*` fully armed while every
 * visible cue said the context had moved on.
 *
 * The consequence was not cosmetic. With a `password` entry still pending,
 * the operator's next ordinary message is irreversibly deleted from
 * Telegram by completeAdd and transmitted as a password in a real IMAP
 * LOGIN — landing in a third party's auth-failure logs. With
 * `remove-confirm`, a stray "yes" deletes a mailbox and purges its history.
 *
 * The notice comes from conversation.ts so the two surfaces cannot drift,
 * and is escaped here because this surface (unlike commands.ts) emits HTML
 * that is not escaped again downstream.
 */
async function cancelPendingUnlessOwned(
  action: CallbackAction | null,
  deps: CallbackDeps,
  chatId: number
): Promise<void> {
  if (ownsPendingFlow(action)) return;
  const pending = deps.conversations.take(chatId, deps.now());
  if (pending === null) return;
  await deps.reply(escapeHtml(cancellationNotice(pending)));
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
async function restoreOrCancel(
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

async function dispatch(
  action: CallbackAction,
  deps: CallbackDeps,
  chatId: number,
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
      return startWizard(deps, chatId, messageId);
    case 'cancel':
      deps.conversations.clear(chatId);
      return renderMenu(deps, messageId);
    case 'host':
      return applyHost(deps, chatId, messageId, action.value);
    case 'port':
      return applyPort(deps, chatId, messageId, action.value);
    case 'type-host':
      return promptTyped(deps, chatId, messageId, 'wizard-host', 'Send the IMAP host as your next message.');
    case 'type-port':
      return promptTyped(deps, chatId, messageId, 'wizard-port', 'Send the port number as your next message.');
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
 * Reads the saved labels, or reports why it could not.
 *
 * labels() hits SQLite and can throw. Unguarded, that throw lands in
 * handleCallback's catch — which logs, clears the spinner and says nothing,
 * leaving the operator with a button that visibly did nothing at all. Same
 * guard buildStatusReport applies for the same call.
 */
async function readLabels(
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
async function resolveOrReport(
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

export async function startWizard(
  deps: CallbackDeps,
  chatId: number,
  messageId: number | undefined
): Promise<void> {
  deps.conversations.set(chatId, {
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
  chatId: number,
  messageId: number | undefined,
  host: string
): Promise<void> {
  const pending = deps.conversations.take(chatId, deps.now());
  if (pending === null) {
    return renderMenu(deps, messageId);
  }
  if (pending.kind !== 'wizard-host') {
    // A stray tap on a stale host button while a DIFFERENT step is pending
    // must not destroy that step — but must not silently keep an armed
    // password prompt alive behind a menu either. See restoreOrCancel.
    await restoreOrCancel(deps, chatId, pending);
    return renderMenu(deps, messageId);
  }
  deps.conversations.set(chatId, {
    kind: 'wizard-port',
    label: pending.label,
    host,
    expiresAt: deps.now() + WIZARD_TTL_MS,
  });
  await show(deps, messageId, `Host: <b>${escapeHtml(host)}</b>\n\nWhich port?`, portPickKeyboard());
}

async function applyPort(
  deps: CallbackDeps,
  chatId: number,
  messageId: number | undefined,
  port: number
): Promise<void> {
  const pending = deps.conversations.take(chatId, deps.now());
  if (pending === null) {
    return renderMenu(deps, messageId);
  }
  if (pending.kind !== 'wizard-port') {
    // Same reasoning as applyHost.
    await restoreOrCancel(deps, chatId, pending);
    return renderMenu(deps, messageId);
  }
  deps.conversations.set(chatId, {
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

/**
 * Solicits a typed value for one wizard step — but only while that exact
 * step is pending.
 *
 * A "Type it myself…" button is as tappable on a stale keyboard as any
 * other, and the reply it invites is consumed by whatever step handleUpdate
 * finds pending, not by the step the button belonged to. An operator who
 * restarts the wizard (arming `wizard-host`), taps the OLD port keyboard's
 * "Type it myself…" and dutifully sends `993` would otherwise have that
 * number stored as the mailbox's *host*. Guarding here mirrors applyHost /
 * applyPort, which were hardened against the same mismatch.
 *
 * The entry is restored before any branch: take() is single-use, so a stray
 * tap must not be able to destroy a step the operator is genuinely in the
 * middle of. It is restored unchanged rather than re-armed, so a tap cannot
 * extend a flow's TTL either.
 */
async function promptTyped(
  deps: CallbackDeps,
  chatId: number,
  messageId: number | undefined,
  step: 'wizard-host' | 'wizard-port',
  prompt: string
): Promise<void> {
  const pending = deps.conversations.take(chatId, deps.now());
  if (pending === null) return renderMenu(deps, messageId);
  if (pending.kind !== step) {
    await restoreOrCancel(deps, chatId, pending);
    return renderMenu(deps, messageId);
  }
  deps.conversations.set(chatId, pending);
  await show(deps, messageId, prompt, cancelKeyboard());
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

/**
 * Renders the SAME report /status renders, only with markup.
 *
 * This view used to read the registry alone, so a saved-but-unwatched
 * mailbox — the exact failure the operator opens this screen to diagnose —
 * was silently missing from it, while /status named it and offered a
 * recovery hint. Sharing buildStatusReport is what stops the two from
 * drifting again.
 */
async function showStatus(deps: CallbackDeps, messageId: number | undefined): Promise<void> {
  const report = buildStatusReport(deps, HTML_STATUS);
  if (report.warning !== null) await deps.reply(report.warning);
  if (report.empty) {
    return show(deps, messageId, 'No mailboxes are being watched.', menuKeyboard());
  }
  return show(deps, messageId, report.text, backKeyboard());
}

async function showPicker(
  deps: CallbackDeps,
  messageId: number | undefined,
  target: 'remove' | 'test'
): Promise<void> {
  const labels = await readLabels(deps, messageId);
  if (labels === null) return;
  if (labels.length === 0) {
    return show(deps, messageId, 'No mailboxes configured yet.', menuKeyboard());
  }
  const verb = target === 'remove' ? 'remove' : 'test';
  return show(deps, messageId, `Which mailbox would you like to ${verb}?`, mailboxKeyboard(labels, target));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
