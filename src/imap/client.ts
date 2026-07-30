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
      // A missing field here must never be defaulted: defaulting uidValidity
      // to 0 makes the sweeper think the server reset its UID space, so it
      // silently re-baselines and destroys the real high-water mark, losing
      // every message that arrives before the next successful STATUS call.
      // Throwing lets the sweeper's per-folder catch record the failure and
      // retry next sweep, leaving stored state untouched in the meantime.
      if (status.uidNext === undefined) {
        throw new Error(`IMAP STATUS for ${path} did not include uidNext`);
      }
      if (status.uidValidity === undefined) {
        throw new Error(`IMAP STATUS for ${path} did not include uidValidity`);
      }
      return {
        uidNext: Number(status.uidNext),
        uidValidity: Number(status.uidValidity),
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
          // so this should be unreachable in practice. Unlike a missing
          // STATUS field (which is transient and safe to retry by throwing),
          // a message that never fetches a source is a per-message defect
          // that retrying will not fix: throwing here would stop folder
          // state from advancing and head-of-line-block every later message
          // in this folder forever. Skip just this message and keep going;
          // never log message content, only folder/uid.
          if (!message.source) {
            console.warn(
              `[imap] skipping message with no source: folder=${path} uid=${message.uid}`
            );
            continue;
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
