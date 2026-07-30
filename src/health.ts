import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WatcherState } from './imap/watcher.js';

export type HealthReport = {
  status: 'ok' | 'degraded';
  accounts: { label: string; state: WatcherState }[];
};

/**
 * Any state other than 'ok' is treated as degraded. This is deliberately
 * generic rather than an allowlist of specific bad states: it also covers
 * 'connect-failed' (the terminal state after exhausting the bounded
 * reconnect cap) without needing to be updated every time a new terminal
 * state is added to WatcherState.
 *
 * Zero watchers is the normal state of a fresh install: mailboxes are
 * added at runtime via Telegram, so an empty set is idle, not unhealthy.
 */
export function buildHealthReport(
  watchers: { label: string; state: WatcherState }[]
): HealthReport {
  const healthy = watchers.every((w) => w.state === 'ok');
  return {
    status: healthy ? 'ok' : 'degraded',
    accounts: watchers.map((w) => ({ label: w.label, state: w.state })),
  };
}

export function startHealthServer(
  port: number,
  report: () => HealthReport,
  exit: (code: number) => void = (code) => process.exit(code)
): { port: number; ready: Promise<void>; close(): Promise<void> } {
  const server: Server = createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const body = report();
    res.writeHead(body.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  // Without this, a bind failure (EADDRINUSE is the realistic case -- two
  // containers/processes racing for the same port) becomes an uncaught
  // exception on a zero-listener EventEmitter, well after main() has
  // returned. That kills the whole process with a raw stack trace instead
  // of a clean, loggable fatal exit. Same class of bug as the unguarded
  // IMAP client 'error' listeners.
  server.on('error', (err: Error) => {
    console.error(`[health] failed to listen on port ${port}: ${err.message}`);
    exit(1);
  });

  /**
   * Settles when the socket is genuinely bound (or when the bind fails).
   * `listen()` is asynchronous, so the mere fact that this function has
   * returned does NOT mean /healthz answers yet. Boot awaits this before it
   * starts anything slow, which is what makes "the health port is bound
   * before the first watcher connects" a property the caller can rely on
   * rather than a race it happens to win most of the time.
   */
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (err: Error) => reject(err));
  });
  // Mark `ready` as handled up front: callers that do not care about the
  // bind result (several tests, and any future call site) must not turn a
  // bind failure into an unhandled rejection that crashes the process.
  ready.catch(() => undefined);

  server.listen(port);

  return {
    get port(): number {
      return (server.address() as AddressInfo).port;
    },
    ready,
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
