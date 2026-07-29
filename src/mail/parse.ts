import { simpleParser } from 'mailparser';
import { createHash } from 'node:crypto';
import type { NormalizedEmail } from '../types.js';

export type ParseContext = {
  accountLabel: string;
  folder: string;
  previewChars: number;
};

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function syntheticId(parts: string[]): string {
  const hash = createHash('sha256').update(parts.join('|')).digest('hex');
  return `synthetic:${hash}`;
}

export async function parseEmail(source: Buffer, ctx: ParseContext): Promise<NormalizedEmail> {
  const parsed = await simpleParser(source, { skipHtmlToText: true });

  const subject = parsed.subject ?? '';
  const from = parsed.from?.text ?? '(unknown sender)';
  const date = parsed.date ?? new Date();

  const body = parsed.text || (parsed.html ? stripHtml(parsed.html) : '');
  const preview = collapse(body).slice(0, ctx.previewChars);

  const messageId =
    parsed.messageId ?? syntheticId([ctx.accountLabel, from, subject, date.toISOString()]);

  return {
    messageId,
    accountLabel: ctx.accountLabel,
    folder: ctx.folder,
    from,
    subject,
    preview,
    date,
  };
}
