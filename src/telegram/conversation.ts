/** How long a pending /add password prompt stays valid. */
export const PASSWORD_TTL_MS = 5 * 60_000;
/** How long a pending /remove confirmation stays valid. */
export const CONFIRM_TTL_MS = 60_000;
/**
 * Wizard steps expire on the same clock as the password prompt. The reason
 * is identical: an abandoned flow must not make the bot treat an unrelated
 * later message as a field value.
 */
export const WIZARD_TTL_MS = PASSWORD_TTL_MS;

export type Pending =
  | {
      kind: 'password';
      label: string;
      host: string;
      port: number;
      username: string;
      expiresAt: number;
    }
  | { kind: 'remove-confirm'; label: string; expiresAt: number }
  | { kind: 'wizard-label'; expiresAt: number }
  | { kind: 'wizard-host'; label: string; expiresAt: number }
  | { kind: 'wizard-port'; label: string; host: string; expiresAt: number }
  | {
      kind: 'wizard-username';
      label: string;
      host: string;
      port: number;
      expiresAt: number;
    };

/**
 * The notice sent when a pending flow is discarded because the operator did
 * something else instead.
 *
 * Both inbound surfaces write conversation state, and both must say the
 * same thing when they throw an entry away: an operator who sees "Cancelled
 * …" after a `/command` and silence after a button tap has no way to know
 * the button tap disarmed anything. Living here rather than in either
 * handler is what makes that structural instead of a coincidence.
 *
 * Returns plain text with no markup — a caller emitting HTML must escape it.
 */
export function cancellationNotice(pending: Pending): string {
  switch (pending.kind) {
    case 'password':
      return `Cancelled the pending password prompt for "${pending.label}".`;
    case 'remove-confirm':
      return `Cancelled the pending removal confirmation for "${pending.label}".`;
    case 'wizard-label':
    case 'wizard-host':
    case 'wizard-port':
    case 'wizard-username':
      return 'Cancelled the pending mailbox setup.';
  }
}

/**
 * In-memory, single-use state for multi-step commands.
 *
 * Expiry is essential, not tidiness: without it an abandoned /add would
 * make the bot treat an unrelated message sent an hour later as a
 * password, and then attempt an IMAP login with it.
 */
export class Conversations {
  readonly #pending = new Map<number, Pending>();

  set(chatId: number, pending: Pending): void {
    this.#pending.set(chatId, pending);
  }

  /** Returns the pending entry and clears it. Null if absent or expired. */
  take(chatId: number, now: number): Pending | null {
    const entry = this.#pending.get(chatId);
    if (entry === undefined) return null;
    this.#pending.delete(chatId);
    if (entry.expiresAt <= now) return null;
    return entry;
  }

  clear(chatId: number): void {
    this.#pending.delete(chatId);
  }

  size(): number {
    return this.#pending.size;
  }
}
