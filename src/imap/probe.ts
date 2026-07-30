import { createClient } from './client.js';
import type { Account } from '../types.js';

export type ProbeResult = { ok: true; folders: number } | { ok: false; reason: string };

type ProbeConnection = {
  list(): Promise<unknown[]>;
  logout(): Promise<void>;
};

export type ProbeDeps = {
  connect(account: Account): Promise<ProbeConnection>;
};

const realDeps: ProbeDeps = {
  async connect(account) {
    const client = createClient(account);
    await client.connect();
    return {
      list: () => client.list() as unknown as Promise<unknown[]>,
      logout: () => client.logout(),
    };
  },
};

/**
 * Redacts the password from any text before it reaches a log or a bot
 * reply. IMAP servers and libraries sometimes echo the credentials they
 * were given, so scrubbing at the boundary is the only reliable place.
 */
function scrub(text: string, secret: string): string {
  if (secret.length === 0) return text;
  return text.split(secret).join('***');
}

/**
 * Attempts a real login and folder listing without saving anything.
 * Used by /add before persisting, and by /test on an existing mailbox.
 */
export async function probeMailbox(
  account: Account,
  deps: ProbeDeps = realDeps
): Promise<ProbeResult> {
  let connection: ProbeConnection | null = null;
  try {
    connection = await deps.connect(account);
    const folders = await connection.list();
    return { ok: true, folders: folders.length };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: scrub(raw, account.pass) };
  } finally {
    if (connection !== null) {
      await connection.logout().catch(() => undefined);
    }
  }
}
