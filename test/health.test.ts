import { describe, it, expect, vi } from 'vitest';
import { buildHealthReport, startHealthServer } from '../src/health.js';
import { createEmailHandler } from '../src/index.js';
import type { NormalizedEmail } from '../src/types.js';
import type { SendOutcome } from '../src/telegram/sender.js';

describe('buildHealthReport', () => {
  it('reports ok when every account is ok', () => {
    const report = buildHealthReport([{ label: 'Work', state: 'ok' }]);
    expect(report.status).toBe('ok');
    expect(report.accounts).toEqual([{ label: 'Work', state: 'ok' }]);
  });

  it('reports degraded when any account is reconnecting', () => {
    const report = buildHealthReport([
      { label: 'Work', state: 'ok' },
      { label: 'Personal', state: 'reconnecting' },
    ]);
    expect(report.status).toBe('degraded');
  });

  it('reports degraded when an account has failed authentication', () => {
    expect(buildHealthReport([{ label: 'Work', state: 'auth-failed' }]).status).toBe('degraded');
  });

  it('reports degraded when an account gave up after exhausting the connection-retry cap', () => {
    expect(buildHealthReport([{ label: 'Work', state: 'connect-failed' }]).status).toBe('degraded');
  });

  it('reports degraded with no accounts at all', () => {
    expect(buildHealthReport([]).status).toBe('degraded');
  });
});

describe('startHealthServer', () => {
  it('serves the report as JSON on /healthz', async () => {
    const server = startHealthServer(0, () => buildHealthReport([{ label: 'Work', state: 'ok' }]));
    const port = server.port;

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });

    await server.close();
  });

  it('returns 503 when degraded so Coolify restarts the container', async () => {
    const server = startHealthServer(0, () => buildHealthReport([{ label: 'Work', state: 'auth-failed' }]));
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(503);
    await server.close();
  });

  it('returns 404 for other paths', async () => {
    const server = startHealthServer(0, () => buildHealthReport([{ label: 'Work', state: 'ok' }]));
    const res = await fetch(`http://127.0.0.1:${server.port}/other`);
    expect(res.status).toBe(404);
    await server.close();
  });
});

describe('createEmailHandler', () => {
  const email: NormalizedEmail = {
    messageId: '<abc@example.com>',
    accountLabel: 'Work',
    folder: 'INBOX',
    from: 'alice@example.com',
    subject: 'Hello there',
    preview: 'this is the body and must never be logged',
    date: new Date('2026-01-01T00:00:00Z'),
  };

  it('resolves and logs quietly when the send succeeds', async () => {
    const sender = { send: vi.fn(async (): Promise<SendOutcome> => 'sent') };
    const logger = { log: vi.fn(), error: vi.fn() };

    const handler = createEmailHandler(sender, logger);
    await expect(handler(email)).resolves.toBeUndefined();

    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('does NOT throw when the sender reports a dropped outcome, and logs it clearly without the body', async () => {
    const sender = { send: vi.fn(async (): Promise<SendOutcome> => 'dropped') };
    const logger = { log: vi.fn(), error: vi.fn() };

    const handler = createEmailHandler(sender, logger);
    await expect(handler(email)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const loggedMessage = logger.error.mock.calls[0]?.[0] as string;
    expect(loggedMessage).toContain('Work');
    expect(loggedMessage).toContain('INBOX');
    expect(loggedMessage).toContain('Hello there');
    expect(loggedMessage).not.toContain(email.preview);
  });

  it('never rejects even when the sender throws unexpectedly (formatting bug, OOM, etc.)', async () => {
    const sender = {
      send: vi.fn(async (): Promise<SendOutcome> => {
        throw new Error('unexpected boom');
      }),
    };
    const logger = { log: vi.fn(), error: vi.fn() };

    const handler = createEmailHandler(sender, logger);
    await expect(handler(email)).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const loggedMessage = logger.error.mock.calls[0]?.[0] as string;
    expect(loggedMessage).toContain('Work');
    expect(loggedMessage).toContain('unexpected boom');
  });

  it('never rejects even when formatEmail-equivalent throw happens synchronously inside send', async () => {
    const sender = {
      send: vi.fn((): Promise<SendOutcome> => {
        throw new Error('synchronous throw, not even a rejected promise');
      }),
    };
    const logger = { log: vi.fn(), error: vi.fn() };

    const handler = createEmailHandler(sender, logger);
    await expect(handler(email)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
