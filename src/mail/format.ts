import type { NormalizedEmail } from '../types.js';

export const TELEGRAM_MAX_CHARS = 4096;

// Caps for header-contributing fields, measured on escaped length
const SUBJECT_MAX_CHARS = 400;
const FROM_MAX_CHARS = 400;
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

export function formatEmail(email: NormalizedEmail): string {
  // Escape and bound each header field independently
  const rawSubject = email.subject.trim() || '(no subject)';
  const escapedSubject = escapeHtml(rawSubject);
  const subject = truncateEscaped(escapedSubject, SUBJECT_MAX_CHARS);

  const escapedFrom = escapeHtml(email.from);
  const from = truncateEscaped(escapedFrom, FROM_MAX_CHARS);

  const escapedAccountLabel = escapeHtml(email.accountLabel);
  const accountLabel = truncateEscaped(escapedAccountLabel, ACCOUNT_LABEL_MAX_CHARS);

  const escapedFolder = escapeHtml(email.folder);
  const folder = truncateEscaped(escapedFolder, FOLDER_MAX_CHARS);

  const location = `${accountLabel} › ${folder}`;
  const header = `📬 <b>${subject}</b>\nFrom: ${from}\n${location}\n\n`;

  // Clamp budget to ensure it never goes negative
  const budget = Math.max(0, TELEGRAM_MAX_CHARS - header.length - 1);

  const escapedPreview = escapeHtml(email.preview.trim());
  if (escapedPreview.length <= budget) {
    return (header + escapedPreview).trimEnd();
  }
  return header + truncateEscaped(escapedPreview, budget) + '…';
}
