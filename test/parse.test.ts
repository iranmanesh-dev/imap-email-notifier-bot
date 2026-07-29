import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEmail } from '../src/mail/parse.js';

function fixture(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

const ctx = { accountLabel: 'Work', folder: 'INBOX', previewChars: 200 };

describe('parseEmail', () => {
  it('extracts sender, subject and message id from plaintext mail', async () => {
    const email = await parseEmail(fixture('plain.eml'), ctx);
    expect(email.subject).toBe('Lunch tomorrow?');
    expect(email.from).toContain('alice@example.com');
    expect(email.messageId).toBe('<plain-001@example.com>');
    expect(email.preview).toContain('free for lunch tomorrow');
  });

  it('carries the account label and folder through', async () => {
    const email = await parseEmail(fixture('plain.eml'), { ...ctx, folder: 'Archive' });
    expect(email.accountLabel).toBe('Work');
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
    expect(email.from).toContain('René Müller');
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
});
