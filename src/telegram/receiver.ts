export type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  text?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type ReceiverOptions = {
  token: string;
  onUpdate: (update: TelegramUpdate) => Promise<void>;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollTimeoutSeconds?: number;
};

/** Thrown for conditions retrying cannot fix, such as a bad bot token. */
export class FatalTelegramError extends Error {}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_BACKOFF_MS = 60_000;

function backoffMs(failures: number): number {
  return Math.min(2 ** failures * 500, MAX_BACKOFF_MS);
}

/**
 * Redacts the bot token from a string before it reaches a log line. The
 * token is embedded in every request URL, so any error text or log message
 * that echoes a URL (or an underlying fetch failure, whose message can
 * include the URL) must be scrubbed at this boundary — the same defensive
 * move used for IMAP passwords in src/imap/probe.ts.
 */
function redact(text: string, token: string): string {
  if (token.length === 0) return text;
  return text.split(token).join('***');
}

function isValidUpdate(value: unknown): value is TelegramUpdate {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isInteger((value as { update_id?: unknown }).update_id)
  );
}

/**
 * Long-polls getUpdates until the signal aborts.
 *
 * Long-polling rather than a webhook because the container deliberately has
 * no public domain. deleteWebhook runs first: a webhook and getUpdates are
 * mutually exclusive, so a stale webhook would silently swallow every update.
 */
export async function runReceiver(opts: ReceiverOptions): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const pollTimeout = opts.pollTimeoutSeconds ?? 30;
  const base = `https://api.telegram.org/bot${opts.token}`;

  let offset = 0;
  let failures = 0;

  const logError = (message: string): void => {
    console.error(redact(message, opts.token));
  };

  const dropWebhook = async (): Promise<void> => {
    await doFetch(`${base}/deleteWebhook`, { method: 'POST', signal: opts.signal }).catch(() => undefined);
  };

  if (opts.signal.aborted) return;
  await dropWebhook();

  while (!opts.signal.aborted) {
    let res: Response;
    try {
      res = await doFetch(`${base}/getUpdates?offset=${offset}&timeout=${pollTimeout}`, {
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal.aborted) return;
      failures += 1;
      logError(`[telegram] poll failed: ${errorText(err)}`);
      await sleep(backoffMs(failures));
      continue;
    }

    if (res.status === 401) {
      // The token is wrong. Retrying cannot fix it, and hammering a bad
      // token is exactly what gets a bot rate-limited.
      throw new FatalTelegramError('Telegram rejected the bot token (401 Unauthorized)');
    }

    if (res.status === 409) {
      // Telegram allows only one long-poll consumer at a time. The dominant
      // real cause of 409 here is *another poller* running concurrently —
      // two container replicas, or a redeploy where the old instance
      // overlaps the new one — not a stray webhook. deleteWebhook cannot
      // fix that case, so we still call it (cheap, and does fix the webhook
      // variant) but always back off too: without a sleep here, two
      // overlapping pollers spin at full CPU issuing paired requests until
      // Telegram rate-limits or bans the bot.
      failures += 1;
      logError(
        '[telegram] 409 conflict from getUpdates; this usually means another poller is ' +
          'running (e.g. a duplicate instance during redeploy), not a stale webhook — ' +
          'clearing webhook defensively and backing off'
      );
      await dropWebhook();
      await sleep(backoffMs(failures));
      continue;
    }

    if (!res.ok) {
      failures += 1;
      await sleep(backoffMs(failures));
      continue;
    }

    failures = 0;
    const payload = (await res.json().catch(() => ({ result: [] }))) as { result?: unknown };
    const rawResult = payload.result;

    if (rawResult !== undefined && !Array.isArray(rawResult)) {
      logError('[telegram] getUpdates returned a non-array result; ignoring this batch');
    }

    const updates = Array.isArray(rawResult) ? rawResult : [];

    for (const raw of updates) {
      if (!isValidUpdate(raw)) {
        logError('[telegram] skipping an update with a missing or invalid update_id');
        continue;
      }
      // Advance past this update BEFORE handling it. A handler that throws
      // must not make the same update replay forever — the command handler
      // is responsible for reporting its own failures.
      offset = Math.max(offset, raw.update_id + 1);
      try {
        await opts.onUpdate(raw);
      } catch (err) {
        logError(`[telegram] handler failed: ${errorText(err)}`);
      }
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
