import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createApp, Waits, type Reviews, type SessionApi, type VerdictSource } from './server.js';
import { CommentStore } from './store.js';
import { forReview, type AnyVerdict } from './verdict.js';

type TestSession = SessionApi & { store: CommentStore; navigated: string[]; closed: number; reloads: number; reloadSummary: (string | null)[] };

function session(values: Partial<SessionApi> = {}): TestSession {
  const s: TestSession = {
    token: 'secret',
    store: new CommentStore(),
    waits: new Waits(),
    currentUrl: () => 'http://127.0.0.1:4400/',
    health: () => ({ pid: process.pid }),
    navigated: [] as string[],
    closed: 0,
    reloads: 0,
    reloadSummary: [],
    navigate: async (url: string) => {
      s.navigated.push(url);
    },
    reload: async () => {
      s.reloads++;
      s.reloadSummary.push(s.store.snapshot().summary);
    },
    close: () => {
      s.closed++;
    },
    ...values,
  };
  return s;
}

const auth = { authorization: 'Bearer secret' };
const post = (app: ReturnType<typeof createApp>, path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const verdict = (app: ReturnType<typeof createApp>, wait = 0) =>
  app.request(`/api/verdict?wait=${wait}`, { headers: auth });

describe('the session API', () => {
  test('refuses a request without the token, or with the wrong one', async () => {
    const app = createApp(session());
    assert.equal((await app.request('/api/state')).status, 401);
    assert.equal((await app.request('/api/state', { headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await app.request('/api/close', { method: 'POST' })).status, 401);
  });

  test('answers the health check with its pid and where the window is', async () => {
    const res = await createApp(session()).request('/api/health', { headers: auth });
    assert.deepEqual(await res.json(), {
      ok: true,
      pid: process.pid,
      url: 'http://127.0.0.1:4400/',
      capabilities: { navigate: true, reload: true, close: true, reviews: false },
    });
  });

  test('reports the round and its comments', async () => {
    const s = session();
    s.store.add('The header is too tall');
    const body = (await (await createApp(s).request('/api/state', { headers: auth })).json()) as {
      round: number;
      comments: Array<{ body: string }>;
    };
    assert.equal(body.round, 1);
    assert.deepEqual(body.comments.map((c) => c.body), ['The header is too tall']);
  });

  test('navigates to an http url, and refuses anything else', async () => {
    const s = session();
    const app = createApp(s);
    const post = (body: unknown) =>
      app.request('/api/navigate', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ url: 'http://127.0.0.1:4400/?fixed' })).status, 200);
    assert.equal((await post({ url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await post({})).status, 400);
    assert.deepEqual(s.navigated, ['http://127.0.0.1:4400/?fixed']);
  });

  test('says a navigation failed rather than throwing', async () => {
    const app = createApp(session({ navigate: () => Promise.reject(new Error('net::ERR_CONNECTION_REFUSED\nat …')) }));
    const res = await app.request('/api/navigate', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1/' }),
    });
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as { error: string }).error, /ERR_CONNECTION_REFUSED$/);
  });

  test('answers close before closing', async () => {
    const s = session();
    const res = await createApp(s).request('/api/close', { method: 'POST', headers: auth });
    assert.equal(res.status, 200);
    assert.equal(s.closed, 0);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(s.closed, 1);
  });

  test('reports the phase, and each comment with the round it went out in', async () => {
    const s = session();
    s.store.add('one', 'http://127.0.0.1:4400/');
    s.store.submit('http://127.0.0.1:4400/');
    const body = (await (await createApp(s).request('/api/state', { headers: auth })).json()) as {
      round: number;
      phase: string;
      comments: Array<{ sentIn: number | null; page: string | null }>;
    };
    assert.equal(body.round, 2);
    assert.equal(body.phase, 'submitted');
    assert.deepEqual(body.comments.map((c) => [c.sentIn, c.page]), [[1, 'http://127.0.0.1:4400/']]);
  });
});

describe('the verdict route', () => {
  test('says pending when the reviewer has not submitted, and caps the wait', async () => {
    const res = await verdict(createApp(session()), 0);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { pending: true });
  });

  test('answers a held wait as soon as the reviewer submits', async () => {
    const s = session();
    const app = createApp(s);
    const started = Date.now();
    const answer = verdict(app, 5);
    setTimeout(() => {
      s.store.add('The header is too tall');
      s.store.submit('http://127.0.0.1:4400/');
    }, 50);
    const body = (await (await answer).json()) as { approved: boolean; round: number; comments: unknown[] };
    assert.ok(Date.now() - started < 2_000);
    assert.deepEqual([body.approved, body.round, body.comments.length], [false, 1, 1]);
  });

  test('gives the same verdict again until the agent moves', async () => {
    const s = session();
    const app = createApp(s);
    s.store.add('one');
    s.store.submit(null);
    const first = await (await verdict(app)).json();
    assert.deepEqual(await (await verdict(app)).json(), first);
    assert.equal((await post(app, '/api/working', { message: 'on it' })).status, 200);
    const refused = await verdict(app, 5);
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as { error: string }).error, /gloss ready/);
  });

  test('ends open waits, and later ones, with the reason the session is stopping', async () => {
    const s = session();
    const app = createApp(s);
    const held = verdict(app, 5);
    await new Promise((r) => setTimeout(r, 20));
    s.waits.end('the Gloss window was closed');
    const res = await held;
    assert.equal(res.status, 410);
    assert.deepEqual(await res.json(), { error: 'the Gloss window was closed' });
    assert.equal((await verdict(app, 5)).status, 410);
  });
});

describe('working and ready', () => {
  test('working takes the round from the reviewer, with a message', async () => {
    const s = session();
    const app = createApp(s);
    s.store.add('one');
    s.store.submit(null);
    const res = await post(app, '/api/working', { message: 'Fixing the header' });
    assert.deepEqual(await res.json(), { ok: true, phase: 'working' });
    assert.equal(s.store.snapshot().message, 'Fixing the header');
  });

  test('ready hands it back with the summary, then reloads the pages', async () => {
    const s = session();
    const app = createApp(s);
    s.store.add('one');
    s.store.submit(null);
    const res = await post(app, '/api/ready', { summary: 'Tightened the header' });
    assert.deepEqual(await res.json(), { ok: true, phase: 'reviewing', reloaded: true });
    assert.equal(s.reloads, 1);
    assert.deepEqual(s.reloadSummary, ['Tightened the header']);
  });

  test('both take no body at all', async () => {
    const s = session();
    const app = createApp(s);
    s.store.add('one');
    s.store.submit(null);
    assert.equal((await post(app, '/api/working')).status, 200);
    assert.equal((await post(app, '/api/ready')).status, 200);
    assert.equal(s.store.snapshot().summary, null);
  });

  test('refuse a move the round does not allow, and reload nothing', async () => {
    const s = session();
    const app = createApp(s);
    const res = await post(app, '/api/ready', { summary: 'x' });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /cannot be marked ready/);
    assert.equal((await post(app, '/api/working', { message: 'x' })).status, 409);
    assert.equal((await post(app, '/api/working', { message: 42 })).status, 400);
    assert.equal(s.reloads, 0);
  });
});

describe('live mode', () => {
  test('turns it on and off, and sends anything unsent when turning it on', async () => {
    const s = session();
    const app = createApp(s);
    s.store.add('one');
    assert.deepEqual(await (await post(app, '/api/live', { live: true })).json(), { ok: true, live: true });
    assert.equal(s.store.snapshot().phase, 'submitted');
    assert.deepEqual(await (await post(app, '/api/live', { live: false })).json(), { ok: true, live: false });
  });

  test('refuses a body with no boolean', async () => {
    const res = await post(createApp(session()), '/api/live', {});
    assert.equal(res.status, 400);
  });
});

describe('a host other than the CLI’s session', () => {
  const bare = (values: Partial<SessionApi> = {}): SessionApi => ({
    store: new CommentStore(),
    waits: new Waits(),
    currentUrl: () => null,
    ...values,
  });

  test('checks requests its own way in place of the token', async () => {
    const app = createApp(
      bare({
        auth: async (c, next) => (c.req.header('x-key') === 'k' ? next() : c.json({ error: 'no' }, 401)),
      }),
    );
    assert.equal((await app.request('/api/state', { headers: auth })).status, 401);
    assert.equal((await app.request('/api/state', { headers: { 'x-key': 'k' } })).status, 200);
  });

  test('will not serve with neither a token nor an auth check', () => {
    assert.throws(() => createApp(bare()), /token or an auth check/);
  });

  test('will not serve with both one store and many reviews, or neither', () => {
    const reviews = { store: () => null, inbox: () => new CommentStore() };
    assert.throws(() => createApp(bare({ token: 'secret', reviews })), /a store or reviews, and not both/);
    assert.throws(() => createApp(bare({ token: 'secret', store: undefined })), /a store or reviews, and not both/);
  });

  test('answers health with only what it was given', async () => {
    const res = await createApp(bare({ token: 'secret' })).request('/api/health', { headers: auth });
    assert.deepEqual(await res.json(), {
      ok: true,
      url: null,
      capabilities: { navigate: false, reload: false, close: false, reviews: false },
    });
  });

  test('says it cannot navigate or close rather than pretending to', async () => {
    const app = createApp(bare({ token: 'secret' }));
    assert.equal((await post(app, '/api/navigate', { url: 'https://example.com/' })).status, 501);
    assert.equal((await post(app, '/api/close')).status, 501);
  });

  test('hands the round back on ready with nothing to reload', async () => {
    const store = new CommentStore();
    const app = createApp(bare({ token: 'secret', store }));
    store.add('one');
    store.submit(null);
    assert.equal((await post(app, '/api/working')).status, 200);
    const res = await post(app, '/api/ready', { summary: 'Done' });
    assert.deepEqual(await res.json(), { ok: true, phase: 'reviewing', reloaded: false });
    assert.equal(store.snapshot().summary, 'Done');
  });
});

describe('Waits', () => {
  test('waits on anything that hands out verdicts the way a store does', async () => {
    const store = new CommentStore();
    const source = { verdict: () => store.verdict(), onChange: (cb: () => void) => store.onChange(cb) };
    const held = new Waits().next(source, 1_000);
    store.add('one');
    store.submit(null);
    const outcome = await held;
    assert.ok('verdict' in outcome && outcome.verdict.round === 1);
  });
});

describe('a server holding many reviews', () => {
  /** Two reviews, and an inbox that hands out the first with a verdict waiting, as version 2. */
  function many() {
    const stores = new Map([
      ['r1', new CommentStore()],
      ['r2', new CommentStore()],
    ]);
    const inbox: VerdictSource = {
      verdict: (): AnyVerdict | null => {
        for (const [id, store] of stores) {
          const v = store.verdict();
          if (v) return forReview(v, id);
        }
        return null;
      },
      onChange: (listener) => {
        const offs = [...stores.values()].map((s) => s.onChange(listener));
        return () => offs.forEach((off) => off());
      },
    };
    const asked: string[] = [];
    const reviews: Reviews = {
      store: (id, c) => {
        asked.push(`${id} by ${c.req.header('x-gloss-client') ?? 'nobody'}`);
        return stores.get(id) ?? null;
      },
      inbox: () => inbox,
    };
    const app = createApp({ token: 'secret', reviews, waits: new Waits(), currentUrl: () => null });
    return { app, stores, asked };
  }

  test('says it holds many in its health', async () => {
    const res = await many().app.request('/api/health', { headers: auth });
    assert.equal(((await res.json()) as { capabilities: { reviews: boolean } }).capabilities.reviews, true);
  });

  test('wants to know which review a request is about', async () => {
    const { app } = many();
    assert.equal((await app.request('/api/state', { headers: auth })).status, 400);
    assert.equal((await post(app, '/api/working', {})).status, 400);
    assert.equal((await app.request('/api/state?review=r9', { headers: auth })).status, 404);
  });

  test('answers each request from the review it names, and lets the server see who asks', async () => {
    const { app, stores, asked } = many();
    stores.get('r2')!.add('only in r2');
    const res = await app.request('/api/state?review=r2', { headers: { ...auth, 'x-gloss-client': 'agent-1' } });
    assert.deepEqual(((await res.json()) as { comments: { body: string }[] }).comments.map((c) => c.body), ['only in r2']);
    assert.deepEqual(asked, ['r2 by agent-1']);
  });

  test('waits on the inbox, and hands out a verdict that says whose it is', async () => {
    const { app, stores } = many();
    const held = verdict(app, 5);
    await new Promise((r) => setTimeout(r, 20));
    stores.get('r2')!.add('one');
    stores.get('r2')!.submit(null);
    const v = (await (await held).json()) as { version: number; review: string; round: number };
    assert.deepEqual([v.version, v.review, v.round], [2, 'r2', 1]);
  });

  test('one review with the agent holds up no other', async () => {
    const { app, stores } = many();
    for (const id of ['r1', 'r2']) {
      stores.get(id)!.add('one');
      stores.get(id)!.submit(null);
    }
    assert.equal((await post(app, '/api/working', { review: 'r1' })).status, 200);
    const v = (await (await verdict(app)).json()) as { review: string };
    assert.equal(v.review, 'r2');
  });

  test('moves only the review a body names, and reloads nothing', async () => {
    const { app, stores } = many();
    stores.get('r1')!.add('one');
    stores.get('r1')!.submit(null);
    stores.get('r2')!.add('two');
    stores.get('r2')!.submit(null);
    const res = await post(app, '/api/ready', { review: 'r1', summary: 'Fixed' });
    assert.deepEqual(await res.json(), { ok: true, phase: 'reviewing', reloaded: false });
    assert.equal(stores.get('r1')!.snapshot().summary, 'Fixed');
    assert.equal(stores.get('r2')!.snapshot().phase, 'submitted');
  });
});
