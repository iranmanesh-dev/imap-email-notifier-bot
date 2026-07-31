import { describe, it, expect, vi } from 'vitest';
import { TelegramSender } from '../src/telegram/sender.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeSender(fetchImpl: typeof fetch, overrides = {}) {
  return new TelegramSender({
    token: 'T',
    chatId: '42',
    fetchImpl,
    sleep: async () => {},
    minIntervalMs: 0,
    ...overrides,
  });
}

describe('TelegramSender', () => {
  it('posts to the sendMessage endpoint with HTML parse mode', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    await sender.send('<b>hi</b>');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botT/sendMessage');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ chat_id: '42', text: '<b>hi</b>', parse_mode: 'HTML' });
  });

  it('reports success', async () => {
    const sender = makeSender((async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch);
    expect(await sender.send('hi')).toBe('sent');
  });

  it('honours retry_after on 429 and then succeeds', async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(429, { ok: false, parameters: { retry_after: 7 } });
      return jsonResponse(200, { ok: true });
    });
    const sender = makeSender(fetchMock as unknown as typeof fetch, {
      sleep: async (ms: number) => { slept.push(ms); },
    });

    expect(await sender.send('hi')).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(slept).toContain(7000);
  });

  it('retries 5xx with backoff and then succeeds', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call < 3) return jsonResponse(502, { ok: false });
      return jsonResponse(200, { ok: true });
    });
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    expect(await sender.send('hi')).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('drops after exhausting attempts on persistent 5xx', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { ok: false }));
    const sender = makeSender(fetchMock as unknown as typeof fetch, { maxAttempts: 3 });

    expect(await sender.send('hi')).toBe('dropped');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a 400 once as plain text with no parse_mode', async () => {
    const calls: RequestInit[] = [];
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      call += 1;
      if (call === 1) return jsonResponse(400, { ok: false, description: "can't parse entities" });
      return jsonResponse(200, { ok: true });
    });
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    expect(await sender.send('<b>broken')).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const second = JSON.parse(calls[1]!.body as string);
    expect(second.parse_mode).toBeUndefined();
    expect(second.text).toContain('broken');
    expect(second.text).not.toContain('<b>');
  });

  it('drops when the plain-text retry also fails', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { ok: false }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    expect(await sender.send('<b>broken')).toBe('dropped');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('performs the mandatory 400 plain-text retry even when maxAttempts is 1', async () => {
    const calls: RequestInit[] = [];
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init);
      call += 1;
      if (call === 1) return jsonResponse(400, { ok: false, description: "can't parse entities" });
      return jsonResponse(200, { ok: true });
    });
    const sender = makeSender(fetchMock as unknown as typeof fetch, { maxAttempts: 1 });

    expect(await sender.send('<b>broken')).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const second = JSON.parse(calls[1]!.body as string);
    expect(second.parse_mode).toBeUndefined();
  });

  it('drops immediately on 401 without retrying', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { ok: false, description: 'Unauthorized' }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    expect(await sender.send('hi')).toBe('dropped');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops immediately on 403 without retrying', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(403, { ok: false, description: 'Forbidden' }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    expect(await sender.send('hi')).toBe('dropped');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent sends in order', async () => {
    const order: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      order.push(body.text);
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse(200, { ok: true });
    });
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    await Promise.all([sender.send('one'), sender.send('two'), sender.send('three')]);
    expect(order).toEqual(['one', 'two', 'three']);
  });

  it('does not throttle the first send', async () => {
    const slept: number[] = [];
    const sender = makeSender(
      (async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch,
      { minIntervalMs: 1000, sleep: async (ms: number) => { slept.push(ms); } }
    );

    await sender.send('one');
    expect(slept).toHaveLength(0);
  });

  it('throttles the second send to approximately minIntervalMs', async () => {
    const slept: number[] = [];
    const sender = makeSender(
      (async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch,
      { minIntervalMs: 1000, sleep: async (ms: number) => { slept.push(ms); } }
    );

    await sender.send('one');
    await sender.send('two');

    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(900);
    expect(slept[0]).toBeLessThanOrEqual(1000);
  });

  it('does not throttle when minIntervalMs has already elapsed', async () => {
    const slept: number[] = [];
    const sender = makeSender(
      (async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch,
      { minIntervalMs: 10, sleep: async (ms: number) => { slept.push(ms); } }
    );

    await sender.send('one');
    await new Promise((r) => setTimeout(r, 20));
    await sender.send('two');

    expect(slept).toHaveLength(0);
  });

  it('disables throttling entirely when minIntervalMs is 0', async () => {
    const slept: number[] = [];
    const sender = makeSender(
      (async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch,
      { minIntervalMs: 0, sleep: async (ms: number) => { slept.push(ms); } }
    );

    await sender.send('one');
    await sender.send('two');
    await sender.send('three');

    expect(slept).toHaveLength(0);
  });

  it('drops on a network error after exhausting attempts', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const sender = makeSender(fetchMock as unknown as typeof fetch, { maxAttempts: 2 });

    expect(await sender.send('hi')).toBe('dropped');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('deleteMessage', () => {
  it('posts to deleteMessage and reports success', async () => {
    const calls: string[] = [];
    const bodies: RequestInit[] = [];
    const sender = makeSender((async (url: string, init: RequestInit) => {
      calls.push(url);
      bodies.push(init);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch);

    expect(await sender.deleteMessage('42', 7)).toBe(true);
    expect(calls[0]).toContain('/deleteMessage');
    expect(calls[0]).not.toContain('/sendMessage');
    // Asserting the full parsed body (not just the URL) so that transposing
    // chat_id and message_id — which would silently fail to delete the
    // operator's typed password — cannot pass this test.
    expect(JSON.parse(bodies[0]!.body as string)).toEqual({ chat_id: '42', message_id: 7 });
  });

  it('reports false rather than throwing when Telegram refuses', async () => {
    const sender = makeSender(
      (async () => jsonResponse(400, { ok: false })) as unknown as typeof fetch
    );
    expect(await sender.deleteMessage('42', 7)).toBe(false);
  });

  it('reports false rather than throwing on a network error', async () => {
    const sender = makeSender((async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch);
    expect(await sender.deleteMessage('42', 7)).toBe(false);
  });
});

describe('keyboards and callbacks', () => {
  it('includes reply_markup when a keyboard is passed to send', async () => {
    const calls: RequestInit[] = [];
    const sender = makeSender((async (_u: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch);

    await sender.send('<b>hi</b>', [[{ text: 'Add', callback_data: 'a' }]]);

    const body = JSON.parse(calls[0]!.body as string);
    expect(body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Add', callback_data: 'a' }]] });
  });

  it('omits reply_markup entirely when no keyboard is passed', async () => {
    const calls: RequestInit[] = [];
    const sender = makeSender((async (_u: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch);

    await sender.send('<b>hi</b>');

    expect(JSON.parse(calls[0]!.body as string)).not.toHaveProperty('reply_markup');
  });

  it('answerCallbackQuery posts the id and reports success', async () => {
    const calls: [string, RequestInit][] = [];
    const sender = makeSender((async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch);

    expect(await sender.answerCallbackQuery('cbq-1', 'done')).toBe(true);
    expect(calls[0]![0]).toContain('/answerCallbackQuery');
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({
      callback_query_id: 'cbq-1',
      text: 'done',
    });
  });

  it('answerCallbackQuery omits text when not supplied', async () => {
    const calls: RequestInit[] = [];
    const sender = makeSender((async (_u: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch);

    await sender.answerCallbackQuery('cbq-1');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ callback_query_id: 'cbq-1' });
  });

  it('answerCallbackQuery reports false rather than throwing on a network error', async () => {
    const sender = makeSender((async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch);
    expect(await sender.answerCallbackQuery('cbq-1')).toBe(false);
  });

  it('editMessageText posts chat, message id, HTML and keyboard', async () => {
    const calls: [string, RequestInit][] = [];
    const sender = makeSender((async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch);

    const ok = await sender.editMessageText('42', 7, '<b>x</b>', [[{ text: 'B', callback_data: 'b' }]]);

    expect(ok).toBe(true);
    expect(calls[0]![0]).toContain('/editMessageText');
    const body = JSON.parse(calls[0]![1].body as string);
    expect(body).toMatchObject({
      chat_id: '42',
      message_id: 7,
      text: '<b>x</b>',
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: 'B', callback_data: 'b' }]] },
    });
  });

  it('editMessageText reports false when Telegram refuses (message too old)', async () => {
    const sender = makeSender(
      (async () => jsonResponse(400, { ok: false, description: 'message to edit not found' })) as unknown as typeof fetch
    );
    expect(await sender.editMessageText('42', 7, 'x')).toBe(false);
  });

  it('editMessageText reports false rather than throwing on a network error', async () => {
    const sender = makeSender((async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch);
    expect(await sender.editMessageText('42', 7, 'x')).toBe(false);
  });

  it('never puts the bot token in a returned value', async () => {
    const sender = new TelegramSender({
      token: 'SECRETTOKEN', chatId: '42',
      fetchImpl: (async () => { throw new Error('boom'); }) as unknown as typeof fetch,
      sleep: async () => {}, minIntervalMs: 0,
    });
    expect(String(await sender.answerCallbackQuery('x'))).not.toContain('SECRETTOKEN');
    expect(String(await sender.editMessageText('42', 1, 'x'))).not.toContain('SECRETTOKEN');
  });
});
