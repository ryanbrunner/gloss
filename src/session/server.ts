import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import type { Verdict } from '../verdict.js';
import type { CommentStore } from './store.js';

/**
 * The session's HTTP API: what the CLI talks to while the browser is open.
 * The agent's half of a round is here: waiting on the verdict, then saying it
 * is working and ready. The reviewer's half is the bar's, over the binding.
 *
 * Every route wants the token from the state file. The server binds loopback
 * only, but any page open in any browser on the machine can reach loopback,
 * and one that guessed the port must not be able to read or steer the review.
 */

export interface SessionApi {
  token: string;
  store: CommentStore;
  /** The `gloss wait`s being held open. */
  waits: Waits;
  /** Where the window is now, for `gloss status`. */
  currentUrl: () => string | null;
  navigate: (url: string) => Promise<void>;
  /** Reloads every page, so the reviewer sees what the agent changed. */
  reload: () => Promise<void>;
  /** Called once the answer has gone out, so the caller hears it worked before the process ends. */
  close: () => void;
}

/**
 * The longest one `GET /api/verdict` is held, in seconds. `gloss wait` asks
 * again and again rather than once for as long as it takes: Node's fetch gives
 * up on a response that has not started after 300 seconds, and between asks
 * it checks the session is still there.
 */
export const MAX_WAIT_SECONDS = 30;

export type WaitOutcome = { verdict: Verdict } | { pending: true } | { ended: string };

/**
 * The waits on a verdict that are open now. A session that is stopping ends
 * them with its reason, so `gloss wait` can say why there is no verdict
 * rather than finding the connection cut.
 */
export class Waits {
  private open = new Set<(outcome: WaitOutcome) => void>();
  private endedWith: string | null = null;

  /** The verdict as soon as there is one, or pending once `ms` have passed or the caller has gone. */
  next(store: CommentStore, ms: number, signal?: AbortSignal): Promise<WaitOutcome> {
    if (this.endedWith !== null) return Promise.resolve({ ended: this.endedWith });
    const now = store.verdict();
    if (now) return Promise.resolve({ verdict: now });
    if (ms <= 0) return Promise.resolve({ pending: true });
    return new Promise((resolve) => {
      const finish = (outcome: WaitOutcome) => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', gone);
        this.open.delete(finish);
        resolve(outcome);
      };
      const gone = () => finish({ pending: true });
      const timer = setTimeout(gone, ms);
      const unsubscribe = store.onChange(() => {
        const verdict = store.verdict();
        if (verdict) finish({ verdict });
      });
      signal?.addEventListener('abort', gone, { once: true });
      this.open.add(finish);
    });
  }

  /** Answers every open wait, and every later one, with why the session is ending. */
  end(reason: string): void {
    this.endedWith = reason;
    for (const finish of [...this.open]) finish({ ended: reason });
  }
}

const navigateBody = z.object({ url: z.url({ protocol: /^https?$/ }) });
const workingBody = z.object({ message: z.string().max(2_000).nullish() });
const readyBody = z.object({ summary: z.string().max(20_000).nullish() });

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

  // The verdict of the round submitted or approved, held until there is one
  // or `wait` seconds pass. Asked again before the agent moves, it is the same
  // verdict: a connection lost on the way loses no round.
  app.get('/api/verdict', async (c) => {
    if (session.store.snapshot().phase === 'working') {
      return c.json({ error: 'the agent is marked working, so the reviewer cannot submit: run `gloss ready` first' }, 409);
    }
    const seconds = Math.min(Math.max(Number(c.req.query('wait')) || 0, 0), MAX_WAIT_SECONDS);
    const outcome = await session.waits.next(session.store, seconds * 1000, c.req.raw.signal);
    if ('ended' in outcome) return c.json({ error: outcome.ended }, 410);
    return c.json('verdict' in outcome ? outcome.verdict : outcome);
  });

  app.post('/api/working', async (c) => {
    const parsed = workingBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'working takes a message of up to 2000 characters' }, 400);
    try {
      session.store.working(parsed.data.message ?? null);
    } catch (e) {
      return c.json({ error: firstLine(e) }, 409);
    }
    return c.json({ ok: true, phase: session.store.snapshot().phase });
  });

  // The summary is in the store before the reload, so the bar that mounts
  // on the reloaded page shows it.
  app.post('/api/ready', async (c) => {
    const parsed = readyBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'ready takes a summary of up to 20000 characters' }, 400);
    try {
      session.store.ready(parsed.data.summary ?? null);
    } catch (e) {
      return c.json({ error: firstLine(e) }, 409);
    }
    await session.reload();
    return c.json({ ok: true, phase: session.store.snapshot().phase });
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

/** Playwright errors carry a whole essay; the first line is the useful part. */
export function firstLine(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.split('\n')[0] ?? text;
}
