import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEmail } from '../src/mail/parse.js';

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

const ctx = {
  accountLabel: 'Work',
  mailboxAddress: 'me@work.example',
  folder: 'INBOX',
  previewChars: 200,
};

describe('parseEmail', () => {
  it('extracts sender, subject and message id from plaintext mail', async () => {
    const email = await parseEmail(fixture('plain.eml'), ctx);
    expect(email.subject).toBe('Lunch tomorrow?');
    expect(email.from).toContain('alice@example.com');
    expect(email.messageId).toBe('<plain-001@example.com>');
    expect(email.preview).toContain('free for lunch tomorrow');
  });

  it('extracts the bare sender address, dropping the display name', async () => {
    const email = await parseEmail(fixture('plain.eml'), ctx);
    expect(email.from).toBe('alice@example.com');
    expect(email.from).not.toContain('Alice Smith');
  });

  it('carries the account label, mailbox address and folder through', async () => {
    const email = await parseEmail(fixture('plain.eml'), { ...ctx, folder: 'Archive' });
    expect(email.accountLabel).toBe('Work');
    expect(email.mailboxAddress).toBe('me@work.example');
    expect(email.folder).toBe('Archive');
  });

  it('falls back to stripped HTML when there is no plaintext part', async () => {
    const email = await parseEmail(fixture('html-only.eml'), ctx);
    expect(email.preview).toContain('Weekly digest');
    expect(email.preview).not.toContain('<h1>');
  });

  it('truncates the preview to previewChars', async () => {
    const email = await parseEmail(fixture('plain.eml'), { ...ctx, previewChars: 10 });
    expect(email.preview.length).toBeLessThanOrEqual(10);
  });

  it('collapses runs of whitespace in the preview', async () => {
    const email = await parseEmail(fixture('plain.eml'), ctx);
    expect(email.preview).not.toMatch(/\n\n/);
  });

  it('synthesises a stable id when Message-ID is absent', async () => {
    const a = await parseEmail(fixture('no-message-id.eml'), ctx);
    const b = await parseEmail(fixture('no-message-id.eml'), ctx);
    expect(a.messageId).toBe(b.messageId);
    expect(a.messageId).toMatch(/^synthetic:[0-9a-f]{64}$/);
  });

  it('gives different synthetic ids to different messages', async () => {
    const a = await parseEmail(fixture('no-message-id.eml'), ctx);
    const b = await parseEmail(fixture('no-message-id.eml'), { ...ctx, accountLabel: 'Personal' });
    expect(a.messageId).not.toBe(b.messageId);
  });

  it('decodes RFC 2047 encoded-word subjects in a non-UTF-8 charset', async () => {
    const email = await parseEmail(fixture('latin1.eml'), ctx);
    expect(email.subject).toBe('Déjeuner à midi?');
    // The From: header here is an encoded-word display name wrapping a plain
    // address. We keep the address and drop the name by design, so decoding
    // is asserted on the subject above; what matters here is that an
    // encoded-word From: still yields the address rather than mojibake or
    // the raw `=?iso-8859-1?Q?...?=` token.
    expect(email.from).toBe('rene@example.com');
  });

  it('decodes a quoted-printable ISO-8859-1 body', async () => {
    const email = await parseEmail(fixture('latin1.eml'), ctx);
    expect(email.preview).toContain('déjeune à midi');
  });

  it('never throws on an empty buffer', async () => {
    const email = await parseEmail(Buffer.from(''), ctx);
    expect(email.subject).toBe('');
    expect(email.messageId).toMatch(/^synthetic:/);
  });

  it('extracts the preview from the plaintext part of a multipart/alternative message', async () => {
    const email = await parseEmail(fixture('multipart-alternative.eml'), ctx);
    expect(email.preview).toContain('real plaintext content');
    expect(email.preview).not.toContain('HTML-rendered content only');
  });

  it('keeps the same synthetic id across parses when both Message-ID and Date are absent', async () => {
    const buf = fixture('no-message-id-no-date.eml');
    const a = await parseEmail(buf, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = await parseEmail(buf, ctx);
    expect(a.messageId).toBe(b.messageId);
    expect(a.messageId).toMatch(/^synthetic:[0-9a-f]{64}$/);
  });

  it('does not produce a lone surrogate when a preview boundary lands mid-emoji', async () => {
    const email = await parseEmail(fixture('emoji-boundary.eml'), { ...ctx, previewChars: 3 });
    expect(email.preview.length).toBeLessThanOrEqual(3);
    expect(() => encodeURIComponent(email.preview)).not.toThrow();
  });

  it('strips <style> and <script> content from HTML-only bodies', async () => {
    const email = await parseEmail(fixture('html-with-style-script.eml'), ctx);
    expect(email.preview).toContain('Important update');
    expect(email.preview).toContain('Please read this');
    expect(email.preview).not.toContain('color: red');
    expect(email.preview).not.toContain('alert(');
  });
});
