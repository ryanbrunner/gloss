import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createApp, startServer, Waits, type SessionApi } from './server.js';
import { CommentStore } from './store.js';

type TestSession = SessionApi & { navigated: string[]; closed: number; reloads: number; reloadSummary: (string | null)[] };

function session(values: Partial<SessionApi> = {}): TestSession {
  const s: TestSession = {
    token: 'secret',
    store: new CommentStore(),
    waits: new Waits(),
    currentUrl: () => 'http://127.0.0.1:4400/',
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
    assert.deepEqual(await res.json(), { ok: true, pid: process.pid, url: 'http://127.0.0.1:4400/' });
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
    await new Promise((r) => setImmediate(r));
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

  test('holds a wait over a real socket for as long as it was asked to', async () => {
    const server = await startServer(createApp(session()));
    try {
      const started = Date.now();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/verdict?wait=1`, { headers: auth });
      assert.deepEqual(await res.json(), { pending: true });
      assert.ok(Date.now() - started >= 900, `answered after ${Date.now() - started}ms`);
    } finally {
      await server.close();
    }
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
    assert.deepEqual(await res.json(), { ok: true, phase: 'reviewing' });
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

describe('the server', () => {
  test('serves on a port the OS picked, at 127.0.0.1', async () => {
    const server = await startServer(createApp(session()));
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/health`, { headers: auth });
      assert.equal(res.status, 200);
    } finally {
      await server.close();
    }
  });
});
