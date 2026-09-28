/**
 * Checks that a page under Gloss behaves as it would without it: links, a
 * form post, client-side navigation (pushState plus a body swap) and a page
 * served with `X-Frame-Options: DENY`, with the bar present on every step.
 * Also races two `gloss open` calls and checks only one session starts, and
 * that `gloss close` takes the session's server down with it.
 *
 * Headless by default, like open-check. Needs Chromium.
 *
 *   npx tsx scripts/spikes/nav-check.ts [--headed]
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { readState, sessionRef } from '../../src/session/state.js';

const BIN = fileURLToPath(new URL('../../bin/gloss.js', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'gloss-nav-check-'));
const cwd = join(root, 'project');
const home = join(root, 'home');
mkdirSync(cwd);
process.env.GLOSS_HOME = home;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const cdpPort = await freePort();
const env = {
  ...process.env,
  GLOSS_HOME: home,
  GLOSS_CDP_PORT: String(cdpPort),
  ...(process.argv.includes('--headed') ? {} : { GLOSS_HEADLESS: '1' }),
};

function gloss(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, env, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

async function until<T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// A tiny site: every response refuses framing.
const posted: string[] = [];
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title>
<style>body{font-family:Georgia,serif;color:rgb(10,20,30);margin:0}h1{margin:0;padding:8px}</style></head>
<body><h1 id="title">${title}</h1>${body}</body></html>`;
const home_ = page(
  'Home',
  `<a id="about" href="/about">About</a>
<form id="f" method="post" action="/submit"><input name="q" id="q"><button id="send">Send</button></form>
<button id="spa">Client nav</button>
<input id="pageinput"><span id="keys">0</span>
<script>
  let keys = 0;
  document.getElementById('pageinput').addEventListener('keydown', () => {
    document.getElementById('keys').textContent = String(++keys);
  });
  document.getElementById('spa').addEventListener('click', () => {
    history.pushState({}, '', '/spa/next');
    const fresh = document.createElement('body');
    fresh.innerHTML = '<h1 id="title">SPA next</h1><a id="back" href="/">Home</a>';
    document.documentElement.replaceChild(fresh, document.body);
  });
</script>`,
);
const site = createHttpServer((req, res) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Type', 'text/html');
  if (req.method === 'POST' && req.url === '/submit') {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      posted.push(data);
      res.end(page('Thanks', `<p id="got">${data}</p>`));
    });
    return;
  }
  if (req.url === '/about') return res.end(page('About', '<a id="home" href="/">Home</a>'));
  res.end(home_);
});
await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
// localhost, as a user would type it, while the site listens on 127.0.0.1.
const base = `http://localhost:${(site.address() as AddressInfo).port}`;

// Widened, so control flow doesn't narrow it to null: windowPage() sets it.
let cdp = null as Browser | null;
async function windowPage(): Promise<Page> {
  cdp ??= await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  return until('the session window', () => cdp!.contexts().flatMap((c) => c.pages()).at(-1));
}
const barThere = (p: Page) => p.locator('gloss-bar .bar').waitFor({ timeout: 5000 });
const title = (p: Page) => p.locator('#title').innerText();

try {
  // Two opens at once: one session, one window.
  const [a, b] = await Promise.all([gloss(['open', `${base}/`]), gloss(['open', `${base}/`])]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const state = readState(sessionRef(cwd));
  assert.ok(state);
  const p = await windowPage();
  assert.equal(cdp!.contexts().flatMap((c) => c.pages()).length, 1, 'two racing opens made one window');
  console.log(`race: two concurrent opens -> one session (pid ${state.pid}), one window`);

  // X-Frame-Options: DENY does not keep the page or the bar out.
  await until('home', async () => (await title(p).catch(() => '')) === 'Home');
  await barThere(p);
  const xfo = (await p.request.get(`${base}/`)).headers()['x-frame-options'];
  assert.equal(xfo, 'DENY');
  console.log('x-frame-options: DENY page loaded with the bar');

  // Page styles untouched apart from the push-down.
  const look = await p.evaluate(() => ({
    font: getComputedStyle(document.body).fontFamily,
    color: getComputedStyle(document.body).color,
    top: document.getElementById('title')!.getBoundingClientRect().top,
  }));
  assert.match(look.font, /Georgia/);
  assert.equal(look.color, 'rgb(10, 20, 30)');
  assert.ok(look.top >= 44);

  // Page's own key handlers still work for page inputs.
  await p.locator('#pageinput').pressSequentially('abc');
  assert.equal(await p.locator('#keys').innerText(), '3');
  console.log('page: styles unchanged, page input keydown handlers fire');

  // A link.
  await p.locator('#about').click();
  await until('about', async () => (await title(p).catch(() => '')) === 'About');
  await barThere(p);
  assert.equal(p.url(), `${base}/about`);
  await p.locator('#home').click();
  await until('home again', async () => (await title(p).catch(() => '')) === 'Home');
  await barThere(p);
  console.log('link: /about and back, bar on both');

  // A form post.
  await p.locator('#q').fill('hello world');
  await p.locator('#send').click();
  await until('thanks', async () => (await title(p).catch(() => '')) === 'Thanks');
  await barThere(p);
  assert.deepEqual(posted, ['q=hello+world']);
  console.log('form: POST reached the server, bar on the result page');

  // Add a comment, then client-side navigate with a body swap.
  await p.goto(`${base}/`);
  await barThere(p);
  await p.locator('gloss-bar textarea').fill('before spa nav');
  await p.locator('gloss-bar textarea').press('Enter');
  await until('count 1', async () => (await p.locator('gloss-bar .toggle').innerText()).includes('(1)'));
  await p.locator('#spa').click();
  await until('spa', async () => (await title(p).catch(() => '')) === 'SPA next');
  assert.equal(p.url(), `${base}/spa/next`);
  await barThere(p);
  assert.ok((await p.locator('gloss-bar .toggle').innerText()).includes('(1)'));
  assert.equal(await p.evaluate(() => document.querySelectorAll('gloss-bar').length), 1);
  await p.goBack();
  await until('popstate url', () => p.url() === `${base}/`);
  await barThere(p);
  console.log('client nav: pushState + body swap kept one bar with its comments; back works');

  // gloss close takes the server down.
  const closed = await gloss(['close']);
  assert.equal(closed.code, 0, closed.stderr);
  await cdp?.close().catch(() => {});
  cdp = null;
  const down = await fetch(`http://127.0.0.1:${state.port}/api/health`, {
    headers: { authorization: `Bearer ${state.token}` },
  }).then(
    () => false,
    () => true,
  );
  assert.ok(down, 'the session server still answers after close');
  console.log('close: session server no longer answers');

  console.log('\nnav-check: all good');
} finally {
  await cdp?.close().catch(() => {});
  await gloss(['close']);
  site.close();
  rmSync(root, { recursive: true, force: true });
}
