import { escapeHtml } from '../mail/format.js';
import type { WatcherRegistry } from '../imap/registry.js';
import type { MailboxStore } from '../store/mailboxes.js';

export type StatusSources = {
  registry: Pick<WatcherRegistry, 'states'>;
  mailboxes: Pick<MailboxStore, 'labels'>;
};

/**
 * How one surface renders the parts of the report that vary.
 *
 * The typed surface emits no markup and is escaped wholesale downstream;
 * the button surface emits intentional <b> and must escape each field
 * itself. Parameterising only that difference is what lets both surfaces
 * share the reconciliation, the wording and the hint verbatim.
 */
export type StatusRenderer = {
  label: (label: string) => string;
  plain: (text: string) => string;
};

export const PLAIN_STATUS: StatusRenderer = {
  label: (label) => label,
  plain: (text) => text,
};

export const HTML_STATUS: StatusRenderer = {
  label: (label) => `<b>${escapeHtml(label)}</b>`,
  plain: (text) => escapeHtml(text),
};

export type StatusReport = {
  /** Set when the saved-mailbox list could not be read at all. */
  warning: string | null;
  /** True when nothing is watched AND nothing is saved. */
  empty: boolean;
  /** The rendered status body. Empty string when `empty` is true. */
  text: string;
};

/**
 * Reconciles the two sources of truth rather than reporting only one.
 *
 * The store holds what is configured; the registry holds the live watchers.
 * A mailbox can be in the store with no watcher — skipped during the
 * startup restore, or persisted by an /add whose registry.add then failed.
 * Reporting only the registry made such a mailbox invisible in status while
 * the list view showed it as perfectly normal, even though status is the
 * operator's only view into connection health.
 *
 * This lives in its own module because BOTH inbound surfaces render it. The
 * button view previously read the registry alone, so the surface the README
 * now points operators at first was the less truthful of the two. Sharing
 * the function makes convergence structural instead of something a reviewer
 * has to re-verify by hand.
 */
export function buildStatusReport(
  sources: StatusSources,
  render: StatusRenderer
): StatusReport {
  const states = sources.registry.states();
  const watched = new Set(states.map((s) => s.label));

  let warning: string | null = null;
  let unwatched: string[] = [];
  try {
    unwatched = sources.mailboxes.labels().filter((label) => !watched.has(label));
  } catch (err) {
    // labels() does not decrypt, so this is a genuine storage failure. Say
    // so rather than silently under-reporting.
    warning = render.plain(`Warning: could not read the saved mailbox list: ${errorText(err)}`);
  }

  if (states.length === 0 && unwatched.length === 0) {
    return { warning, empty: true, text: '' };
  }

  const lines = [
    ...states.map((s) => `• ${render.label(s.label)} — ${render.plain(s.state)}`),
    ...unwatched.map(
      (label) => `• ${render.label(label)} — NOT BEING WATCHED (saved, but no watcher running)`
    ),
  ];

  // The hint embeds a literal "<label>" placeholder, so it must go through
  // `plain` — unescaped on the HTML surface Telegram rejects the whole
  // message and the operator sees nothing at all.
  const hint =
    unwatched.length > 0
      ? '\n\n' +
        render.plain(
          `A saved mailbox with no watcher is not delivering anything. ` +
            `Try /test <label> to see why, then restart the bot or /remove and /add it again.`
        )
      : '';

  return { warning, empty: false, text: `Watcher status:\n${lines.join('\n')}${hint}` };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
