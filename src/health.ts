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
 */
export function buildHealthReport(
  watchers: { label: string; state: WatcherState }[]
): HealthReport {
  const healthy = watchers.length > 0 && watchers.every((w) => w.state === 'ok');
  return {
    status: healthy ? 'ok' : 'degraded',
    accounts: watchers.map((w) => ({ label: w.label, state: w.state })),
  };
}

export function startHealthServer(
  port: number,
  report: () => HealthReport
): { port: number; close(): Promise<void> } {
  const server: Server = createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    const body = report();
    res.writeHead(body.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  server.listen(port);

  return {
    get port(): number {
      return (server.address() as AddressInfo).port;
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
