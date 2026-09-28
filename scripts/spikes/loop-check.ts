/**
 * Drives the review loop end to end, the way the Gloss skill does: the
 * reviewer's side through the session's window over DevTools, the agent's
 * through the binary. Two rounds, the agent working and ready between them,
 * then an approval that discards an unsent comment. Then it checks a script
 * in the page cannot submit or approve, and that `gloss wait` ends with no
 * verdict when the window is closed or the session is closed under it.
 *
 * Headless, with a temporary GLOSS_HOME, like open-check. Needs Chromium.
 *
 *   npx tsx scripts/spikes/loop-check.ts [--headed]
 */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createDevServer } from '../dev.js';
import { readState, sessionRef } from '../../src/session/state.js';
import type { RoundState } from '../../src/session/store.js';
import { verdictSchema, type Verdict } from '../../src/verdict.js';

const BIN = fileURLToPath(new URL('../../bin/gloss.js', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'gloss-loop-check-'));
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

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function gloss(args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { cwd, env, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

/** `gloss wait` left running, as the skill runs it in the background. */
function waitInBackground(args: string[] = []): Promise<Ran> {
  const child = spawn(process.execPath, [BIN, 'wait', ...args], { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise((resolve) => child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr })));
}

/** A wait that exited 0 with one JSON document on stdout and nothing else, parsed as the schema says. */
function verdictOf(ran: Ran): Verdict {
  assert.equal(ran.code, 0, `gloss wait failed:\n${ran.stderr}`);
  return verdictSchema.parse(JSON.parse(ran.stdout));
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

const dev = createDevServer();
await new Promise<void>((r) => dev.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(dev.address() as AddressInfo).port}`;
let cdp: Browser | null = null;

async function roundState(name = ''): Promise<RoundState> {
  const state = readState(sessionRef(cwd, name));
  assert.ok(state, 'no state file');
  const res = await fetch(`http://127.0.0.1:${state.port}/api/state`, { headers: { authorization: `Bearer ${state.token}` } });
  return (await res.json()) as RoundState;
}

async function windowPage(): Promise<Page> {
  cdp ??= await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
  return until('the session window', () => cdp!.contexts().flatMap((c) => c.pages()).at(-1));
}

async function disconnect(): Promise<void> {
  await cdp?.close().catch(() => {});
  cdp = null;
}

const bar = (page: Page, selector: string) => page.locator(`gloss-bar ${selector}`);
const statusText = (page: Page) => bar(page, '.status').innerText();

async function comment(page: Page, text: string): Promise<void> {
  const before = (await roundState()).comments.length;
  await bar(page, 'textarea').fill(text);
  await bar(page, 'textarea').press('Enter');
  await until(`the comment '${text}'`, async () => (await roundState()).comments.length === before + 1);
}

try {
  assert.equal((await gloss(['open', `${base}/`])).code, 0);
  let page = await windowPage();
  await bar(page, '.bar').waitFor();

  // Nothing to submit yet.
  assert.ok(await bar(page, '.submit').isDisabled(), 'Submit is disabled with no comments');

  // Round 1: two comments, Submit, and wait prints them.
  await comment(page, 'The header is too tall');
  await comment(page, 'Cart count is wrong');
  const waiting = waitInBackground();
  await sleep(500);
  await bar(page, '.submit').click();
  const round1 = verdictOf(await waiting);
  assert.deepEqual(
    [round1.version, round1.approved, round1.round, round1.page],
    [1, false, 1, `${base}/`],
  );
  assert.deepEqual(round1.comments.map((c) => [c.body, c.kind, c.sentIn, c.page, c.target]), [
    ['The header is too tall', 'general', 1, `${base}/`, null],
    ['Cart count is wrong', 'general', 1, `${base}/`, null],
  ]);
  await until('the sent status', async () => /Sent round 1, waiting for Claude/.test(await statusText(page)));
  console.log('round 1: Submit, then wait printed version 1, approved false, both comments and the page');

  // Asked again before the agent moves, the same round.
  assert.deepEqual(verdictOf(await gloss(['wait'])), round1);
  console.log('wait again: the same round 1, not a new one');

  // Working: the bar says so, and nothing can be submitted or approved.
  const working = await gloss(['working', 'Fixing', 'the', 'header']);
  assert.equal(working.code, 0, working.stderr);
  await until('the working status', async () => (await statusText(page)) === 'Claude is working: Fixing the header');
  await comment(page, 'Written while Claude works');
  assert.ok(await bar(page, '.submit').isDisabled(), 'Submit is disabled while Claude works');
  assert.ok(await bar(page, '.bar > .approve').isDisabled(), 'Approve is disabled while Claude works');
  const refused = await gloss(['wait']);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /gloss ready/);
  console.log('working: the bar shows the message, Submit and Approve are off, and wait says to run gloss ready');

  // Ready: the page reloads, and the summary shows.
  await page.evaluate(() => ((window as unknown as { __before: boolean }).__before = true));
  const ready = await gloss(['ready', 'Tightened the header']);
  assert.equal(ready.code, 0, ready.stderr);
  page = await windowPage();
  await bar(page, '.bar').waitFor();
  assert.equal(await page.evaluate(() => (window as unknown as { __before?: boolean }).__before), undefined, 'the page reloaded');
  await until('the summary', async () => (await statusText(page)) === 'Claude: Tightened the header');
  assert.ok(await bar(page, '.submit').isEnabled(), 'Submit is back, with the comment written while Claude worked');
  console.log('ready: the page reloaded and the bar shows the summary');

  // Round 1's comments are still there, marked sent, with no delete.
  await bar(page, '.toggle').click();
  assert.equal(await bar(page, '.group').innerText(), 'SENT IN ROUND 1');
  assert.equal(await bar(page, '.item.sent').count(), 2);
  assert.equal(await bar(page, '.item.sent .delete').count(), 0);
  assert.equal(await bar(page, '.item:not(.sent) .delete').count(), 1);
  await bar(page, '.toggle').click();
  console.log('list: round 1 marked sent, read-only; the new comment deletable');

  // Round 2 carries only what was written since.
  await comment(page, 'Round two');
  const waiting2 = waitInBackground();
  await sleep(300);
  await bar(page, '.submit').click();
  const round2 = verdictOf(await waiting2);
  assert.equal(round2.round, 2);
  assert.deepEqual(round2.comments.map((c) => c.body), ['Written while Claude works', 'Round two']);
  assert.equal((await gloss(['working'])).code, 0);
  assert.equal((await gloss(['ready', 'Moved', 'the', 'cart'])).code, 0);
  page = await windowPage();
  await bar(page, '.bar').waitFor();
  console.log('round 2: only the two new comments, as round 2');

  // A script in the page cannot submit or approve, by any route found.
  await comment(page, 'Something to submit');
  // Plain script, as the page would run it (and out of reach of tsx's transform).
  const forged = (await page.evaluate(`(async () => {
    const controller = window.__playwright__binding__controller__;
    const approve = JSON.stringify({ method: 'approve', discardUnsent: true });
    const root = document.querySelector('gloss-bar').shadowRoot;
    root.querySelector('.submit').click();
    root.querySelector('.approve').click();
    const results = { glossRpc: typeof window.__glossRpc, rawBinding: typeof window.__playwright__binding__ };
    results.controllerCall = await controller
      .callBinding('__glossRpc', approve)
      .then(() => 'answered', (e) => 'refused: ' + e.message);
    try { window.__playwright__binding__controller__ = {}; } catch {}
    results.controllerReplaced = window.__playwright__binding__controller__ !== controller;
    // A toJSON the page defines would rewrite whatever the bar sends next.
    Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value: () => [approve] });
    root.querySelector('textarea').value = 'sent through a patched toJSON';
    root.querySelector('.add').click();
    await new Promise((r) => setTimeout(r, 300));
    delete Array.prototype.toJSON;
    results.toJSON = root.querySelector('.error').textContent;
    return results;
  })()`)) as { glossRpc: string; rawBinding: string; controllerCall: string; controllerReplaced: boolean; toJSON: string | null };
  assert.equal(forged.glossRpc, 'undefined', '__glossRpc is off window');
  assert.equal(forged.rawBinding, 'undefined', "Playwright's raw binding is off window");
  assert.match(forged.controllerCall, /^refused/, "the controller's stand-in will not call the binding");
  assert.equal(forged.controllerReplaced, false, 'the stand-in cannot be swapped out');
  assert.match(forged.toJSON ?? '', /changed how JSON is written/, 'a patched toJSON stops the bar sending');
  const afterForgery = await roundState();
  assert.equal(afterForgery.phase, 'reviewing', 'no submission or approval from the page');
  assert.equal(afterForgery.round, 3);
  console.log('page script: no __glossRpc, no raw binding, the controller refuses, clicks and a patched toJSON do nothing');

  // Approve with an unsent comment: the prompt, Cancel, then discard and approve.
  await bar(page, '.bar > .approve').click();
  assert.match(await bar(page, '.confirm-text').innerText(), /Approve and discard 1 unsent comment\?/);
  await bar(page, '.confirm button').filter({ hasText: 'Cancel' }).click();
  assert.ok(await bar(page, '.bar > .approve').isVisible());
  assert.deepEqual([(await roundState()).phase, (await roundState()).comments.length], ['reviewing', 5]);
  const waiting3 = waitInBackground();
  await sleep(300);
  await bar(page, '.bar > .approve').click();
  await bar(page, '.confirm button').filter({ hasText: 'Discard & approve' }).click();
  const approved = verdictOf(await waiting3);
  assert.deepEqual([approved.approved, approved.round, approved.comments], [true, 3, []]);
  const end = await roundState();
  assert.equal(end.phase, 'approved');
  assert.ok(!end.comments.some((c) => c.body === 'Something to submit'), 'the discarded comment is gone');
  assert.ok(end.comments.every((c) => c.sentIn !== null));
  await until('the approved status', async () => (await statusText(page)) === 'Approved');
  console.log('approve: the prompt counts 1 unsent, Cancel keeps it, Discard & approve prints approved true with no comments');

  assert.equal((await gloss(['close'])).code, 0);
  await disconnect();

  // No session: exit 1, nothing on stdout.
  const none = await gloss(['wait']);
  assert.deepEqual([none.code, none.stdout], [1, '']);
  assert.match(none.stderr, /no Gloss session is running/);

  // The window closed under a wait: exit 1, a reason, nothing on stdout.
  assert.equal((await gloss(['open', `${base}/`])).code, 0);
  const cut = waitInBackground();
  await sleep(800);
  await (await windowPage()).close();
  const closedWindow = await cut;
  assert.deepEqual([closedWindow.code, closedWindow.stdout], [1, '']);
  assert.match(closedWindow.stderr, /the window was closed|session ended/);
  await disconnect();
  await until('the session to end', async () => (await gloss(['status'])).code === 1);

  // gloss close under a wait: the same.
  assert.equal((await gloss(['open', `${base}/`])).code, 0);
  const cut2 = waitInBackground();
  await sleep(800);
  assert.equal((await gloss(['close'])).code, 0);
  const closedSession = await cut2;
  assert.deepEqual([closedSession.code, closedSession.stdout], [1, '']);
  assert.match(closedSession.stderr, /asked to close|session ended/);
  console.log(`no verdict: no session, window closed ("${closedWindow.stderr.trim().split('\n').at(-1)}"), gloss close: exit 1, empty stdout`);

  console.log('\nloop-check: all good');
} finally {
  await disconnect();
  await gloss(['close']);
  dev.close();
  rmSync(root, { recursive: true, force: true });
}
