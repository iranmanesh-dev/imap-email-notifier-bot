import { parseEmail } from '../mail/parse.js';
import type { SeenStore } from '../store/seen.js';
import type { NormalizedEmail } from '../types.js';

export type SweepDeps = {
  list(): Promise<{ path: string }[]>;
  status(path: string): Promise<{ uidNext: number; uidValidity: number }>;
  fetchSince(
    path: string,
    uidFrom: number,
    maxMessages: number
  ): Promise<{ uid: number; source: Buffer }[]>;
};

/**
 * Upper bound on how many messages a single sweep will fetch from one
 * folder. Without this, a user bulk-archiving a few hundred messages (wholly
 * ordinary behaviour) makes the next sweep buffer every one of their full
 * raw sources -- attachments included -- into memory at once: at ~2MB
 * average, a few hundred messages is enough to OOM a small VPS. Capping the
 * batch only prevents that if folder state advances to match what was
 * actually processed rather than jumping straight to current.uidNext -- see
 * the truncation handling in sweepFolder below.
 */
export const MAX_MESSAGES_PER_SWEEP = 50;

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

/**
 * Safely stringifies a caught value that may not be an Error. A bare
 * `(err as Error).message` throws a TypeError when `err` is `null` or
 * `undefined` (a non-Error rejection reason), and that throw would escape
 * from inside a catch block meant to be the last line of defense. Exported
 * so other modules (e.g. watcher.ts) can reuse the same safe formatting
 * instead of duplicating an unguarded cast.
 */
export function errorMessage(err: unknown): string {
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
  const messages = await deps.fetchSince(path, previous.uidNext, MAX_MESSAGES_PER_SWEEP);
  messages.sort((a, b) => a.uid - b.uid);
  // Reaching the cap means there may be more messages beyond this batch
  // (or, in the exact-boundary case where there happen to be precisely
  // MAX_MESSAGES_PER_SWEEP new messages and no more, "highest uid + 1"
  // below computes the same value as current.uidNext anyway -- so treating
  // this as "possibly truncated" is always safe, never wrong).
  const truncated = messages.length === MAX_MESSAGES_PER_SWEEP;

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

  // Only advance once the whole batch is handled, so a crash mid-batch
  // retries. If the batch was truncated by MAX_MESSAGES_PER_SWEEP, advance
  // only to (highest processed uid) + 1, NOT to current.uidNext -- jumping
  // straight to current.uidNext here would silently skip every message
  // beyond the cap, which is the exact failure mode this batching fix must
  // not introduce. The next sweep resumes from precisely that point.
  const nextState = truncated
    ? { uidNext: messages[messages.length - 1]!.uid + 1, uidValidity: current.uidValidity }
    : current;
  opts.store.setFolderState(opts.accountLabel, path, nextState);
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
