import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type FolderState = { uidNext: number; uidValidity: number };

export class SeenStore {
  #db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    // Dedup is scoped per (account_label, message_id) rather than by
    // message_id alone: the same email genuinely reaching two different
    // watched mailboxes (BCC, forwarding rules, etc.) must produce one
    // notification per mailbox, not one total.
    //
    // This table is named `seen_by_account` rather than reusing the old
    // `seen` name. An earlier version of this store used a single-column
    // `seen(message_id TEXT PRIMARY KEY, ...)` table. `CREATE TABLE IF NOT
    // EXISTS` does not alter an existing table, so a developer (or
    // deployment) with an old `seen.db` already on disk would otherwise
    // silently keep the stale single-column schema, and every hasSeen/
    // markSeen call below — written against the new composite-key shape —
    // would throw "no such column: account_label" at runtime. There is no
    // deployed database to migrate yet, so the simplest safe fix is a new
    // table name: any old `seen` table is left inert and unused in the same
    // file (harmless), and every fresh or legacy database gets the correct
    // schema here with no schema-detection/ALTER-TABLE logic to get wrong.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS seen_by_account (
        account_label TEXT NOT NULL,
        message_id    TEXT NOT NULL,
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (account_label, message_id)
      );
      CREATE INDEX IF NOT EXISTS seen_by_account_first_seen_at ON seen_by_account (first_seen_at);

      CREATE TABLE IF NOT EXISTS folder_state (
        account_label TEXT NOT NULL,
        folder        TEXT NOT NULL,
        uid_next      INTEGER NOT NULL,
        uid_validity  INTEGER NOT NULL,
        PRIMARY KEY (account_label, folder)
      );
    `);
  }

  hasSeen(accountLabel: string, messageId: string): boolean {
    const row = this.#db
      .prepare('SELECT 1 FROM seen_by_account WHERE account_label = ? AND message_id = ?')
      .get(accountLabel, messageId);
    return row !== undefined;
  }

  /**
   * Records a message id as notified for a specific account. Returns true if
   * it was newly inserted. `firstSeenAt` (a bound `YYYY-MM-DD HH:MM:SS`
   * value) lets tests create backdated rows; production callers omit it.
   */
  markSeen(accountLabel: string, messageId: string, firstSeenAt?: string): boolean {
    const info =
      firstSeenAt === undefined
        ? this.#db
            .prepare('INSERT OR IGNORE INTO seen_by_account (account_label, message_id) VALUES (?, ?)')
            .run(accountLabel, messageId)
        : this.#db
            .prepare(
              'INSERT OR IGNORE INTO seen_by_account (account_label, message_id, first_seen_at) VALUES (?, ?, ?)'
            )
            .run(accountLabel, messageId, firstSeenAt);
    return info.changes > 0;
  }

  getFolderState(accountLabel: string, folder: string): FolderState | null {
    const row = this.#db
      .prepare(
        'SELECT uid_next AS uidNext, uid_validity AS uidValidity FROM folder_state WHERE account_label = ? AND folder = ?'
      )
      .get(accountLabel, folder) as FolderState | undefined;
    return row ?? null;
  }

  setFolderState(accountLabel: string, folder: string, state: FolderState): void {
    this.#db
      .prepare(
        `INSERT INTO folder_state (account_label, folder, uid_next, uid_validity)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (account_label, folder)
         DO UPDATE SET uid_next = excluded.uid_next, uid_validity = excluded.uid_validity`
      )
      .run(accountLabel, folder, state.uidNext, state.uidValidity);
  }

  prune(olderThanDays: number): number {
    const info = this.#db
      .prepare(`DELETE FROM seen_by_account WHERE first_seen_at < datetime('now', ?)`)
      .run(`-${olderThanDays} days`);
    return info.changes;
  }

  /**
   * Deletes every trace of an account: its per-folder UID state and its
   * seen-message records. Called when a mailbox is removed, so that
   * re-adding the same label starts from a fresh baseline rather than
   * resuming from a stale high-water mark and flooding the operator.
   */
  purgeAccount(accountLabel: string): number {
    const purge = this.#db.transaction((label: string): number => {
      const state = this.#db
        .prepare('DELETE FROM folder_state WHERE account_label = ?')
        .run(label).changes;
      const seen = this.#db
        .prepare('DELETE FROM seen_by_account WHERE account_label = ?')
        .run(label).changes;
      return state + seen;
    });
    return purge(accountLabel);
  }

  close(): void {
    this.#db.close();
  }
}
