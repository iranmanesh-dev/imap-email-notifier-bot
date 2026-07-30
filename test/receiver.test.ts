import { describe, it, expect, vi } from 'vitest';
import { runReceiver, FatalTelegramError, type TelegramUpdate } from '../src/telegram/receiver.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const okUpdates = (result: TelegramUpdate[]) => jsonResponse(200, { ok: true, result });

function update(id: number, text: string, chatId = 42): TelegramUpdate {
  return { update_id: id, message: { message_id: id * 10, chat: { id: chatId }, text } };
}

/** Runs the receiver, aborting once `calls` fetches have happened. */
function runUntil(fetchImpl: typeof fetch, calls: number, onUpdate: (u: TelegramUpdate) => Promise<void>) {
  const controller = new AbortController();
  let seen = 0;
  const counting = (async (...args: Parameters<typeof fetch>) => {
    seen += 1;
    const res = await (fetchImpl as (...a: Parameters<typeof fetch>) => Promise<Response>)(...args);
    if (seen >= calls) controller.abort();
    return res;
  }) as unknown as typeof fetch;
  return runReceiver({
    token: 'T',
    onUpdate,
    signal: controller.signal,
    fetchImpl: counting,
    sleep: async () => {},
  });
}

describe('runReceiver', () => {
  it('deletes any webhook before polling', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return url.includes('deleteWebhook') ? jsonResponse(200, { ok: true }) : okUpdates([]);
    }) as unknown as typeof fetch;

    await runUntil(fetchImpl, 2, async () => {});
    expect(urls[0]).toContain('/deleteWebhook');
    expect(urls[1]).toContain('/getUpdates');
  });

  it('passes each update to onUpdate', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) =>
      url.includes('deleteWebhook')
        ? jsonResponse(200, { ok: true })
        : okUpdates([update(1, '/list'), update(2, '/status')])) as unknown as typeof fetch;

    await runUntil(fetchImpl, 2, async (u) => { seen.push(u.message?.text ?? ''); });
    expect(seen).toEqual(['/list', '/status']);
  });

  it('advances the offset past the highest handled update_id', async () => {
    const urls: string[] = [];
    let poll = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes('deleteWebhook')) return jsonResponse(200, { ok: true });
      urls.push(url);
      poll += 1;
      return okUpdates(poll === 1 ? [update(7, '/list')] : []);
    }) as unknown as typeof fetch;

    await runUntil(fetchImpl, 3, async () => {});
    expect(urls[0]).toContain('offset=0');
    expect(urls[1]).toContain('offset=8');
  });

  it('still advances the offset when a handler throws, so one bad update cannot replay forever', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      if (url.includes('deleteWebhook')) return jsonResponse(200, { ok: true });
      urls.push(url);
      return okUpdates([update(7, '/boom')]);
    }) as unknown as typeof fetch;

    await runUntil(fetchImpl, 3, async () => { throw new Error('handler exploded'); });
    expect(urls[1]).toContain('offset=8');
  });

  it('retries after a network error instead of exiting', async () => {
    let poll = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes('deleteWebhook')) return jsonResponse(200, { ok: true });
      poll += 1;
      if (poll === 1) throw new Error('ECONNRESET');
      return okUpdates([]);
    }) as unknown as typeof fetch;

    await expect(runUntil(fetchImpl, 3, async () => {})).resolves.toBeUndefined();
    expect(poll).toBeGreaterThanOrEqual(2);
  });

  it('calls deleteWebhook again on 409 Conflict', async () => {
    const urls: string[] = [];
    let poll = 0;
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.includes('deleteWebhook')) return jsonResponse(200, { ok: true });
      poll += 1;
      return poll === 1 ? jsonResponse(409, { ok: false }) : okUpdates([]);
    }) as unknown as typeof fetch;

    await runUntil(fetchImpl, 4, async () => {});
    expect(urls.filter((u) => u.includes('deleteWebhook')).length).toBeGreaterThanOrEqual(2);
  });

  it('backs off between repeated 409 conflicts instead of spinning', async () => {
    const sleepDurations: number[] = [];
    const fetchImpl = (async (url: string) => {
      if (url.includes('deleteWebhook')) return jsonResponse(200, { ok: true });
      return jsonResponse(409, { ok: false });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    let seen = 0;
    const counting = (async (...args: Parameters<typeof fetch>) => {
      seen += 1;
      const res = await (fetchImpl as (...a: Parameters<typeof fetch>) => Promise<Response>)(...args);
      if (seen >= 6) controller.abort();
      return res;
    }) as unknown as typeof fetch;

    await runReceiver({
      token: 'T',
      onUpdate: async () => {},
      signal: controller.signal,
      fetchImpl: counting,
      sleep: async (ms) => { sleepDurations.push(ms); },
    });

    expect(sleepDurations.length).toBeGreaterThan(0);
    expect(sleepDurations.every((ms) => ms > 0)).toBe(true);
  });

  it('ignores a non-array result instead of crashing the receiver', async () => {
    const fetchImpl = (async (url: string) =>
      url.includes('deleteWebhook')
        ? jsonResponse(200, { ok: true })
        : jsonResponse(200, { ok: true, result: 42 })) as unknown as typeof fetch;

    await expect(runUntil(fetchImpl, 3, async () => {})).resolves.toBeUndefined();
  });

  it('skips an update missing update_id without corrupting the offset', async () => {
    const urls: string[] = [];
    let poll = 0;
    const fetchImpl = (async (url: string) => {
      if (url.includes('deleteWebhook')) return jsonResponse(200, { ok: true });
      urls.push(url);
      poll += 1;
      if (poll === 1) {
        return jsonResponse(200, {
          ok: true,
          result: [{ message: { message_id: 1, chat: { id: 1 }, text: 'no id' } }, update(7, '/list')],
        });
      }
      return okUpdates([]);
    }) as unknown as typeof fetch;

    await runUntil(fetchImpl, 3, async () => {});
    expect(urls[0]).toContain('offset=0');
    expect(urls[1]).toContain('offset=8');
    expect(urls[1]).not.toContain('NaN');
  });

  it('throws FatalTelegramError on 401 rather than retrying forever', async () => {
    const fetchImpl = (async (url: string) =>
      url.includes('deleteWebhook')
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, { ok: false, description: 'Unauthorized' })) as unknown as typeof fetch;

    const controller = new AbortController();
    await expect(
      runReceiver({
        token: 'T', onUpdate: async () => {}, signal: controller.signal,
        fetchImpl, sleep: async () => {},
      })
    ).rejects.toBeInstanceOf(FatalTelegramError);
  });

  it('resolves promptly when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => okUpdates([]));
    await runReceiver({
      token: 'T', onUpdate: async () => {}, signal: controller.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {},
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('redacts the bot token from a logged network-error message', async () => {
    // A realistic long, high-entropy token, not the single-character 'T'
    // used elsewhere — a short token could pass this assertion by
    // accidentally over-redacting unrelated text rather than because
    // redaction actually ran.
    const REALISTIC_TOKEN = '123456789:AAHExampleFakeRealisticBotTokenValue1234';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let poll = 0;
      const fetchImpl = (async (url: string) => {
        if (url.includes('deleteWebhook')) return jsonResponse(200, { ok: true });
        poll += 1;
        if (poll === 1) {
          // The classic real-world leak: a token with stray whitespace (e.g.
          // a trailing newline from an env var) makes undici's fetch throw
          // a TypeError whose message embeds the full request URL,
          // including the token.
          throw new Error(
            `Failed to parse URL from https://api.telegram.org/bot${REALISTIC_TOKEN}/getUpdates`
          );
        }
        return okUpdates([]);
      }) as unknown as typeof fetch;

      const controller = new AbortController();
      let seen = 0;
      const counting = (async (...args: Parameters<typeof fetch>) => {
        seen += 1;
        const res = await (fetchImpl as (...a: Parameters<typeof fetch>) => Promise<Response>)(...args);
        if (seen >= 3) controller.abort();
        return res;
      }) as unknown as typeof fetch;

      await runReceiver({
        token: REALISTIC_TOKEN,
        onUpdate: async () => {},
        signal: controller.signal,
        fetchImpl: counting,
        sleep: async () => {},
      });

      // The network-error branch must actually have logged something —
      // otherwise this test would prove nothing, the same way the old spy
      // loop over an empty 401 call list proved nothing.
      expect(errorSpy.mock.calls.length).toBeGreaterThan(0);

      const loggedText = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(loggedText).not.toContain(REALISTIC_TOKEN);
      expect(loggedText).toContain('***');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('never puts the bot token in a thrown error message or a logged line', async () => {
    const fetchImpl = (async (url: string) =>
      url.includes('deleteWebhook')
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, { ok: false })) as unknown as typeof fetch;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const controller = new AbortController();
      let caught: unknown;
      try {
        await runReceiver({
          token: 'SUPERSECRETTOKEN', onUpdate: async () => {}, signal: controller.signal,
          fetchImpl, sleep: async () => {},
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(FatalTelegramError);
      expect((caught as Error).message).not.toContain('SUPERSECRETTOKEN');

      for (const call of errorSpy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain('SUPERSECRETTOKEN');
        }
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});
