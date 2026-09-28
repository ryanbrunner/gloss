import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createApp, startServer, type SessionApi } from './server.js';
import { CommentStore } from './store.js';

function session(values: Partial<SessionApi> = {}): SessionApi & { navigated: string[]; closed: number } {
  const s = {
    token: 'secret',
    store: new CommentStore(),
    currentUrl: () => 'http://127.0.0.1:4400/',
    navigated: [] as string[],
    closed: 0,
    navigate: async (url: string) => {
      s.navigated.push(url);
    },
    close: () => {
      s.closed++;
    },
    ...values,
  };
  return s;
}

const auth = { authorization: 'Bearer secret' };

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
