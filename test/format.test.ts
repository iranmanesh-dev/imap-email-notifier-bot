import { describe, it, expect } from 'vitest';
import { escapeHtml, formatEmail, hashtagify, TELEGRAM_MAX_CHARS } from '../src/mail/format.js';
import type { NormalizedEmail } from '../src/types.js';

function makeEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    messageId: '<abc@example.com>',
    accountLabel: 'Work',
    mailboxAddress: 'me@work.example',
    folder: 'INBOX',
    from: 'Alice Smith <alice@example.com>',
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

describe('hashtagify', () => {
  it('joins a multi-word label into one tag body', () => {
    expect(hashtagify('Work Mail')).toBe('Work_Mail');
  });

  it('collapses IMAP folder punctuation', () => {
    expect(hashtagify('INBOX.Sent')).toBe('INBOX_Sent');
    expect(hashtagify('[Gmail]/All Mail')).toBe('Gmail_All_Mail');
  });

  it('collapses a run of separators into a single underscore', () => {
    expect(hashtagify('a -- b')).toBe('a_b');
  });

  it('does not leave a leading or trailing underscore', () => {
    expect(hashtagify('[Gmail]')).toBe('Gmail');
    expect(hashtagify('  spaced  ')).toBe('spaced');
  });

  it('keeps existing underscores without doubling them', () => {
    expect(hashtagify('already_tagged')).toBe('already_tagged');
  });

  it('keeps non-Latin letters, which Telegram tags fine', () => {
    expect(hashtagify('Работа Почта')).toBe('Работа_Почта');
  });

  it('returns empty when nothing taggable remains', () => {
    expect(hashtagify('...')).toBe('');
  });

  it('strips the HTML-special characters entirely, so no escaping is needed', () => {
    expect(hashtagify('a&b<c>d')).toBe('a_b_c_d');
  });
});

describe('formatEmail', () => {
  it('renders the fields in order on their own lines', () => {
    const out = formatEmail(makeEmail());
    expect(out).toBe(
      '#Work\n' +
        '#INBOX\n' +
        'from: Alice Smith &lt;alice@example.com&gt;\n' +
        'to: me@work.example\n' +
        'subject: Hello there\n' +
        'Just checking in.'
    );
  });

  it('shows the sender name alongside the address', () => {
    const out = formatEmail(makeEmail({ from: 'Alice Smith <alice@example.com>' }));
    expect(out).toContain('Alice Smith');
    expect(out).toContain('alice@example.com');
  });

  it('shows a bare address unchanged when there is no display name', () => {
    const out = formatEmail(makeEmail({ from: 'alice@example.com' }));
    expect(out).toContain('\nfrom: alice@example.com\n');
  });

  it('hashtags the mailbox label and the folder on separate lines', () => {
    const out = formatEmail(makeEmail({ accountLabel: 'Work Mail', folder: '[Gmail]/All Mail' }));
    expect(out.startsWith('#Work_Mail\n#Gmail_All_Mail\n')).toBe(true);
  });

  it('shows the configured mailbox address as the recipient', () => {
    const out = formatEmail(makeEmail({ mailboxAddress: 'sales@example.com' }));
    expect(out).toContain('\nto: sales@example.com\n');
  });

  it('falls back to the plain name when a label has nothing taggable', () => {
    const out = formatEmail(makeEmail({ accountLabel: '...' }));
    expect(out.startsWith('...\n')).toBe(true);
    expect(out).not.toContain('#\n');
  });

  it('escapes a hostile subject so Telegram will not reject it', () => {
    const out = formatEmail(makeEmail({ subject: '<script>alert(1)</script> & more' }));
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp; more');
  });

  it('escapes a sender that still carries angle brackets', () => {
    const out = formatEmail(makeEmail({ from: 'Bob <bob@example.com>' }));
    expect(out).toContain('Bob &lt;bob@example.com&gt;');
  });

  it('escapes the mailbox address, which the operator typed', () => {
    const out = formatEmail(makeEmail({ mailboxAddress: 'a<b>&c' }));
    expect(out).toContain('to: a&lt;b&gt;&amp;c');
    expect(out).not.toContain('<b>');
  });

  it('escapes an account label that has taggable text around markup', () => {
    const out = formatEmail(makeEmail({ accountLabel: '<b>Work</b>' }));
    expect(out).not.toContain('<b>');
    expect(out.startsWith('#b_Work_b\n')).toBe(true);
  });

  it('escapes an account label with no taggable text at all', () => {
    const out = formatEmail(makeEmail({ accountLabel: '<<>>' }));
    expect(out).not.toContain('<<');
    expect(out.startsWith('&lt;&lt;&gt;&gt;\n')).toBe(true);
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

  it('bounds a very long subject to stay under the limit', () => {
    const out = formatEmail(makeEmail({ subject: 'A'.repeat(4200) }));
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  it('bounds a long subject made entirely of ampersands (5x expansion)', () => {
    const out = formatEmail(makeEmail({ subject: '&'.repeat(1000) }));
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  it('bounds a very long from field', () => {
    const out = formatEmail(makeEmail({ from: 'B'.repeat(5000) }));
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  it('bounds a very long folder', () => {
    const out = formatEmail(makeEmail({ folder: 'C'.repeat(5000) }));
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  it('bounds a very long mailbox address', () => {
    const out = formatEmail(makeEmail({ mailboxAddress: 'D'.repeat(5000) }));
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  it('bounds a long label whose punctuation expands into underscores', () => {
    const out = formatEmail(makeEmail({ accountLabel: 'a b'.repeat(2000) }));
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
  });

  it('bounds a long untaggable label, which falls back to escaped text', () => {
    const out = formatEmail(makeEmail({ accountLabel: '&'.repeat(2000) }));
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(out).not.toMatch(/&(a(m(p)?)?)?$|&l(t)?$|&g(t)?$/);
  });

  it('does not truncate a normal short subject', () => {
    const email = makeEmail({ subject: 'Normal subject here' });
    const out = formatEmail(email);
    expect(out).toContain('subject: Normal subject here');
    expect(out).not.toContain('Normal subject here…');
  });

  it('never ends with a partial HTML entity', () => {
    const out = formatEmail(
      makeEmail({
        subject: 'A'.repeat(4200),
        from: 'B'.repeat(5000),
        folder: 'C'.repeat(5000),
        mailboxAddress: 'D'.repeat(5000),
        preview: 'x'.repeat(1000),
      })
    );
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(out).not.toMatch(/&(a(m(p)?)?)?$|&l(t)?$|&g(t)?$/);
  });

  it('stays under the limit when every field is maximally hostile', () => {
    const out = formatEmail(
      makeEmail({
        accountLabel: '&'.repeat(5000),
        folder: '<'.repeat(5000),
        from: '>'.repeat(5000),
        mailboxAddress: '&'.repeat(5000),
        subject: '&'.repeat(5000),
        preview: '&'.repeat(5000),
      })
    );
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    expect(out).not.toMatch(/&(a(m(p)?)?)?$|&l(t)?$|&g(t)?$/);
  });
});
