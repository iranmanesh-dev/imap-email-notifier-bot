import { describe, it, expect } from 'vitest';
import {
  labelToken, resolveToken, encodeAction, decodeAction,
  menuKeyboard, mailboxKeyboard, confirmRemoveKeyboard,
  hostPickKeyboard, portPickKeyboard, cancelKeyboard, backKeyboard,
  CALLBACK_DATA_MAX_BYTES, type CallbackAction,
} from '../src/telegram/keyboards.js';

const byteLen = (s: string) => Buffer.byteLength(s, 'utf8');

describe('labelToken', () => {
  it('is stable for the same label', () => {
    expect(labelToken('Work')).toBe(labelToken('Work'));
  });

  it('differs for different labels', () => {
    expect(labelToken('Work')).not.toBe(labelToken('Personal'));
  });

  it('is 8 lowercase hex characters', () => {
    expect(labelToken('Work')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('handles unicode and very long labels', () => {
    expect(labelToken('Ünïcødé 📬 ' + 'x'.repeat(500))).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('resolveToken', () => {
  it('finds the label whose token matches', () => {
    expect(resolveToken(labelToken('Work'), ['Personal', 'Work'])).toBe('Work');
  });

  it('returns null when nothing matches — a stale button', () => {
    expect(resolveToken(labelToken('Deleted'), ['Work'])).toBeNull();
  });

  it('returns null for an empty label list', () => {
    expect(resolveToken(labelToken('Work'), [])).toBeNull();
  });

  it('returns null for a malformed token', () => {
    expect(resolveToken('not-a-token', ['Work'])).toBeNull();
  });
});

describe('encode/decode round-trip', () => {
  const cases: CallbackAction[] = [
    { kind: 'menu' },
    { kind: 'add' },
    { kind: 'list' },
    { kind: 'status' },
    { kind: 'cancel' },
    { kind: 'remove-pick' },
    { kind: 'test-pick' },
    { kind: 'remove', token: 'a1b2c3d4' },
    { kind: 'remove-confirm', token: 'a1b2c3d4' },
    { kind: 'test', token: 'a1b2c3d4' },
    { kind: 'host', value: 'imap.hostinger.com' },
    { kind: 'port', value: 993 },
    { kind: 'type-host' },
    { kind: 'type-port' },
  ];

  it.each(cases)('round-trips %j', (action) => {
    expect(decodeAction(encodeAction(action))).toEqual(action);
  });

  it.each(cases)('stays within the 64-byte cap for %j', (action) => {
    expect(byteLen(encodeAction(action))).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it('returns null for unknown data rather than throwing', () => {
    expect(decodeAction('zzz')).toBeNull();
    expect(decodeAction('')).toBeNull();
    expect(decodeAction('r:')).toBeNull();
  });

  it('returns null for a non-numeric port', () => {
    expect(decodeAction('p:abc')).toBeNull();
  });

  it('does not confuse test-pick with type-port', () => {
    expect(decodeAction(encodeAction({ kind: 'test-pick' }))).toEqual({ kind: 'test-pick' });
    expect(decodeAction(encodeAction({ kind: 'type-port' }))).toEqual({ kind: 'type-port' });
    expect(encodeAction({ kind: 'test-pick' })).not.toBe(encodeAction({ kind: 'type-port' }));
  });
});

describe('keyboards', () => {
  it('menu offers every action', () => {
    const flat = menuKeyboard().flat();
    const kinds = flat.map((b) => decodeAction(b.callback_data)?.kind);
    expect(kinds).toEqual(expect.arrayContaining(['add', 'list', 'status', 'remove-pick', 'test-pick']));
  });

  it('mailbox keyboard has one button per label plus a back button', () => {
    const kb = mailboxKeyboard(['Work', 'Personal'], 'remove');
    const flat = kb.flat();
    expect(flat.filter((b) => decodeAction(b.callback_data)?.kind === 'remove')).toHaveLength(2);
    expect(flat.some((b) => decodeAction(b.callback_data)?.kind === 'menu')).toBe(true);
  });

  it('mailbox keyboard encodes the label token, never the raw label', () => {
    const kb = mailboxKeyboard(['A very long mailbox label indeed'.repeat(4)], 'test');
    const button = kb.flat()[0]!;
    expect(button.callback_data).not.toContain('very long');
    expect(byteLen(button.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it('mailbox keyboard shows the label as the visible button text', () => {
    expect(mailboxKeyboard(['Work'], 'remove').flat()[0]!.text).toContain('Work');
  });

  it('every generated button stays within the byte cap', () => {
    const all = [
      ...menuKeyboard().flat(),
      ...mailboxKeyboard(['Work'], 'remove').flat(),
      ...confirmRemoveKeyboard('a1b2c3d4').flat(),
      ...hostPickKeyboard().flat(),
      ...portPickKeyboard().flat(),
      ...cancelKeyboard().flat(),
      ...backKeyboard().flat(),
    ];
    for (const b of all) {
      expect(byteLen(b.callback_data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
  });

  it('every generated button decodes to a known action', () => {
    const all = [
      ...menuKeyboard().flat(),
      ...mailboxKeyboard(['Work'], 'test').flat(),
      ...confirmRemoveKeyboard('a1b2c3d4').flat(),
      ...hostPickKeyboard().flat(),
      ...portPickKeyboard().flat(),
      ...cancelKeyboard().flat(),
      ...backKeyboard().flat(),
    ];
    for (const b of all) {
      expect(decodeAction(b.callback_data)).not.toBeNull();
    }
  });

  it('confirm keyboard offers exactly confirm and cancel', () => {
    const kinds = confirmRemoveKeyboard('a1b2c3d4').flat().map((b) => decodeAction(b.callback_data)?.kind);
    expect(kinds).toEqual(expect.arrayContaining(['remove-confirm', 'cancel']));
  });

  it('host picks include a manual-entry option', () => {
    const kinds = hostPickKeyboard().flat().map((b) => decodeAction(b.callback_data)?.kind);
    expect(kinds).toContain('type-host');
    expect(kinds).toContain('host');
  });

  it('port picks offer 993 and a manual-entry option', () => {
    const actions = portPickKeyboard().flat().map((b) => decodeAction(b.callback_data));
    expect(actions).toContainEqual({ kind: 'port', value: 993 });
    expect(actions.map((a) => a?.kind)).toContain('type-port');
  });
});
