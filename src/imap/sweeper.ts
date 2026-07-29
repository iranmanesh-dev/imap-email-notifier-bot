import { parseEmail } from '../mail/parse.js';
import type { SeenStore } from '../store/seen.js';
import type { NormalizedEmail } from '../types.js';

export type SweepDeps = {
  list(): Promise<{ path: string }[]>;
  status(path: string): Promise<{ uidNext: number; uidValidity: number }>;
  fetchSince(path: string, uidFrom: number): Promise<{ uid: number; source: Buffer }[]>;
};

export type SweepOptions = {
  accountLabel: string;
  previewChars: number;
  store: SeenStore;
  onEmail: (email: NormalizedEmail) => Promise<void>;
};

async function sweepFolder(deps: SweepDeps, opts: SweepOptions, path: string): Promise<void> {
  const current = await deps.status(path);
  const previous = opts.store.getFolderState(opts.accountLabel, path);

  // First time we have seen this folder, or the server reset its UID space:
  // record a baseline and notify nothing.
  if (previous === null || previous.uidValidity !== current.uidValidity) {
    opts.store.setFolderState(opts.accountLabel, path, current);
    return;
  }

  if (current.uidNext <= previous.uidNext) return;

  const messages = await deps.fetchSince(path, previous.uidNext);
  messages.sort((a, b) => a.uid - b.uid);

  for (const message of messages) {
    const email = await parseEmail(message.source, {
      accountLabel: opts.accountLabel,
      folder: path,
      previewChars: opts.previewChars,
    });

    if (!opts.store.markSeen(email.messageId)) continue; // already notified elsewhere
    await opts.onEmail(email);
  }

  // Only advance once the whole batch is handled, so a crash mid-batch retries.
  opts.store.setFolderState(opts.accountLabel, path, current);
}

export async function sweep(deps: SweepDeps, opts: SweepOptions): Promise<void> {
  const folders = await deps.list();

  for (const folder of folders) {
    try {
      await sweepFolder(deps, opts, folder.path);
    } catch (err) {
      console.error(
        `[${opts.accountLabel}] sweep failed for folder ${folder.path}: ${(err as Error).message}`
      );
    }
  }
}
