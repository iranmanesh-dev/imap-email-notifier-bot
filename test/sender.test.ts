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

  it('waits minIntervalMs between sends', async () => {
    const slept: number[] = [];
    const sender = makeSender(
      (async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch,
      { minIntervalMs: 1000, sleep: async (ms: number) => { slept.push(ms); } }
    );

    await sender.send('one');
    await sender.send('two');
    expect(slept.some((ms) => ms > 0)).toBe(true);
  });

  it('drops on a network error after exhausting attempts', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const sender = makeSender(fetchMock as unknown as typeof fetch, { maxAttempts: 2 });

    expect(await sender.send('hi')).toBe('dropped');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
