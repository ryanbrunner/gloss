/**
 * Drives `gloss open`, `status` and `close` end to end, the way Claude would:
 * through the binary, against the demo storefront, reading exit statuses and
 * the session's API. Then it looks inside the session's window over DevTools
 * to check the bar is where it should be and does what it should.
 *
 * Chromium runs headless (`GLOSS_HEADLESS=1`) with a DevTools port
 * (`GLOSS_CDP_PORT`), and the state files go to a temporary `GLOSS_HOME`, so
 * none of it touches a real session. Needs Chromium: `npx playwright install
 * chromium`. Not part of `npm test`, so CI without a browser stays green.
 * `--headed` shows the real window instead, for a few seconds.
 *
 *   npx tsx scripts/spikes/open-check.ts [--headed]
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createDevServer } from '../dev.js';
import { pidAlive, readState, sessionRef } from '../../src/session/state.js';
import type { RoundState } from '../../src/session/store.js';

const BIN = fileURLToPath(new URL('../../bin/gloss.js', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'gloss-open-check-'));
const cwd = join(root, 'project');
const home = join(root, 'home');
mkdirSync(cwd);
process.env.GLOSS_HOME = home;

const cdpPort = await freePort();
const headed = process.argv.includes('--headed');
const env = {
  ...process.env,
  GLOSS_HOME: home,
  GLOSS_CDP_PORT: String(cdpPort),
  ...(headed ? {} : { GLOSS_HEADLESS: '1' }),
};

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

function gloss(args: string[], extraEnv: Record<string, string> = {}): Promise<Ran> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, env: { ...env, ...extraEnv }, timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
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

const ref = sessionRef(cwd);
const dev = createDevServer();
await new Promise<void>((r) => dev.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(dev.address() as AddressInfo).port}`;
let cdp: Browser | null = null;

async function apiState(token = readState(ref)?.token): Promise<Response> {
  const state = readState(ref);
  assert.ok(state, 'no state file');
  return fetch(`http://127.0.0.1:${state.port}/api/state`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
}
const comments = async () => ((await (await apiState()).json()) as RoundState).comments.map((c) => c.body);

/** The session's window, as the DevTools connection sees it. */
async function windowPage(): Promise<Page> {
  cdp ??= await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  return until('the session window', () => cdp!.contexts().flatMap((c) => c.pages()).at(-1));
}

async function disconnect(): Promise<void> {
  await cdp?.close().catch(() => {});
  cdp = null;
}

const toggleText = (page: Page) => page.locator('gloss-bar .toggle').innerText();
const waitForCount = (page: Page, n: number) =>
  until(`Comments (${n})`, async () => (await toggleText(page)).includes(`(${n})`));

try {
  // gloss open: returns promptly, having started a session that answers.
  const opened = await gloss(['open', `${base}/`]);
  assert.equal(opened.code, 0, `gloss open failed:\n${opened.stderr}`);
  assert.ok(opened.ms < 15_000, `gloss open took ${opened.ms}ms`);
  assert.match(opened.stdout, /session {2}http:\/\/127\.0\.0\.1:\d+ \(pid \d+\)/);
  const first = readState(ref);
  assert.ok(first && existsSync(ref.statePath), 'the state file is there while the session runs');
  assert.ok(ref.statePath.startsWith(join(home, 'sessions')));
  console.log(`open: ${opened.ms}ms, session pid ${first.pid} on port ${first.port}`);

  const status = await gloss(['status']);
  assert.equal(status.code, 0);
  assert.match(status.stdout, new RegExp(`http://127\\.0\\.0\\.1:${first.port}`));

  // The API wants the token.
  assert.equal((await apiState('wrong')).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${first.port}/api/state`)).status, 401);

  // The bar: in a shadow root on <html>, with the page pushed down under it.
  const page = await windowPage();
  await page.locator('gloss-bar .bar').waitFor();
  const layout = await page.evaluate(() => {
    const host = document.querySelector('gloss-bar')!;
    const header = document.querySelector('.site-header')!;
    return {
      onHtml: host.parentElement === document.documentElement,
      shadow: host.shadowRoot !== null,
      inBody: document.body.querySelectorAll('gloss-bar').length,
      barHeight: host.getBoundingClientRect().height,
      headerTop: header.getBoundingClientRect().top,
      bodyFont: getComputedStyle(document.body).fontFamily,
      bodyColor: getComputedStyle(document.body).color,
      headerBackground: getComputedStyle(header).backgroundColor,
    };
  });
  assert.deepEqual(
    { onHtml: layout.onHtml, shadow: layout.shadow, inBody: layout.inBody, barHeight: layout.barHeight },
    { onHtml: true, shadow: true, inBody: 0, barHeight: 44 },
  );
  assert.ok(layout.headerTop >= 44, `the storefront header starts at ${layout.headerTop}px, under the bar`);
  assert.match(layout.bodyFont, /Helvetica Neue/);
  assert.equal(layout.bodyColor, 'rgb(26, 26, 26)');
  assert.equal(layout.headerBackground, 'rgb(255, 255, 255)');
  console.log(`bar: 44px on <html>, storefront header at ${layout.headerTop}px`);

  // An anchor jump clears the page's own 51px header as well as the bar. The
  // padding gives the page room to scroll the summary that far.
  await page.evaluate(() => (document.body.style.paddingBottom = '100vh'));
  await page.getByRole('link', { name: 'Cart (2)' }).click();
  const summaryTop = () => page.evaluate(() => document.querySelector('#summary')!.getBoundingClientRect().top);
  await until('the summary below the header', async () => (await summaryTop()) === 95);
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollPaddingTop), '95px');
  await page.evaluate(() => (document.body.style.paddingBottom = ''));
  console.log('anchor jump: Cart (2) put the summary at 95px, below the bar and the header');

  // Adding: Enter, the Add button, and Shift+Enter for a newline.
  const box = page.locator('gloss-bar textarea');
  await box.fill('The header is too tall');
  await box.press('Enter');
  await waitForCount(page, 1);
  await box.fill('Cart count is wrong');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await waitForCount(page, 2);
  await box.fill('line one');
  await box.press('Shift+Enter');
  await box.pressSequentially('line two');
  await box.press('Enter');
  await waitForCount(page, 3);
  assert.equal(await box.inputValue(), '');
  assert.deepEqual(await comments(), ['The header is too tall', 'Cart count is wrong', 'line one\nline two']);

  // A key typed in the bar never reaches the page's own listeners.
  await page.evaluate(() => {
    let seen = 0;
    document.addEventListener('keydown', () => seen++);
    (window as unknown as { __seen: () => number }).__seen = () => seen;
  });
  await box.press('j');
  assert.equal(await page.evaluate(() => (window as unknown as { __seen: () => number }).__seen()), 0);
  await box.fill('');

  // The list, and deleting from it.
  await page.getByRole('button', { name: /Comments/ }).click();
  const items = page.locator('gloss-bar .item');
  assert.equal(await items.count(), 3);
  await items.first().getByRole('button', { name: 'Delete comment' }).click();
  await waitForCount(page, 2);
  assert.deepEqual(await comments(), ['Cart count is wrong', 'line one\nline two']);
  console.log('comments: added with Enter, Add and Shift+Enter; deleted from the list; read back from /api/state');

  // Submit and Approve are there, and only say they come later.
  // Forced: Playwright will not click an aria-disabled button, which is the point of it.
  await page.getByRole('button', { name: 'Submit' }).click({ force: true });
  assert.match(await page.locator('gloss-bar .note').innerText(), /later card/);
  const after = (await (await apiState()).json()) as RoundState;
  assert.equal(after.round, 1);
  assert.equal(after.comments.length, 2);

  // A reload loses nothing: the comments are the session's, not the page's.
  await page.reload();
  await page.locator('gloss-bar .bar').waitFor();
  await waitForCount(page, 2);
  console.log('reload: the bar came back with both comments');

  // A second open from the same directory moves the same window.
  const again = await gloss(['open', `${base}/?fixed`]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already open/);
  assert.equal(readState(ref)?.pid, first.pid);
  const pages = cdp!.contexts().flatMap((c) => c.pages());
  assert.equal(pages.length, 1, 'still one window');
  await until('the ?fixed page', () => pages[0]!.url().endsWith('/?fixed'));
  console.log('second open: reused the session and navigated its window');

  // A strict CSP does not keep the bar out, or unstyled.
  assert.equal((await gloss(['open', `${base}/?csp`])).code, 0);
  const cspPage = await windowPage();
  await until('the ?csp page', () => cspPage.url().endsWith('/?csp'));
  await cspPage.locator('gloss-bar .bar').waitFor();
  // No named functions inside: tsx's transform would wrap them in a helper
  // the page does not have.
  const csp = await cspPage.evaluate(
    () =>
      new Promise<{ enforced: boolean; barBackground: string; headerTop: number }>((resolve) => {
        let enforced = false;
        document.addEventListener('securitypolicyviolation', () => (enforced = true), { once: true });
        const probe = document.createElement('style');
        probe.textContent = 'body{}';
        document.head.append(probe);
        setTimeout(() => {
          const bar = document.querySelector('gloss-bar')!.shadowRoot!.querySelector('.bar')!;
          resolve({
            enforced,
            barBackground: getComputedStyle(bar).backgroundColor,
            headerTop: document.querySelector('.site-header')!.getBoundingClientRect().top,
          });
        }, 500);
      }),
  );
  assert.ok(csp.enforced, 'the ?csp page is really under a strict policy');
  assert.equal(csp.barBackground, 'rgb(14, 17, 22)');
  assert.ok(csp.headerTop >= 44);
  await waitForCount(cspPage, 2);
  console.log('csp: the bar mounted, styled, and reached the session under a strict policy');

  // gloss close ends it all.
  const closed = await gloss(['close']);
  assert.equal(closed.code, 0, closed.stderr);
  assert.ok(!existsSync(ref.statePath), 'the state file is gone');
  assert.ok(!pidAlive(first.pid), 'the session process is gone');
  assert.equal((await gloss(['status'])).code, 1);
  await disconnect();
  console.log('close: session ended, state file removed, status exits 1');

  // So does closing the window.
  assert.equal((await gloss(['open', `${base}/`])).code, 0);
  const second = readState(ref);
  assert.ok(second && second.pid !== first.pid);
  await (await windowPage()).close();
  await until('the session to end', () => !existsSync(ref.statePath) && !pidAlive(second.pid));
  assert.equal((await gloss(['status'])).code, 1);
  await disconnect();
  console.log('window closed: session ended and removed its state file');

  // No Chromium: a clear message, exit 1, and no session left behind.
  const missing = await gloss(['open', `${base}/`], { PLAYWRIGHT_BROWSERS_PATH: join(root, 'no-browsers') });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /npx playwright install chromium/);
  assert.ok(!existsSync(ref.statePath));
  console.log('no chromium: exits 1 and says to run npx playwright install chromium');

  console.log('\nopen-check: all good');
} finally {
  await disconnect();
  await gloss(['close']);
  dev.close();
  rmSync(root, { recursive: true, force: true });
}
