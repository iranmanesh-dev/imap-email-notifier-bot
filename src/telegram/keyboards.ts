import { createHash } from 'node:crypto';
import type { InlineKeyboard } from './sender.js';

/** Telegram's hard limit on callback_data. */
export const CALLBACK_DATA_MAX_BYTES = 64;

export type CallbackAction =
  | { kind: 'menu' }
  | { kind: 'add' }
  | { kind: 'list' }
  | { kind: 'status' }
  | { kind: 'cancel' }
  | { kind: 'remove-pick' }
  | { kind: 'test-pick' }
  | { kind: 'remove'; token: string }
  | { kind: 'remove-confirm'; token: string }
  | { kind: 'test'; token: string }
  | { kind: 'host'; value: string }
  | { kind: 'port'; value: number }
  | { kind: 'type-host' }
  | { kind: 'type-port' };

/**
 * A short, stable identifier for a mailbox label.
 *
 * callback_data is capped at 64 bytes and a label can be longer than the
 * budget, so the label itself is never embedded. A list index would be
 * smaller still but goes stale the moment the list changes — tapping an
 * older message could then act on the wrong mailbox, which is a data-loss
 * bug. A hash is stable and self-invalidating: if it no longer resolves,
 * the mailbox is genuinely gone.
 *
 * Trade-off: 8 hex characters is only 32 bits of hash, so a collision
 * between two distinct labels is possible in principle — `resolveToken`
 * would then silently resolve to the wrong mailbox. At realistic mailbox
 * counts (single digits to low hundreds per operator) the birthday-bound
 * probability (~n²/2³³) is negligible, and widening the token eats further
 * into the 64-byte callback_data budget for no practical benefit. The
 * trade is accepted deliberately, not overlooked.
 */
export function labelToken(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex').slice(0, 8);
}

/** Resolves a token back to a live label, or null if it is stale. */
export function resolveToken(token: string, labels: string[]): string | null {
  return labels.find((l) => labelToken(l) === token) ?? null;
}

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Encodes a `CallbackAction` as `callback_data`.
 *
 * This is a programming-error guard, not a user-input path: it throws
 * rather than truncating or clamping, because a silently truncated host
 * would produce a button that connects to the *wrong server*, and a
 * silently clamped port would test the wrong one — both worse than a loud
 * failure at build time. Every string this function returns must therefore
 * be something `decodeAction` can reconstruct, and must fit Telegram's cap.
 */
export function encodeAction(action: CallbackAction): string {
  if (action.kind === 'port') {
    const { value } = action;
    if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
      throw new Error(
        `encodeAction: 'port' value ${value} is outside the valid range ${MIN_PORT}-${MAX_PORT}`
      );
    }
  }

  const data = encodeActionData(action);
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(
      `encodeAction: '${action.kind}' action encodes to ${bytes} bytes, exceeding the ${CALLBACK_DATA_MAX_BYTES}-byte callback_data cap`
    );
  }
  return data;
}

function encodeActionData(action: CallbackAction): string {
  switch (action.kind) {
    case 'menu': return 'm';
    case 'add': return 'a';
    case 'list': return 'l';
    case 'status': return 's';
    case 'cancel': return 'c';
    case 'remove-pick': return 'rp';
    case 'test-pick': return 'tp';
    case 'type-host': return 'xh';
    case 'type-port': return 'xp';
    case 'remove': return `r:${action.token}`;
    case 'remove-confirm': return `rc:${action.token}`;
    case 'test': return `t:${action.token}`;
    case 'host': return `h:${action.value}`;
    case 'port': return `p:${action.value}`;
  }
}

export function decodeAction(data: string): CallbackAction | null {
  switch (data) {
    case 'm': return { kind: 'menu' };
    case 'a': return { kind: 'add' };
    case 'l': return { kind: 'list' };
    case 's': return { kind: 'status' };
    case 'c': return { kind: 'cancel' };
    case 'rp': return { kind: 'remove-pick' };
    case 'tp': return { kind: 'test-pick' };
    case 'xh': return { kind: 'type-host' };
    case 'xp': return { kind: 'type-port' };
    default: break;
  }

  const sep = data.indexOf(':');
  if (sep <= 0) return null;
  const prefix = data.slice(0, sep);
  const value = data.slice(sep + 1);
  if (value.length === 0) return null;

  switch (prefix) {
    case 'r': return { kind: 'remove', token: value };
    case 'rc': return { kind: 'remove-confirm', token: value };
    case 't': return { kind: 'test', token: value };
    case 'h': return { kind: 'host', value };
    case 'p': {
      const port = Number(value);
      if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return null;
      return { kind: 'port', value: port };
    }
    default: return null;
  }
}

const btn = (text: string, action: CallbackAction) => ({
  text,
  callback_data: encodeAction(action),
});

export function menuKeyboard(): InlineKeyboard {
  return [
    [btn('➕ Add mailbox', { kind: 'add' })],
    [btn('📋 List', { kind: 'list' }), btn('📊 Status', { kind: 'status' })],
    [btn('🗑 Remove', { kind: 'remove-pick' }), btn('🔌 Test', { kind: 'test-pick' })],
  ];
}

export function mailboxKeyboard(labels: string[], target: 'remove' | 'test'): InlineKeyboard {
  const rows: InlineKeyboard = labels.map((label) => [
    btn(label, target === 'remove'
      ? { kind: 'remove', token: labelToken(label) }
      : { kind: 'test', token: labelToken(label) }),
  ]);
  rows.push([btn('← Back', { kind: 'menu' })]);
  return rows;
}

export function confirmRemoveKeyboard(token: string): InlineKeyboard {
  return [[
    btn('✅ Yes, remove', { kind: 'remove-confirm', token }),
    btn('✖️ Cancel', { kind: 'cancel' }),
  ]];
}

/** The two fields most prone to typos get quick-picks. */
export function hostPickKeyboard(): InlineKeyboard {
  return [
    [btn('Hostinger', { kind: 'host', value: 'imap.hostinger.com' }),
     btn('Gmail', { kind: 'host', value: 'imap.gmail.com' })],
    [btn('Outlook', { kind: 'host', value: 'outlook.office365.com' }),
     btn('iCloud', { kind: 'host', value: 'imap.mail.me.com' })],
    [btn('Type it myself…', { kind: 'type-host' })],
    [btn('✖️ Cancel', { kind: 'cancel' })],
  ];
}

export function portPickKeyboard(): InlineKeyboard {
  return [
    [btn('993 (standard)', { kind: 'port', value: 993 })],
    [btn('Type it myself…', { kind: 'type-port' })],
    [btn('✖️ Cancel', { kind: 'cancel' })],
  ];
}

export function cancelKeyboard(): InlineKeyboard {
  return [[btn('✖️ Cancel', { kind: 'cancel' })]];
}

export function backKeyboard(): InlineKeyboard {
  return [[btn('← Back', { kind: 'menu' })]];
}
