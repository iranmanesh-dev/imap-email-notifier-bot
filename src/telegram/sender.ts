export type SendOutcome = 'sent' | 'dropped';

export type SenderOptions = {
  token: string;
  chatId: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
  maxAttempts?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Removes tags so a message rejected for bad HTML can be retried as plain text. */
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export class TelegramSender {
  readonly #url: string;
  readonly #chatId: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #minIntervalMs: number;
  readonly #maxAttempts: number;

  #queue: Promise<unknown> = Promise.resolve();
  #lastSentAt = 0;

  constructor(opts: SenderOptions) {
    this.#url = `https://api.telegram.org/bot${opts.token}/sendMessage`;
    this.#chatId = opts.chatId;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#minIntervalMs = opts.minIntervalMs ?? 1100;
    this.#maxAttempts = opts.maxAttempts ?? 5;
  }

  /** Enqueues a message. Resolves once it is sent or definitively dropped. */
  send(html: string): Promise<SendOutcome> {
    const result = this.#queue.then(() => this.#sendNow(html));
    // Keep the chain alive even if one send rejects unexpectedly.
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #throttle(): Promise<void> {
    if (this.#minIntervalMs <= 0) return;
    const elapsed = Date.now() - this.#lastSentAt;
    if (elapsed < this.#minIntervalMs) {
      await this.#sleep(this.#minIntervalMs - elapsed);
    }
  }

  async #post(text: string, useHtml: boolean): Promise<Response> {
    const body: Record<string, unknown> = {
      chat_id: this.#chatId,
      text,
      disable_web_page_preview: true,
    };
    if (useHtml) body.parse_mode = 'HTML';

    return this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async #sendNow(html: string): Promise<SendOutcome> {
    let text = html;
    let useHtml = true;
    let plainRetryUsed = false;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      await this.#throttle();

      let res: Response;
      try {
        res = await this.#post(text, useHtml);
      } catch {
        if (attempt === this.#maxAttempts) return 'dropped';
        await this.#sleep(Math.min(2 ** attempt * 500, 30_000));
        continue;
      } finally {
        this.#lastSentAt = Date.now();
      }

      if (res.ok) return 'sent';

      if (res.status === 429) {
        const payload = (await res.json().catch(() => ({}))) as {
          parameters?: { retry_after?: number };
        };
        const retryAfter = payload.parameters?.retry_after ?? 1;
        await this.#sleep(retryAfter * 1000);
        continue;
      }

      if (res.status === 400) {
        if (plainRetryUsed) return 'dropped';
        plainRetryUsed = true;
        text = toPlainText(html);
        useHtml = false;
        continue;
      }

      if (res.status >= 500) {
        if (attempt === this.#maxAttempts) return 'dropped';
        await this.#sleep(Math.min(2 ** attempt * 500, 30_000));
        continue;
      }

      // 401/403 and similar: retrying will not help.
      return 'dropped';
    }

    return 'dropped';
  }
}
