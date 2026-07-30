import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WatcherState } from './imap/watcher.js';

export type HealthReport = {
  status: 'ok' | 'degraded';
  accounts: { label: string; state: WatcherState }[];
};

/**
 * Healthy states are listed explicitly and everything else is degraded —
 * still deliberately "deny by default", so a new terminal state added to
 * WatcherState (as 'connect-failed' once was) counts as degraded without
 * anyone having to remember to update this.
 *
 * 'starting' is healthy because it means initialising, not broken. The
 * registry now reports mailboxes whose add is still in flight (so a mailbox
 * stuck in a long reconnect is visible to /status and to shutdown), and a
 * container that has just booted with several mailboxes still connecting
 * must not report itself degraded for the whole startup window. This does
 * not hide a real failure: the first failed attempt moves the watcher to
 * 'reconnecting', and exhausting the cap moves it to 'connect-failed' —
 * both degraded.
 *
 * Zero watchers is the normal state of a fresh install: mailboxes are
 * added at runtime via Telegram, so an empty set is idle, not unhealthy.
 */
const HEALTHY_STATES: ReadonlySet<WatcherState> = new Set<WatcherState>(['ok', 'starting']);

export function buildHealthReport(
  watchers: { label: string; state: WatcherState }[]
): HealthReport {
  const healthy = watchers.every((w) => HEALTHY_STATES.has(w.state));
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
