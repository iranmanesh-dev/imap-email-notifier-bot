import type { NormalizedEmail } from '../types.js';

export const TELEGRAM_MAX_CHARS = 4096;

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
  const subject = escapeHtml(email.subject.trim() || '(no subject)');
  const from = escapeHtml(email.from);
  const location = `${escapeHtml(email.accountLabel)} › ${escapeHtml(email.folder)}`;

  const header = `📬 <b>${subject}</b>\nFrom: ${from}\n${location}\n\n`;
  const budget = TELEGRAM_MAX_CHARS - header.length - 1; // 1 char reserved for the ellipsis

  const escapedPreview = escapeHtml(email.preview.trim());
  if (escapedPreview.length <= budget) {
    return (header + escapedPreview).trimEnd();
  }
  return header + truncateEscaped(escapedPreview, budget) + '…';
}
