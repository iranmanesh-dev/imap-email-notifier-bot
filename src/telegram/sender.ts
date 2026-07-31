export type SendOutcome = 'sent' | 'dropped';

export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboard = InlineButton[][];

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
  readonly #baseUrl: string;
  readonly #chatId: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #minIntervalMs: number;
  readonly #maxAttempts: number;

  #queue: Promise<unknown> = Promise.resolve();
  #lastSentAt = 0;

  constructor(opts: SenderOptions) {
    this.#baseUrl = `https://api.telegram.org/bot${opts.token}`;
    this.#chatId = opts.chatId;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#minIntervalMs = opts.minIntervalMs ?? 1100;
    this.#maxAttempts = opts.maxAttempts ?? 5;
  }

  /** Enqueues a message. Resolves once it is sent or definitively dropped. */
  send(html: string, keyboard?: InlineKeyboard): Promise<SendOutcome> {
    const result = this.#queue.then(() => this.#sendNow(html, keyboard));
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

  async #post(text: string, useHtml: boolean, keyboard?: InlineKeyboard): Promise<Response> {
    const body: Record<string, unknown> = {
      chat_id: this.#chatId,
      text,
      disable_web_page_preview: true,
    };
    if (useHtml) body.parse_mode = 'HTML';
    if (keyboard !== undefined) {
      body.reply_markup = { inline_keyboard: keyboard };
    }

    return this.#fetch(`${this.#baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * Deletes a message in the operator's chat. Used to remove a password
   * the operator typed. Returns false rather than throwing — the caller
   * warns the operator to delete it manually.
   */
  async deleteMessage(chatId: string, messageId: number): Promise<boolean> {
    try {
      const res = await this.#fetch(`${this.#baseUrl}/deleteMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Answers a callback query. MUST be called for every button tap, on every
   * path including failures, or the operator's Telegram client shows a
   * spinner on the button until it times out.
   *
   * Returns false rather than throwing — a failed answer is cosmetic and
   * must never abort the action the tap requested.
   */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (text !== undefined) body.text = text;
    try {
      const res = await this.#fetch(`${this.#baseUrl}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Edits a message in place, so a multi-step wizard does not leave one
   * message per step in the chat.
   *
   * Returns false rather than throwing. Telegram refuses to edit messages
   * older than 48 hours, so callers must fall back to sending a new message
   * — otherwise tapping a button on a day-old menu silently does nothing.
   *
   * True means "the message now displays this content", which is why a
   * "message is not modified" 400 counts as success: Telegram rejects a
   * no-op edit, but the requested state IS the displayed state. Reporting
   * false there sent the caller down the new-message fallback, so
   * double-tapping Back appended a duplicate menu every time. This is the
   * only place that can tell the two 400s apart.
   */
  async editMessageText(
    chatId: string,
    messageId: number,
    html: string,
    keyboard?: InlineKeyboard
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (keyboard !== undefined) body.reply_markup = { inline_keyboard: keyboard };
    try {
      const res = await this.#fetch(`${this.#baseUrl}/editMessageText`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      const payload = (await res.json().catch(() => ({}))) as { description?: string };
      return (payload.description ?? '').includes('message is not modified');
    } catch {
      return false;
    }
  }

  async #sendNow(html: string, keyboard?: InlineKeyboard): Promise<SendOutcome> {
    let text = html;
    let useHtml = true;
    let plainRetryUsed = false;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      await this.#throttle();

      let res: Response;
      try {
        res = await this.#post(text, useHtml, keyboard);
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
        // The mandatory plain-text retry must not consume the maxAttempts
        // budget, so cancel out the loop's `attempt += 1` for this pass.
        attempt -= 1;
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
