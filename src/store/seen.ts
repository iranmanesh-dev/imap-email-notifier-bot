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
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS seen (
        message_id    TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS seen_first_seen_at ON seen (first_seen_at);

      CREATE TABLE IF NOT EXISTS folder_state (
        account_label TEXT NOT NULL,
        folder        TEXT NOT NULL,
        uid_next      INTEGER NOT NULL,
        uid_validity  INTEGER NOT NULL,
        PRIMARY KEY (account_label, folder)
      );
    `);
  }

  hasSeen(messageId: string): boolean {
    const row = this.#db.prepare('SELECT 1 FROM seen WHERE message_id = ?').get(messageId);
    return row !== undefined;
  }

  /**
   * Records a message id as notified. Returns true if it was newly inserted.
   * `firstSeenAt` (a bound `YYYY-MM-DD HH:MM:SS` value) lets tests create
   * backdated rows; production callers omit it.
   */
  markSeen(messageId: string, firstSeenAt?: string): boolean {
    const info =
      firstSeenAt === undefined
        ? this.#db.prepare('INSERT OR IGNORE INTO seen (message_id) VALUES (?)').run(messageId)
        : this.#db
            .prepare('INSERT OR IGNORE INTO seen (message_id, first_seen_at) VALUES (?, ?)')
            .run(messageId, firstSeenAt);
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
      .prepare(`DELETE FROM seen WHERE first_seen_at < datetime('now', ?)`)
      .run(`-${olderThanDays} days`);
    return info.changes;
  }

  close(): void {
    this.#db.close();
  }
}
