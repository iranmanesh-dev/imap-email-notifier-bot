/** How long a pending /add password prompt stays valid. */
export const PASSWORD_TTL_MS = 5 * 60_000;
/** How long a pending /remove confirmation stays valid. */
export const CONFIRM_TTL_MS = 60_000;

export type Pending =
  | {
      kind: 'password';
      label: string;
      host: string;
      port: number;
      username: string;
      expiresAt: number;
    }
  | { kind: 'remove-confirm'; label: string; expiresAt: number };

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
