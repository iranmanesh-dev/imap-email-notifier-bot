import type { NormalizedEmail } from '../types.js';

export const TELEGRAM_MAX_CHARS = 4096;

// Caps for header-contributing fields, measured on escaped length
const SUBJECT_MAX_CHARS = 400;
const FROM_MAX_CHARS = 400;
const TO_MAX_CHARS = 400;
const ACCOUNT_LABEL_MAX_CHARS = 100;
const FOLDER_MAX_CHARS = 100;

export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Trims escaped text to `max` chars without leaving a half-written HTML entity. */
function truncateEscaped(escaped: string, max: number): string {
  if (escaped.length <= max) return escaped;
  let cut = escaped.slice(0, max);
  const lastAmp = cut.lastIndexOf('&');
  if (lastAmp !== -1 && !cut.slice(lastAmp).includes(';')) {
    cut = cut.slice(0, lastAmp);
  }
  return cut;
}

/**
 * Reduces arbitrary text to a body Telegram will treat as a single hashtag.
 *
 * A Telegram hashtag ends at the first character that is not a letter, digit
 * or underscore. So `#Work Mail` tags only "Work", `#INBOX.Sent` tags only
 * "INBOX", and `#[Gmail]/All Mail` tags nothing at all. Collapsing every run
 * of unsupported characters into one underscore keeps the whole name inside
 * one tag: `Work_Mail`, `INBOX_Sent`, `Gmail_All_Mail`.
 *
 * Letters and digits are matched by Unicode property, not `[A-Za-z0-9]`,
 * because Telegram tags non-Latin scripts fine and a mailbox may well be
 * labelled in one.
 *
 * The result contains only letters, digits and underscores, so it needs no
 * HTML escaping afterwards — `&`, `<` and `>` cannot survive this function.
 * Returns an empty string when nothing taggable remains.
 */
export function hashtagify(input: string): string {
  return input
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Renders one `#tag` line, bounded to `max`. Falls back to the plain escaped
 * text when the value has nothing taggable in it (a label of pure
 * punctuation): a bare `#` would carry less information than the name itself.
 */
function tagLine(raw: string, max: number): string {
  const tag = hashtagify(raw);
  if (tag.length > 0) return `#${truncateEscaped(tag, max)}`;
  return truncateEscaped(escapeHtml(raw), max);
}

export function formatEmail(email: NormalizedEmail): string {
  // Escape and bound each header field independently
  const rawSubject = email.subject.trim() || '(no subject)';
  const escapedSubject = escapeHtml(rawSubject);
  const subject = truncateEscaped(escapedSubject, SUBJECT_MAX_CHARS);

  const escapedFrom = escapeHtml(email.from);
  const from = truncateEscaped(escapedFrom, FROM_MAX_CHARS);

  const escapedTo = escapeHtml(email.mailboxAddress);
  const to = truncateEscaped(escapedTo, TO_MAX_CHARS);

  const accountTag = tagLine(email.accountLabel, ACCOUNT_LABEL_MAX_CHARS);
  const folderTag = tagLine(email.folder, FOLDER_MAX_CHARS);

  const header =
    `${accountTag}\n` +
    `${folderTag}\n` +
    `from: ${from}\n` +
    `to: ${to}\n` +
    `subject: ${subject}\n`;

  // Clamp budget to ensure it never goes negative
  const budget = Math.max(0, TELEGRAM_MAX_CHARS - header.length - 1);

  const escapedPreview = escapeHtml(email.preview.trim());
  if (escapedPreview.length <= budget) {
    return (header + escapedPreview).trimEnd();
  }
  return header + truncateEscaped(escapedPreview, budget) + '…';
}
