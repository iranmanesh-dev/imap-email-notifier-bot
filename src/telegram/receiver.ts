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

  const dropWebhook = async (): Promise<void> => {
    await doFetch(`${base}/deleteWebhook`, { method: 'POST' }).catch(() => undefined);
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
      console.error(`[telegram] poll failed: ${errorText(err)}`);
      await sleep(Math.min(2 ** failures * 500, MAX_BACKOFF_MS));
      continue;
    }

    if (res.status === 401) {
      // The token is wrong. Retrying cannot fix it, and hammering a bad
      // token is exactly what gets a bot rate-limited.
      throw new FatalTelegramError('Telegram rejected the bot token (401 Unauthorized)');
    }

    if (res.status === 409) {
      // A webhook was registered behind our back; they are mutually exclusive.
      console.error('[telegram] 409 conflict; removing webhook and resuming');
      await dropWebhook();
      continue;
    }

    if (!res.ok) {
      failures += 1;
      await sleep(Math.min(2 ** failures * 500, MAX_BACKOFF_MS));
      continue;
    }

    failures = 0;
    const payload = (await res.json().catch(() => ({ result: [] }))) as {
      result?: TelegramUpdate[];
    };
    const updates = payload.result ?? [];

    for (const update of updates) {
      // Advance past this update BEFORE handling it. A handler that throws
      // must not make the same update replay forever — the command handler
      // is responsible for reporting its own failures.
      offset = Math.max(offset, update.update_id + 1);
      try {
        await opts.onUpdate(update);
      } catch (err) {
        console.error(`[telegram] handler failed: ${errorText(err)}`);
      }
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
