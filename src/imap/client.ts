import { ImapFlow } from 'imapflow';
import type { SweepDeps } from './sweeper.js';
import type { Account } from '../types.js';

export function createClient(account: Account): ImapFlow {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.user, pass: account.pass },
    logger: false, // never log IMAP traffic: it contains message content
    emitLogs: false,
  });
}

export function isAuthError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { authenticationFailed?: boolean; responseText?: string };
  if (e.authenticationFailed === true) return true;
  return typeof e.responseText === 'string' && e.responseText.includes('AUTHENTICATIONFAILED');
}

export function imapSweepDeps(client: ImapFlow): SweepDeps {
  return {
    async list() {
      const mailboxes = await client.list();
      return mailboxes
        .filter((m) => !m.flags.has('\\Noselect'))
        .map((m) => ({ path: m.path }));
    },

    async status(path) {
      const status = await client.status(path, { uidNext: true, uidValidity: true });
      return {
        uidNext: Number(status.uidNext ?? 1),
        uidValidity: Number(status.uidValidity ?? 0),
      };
    },

    async fetchSince(path, uidFrom) {
      const lock = await client.getMailboxLock(path);
      try {
        const out: { uid: number; source: Buffer }[] = [];
        for await (const message of client.fetch(
          `${uidFrom}:*`,
          { uid: true, source: true },
          { uid: true }
        )) {
          // `uid:*` always returns at least one message even when none are new.
          if (message.uid < uidFrom) continue;
          // FetchMessageObject.source is typed optional (it depends on the
          // requested query), but we always request { source: true } above,
          // so a missing source here indicates a server/library bug worth
          // surfacing rather than silently dropping the message.
          if (!message.source) {
            throw new Error(
              `IMAP fetch for ${path} uid ${message.uid} did not include a message source`
            );
          }
          out.push({ uid: message.uid, source: message.source });
        }
        return out;
      } finally {
        lock.release();
      }
    },
  };
}
