import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { CommentStore } from './store.js';

/**
 * The session's HTTP API: what the CLI talks to while the browser is open.
 * Later commands (submit, wait, approve) are routes added here.
 *
 * Every route wants the token from the state file. The server binds loopback
 * only, but any page open in any browser on the machine can reach loopback,
 * and one that guessed the port must not be able to read or steer the review.
 */

export interface SessionApi {
  token: string;
  store: CommentStore;
  /** Where the window is now, for `gloss status`. */
  currentUrl: () => string | null;
  navigate: (url: string) => Promise<void>;
  /** Called once the answer has gone out, so the caller hears it worked before the process ends. */
  close: () => void;
}

const navigateBody = z.object({ url: z.url({ protocol: /^https?$/ }) });

export function createApp(session: SessionApi): Hono {
  const app = new Hono();

  app.use('/api/*', bearerAuth({ token: session.token }));

  app.get('/api/health', (c) => c.json({ ok: true, pid: process.pid, url: session.currentUrl() }));

  app.get('/api/state', (c) => c.json(session.store.snapshot()));

  app.post('/api/navigate', async (c) => {
    const parsed = navigateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'navigate needs an http or https url' }, 400);
    try {
      await session.navigate(parsed.data.url);
    } catch (e) {
      return c.json({ error: `could not open ${parsed.data.url}: ${firstLine(e)}` }, 502);
    }
    return c.json({ ok: true, url: parsed.data.url });
  });

  app.post('/api/close', (c) => {
    setImmediate(session.close);
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: `no such route: ${c.req.method} ${c.req.path}` }, 404));

  return app;
}

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
        // Keep-alive sockets from the CLI's fetch would hold `close` open.
        (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      }),
  };
}

/** Playwright errors carry a whole essay; the first line is the useful part. */
export function firstLine(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.split('\n')[0] ?? text;
}
