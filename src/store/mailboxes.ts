import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { decryptSecret, encryptSecret } from '../crypto/secret.js';
import type { Account } from '../types.js';

export type MailboxSummary = {
  label: string;
  host: string;
  port: number;
  username: string;
};

type Row = {
  label: string;
  host: string;
  port: number;
  username: string;
  pass_enc: Buffer;
};

export class MailboxStore {
  #db: Database.Database;
  #key: Buffer;

  constructor(dbPath: string, key: Buffer) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS mailboxes (
        label      TEXT PRIMARY KEY,
        host       TEXT NOT NULL,
        port       INTEGER NOT NULL,
        username   TEXT NOT NULL,
        secure     INTEGER NOT NULL DEFAULT 1,
        pass_enc   BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    this.#key = key;
  }

  /** Throws if the label already exists — the PK is the uniqueness invariant. */
  add(account: Account): void {
    const existing = this.#db
      .prepare('SELECT 1 FROM mailboxes WHERE label = ?')
      .get(account.label);
    if (existing !== undefined) {
      throw new Error(`a mailbox labelled "${account.label}" already exists`);
    }
    this.#db
      .prepare(
        `INSERT INTO mailboxes (label, host, port, username, secure, pass_enc)
         VALUES (?, ?, ?, ?, 1, ?)`
      )
      .run(
        account.label,
        account.host,
        account.port,
        account.user,
        encryptSecret(account.pass, this.#key)
      );
  }

  list(): MailboxSummary[] {
    return this.#db
      .prepare('SELECT label, host, port, username FROM mailboxes ORDER BY label')
      .all() as MailboxSummary[];
  }

  /** Decrypts the password. Throws if the key is wrong or the row was tampered with. */
  get(label: string): Account | null {
    const row = this.#db
      .prepare('SELECT label, host, port, username, pass_enc FROM mailboxes WHERE label = ?')
      .get(label) as Row | undefined;
    if (row === undefined) return null;
    return {
      label: row.label,
      host: row.host,
      port: row.port,
      user: row.username,
      pass: decryptSecret(row.pass_enc, this.#key),
      secure: true,
    };
  }

  /** All labels, without decrypting anything. */
  labels(): string[] {
    return (
      this.#db.prepare('SELECT label FROM mailboxes ORDER BY label').all() as { label: string }[]
    ).map((r) => r.label);
  }

  remove(label: string): boolean {
    return this.#db.prepare('DELETE FROM mailboxes WHERE label = ?').run(label).changes > 0;
  }

  close(): void {
    this.#db.close();
  }
}
