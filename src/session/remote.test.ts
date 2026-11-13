import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { VerdictV2 } from '#core/verdict.js';
import { credentialsPath, forgetToken, saveToken, tokenFor } from './credentials.js';
import { saveScreenshots, secureOrLocal, serverUrl } from './remote.js';
import type { RemoteState } from './state.js';

let root: string;
let previousHome: string | undefined;
let previousToken: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'gloss-remote-'));
  previousHome = process.env.GLOSS_HOME;
  previousToken = process.env.GLOSS_TOKEN;
  process.env.GLOSS_HOME = join(root, 'home');
  delete process.env.GLOSS_TOKEN;
});

after(() => {
  if (previousHome === undefined) delete process.env.GLOSS_HOME;
  else process.env.GLOSS_HOME = previousHome;
  if (previousToken === undefined) delete process.env.GLOSS_TOKEN;
  else process.env.GLOSS_TOKEN = previousToken;
  rmSync(root, { recursive: true, force: true });
});

describe('serverUrl', () => {
  test('takes https anywhere, and http only on this machine', () => {
    assert.equal(serverUrl('https://gloss.example/v1/projects/acme/'), 'https://gloss.example/v1/projects/acme');
    assert.equal(serverUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
    assert.equal(serverUrl('http://localhost:8787/'), 'http://localhost:8787');
    assert.throws(() => serverUrl('http://gloss.example/'), /over https/);
    assert.throws(() => serverUrl('ftp://gloss.example/'), /over https/);
    assert.throws(() => serverUrl('gloss.example'), /not a url/);
    assert.throws(() => serverUrl('https://gloss.example/?project=acme'), /no query/);
  });

  test('secureOrLocal says the same of any link', () => {
    assert.ok(secureOrLocal(new URL('https://cdn.example/x.png')));
    assert.ok(!secureOrLocal(new URL('http://cdn.example/x.png')));
  });
});

describe('credentials', () => {
  test('keeps one token per origin, where only the owner can read it', () => {
    saveToken('https://gloss.example/v1/projects/acme', 'one');
    saveToken('https://other.example', 'two');
    assert.equal(tokenFor('https://gloss.example/v1/projects/beta'), 'one', 'any path on the same origin');
    assert.equal(tokenFor('https://other.example/'), 'two');
    assert.equal(tokenFor('https://gloss.example:8443/'), null, 'a different port is a different origin');
    assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600);
  });

  test('GLOSS_TOKEN stands in for every sign-in', () => {
    process.env.GLOSS_TOKEN = 'from-env';
    try {
      assert.equal(tokenFor('https://nowhere.example'), 'from-env');
    } finally {
      delete process.env.GLOSS_TOKEN;
    }
  });

  test('forgets a token, and says when there was none', () => {
    saveToken('https://forget.example', 'x');
    assert.equal(forgetToken('https://forget.example/any/path'), true);
    assert.equal(tokenFor('https://forget.example'), null);
    assert.equal(forgetToken('https://forget.example'), false);
  });
});

describe('saveScreenshots', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
  let server: Server;
  let other: Server;
  let base: string;
  let elsewhere: string;
  const seen: Array<{ path: string; auth: string | undefined }> = [];

  const serve = (handle: (req: IncomingMessage) => [number, Buffer]) => {
    const s = createServer((req, res) => {
      seen.push({ path: `${req.headers.host}${req.url}`, auth: req.headers.authorization });
      const [status, body] = handle(req);
      res.writeHead(status, { 'content-type': 'image/png' }).end(body);
    });
    return new Promise<Server>((r) => s.listen(0, '127.0.0.1', () => r(s)));
  };

  before(async () => {
    server = await serve((req) => (req.url === '/not-png' ? [200, Buffer.from('<html>')] : req.url === '/gone' ? [404, Buffer.alloc(0)] : [200, PNG]));
    other = await serve(() => [200, PNG]);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // localhost rather than 127.0.0.1, so it is another origin.
    elsewhere = `http://localhost:${(other.address() as AddressInfo).port}`;
    saveToken(base, 'secret');
  });

  after(() => {
    server.close();
    other.close();
  });

  const state = (): RemoteState => ({
    kind: 'remote',
    server: `${base}/v1/projects/acme`,
    clientId: 'client-1',
    reviews: true,
    review: null,
    cwd: '/',
    name: '',
    startedAt: 0,
  });

  const verdict = (targets: Array<Record<string, unknown> | null>): VerdictV2 => ({
    version: 2,
    review: 'r/1',
    approved: false,
    round: 1,
    page: null,
    comments: targets.map((target, i) => ({
      id: `c${i + 1}`,
      kind: target ? 'pinned' : 'general',
      body: 'x',
      page: null,
      createdAt: 0,
      sentIn: 1,
      target,
    })),
  });

  test('fetches each picture to a file of the review’s own, and points screenshot at it', async () => {
    seen.length = 0;
    const dir = join(root, 'shots-a');
    const out = await saveScreenshots(verdict([{ screenshotUrl: '/shots/a.png', screenshot: '/srv/elsewhere.png' }, null]), state(), dir);
    const path = out.comments[0]?.target?.screenshot as string;
    assert.equal(path, join(dir, 'r_1', 'c1.png'), 'a review id from the server is made safe for a path');
    assert.deepEqual(readFileSync(path), PNG);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(seen[0]?.auth, 'Bearer secret', 'the server’s own origin gets the token');
  });

  test('sends the token nowhere but the server’s own origin', async () => {
    seen.length = 0;
    const out = await saveScreenshots(verdict([{ screenshotUrl: `${elsewhere}/signed.png?sig=1` }]), state(), join(root, 'shots-b'));
    assert.equal(typeof out.comments[0]?.target?.screenshot, 'string');
    assert.equal(seen[0]?.auth, undefined);
  });

  test('leaves a comment without a picture it could not have, and never with the server’s path', async () => {
    const out = await saveScreenshots(
      verdict([
        { screenshotUrl: '/not-png', screenshot: '/srv/x.png' },
        { screenshotUrl: '/gone' },
        { screenshotUrl: 'http://cdn.example/plain-http.png' },
        { screenshot: '/srv/no-url.png' },
      ]),
      state(),
      join(root, 'shots-c'),
    );
    for (const c of out.comments) assert.equal(c.target?.screenshot, undefined, `${c.id} kept a screenshot`);
  });

  test('changes nothing in the verdict it was given', async () => {
    const given = verdict([{ screenshotUrl: '/shots/a.png', screenshot: '/srv/x.png' }]);
    await saveScreenshots(given, state(), join(root, 'shots-d'));
    assert.equal(given.comments[0]?.target?.screenshot, '/srv/x.png');
  });
});
