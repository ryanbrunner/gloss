import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CommentStore } from '#core/store.js';
import { createApp, startServer, Waits, type SessionApi } from './server.js';

type TestSession = SessionApi & { store: CommentStore; navigated: string[]; closed: number; reloads: number; reloadSummary: (string | null)[] };

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

describe('the server', () => {
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
