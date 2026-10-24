import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { z } from 'zod';
import type { CommentStore } from './store.js';
import { firstLine } from './util.js';
import type { AnyVerdict } from './verdict.js';

/**
 * The session's HTTP API: what the CLI talks to while the browser is open.
 * The agent's half of a round is here: waiting on the verdict, then saying it
 * is working and ready. The reviewer's half is the bar's, over the binding.
 *
 * Every route wants the token from the state file. The server binds loopback
 * only, but any page open in any browser on the machine can reach loopback,
 * and one that guessed the port must not be able to read or steer the review.
 *
 * Nothing here is Node's, so a host other than the CLI's session can serve
 * it: one with accounts of its own passes `auth` in place of the token, one
 * with no browser of its own leaves out what it cannot do, and one holding
 * many reviews passes `reviews` in place of `store`. docs/protocol.md is
 * this API for anyone writing a server or a client of their own.
 */

export interface SessionApi {
  /** What every route wants as a bearer token, unless `auth` checks requests instead. */
  token?: string;
  /** Checks each request in place of the token. */
  auth?: MiddlewareHandler;
  /** The one review, for a session that has one. */
  store?: CommentStore;
  /** In place of `store`, for a server holding many. */
  reviews?: Reviews;
  /** The `gloss wait`s being held open. */
  waits: Waits;
  /** Where the window is now, for `gloss status`. */
  currentUrl: () => string | null;
  /** More for `GET /api/health` to say, such as the pid the CLI checks it is talking to. */
  health?: () => Record<string, unknown>;
  /** Without it, `POST /api/navigate` answers 501. */
  navigate?: (url: string) => Promise<void>;
  /** Reloads every page, so the reviewer sees what the agent changed. Without it, `ready` reloads nothing. */
  reload?: () => Promise<void>;
  /** Called once the answer has gone out, so the caller hears it worked before the process ends. Without it, `POST /api/close` answers 501. */
  close?: () => void;
}

/**
 * A server's many reviews, each a store of its own. A request names its
 * review, as `?review=` or a body's `review`; a wait names none, and gets
 * the next verdict from any of them, as version 2, which says whose it is.
 * Who may see which review, and which verdict goes to which agent, is the
 * server's to decide: both get the request.
 */
export interface Reviews {
  /** The review's store, or null when there is none this request may see. */
  store(review: string, c: Context): CommentStore | null | Promise<CommentStore | null>;
  /** What this request's wait watches: version 2 verdicts, from whichever review has one. */
  inbox(c: Context): VerdictSource | Promise<VerdictSource>;
}

/** What a wait watches for a verdict: a store, or anything that hands one out the way a store does. */
export interface VerdictSource {
  verdict(): AnyVerdict | null;
  /** Calls `listener` after every change, until the function it returns is called. */
  onChange(listener: () => void): () => void;
}

/**
 * The longest one `GET /api/verdict` is held, in seconds. `gloss wait` asks
 * again and again rather than once for as long as it takes: Node's fetch gives
 * up on a response that has not started after 300 seconds, and between asks
 * it checks the session is still there.
 */
export const MAX_WAIT_SECONDS = 30;

export type WaitOutcome = { verdict: AnyVerdict } | { pending: true } | { ended: string };

/**
 * The waits on a verdict that are open now. A session that is stopping ends
 * them with its reason, so `gloss wait` can say why there is no verdict
 * rather than finding the connection cut.
 */
export class Waits {
  private open = new Set<(outcome: WaitOutcome) => void>();
  private endedWith: string | null = null;

  /** The verdict as soon as there is one, or pending once `ms` have passed or the caller has gone. */
  next(store: VerdictSource, ms: number, signal?: AbortSignal): Promise<WaitOutcome> {
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

const review = z.string().min(1).max(200).optional();
const navigateBody = z.object({ url: z.url({ protocol: /^https?$/ }) });
const workingBody = z.object({ message: z.string().max(2_000).nullish(), review });
const readyBody = z.object({ summary: z.string().max(20_000).nullish(), review });
const liveBody = z.object({ live: z.boolean(), review });

export function createApp(session: SessionApi): Hono {
  const auth = session.auth ?? (session.token ? bearerAuth({ token: session.token }) : null);
  if (!auth) throw new Error('the session API needs a token or an auth check');
  const { store: single, reviews } = session;
  if (!single === !reviews) throw new Error('the session API needs a store or reviews, and not both');
  const app = new Hono();

  /** The store a request is about, or the answer that says why there is none. */
  const storeFor = async (c: Context, id: string | undefined): Promise<CommentStore | Response> => {
    if (single) return single;
    if (!id) return c.json({ error: 'this server holds many reviews: say which, as `review`' }, 400);
    return (await reviews!.store(id, c)) ?? c.json({ error: `no such review: ${id}` }, 404);
  };

  app.use('/api/*', auth);

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      ...session.health?.(),
      url: session.currentUrl(),
      capabilities: {
        navigate: !!session.navigate,
        reload: !!session.reload,
        close: !!session.close,
        reviews: !!reviews,
      },
    }),
  );

  app.get('/api/state', async (c) => {
    const store = await storeFor(c, c.req.query('review'));
    if (store instanceof Response) return store;
    return c.json(store.snapshot());
  });

  app.post('/api/navigate', async (c) => {
    const parsed = navigateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'navigate needs an http or https url' }, 400);
    if (!session.navigate) return c.json({ error: 'this session has no window to navigate' }, 501);
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
  // With many reviews, one being worked on holds up no other, so a wait is
  // refused only by what the server's inbox decides.
  app.get('/api/verdict', async (c) => {
    if (single?.snapshot().phase === 'working') {
      return c.json({ error: 'the agent is marked working, so the reviewer cannot submit: run `gloss ready` first' }, 409);
    }
    const source = single ?? (await reviews!.inbox(c));
    const seconds = Math.min(Math.max(Number(c.req.query('wait')) || 0, 0), MAX_WAIT_SECONDS);
    const outcome = await session.waits.next(source, seconds * 1000, c.req.raw.signal);
    if ('ended' in outcome) return c.json({ error: outcome.ended }, 410);
    return c.json('verdict' in outcome ? outcome.verdict : outcome);
  });

  app.post('/api/working', async (c) => {
    const parsed = workingBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'working takes a message of up to 2000 characters' }, 400);
    const store = await storeFor(c, parsed.data.review);
    if (store instanceof Response) return store;
    try {
      store.working(parsed.data.message ?? null);
    } catch (e) {
      return c.json({ error: firstLine(e) }, 409);
    }
    return c.json({ ok: true, phase: store.snapshot().phase });
  });

  // The summary is in the store before the reload, so the bar that mounts
  // on the reloaded page shows it. With no pages to reload, the reviewer
  // sees it the next time they open one, and `reloaded` says so.
  app.post('/api/ready', async (c) => {
    const parsed = readyBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'ready takes a summary of up to 20000 characters' }, 400);
    const store = await storeFor(c, parsed.data.review);
    if (store instanceof Response) return store;
    try {
      store.ready(parsed.data.summary ?? null);
    } catch (e) {
      return c.json({ error: firstLine(e) }, 409);
    }
    await session.reload?.();
    return c.json({ ok: true, phase: store.snapshot().phase, reloaded: !!session.reload });
  });

  // `gloss open --live` against a session already running: argv cannot be
  // changed after the fact, so it reaches the same `setLive` the bar's own
  // toggle calls, over HTTP instead of the RPC binding.
  app.post('/api/live', async (c) => {
    const parsed = liveBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'live takes a boolean `live`' }, 400);
    const store = await storeFor(c, parsed.data.review);
    if (store instanceof Response) return store;
    try {
      store.setLive(parsed.data.live);
    } catch (e) {
      return c.json({ error: firstLine(e) }, 409);
    }
    return c.json({ ok: true, live: store.snapshot().live });
  });

  app.post('/api/close', (c) => {
    const { close } = session;
    if (!close) return c.json({ error: 'this session cannot be closed from here' }, 501);
    setTimeout(close, 0);
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: `no such route: ${c.req.method} ${c.req.path}` }, 404));

  return app;
}
