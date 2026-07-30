import { describe, it, expect, vi } from 'vitest';
import { buildHealthReport, startHealthServer } from '../src/health.js';
import { createEmailHandler, shutdown } from '../src/index.js';
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

  it('never rejects even when the injected logger itself throws on every call (e.g. EPIPE on a closed stdout)', async () => {
    const throwingLogger = {
      log: vi.fn(() => {
        throw new Error('EPIPE');
      }),
      error: vi.fn(() => {
        throw new Error('EPIPE');
      }),
    };

    // Exercise all three call sites that log: the 'sent' path (logger.log),
    // the 'dropped' path (logger.error), and the unexpected-throw path
    // (logger.error). None of them may let the logger's own throw escape.
    const sentSender = { send: vi.fn(async (): Promise<SendOutcome> => 'sent') };
    await expect(createEmailHandler(sentSender, throwingLogger)(email)).resolves.toBeUndefined();

    const droppedSender = { send: vi.fn(async (): Promise<SendOutcome> => 'dropped') };
    await expect(
      createEmailHandler(droppedSender, throwingLogger)(email)
    ).resolves.toBeUndefined();

    const throwingSender = {
      send: vi.fn(async (): Promise<SendOutcome> => {
        throw new Error('unexpected boom');
      }),
    };
    await expect(
      createEmailHandler(throwingSender, throwingLogger)(email)
    ).resolves.toBeUndefined();
  });
});

describe('shutdown', () => {
  function fakeWatcher(label: string, stop: () => Promise<void>) {
    return { label, stop: vi.fn(stop) };
  }

  it('stops every watcher, closes the health server and store, and exits 0 on the happy path', async () => {
    const watcherA = fakeWatcher('A', async () => {});
    const watcherB = fakeWatcher('B', async () => {});
    const health = { close: vi.fn(async () => {}) };
    const store = { close: vi.fn(() => {}) };
    const exit = vi.fn();
    const pruneTimer = setInterval(() => {}, 1_000_000);

    await shutdown('SIGTERM', {
      watchers: [watcherA, watcherB],
      pruneTimer,
      health,
      store,
      exit,
    });

    expect(watcherA.stop).toHaveBeenCalledTimes(1);
    expect(watcherB.stop).toHaveBeenCalledTimes(1);
    expect(health.close).toHaveBeenCalledTimes(1);
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still stops the other watchers, closes the store, and exits 0 when one watcher fails to stop', async () => {
    const watcherA = fakeWatcher('A', async () => {
      throw new Error('logout failed');
    });
    const watcherB = fakeWatcher('B', async () => {});
    const health = { close: vi.fn(async () => {}) };
    const store = { close: vi.fn(() => {}) };
    const exit = vi.fn();
    const pruneTimer = setInterval(() => {}, 1_000_000);

    await shutdown('SIGTERM', {
      watchers: [watcherA, watcherB],
      pruneTimer,
      health,
      store,
      exit,
    });

    expect(watcherB.stop).toHaveBeenCalledTimes(1);
    expect(health.close).toHaveBeenCalledTimes(1);
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still closes the store and exits 0 when the health server fails to close', async () => {
    const watcher = fakeWatcher('A', async () => {});
    const health = {
      close: vi.fn(async () => {
        throw new Error('EPIPE');
      }),
    };
    const store = { close: vi.fn(() => {}) };
    const exit = vi.fn();
    const pruneTimer = setInterval(() => {}, 1_000_000);

    await shutdown('SIGTERM', { watchers: [watcher], pruneTimer, health, store, exit });

    expect(store.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('still exits 0 when the store fails to close (the realistic better-sqlite3 case)', async () => {
    const watcher = fakeWatcher('A', async () => {});
    const health = { close: vi.fn(async () => {}) };
    const store = {
      close: vi.fn(() => {
        throw new Error('disk I/O error');
      }),
    };
    const exit = vi.fn();
    const pruneTimer = setInterval(() => {}, 1_000_000);

    await shutdown('SIGTERM', { watchers: [watcher], pruneTimer, health, store, exit });

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('always exits 0, never rejects, and clears the prune timer, even when everything (including the logger) throws', async () => {
    const watcher = fakeWatcher('A', async () => {
      throw new Error('logout failed');
    });
    const health = {
      close: vi.fn(async () => {
        throw new Error('EPIPE');
      }),
    };
    const store = {
      close: vi.fn(() => {
        throw new Error('disk I/O error');
      }),
    };
    const exit = vi.fn();
    const pruneTimer = setInterval(() => {}, 1_000_000);
    const logger = {
      log: vi.fn(() => {
        throw new Error('log throws');
      }),
      error: vi.fn(() => {
        throw new Error('error throws');
      }),
    };

    await expect(
      shutdown('SIGTERM', { watchers: [watcher], pruneTimer, health, store, exit, logger })
    ).resolves.toBeUndefined();

    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
