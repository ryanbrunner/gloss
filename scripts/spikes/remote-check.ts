/**
 * Drives the review loop against a Gloss server elsewhere, the way an agent
 * connected with `gloss connect` runs it: a stand-in for an inbox that many
 * reviewers write to, built from core's own `createApp` with two reviews in
 * it, a device-flow sign-in, and pictures behind the server's own token.
 *
 * Checks that the agent signs in and connects; gets each review's rounds as
 * version 2 verdicts, in order, with authors and with pictures fetched to
 * local files; that two agents are not handed the same round; that working
 * and ready move only the review they are about and reload nothing; that an
 * approval ends one review and not the connection; and that close, a
 * revoked token and a server that has gone each end as they should.
 *
 * No browser: the reviewers' side is played on the server's stores directly.
 *
 *   npx tsx scripts/spikes/remote-check.ts
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { createApp, Waits, type VerdictSource } from '#core/server.js';
import { CommentStore, type Pin } from '#core/store.js';
import { forReview, verdictV2Schema, type AnyVerdict, type VerdictV2 } from '#core/verdict.js';
import { readRemote, sessionRef } from '../../src/session/state.js';

const BIN = fileURLToPath(new URL('../../bin/gloss.js', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'gloss-remote-check-'));
const home = join(root, 'home');
const agentA = join(root, 'agent-a');
const agentB = join(root, 'agent-b');
for (const d of [agentA, agentB]) mkdirSync(d);
process.env.GLOSS_HOME = home;
const env = { ...process.env, GLOSS_HOME: home, GLOSS_TOKEN: '' };

/** A PNG's signature and nothing else, which is all `gloss wait` checks. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const TOKEN = 'token-for-the-check';

// The server: two reviews, each one reviewer's, and an inbox that hands
// each queued round to the first agent to ask, and to no other until that
// agent is done with it. The claims are this stand-in's; a real server
// keeps them however it likes (docs/protocol.md).
const reviews = new Map([
  ['r1', new CommentStore()],
  ['r2', new CommentStore()],
]);
const claims = new Map<string, string>();
const archived = new Set<string>();
const tokens = new Set([TOKEN]);
let tokenAsks = 0;

for (const [id, store] of reviews) {
  store.onChange((s) => {
    if (s.phase === 'reviewing') claims.delete(id);
  });
}

function inbox(client: string): VerdictSource {
  // An approval this agent was handed is done with once it asks again.
  for (const [id, by] of claims) {
    if (by === client && reviews.get(id)?.snapshot().phase === 'approved') {
      archived.add(id);
      claims.delete(id);
    }
  }
  return {
    verdict: (): AnyVerdict | null => {
      for (const [id, store] of reviews) {
        if (archived.has(id)) continue;
        const by = claims.get(id);
        if (by && by !== client) continue;
        const v = store.verdict();
        if (!v) continue;
        claims.set(id, client);
        return withPictureLinks(forReview(v, id));
      }
      return null;
    },
    onChange: (listener) => {
      const offs = [...reviews.values()].map((s) => s.onChange(listener));
      return () => offs.forEach((off) => off());
    },
  };
}

/** The store keeps a picture's key; the verdict links it, on the server's own origin. */
function withPictureLinks(v: VerdictV2): VerdictV2 {
  for (const c of v.comments) {
    if (typeof c.target?.screenshot !== 'string') continue;
    c.target.screenshotUrl = `/shots/${c.target.screenshot}`;
    c.target.screenshot = '/srv/gloss/not/a/path/here.png';
  }
  return v;
}

const clientOf = (c: Context) => c.req.header('x-gloss-client') ?? '';
/** How many of the next asks for a verdict answer 503, as a proxy in front of a restarting server would. */
let flaky = 0;
const signedIn = (c: Context) => tokens.has(c.req.header('authorization')?.replace(/^Bearer /, '') ?? '');
const app = new Hono();
let origin = '';

app.get('/.well-known/gloss.json', (c) =>
  c.json({ device_authorization_endpoint: `${origin}/device`, token_endpoint: `${origin}/token`, client_id: 'gloss-cli' }),
);
app.post('/device', (c) =>
  c.json({ device_code: 'dc', user_code: 'WXYZ-1234', verification_uri: `${origin}/activate`, expires_in: 60, interval: 0.05 }),
);
// Pending once, as though the person took a moment to approve.
app.post('/token', async (c) => {
  const form = await c.req.parseBody();
  if (form.device_code !== 'dc' || form.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
    return c.json({ error: 'invalid_grant' }, 400);
  }
  return ++tokenAsks === 1 ? c.json({ error: 'authorization_pending' }, 400) : c.json({ access_token: TOKEN });
});
app.get('/shots/:key', (c) => (signedIn(c) ? c.body(PNG, 200, { 'content-type': 'image/png' }) : c.json({ error: 'no' }, 401)));
app.use('/api/verdict', async (c, next) => (flaky > 0 && flaky-- ? c.json({ error: 'upstream restarting' }, 503) : next()));
app.route(
  '/',
  createApp({
    auth: async (c, next) => (signedIn(c) ? next() : c.json({ error: 'sign in first' }, 401)),
    reviews: {
      // Only the agent a round was handed to may act on its review.
      store: (id, c) => (claims.get(id) === clientOf(c) && !archived.has(id) ? (reviews.get(id) ?? null) : null),
      inbox: (c) => inbox(clientOf(c)),
      busy: (c) => {
        for (const [id, by] of claims) {
          if (by === clientOf(c) && reviews.get(id)?.snapshot().phase === 'working') {
            return `this agent is working on review ${id}: run \`gloss ready\` first`;
          }
        }
        return null;
      },
    },
    waits: new Waits(),
    currentUrl: () => null,
  }),
);

const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
await new Promise<void>((r) => server.once('listening', () => r()));
origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function gloss(cwd: string, args: string[], timeout = 30_000): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, env, timeout }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

function v2Of(ran: Ran): VerdictV2 {
  assert.equal(ran.code, 0, `gloss wait failed:\n${ran.stderr}`);
  return verdictV2Schema.parse(JSON.parse(ran.stdout));
}

const page = 'https://shop.example/cart';
const pin = (screenshot: string): Pin => ({
  url: page,
  selector: '#total',
  tag: 'p',
  text: 'Total $43.20',
  box: { x: 1, y: 2, width: 3, height: 4 },
  viewport: { width: 1280, height: 800 },
  screenshot,
});

try {
  // Connecting signs in through the device flow, once, and keeps the token to the owner.
  const connected = await gloss(agentA, ['connect', origin]);
  assert.equal(connected.code, 0, connected.stderr);
  assert.match(connected.stderr, /enter the code WXYZ-1234/);
  assert.match(connected.stdout, /Connected .* to http:\/\/127\.0\.0\.1/);
  assert.equal(statSync(join(home, 'credentials.json')).mode & 0o777, 0o600);
  assert.equal(readRemote(sessionRef(agentA))?.reviews, true);
  const second = await gloss(agentB, ['connect', `${origin}/`]);
  assert.equal(second.code, 0, second.stderr);
  assert.doesNotMatch(second.stderr, /code/, 'the second directory used the saved sign-in');
  console.log('connect: signs in with the device flow once, then reuses the token');

  const status = JSON.parse((await gloss(agentA, ['status', '--json'])).stdout);
  assert.deepEqual([status.running, status.remote, status.reachable, status.review], [true, true, true, null]);
  assert.match((await gloss(agentA, ['working'])).stderr, /no round has come .* run `gloss wait` first/);
  console.log('status: connected and reachable; working before any round says to wait');

  // Two reviewers submit: r2 first, with a pinned comment and an author.
  const r1 = reviews.get('r1')!;
  const r2 = reviews.get('r2')!;
  r2.add('The total is wrong', page, pin('r2-c1.png'), { id: 'u-ana', name: 'Ana' });
  r2.submit(page);
  r1.add('Make the header shorter', page, undefined, { id: 'u-bo', name: null });
  r1.submit(page);

  // Two 503s first: the wait asks again rather than giving up.
  flaky = 2;
  const flakyWait = await gloss(agentA, ['wait']);
  assert.match(flakyWait.stderr, /answered 503; trying again until it answers/);
  assert.equal(flaky, 0);
  const first = v2Of(flakyWait);
  assert.equal(first.review, 'r1', 'the inbox hands out its reviews in order');
  assert.deepEqual(first.comments[0]?.author, { id: 'u-bo', name: null });
  const again = v2Of(await gloss(agentA, ['wait']));
  assert.deepEqual([again.review, again.round], [first.review, first.round], 'asked again, the same round');
  assert.equal(readRemote(sessionRef(agentA))?.review, 'r1');

  const other = v2Of(await gloss(agentB, ['wait']));
  assert.equal(other.review, 'r2', 'a round handed to one agent is not handed to another');
  const shot = other.comments[0]?.target?.screenshot;
  assert.equal(typeof shot, 'string');
  assert.ok((shot as string).startsWith(join(home, 'shots')), `the picture is a local file: ${shot}`);
  assert.deepEqual(readFileSync(shot as string), PNG);
  assert.equal(other.comments[0]?.target?.screenshotUrl, '/shots/r2-c1.png');
  assert.deepEqual(other.comments[0]?.author, { id: 'u-ana', name: 'Ana' });
  console.log('wait: version 2 verdicts in order, one agent each, with authors and pictures fetched locally; 5xx is retried');

  // An agent working on one review gets no other's round until it is ready,
  // so its `ready` cannot land on the wrong review.
  assert.equal((await gloss(agentA, ['working', 'Shortening the header'])).code, 0);
  const busy = await gloss(agentA, ['wait']);
  assert.equal(busy.code, 1);
  assert.equal(busy.stdout, '');
  assert.match(busy.stderr, /working on review r1: run `gloss ready` first/);
  assert.equal(readRemote(sessionRef(agentA))?.review, 'r1');
  // Nor can one agent move a review it was not handed.
  const b = readRemote(sessionRef(agentB))!;
  const meddle = await fetch(`${origin}/api/ready`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'x-gloss-client': b.clientId, 'content-type': 'application/json' },
    body: JSON.stringify({ review: 'r1', summary: 'not mine' }),
  });
  assert.equal(meddle.status, 404);
  assert.equal(r1.snapshot().phase, 'working');
  console.log('wait: refused while this agent works on a round; another agent cannot move it');

  // Working and ready move the review they are about, and only that one.
  assert.equal((await gloss(agentB, ['working', 'Fixing the total'])).code, 0);
  assert.equal(r2.snapshot().phase, 'working');
  assert.equal(r1.snapshot().phase, 'working');
  const done = await gloss(agentB, ['ready', 'The total now includes shipping']);
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /Posted the summary; the reviewer sees it the next time they open the page/);
  assert.equal(r2.snapshot().summary, 'The total now includes shipping');
  assert.equal(r1.snapshot().phase, 'working');
  console.log('working/ready: move only their review, and say nothing was reloaded');

  // Approving one review ends that review, not the agent's connection.
  r2.approve(page);
  const approved = v2Of(await gloss(agentB, ['wait']));
  assert.deepEqual([approved.review, approved.approved], ['r2', true]);
  // However long the CLI takes to start, its first ask is what tells the
  // server; then it waits on, with nothing to hand out, until it is stopped.
  const after = spawn(process.execPath, [BIN, 'wait'], { cwd: agentB, env });
  for (let i = 0; i < 150 && !archived.has('r2'); i++) await sleep(100);
  assert.ok(archived.has('r2'), 'the next wait told the server the approval was read');
  await sleep(500);
  assert.equal(after.exitCode, null, 'nothing else to hand out: still waiting');
  after.kill();
  assert.ok(readRemote(sessionRef(agentB)), 'still connected after an approval');
  console.log('approve: ends one review; the next wait acknowledges it and keeps waiting');

  // No window to open while connected.
  const opened = await gloss(agentA, ['open', 'http://127.0.0.1:1/']);
  assert.equal(opened.code, 1);
  assert.match(opened.stderr, /connected to .* no window to open/);
  console.log('open: refused while connected');

  // A revoked token is an answer, not something to retry.
  tokens.clear();
  const refused = await gloss(agentA, ['wait']);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /did not take this machine's token: run `gloss login/);
  tokens.add(TOKEN);
  console.log('wait: a revoked token exits 1 and says to log in');

  // A server that has gone is waited out, not given up on. Agent A's round
  // is done first, so its wait has nothing to print at once.
  assert.equal((await gloss(agentA, ['ready', 'Shorter header'])).code, 0);
  assert.equal(r1.snapshot().summary, 'Shorter header');
  const child = spawn(process.execPath, [BIN, 'wait'], { cwd: agentA, env: { ...env } });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  await sleep(300);
  server.close();
  (server as unknown as { closeAllConnections(): void }).closeAllConnections();
  for (let i = 0; i < 150 && !/trying again/.test(stderr); i++) await sleep(100);
  assert.match(stderr, /could not reach the Gloss server .* trying again/);
  await sleep(1_000);
  assert.equal(child.exitCode, null, `wait gave up on a server that went away:\n${stderr}`);
  child.kill();
  console.log('wait: keeps trying a server that is not answering');

  // Close disconnects, and takes the pictures with it.
  assert.ok(existsSync(join(home, 'shots')));
  const closed = await gloss(agentB, ['close']);
  assert.match(closed.stdout, /Disconnected this directory from/);
  assert.equal(readRemote(sessionRef(agentB)), null);
  assert.ok(!existsSync(shot as string), 'the pictures went with the connection');
  console.log('close: disconnects and removes the pictures');

  console.log('\nremote-check: all good');
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}
