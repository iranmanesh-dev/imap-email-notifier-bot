import { simpleParser } from 'mailparser';
import { createHash } from 'node:crypto';
import type { NormalizedEmail } from '../types.js';

export type ParseContext = {
  accountLabel: string;
  mailboxAddress: string;
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

// Truncates on whole Unicode code points so the boundary can never land inside
// a surrogate pair (e.g. an emoji), which would otherwise leave a lone
// surrogate and produce a corrupt string.
function truncateCodePoints(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let result = '';
  for (const char of text) {
    if (result.length + char.length > maxChars) break;
    result += char;
  }
  return result;
}

// The dedup key must be a pure function of the message bytes and the parse
// context - never wall-clock time. If a retry re-parses the identical buffer
// (e.g. after a failed onEmail handler leaves folder state unadvanced), the
// same key must come out, or the message would be notified again on every
// retry. Hashing the raw source buffer together with accountLabel (rather
// than joining decoded header strings with a plain delimiter) also removes
// any field-boundary ambiguity: the two inputs are hashed as fixed-length
// prefixed segments so no choice of accountLabel or message bytes can shift
// a boundary and produce a collision.
//
// Folding accountLabel into this id is no longer an inconsistency with the
// real-Message-ID path: SeenStore now scopes dedup by (accountLabel,
// messageId) uniformly, so a synthetic id that is already account-scoped
// here is redundant-but-harmless rather than the odd one out — a real
// Message-ID is account-independent on its own, and the store's composite
// key is what makes both cases behave the same way (one notification per
// mailbox that genuinely received the message).
function syntheticId(source: Buffer, accountLabel: string): string {
  const labelBuf = Buffer.from(accountLabel, 'utf8');
  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32BE(labelBuf.length, 0);
  const hash = createHash('sha256')
    .update(lengthPrefix)
    .update(labelBuf)
    .update(source)
    .digest('hex');
  return `synthetic:${hash}`;
}

export async function parseEmail(source: Buffer, ctx: ParseContext): Promise<NormalizedEmail> {
  const parsed = await simpleParser(source, { skipHtmlToText: true });

  const subject = parsed.subject ?? '';
  // Prefer the bare address over `from.text` ("Alice <alice@example.com>"),
  // because the notification shows a sender *address*. A display name is
  // attacker-controlled and routinely spoofs a different address; the
  // address is the part worth showing. Fall back to the full text only
  // when the header is malformed enough that no address parsed out of it.
  const from =
    parsed.from?.value?.[0]?.address?.trim() || parsed.from?.text?.trim() || '(unknown sender)';
  const date = parsed.date ?? new Date();

  const body = parsed.text || (parsed.html ? stripHtml(parsed.html) : '');
  const preview = truncateCodePoints(collapse(body), ctx.previewChars);

  const messageId = parsed.messageId ?? syntheticId(source, ctx.accountLabel);

  return {
    messageId,
    accountLabel: ctx.accountLabel,
    mailboxAddress: ctx.mailboxAddress,
    folder: ctx.folder,
    from,
    subject,
    preview,
    date,
  };
}
