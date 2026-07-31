import {
  backKeyboard, confirmRemoveKeyboard, decodeAction, mailboxKeyboard, menuKeyboard,
  type CallbackAction,
} from './keyboards.js';
import type { TelegramUpdate } from './receiver.js';
import { cancellationNotice } from './conversation.js';
import type { Account } from '../types.js';
import { escapeHtml } from '../mail/format.js';
import { HTML_STATUS, buildStatusReport } from './status.js';
import { scrubSecret } from '../scrub.js';
import {
  errorText, readLabels, renderMenu, resolveOrReport, show, type CallbackDeps,
} from './render.js';
import { applyHost, applyPort, promptTyped, startWizard } from './wizard.js';

// Re-exported so consumers keep one import site for the button surface, and
// so `renderMenu`'s only other caller (deps.ts) does not need to know that
// the shared primitives were split out of here.
export { renderMenu, type CallbackDeps };

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
