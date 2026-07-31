import { cancelKeyboard, portPickKeyboard } from './keyboards.js';
import { WIZARD_TTL_MS } from './conversation.js';
import { escapeHtml } from '../mail/format.js';
import { renderMenu, restoreOrCancel, show, type CallbackDeps } from './render.js';

/**
 * The guided add flow's button steps.
 *
 * Only the steps a *button* drives live here. The typed replies each step
 * invites (label, host, port, username, password) are consumed by
 * commands.ts, which owns every incoming text message; the two surfaces
 * share one conversation store, not one handler.
 */

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
export async function applyHost(
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

export async function applyPort(
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
export async function promptTyped(
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
