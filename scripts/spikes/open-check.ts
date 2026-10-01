/**
 * Drives `gloss open`, `status` and `close` end to end, the way Claude would:
 * through the binary, against the demo storefront, reading exit statuses and
 * the session's API. Then it looks inside the session's window over DevTools
 * to check the bar is where it should be and does what it should.
 *
 * Chromium runs headless (`GLOSS_HEADLESS=1`) with a DevTools port
 * (`GLOSS_CDP_PORT`), and the state files go to a temporary `GLOSS_HOME`, so
 * none of it touches a real session. Needs Chromium: `gloss install-chromium`.
 * Not part of `npm test`, so CI without a browser stays green.
 * `--headed` shows the real window instead, for a few seconds.
 *
 *   npx tsx scripts/spikes/open-check.ts [--headed]
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  // A fixed header is moved down out from under the bar.
  const fixedHeaderTop = () =>
    pages[0]!.evaluate(() => document.querySelector('.site-header')!.getBoundingClientRect().top);
  await until('the fixed header below the bar', async () => (await fixedHeaderTop()) === 44);
  console.log('fixed header: moved down below the bar');

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

  // Pinning, on the same strict page: in Select mode a click on the page picks.
  const inBar = (selector: string) => cspPage.locator(`gloss-bar ${selector}`);
  const pressed = (name: string) => cspPage.getByRole('button', { name, exact: true }).getAttribute('aria-pressed');
  await cspPage.getByRole('button', { name: 'Select', exact: true }).click();
  assert.equal(await pressed('Select'), 'true');
  assert.equal(await pressed('Interact'), 'false');
  await cspPage.getByRole('link', { name: 'Cart (2)' }).click();
  await inBar('.composer').waitFor();
  assert.equal(await cspPage.evaluate(() => location.hash), '', 'the link was not followed');
  assert.equal(await inBar('.composer-heading').innerText(), 'Comment on a · Cart (2)');
  await cspPage.keyboard.press('Escape');
  await inBar('.composer').waitFor({ state: 'detached' });
  assert.equal(await pressed('Select'), 'true', 'Escape closed the box, and left Select mode on');

  // The bar's own buttons still work.
  await cspPage.getByRole('button', { name: /Comments/ }).click();
  assert.equal(await inBar('.toggle').getAttribute('aria-expanded'), 'true');
  await cspPage.getByRole('button', { name: /Comments/ }).click();
  assert.equal(await inBar('.toggle').getAttribute('aria-expanded'), 'false');

  // Hovering outlines the element, exactly.
  const total = cspPage.getByText('Total $43.20');
  await total.hover();
  await until('the Total outlined', () =>
    cspPage.evaluate(() => {
      const el = document.querySelector('#summary p:last-of-type')!.getBoundingClientRect();
      const outline = document.querySelector('gloss-bar')!.shadowRoot!.querySelector('.highlight:not(.picked)')!;
      const box = outline.getBoundingClientRect();
      return (
        !outline.hasAttribute('hidden') &&
        [box.left - el.left, box.top - el.top, box.width - el.width, box.height - el.height].every((d) => Math.abs(d) < 1)
      );
    }),
  );

  // Click, type, Enter: a comment pinned to exactly that element.
  await total.click();
  await inBar('.composer').waitFor();
  assert.equal(await inBar('.composer-heading').innerText(), 'Comment on p · Total $43.20');
  assert.ok(
    await cspPage.evaluate(() => {
      const root = document.querySelector('gloss-bar')!.shadowRoot!;
      return root.activeElement === root.querySelector('.composer textarea');
    }),
    'the cursor is in the comment box',
  );
  await cspPage.keyboard.type('Show shipping above the total');
  await cspPage.keyboard.press('Enter');
  await waitForCount(cspPage, 3);
  await inBar('.composer').waitFor({ state: 'detached' });
  const pinned = ((await (await apiState()).json()) as RoundState).comments.at(-1)!;
  assert.equal(pinned.body, 'Show shipping above the total');
  assert.ok(pinned.pin, 'the comment has a pin');
  assert.equal(pinned.pin.selector, '#summary > p:nth-of-type(3)');
  assert.ok(
    await cspPage.evaluate((selector) => {
      const found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === document.querySelector('#summary p:last-of-type');
    }, pinned.pin.selector),
    `${pinned.pin.selector} matches the Total and nothing else`,
  );
  assert.deepEqual([pinned.pin.tag, pinned.pin.text], ['p', 'Total $43.20']);
  assert.equal(await pressed('Select'), 'true', 'still in Select mode after adding');

  // The session's photograph is of the page alone: the storefront is grey
  // and white, so a blue pixel is the outline, a marker or the comment box.
  assert.ok(pinned.pin.screenshot && existsSync(pinned.pin.screenshot), 'the screenshot was written');
  const blue = await cspPage.evaluate(async (png) => {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 2]! > data[i]! + 24) count++;
    return { count, width: bitmap.width, height: bitmap.height };
  }, readFileSync(pinned.pin.screenshot).toString('base64'));
  assert.ok(blue.width > 100 && blue.height > 10, `the screenshot is ${blue.width}×${blue.height}`);
  assert.equal(blue.count, 0, 'nothing the bar draws is in the screenshot');

  // A marker sits on the element's top right corner, and follows it as the page scrolls.
  const markerOnTotal = (sent: boolean) =>
    cspPage.evaluate((sent) => {
      const marker = document.querySelector('gloss-bar')!.shadowRoot!.querySelector('.marker');
      if (!marker || marker.hasAttribute('hidden') || marker.classList.contains('sent') !== sent) return false;
      const m = marker.getBoundingClientRect();
      const el = document.querySelector('#summary p:last-of-type')!.getBoundingClientRect();
      return marker.textContent === '1' && Math.abs(m.left + m.width / 2 - el.right) < 1 && Math.abs(m.top + m.height / 2 - el.top) < 1;
    }, sent);
  await until('the marker on the Total', () => markerOnTotal(false));
  await cspPage.evaluate(() => {
    document.body.style.paddingBottom = '100vh';
    scrollTo(0, 60);
  });
  assert.equal(await cspPage.evaluate(() => scrollY), 60);
  await until('the marker on the scrolled Total', () => markerOnTotal(false));
  await cspPage.evaluate(() => {
    scrollTo(0, 0);
    document.body.style.paddingBottom = '';
  });

  // The list numbers it the same way.
  await cspPage.getByRole('button', { name: /Comments/ }).click();
  const item = inBar('.item').filter({ hasText: 'Show shipping above the total' });
  assert.equal(await item.locator('.num').innerText(), '1');
  assert.equal(await item.locator('.meta').innerText(), 'p · Total $43.20');
  await cspPage.keyboard.press('Escape');

  // Escape with nothing open goes back to Interact.
  await cspPage.keyboard.press('Escape');
  assert.equal(await pressed('Interact'), 'true');
  console.log(`pin: picked the Total in Select mode, pinned ${pinned.pin.selector}, photographed without the overlay`);

  // A reload brings the marker back.
  await cspPage.reload();
  await cspPage.locator('gloss-bar .bar').waitFor();
  await until('the marker after a reload', () => markerOnTotal(false));

  // Submit works from Select mode; once Claude is ready, the marker is dimmed.
  await cspPage.getByRole('button', { name: 'Select', exact: true }).click();
  await cspPage.getByRole('button', { name: 'Submit', exact: true }).click();
  await until('the round submitted', async () => ((await (await apiState()).json()) as RoundState).phase === 'submitted');
  await cspPage.getByRole('button', { name: 'Interact', exact: true }).click();
  assert.equal(await pressed('Interact'), 'true');
  const ready = await gloss(['ready', 'Moved shipping above the total']);
  assert.equal(ready.code, 0, ready.stderr);
  await until('the dimmed marker', () => markerOnTotal(true));
  // A sent pin whose element is gone has no marker.
  await cspPage.evaluate(() => document.querySelector('#summary p:last-of-type')!.remove());
  await until('no marker for the gone element', () =>
    cspPage.evaluate(() => document.querySelector('gloss-bar')!.shadowRoot!.querySelector('.marker')!.hasAttribute('hidden')),
  );
  console.log('markers: on the element through a scroll and a reload, dimmed once sent, gone with the element');

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
  assert.match(missing.stderr, /Run `gloss install-chromium`/);
  assert.ok(!existsSync(ref.statePath));
  console.log('no chromium: exits 1 and says to run gloss install-chromium');

  console.log('\nopen-check: all good');
} finally {
  await disconnect();
  await gloss(['close']);
  dev.close();
  rmSync(root, { recursive: true, force: true });
}
