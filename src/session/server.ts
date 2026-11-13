import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import type { AddressInfo } from 'node:net';

export { createApp, MAX_WAIT_SECONDS, Waits, type SessionApi, type WaitOutcome } from '#core/server.js';

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

/** On a port the OS picks, on loopback and nothing else. */
export async function startServer(app: Hono): Promise<RunningServer> {
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // Keep-alive sockets from the CLI's fetch would hold `close` open. One
        // still writing an answer, such as a wait being told the session is
        // ending, gets a moment to finish first.
        const sockets = server as { closeIdleConnections?: () => void; closeAllConnections?: () => void };
        sockets.closeIdleConnections?.();
        setTimeout(() => sockets.closeAllConnections?.(), CLOSE_GRACE_MS).unref();
      }),
  };
}

const CLOSE_GRACE_MS = 250;
