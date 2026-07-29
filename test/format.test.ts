import { describe, it, expect } from 'vitest';
import { escapeHtml, formatEmail, TELEGRAM_MAX_CHARS } from '../src/mail/format.js';
import type { NormalizedEmail } from '../src/types.js';

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    messageId: '<abc@example.com>',
    accountLabel: 'Work',
    folder: 'INBOX',
    from: 'Alice <alice@example.com>',
    subject: 'Hello there',
    preview: 'Just checking in.',
    date: new Date('2026-07-28T10:00:00Z'),
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes the three characters Telegram HTML cares about', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes ampersands before angle brackets, not after', () => {
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });
});

describe('formatEmail', () => {
  it('includes subject, sender, account and folder', () => {
    const out = formatEmail(makeEmail());
    expect(out).toContain('Hello there');
    expect(out).toContain('alice@example.com');
    expect(out).toContain('Work');
    expect(out).toContain('INBOX');
    expect(out).toContain('Just checking in.');
  });

  it('escapes a hostile subject so Telegram will not reject it', () => {
    const out = formatEmail(makeEmail({ subject: '<script>alert(1)</script> & more' }));
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp; more');
  });

  it('escapes the sender, which contains angle brackets by nature', () => {
    const out = formatEmail(makeEmail({ from: 'Bob <bob@example.com>' }));
    expect(out).toContain('Bob &lt;bob@example.com&gt;');
  });

  it('substitutes a placeholder for an empty subject', () => {
    const out = formatEmail(makeEmail({ subject: '' }));
    expect(out).toContain('(no subject)');
  });

  it('truncates so the result never exceeds the Telegram limit', () => {
    const out = formatEmail(makeEmail({ preview: 'x'.repeat(10_000) }));
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(out).toContain('…');
  });

  it('keeps the header intact when truncating', () => {
    const out = formatEmail(makeEmail({ subject: 'Important', preview: 'y'.repeat(10_000) }));
    expect(out).toContain('Important');
    expect(out).toContain('Work');
  });

  it('does not split an HTML entity when truncating', () => {
    const out = formatEmail(makeEmail({ preview: '&'.repeat(5_000) }));
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(out).not.toMatch(/&(a(m(p)?)?)?$|&l(t)?$|&g(t)?$/);
  });
});
