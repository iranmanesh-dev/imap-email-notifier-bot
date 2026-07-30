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

  it('never puts the bot token in a thrown error message', async () => {
    const fetchImpl = (async (url: string) =>
      url.includes('deleteWebhook')
        ? jsonResponse(200, { ok: true })
        : jsonResponse(401, { ok: false })) as unknown as typeof fetch;

    const controller = new AbortController();
    await expect(
      runReceiver({
        token: 'SUPERSECRETTOKEN', onUpdate: async () => {}, signal: controller.signal,
        fetchImpl, sleep: async () => {},
      })
    ).rejects.toThrow(expect.not.stringContaining('SUPERSECRETTOKEN') as unknown as string);
  });
});
