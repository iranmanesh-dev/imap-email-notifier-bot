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

export type SweepResult = {
  foldersChecked: number;
  failures: { folder: string; message: string }[];
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function sweepFolder(deps: SweepDeps, opts: SweepOptions, path: string): Promise<void> {
  const current = await deps.status(path);
  const previous = opts.store.getFolderState(opts.accountLabel, path);

  // First time we have seen this folder, or the server reset its UID space:
  // record a baseline and notify nothing.
  if (previous === null || previous.uidValidity !== current.uidValidity) {
    if (previous !== null) {
      console.error(
        `[${opts.accountLabel}] folder ${path}: uidValidity changed (${previous.uidValidity} -> ${current.uidValidity}); re-baselining`
      );
    }
    opts.store.setFolderState(opts.accountLabel, path, current);
    return;
  }

  // uidNext moving backward without a uidValidity change means a mailbox
  // restore or a non-compliant server reset the high-water mark under us.
  // Trusting the old (higher) value would silently drop all future mail in
  // this folder forever, so re-baseline here too and self-heal in one sweep.
  if (current.uidNext < previous.uidNext) {
    console.error(
      `[${opts.accountLabel}] folder ${path}: uidNext moved backward (${previous.uidNext} -> ${current.uidNext}); re-baselining`
    );
    opts.store.setFolderState(opts.accountLabel, path, current);
    return;
  }

  if (current.uidNext === previous.uidNext) return;

  // fetchSince uses previous.uidNext only as a floor. A message that arrives
  // between status() and fetchSince() may be included here and again in the
  // next sweep's fetch; that overlap is intentional and harmless because
  // hasSeen/markSeen dedup on (accountLabel, messageId), so it is never
  // notified twice for the same account (moving between folders within one
  // account is still a single notification), while the same message
  // genuinely reaching a different account's mailbox still notifies there.
  const messages = await deps.fetchSince(path, previous.uidNext);
  messages.sort((a, b) => a.uid - b.uid);

  for (const message of messages) {
    const email = await parseEmail(message.source, {
      accountLabel: opts.accountLabel,
      folder: path,
      previewChars: opts.previewChars,
    });

    if (opts.store.hasSeen(opts.accountLabel, email.messageId)) continue; // already notified for this account

    // Mark seen only after the send succeeds. This accepts at-least-once
    // delivery (a crash between onEmail resolving and markSeen committing
    // yields one duplicate on restart) in exchange for never losing a
    // notification: if onEmail throws, the id stays unmarked and folder
    // state stays unadvanced, so this exact message is retried next sweep.
    await opts.onEmail(email);

    try {
      opts.store.markSeen(opts.accountLabel, email.messageId);
    } catch (err) {
      // A markSeen throw (SQLITE_FULL, read-only volume, corruption) must
      // NOT be treated like an onEmail failure: hasSeen is a plain SELECT
      // that keeps succeeding, so leaving folder state unadvanced would mean
      // this exact message is refetched, resent, and fails to mark seen
      // again on every future sweep forever — an unbounded duplicate-
      // notification storm even though the notification itself already went
      // out. Escalate instead: advance folder state past exactly this
      // message (never past any later, unprocessed message in the batch) so
      // it can never be refetched, accepting the loss of its "seen" record
      // in exchange for a hard stop on repeat sends, then stop this folder
      // for the rest of this sweep so later messages are left untouched for
      // a future sweep instead of being fetched-and-discarded now.
      console.error(
        `[${opts.accountLabel}] folder ${path}: STORAGE FAILURE marking uid ${message.uid} as seen; the notification was already sent and will not be repeated, but its "seen" record was not persisted: ${errorMessage(err)}`
      );
      try {
        opts.store.setFolderState(opts.accountLabel, path, {
          uidNext: message.uid + 1,
          uidValidity: current.uidValidity,
        });
      } catch (stateErr) {
        // Best-effort: if the underlying storage is broken badly enough that
        // even setFolderState fails, there is nothing more we can do here —
        // the outer catch below still surfaces the original failure.
        console.error(
          `[${opts.accountLabel}] folder ${path}: failed to advance folder state after a markSeen failure: ${errorMessage(stateErr)}`
        );
      }
      throw new Error(
        `storage failure: unable to mark message as seen in folder ${path} (uid=${message.uid}): ${errorMessage(err)}`
      );
    }
  }

  // Only advance once the whole batch is handled, so a crash mid-batch retries.
  opts.store.setFolderState(opts.accountLabel, path, current);
}

export async function sweep(deps: SweepDeps, opts: SweepOptions): Promise<SweepResult> {
  const folders = await deps.list();
  const failures: { folder: string; message: string }[] = [];
  let foldersChecked = 0;

  for (const folder of folders) {
    try {
      await sweepFolder(deps, opts, folder.path);
      foldersChecked++;
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[${opts.accountLabel}] sweep failed for folder ${folder.path}: ${message}`);
      failures.push({ folder: folder.path, message });
    }
  }

  return { foldersChecked, failures };
}
