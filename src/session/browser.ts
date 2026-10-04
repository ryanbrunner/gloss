import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { z } from 'zod';
import { bundleBar } from '../bar/bundle.js';
import { BAR_HEIGHT } from '../bar/styles.js';
import { STATE_EVENT } from '../bar/transport.js';
import { firstLine } from './server.js';
import type { Box, CommentStore, Pin, RoundState } from './store.js';

/**
 * The browser half of a session: a Playwright Chromium whose every page gets
 * the bar.
 *
 * Playwright rather than a proxy that rewrites the dev server's HTML. The page
 * loads from its real origin, untouched: no decompressing and rewriting
 * responses, no relaying HMR websockets, no stripping CSP or X-Frame-Options.
 * An init script runs whatever the page's CSP says, and the bar talks to the
 * session through an exposed binding rather than `fetch`, so `connect-src`
 * cannot cut it off either. Registered on the context, both follow the
 * reviewer into new tabs and across reloads.
 *
 * The session process owns the browser, because a Chromium Playwright
 * launched dies with the process that launched it.
 */

const INSTALL_HINT = 'Run `gloss install-chromium`.';
const WITH_DEPS_HINT = 'Run `gloss install-chromium --with-deps`.';

/** Why Chromium cannot start, before trying: said by `gloss open` rather than found in a log. */
export function chromiumMissing(): string | null {
  const path = chromium.executablePath();
  return existsSync(path) ? null : `Chromium is not installed (there is nothing at ${path}). ${INSTALL_HINT}`;
}

/**
 * Whether a launch failure is Playwright's own shared-library error: the
 * executable is there but a Linux box is missing the system libraries
 * `--with-deps` installs. Playwright's CLI matches the same text to tell the
 * two cases apart (see its `cannot open shared object file` check).
 */
export function missingSystemLibraries(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes('cannot open shared object file: No such file or directory');
}

export class BrowserUnavailable extends Error {}

const box = z.object({ x: z.number(), y: z.number(), width: z.number().min(0), height: z.number().min(0) });

/** A pin as the page sends it: everything but the screenshot, which only the session takes. */
const pinDraft = z.strictObject({
  url: z.string().max(4_000),
  selector: z.string().min(1).max(4_000),
  tag: z.string().max(100),
  text: z.string().max(1_000),
  box,
  viewport: z.object({ width: z.number().min(0), height: z.number().min(0) }),
  quote: z.string().max(4_000).optional(),
});

const rpcCall = z.discriminatedUnion('method', [
  z.object({ method: z.literal('state') }),
  z.object({ method: z.literal('add'), body: z.string().max(20_000), pin: pinDraft.optional() }),
  z.object({ method: z.literal('remove'), id: z.string() }),
  z.object({ method: z.literal('edit'), id: z.string(), body: z.string().max(20_000) }),
  z.object({ method: z.literal('submit') }),
  z.object({ method: z.literal('approve'), discardUnsent: z.boolean() }),
]);

/** Takes a picture of a pinned element, and says where it put it, or nothing if it could not. */
export type Capture = (pin: Pin) => Promise<string | undefined>;

/** Where a call on the binding came from, as Playwright saw it rather than as the page says. */
export interface RpcSource {
  /** The URL of the page that made it. */
  url: string;
  /** Whether it came from the page itself rather than a frame inside it, where the bar never is. */
  topFrame: boolean;
}

/**
 * What the bar asks of the session, answered with the round as it stands.
 * The call is JSON, as `sealBinding` in ../bar/transport.ts sends it. The page
 * may still find a way to call the binding, so what it sends is checked, and
 * nothing that changes the round is taken from a frame, or from a page that
 * is not on http or https (a blank popup the page opened and scripts).
 */
export async function handleRpc(
  store: CommentStore,
  json: unknown,
  from: RpcSource,
  capture?: Capture,
): Promise<RoundState> {
  let call: unknown;
  try {
    call = typeof json === 'string' ? JSON.parse(json) : null;
  } catch {
    call = null;
  }
  const parsed = rpcCall.safeParse(call);
  if (!parsed.success) throw new Error('Gloss did not understand that request');
  const { data } = parsed;
  if (data.method === 'state') return store.snapshot();
  if (!from.topFrame || !/^https?:/.test(from.url)) throw new Error('Gloss takes changes only from the page under review');
  if (data.method === 'add') {
    // The draft is the page's; the screenshot is the session's alone.
    const pin: Pin | undefined = data.pin && { ...data.pin };
    if (pin && data.body.trim() && capture) pin.screenshot = await capture(pin);
    store.add(data.body, from.url, pin);
  }
  if (data.method === 'remove') store.remove(data.id);
  // The pin does not move, so the screenshot taken for it still stands.
  if (data.method === 'edit') store.edit(data.id, data.body);
  if (data.method === 'submit') store.submit(from.url);
  if (data.method === 'approve') store.approve(from.url, { discardUnsent: data.discardUnsent });
  return store.snapshot();
}

/**
 * The part of an element's box to photograph, in the viewport's coordinates:
 * what is on screen and not under the bar. Null when none of it is.
 */
export function visibleClip(
  pin: Pin,
  view: { scrollX: number; scrollY: number; width: number; height: number },
): Box | null {
  const left = Math.max(pin.box.x - view.scrollX, 0);
  const top = Math.max(pin.box.y - view.scrollY, BAR_HEIGHT);
  const right = Math.min(pin.box.x - view.scrollX + pin.box.width, view.width);
  const bottom = Math.min(pin.box.y - view.scrollY + pin.box.height, view.height);
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Photographs a pinned element on the page that pinned it, while it is still
 * where the reviewer saw it. The bar hides its own markers for the moment
 * this takes, so the picture is of the page alone.
 */
async function screenshot(page: Page, pin: Pin, dir: string, name: string): Promise<string | undefined> {
  try {
    const view = await page.evaluate(() => ({ scrollX, scrollY, width: innerWidth, height: innerHeight }));
    const clip = visibleClip(pin, view);
    if (!clip) return undefined;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.png`);
    await page.screenshot({ path, clip });
    return path;
  } catch (e) {
    console.error(`[gloss] could not photograph ${pin.selector}: ${firstLine(e)}`);
    return undefined;
  }
}

export interface SessionBrowser {
  /** The page most recently opened, where it is now. */
  currentUrl(): string | null;
  navigate(url: string): Promise<void>;
  /** Reloads every page, so each shows the agent's latest. A page that cannot reload is left as it is. */
  reload(): Promise<void>;
  /** Settles when the last page is closed or the browser goes away. */
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface BrowserOptions {
  headless: boolean;
  /** A DevTools port, so the end-to-end spike can look inside the window. */
  cdpPort?: number;
  /** Where pinned elements' screenshots go. */
  shotsDir: string;
}

export async function openBrowser(url: string, store: CommentStore, options: BrowserOptions): Promise<SessionBrowser> {
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: options.headless,
      args: options.cdpPort ? [`--remote-debugging-port=${options.cdpPort}`] : [],
    });
  } catch (cause) {
    const hint = missingSystemLibraries(cause) ? WITH_DEPS_HINT : INSTALL_HINT;
    throw new BrowserUnavailable(`could not start Chromium (${firstLine(cause)}). ${hint}`);
  }

  // A headed window without `viewport: null` is pinned to 1280×720 however
  // it is resized. Headless has no window to follow, so it gets a size.
  const context = await browser.newContext({
    viewport: options.headless ? { width: 1280, height: 800 } : null,
    ignoreHTTPSErrors: true,
  });
  let shots = 0;
  await context.exposeBinding('__glossRpc', (source, call: unknown) =>
    handleRpc(
      store,
      call,
      { url: source.page.url(), topFrame: source.frame === source.page.mainFrame() },
      (pin) => screenshot(source.page, pin, options.shotsDir, `pin-${++shots}`),
    ),
  );
  await context.addInitScript({ content: await bundleBar('session') });

  // Every tab is told of each change, so two tabs on the same round agree.
  // A page part-way through navigating throws; it asks for the state anyway
  // once its new bar mounts.
  store.onChange((state) => {
    for (const page of context.pages()) {
      page
        .evaluate(([event, detail]) => window.dispatchEvent(new CustomEvent(event, { detail })), [STATE_EVENT, state] as const)
        .catch(() => {});
    }
  });

  // Closing the window does not disconnect a launched browser: left alone,
  // the session would sit there with nothing to show. The last page closing
  // is the reviewer saying they are done.
  let settle = () => {};
  const closed = new Promise<void>((resolve) => (settle = resolve));
  const watch = (page: Page) => page.on('close', () => context.pages().length === 0 && settle());
  context.on('page', watch);
  browser.on('disconnected', () => settle());

  const first = await context.newPage();
  // A dev server that is down is the page's problem, not the session's: the
  // window shows Chromium's error, and a later `gloss open` can go elsewhere.
  await first.goto(url, { waitUntil: 'domcontentloaded' }).catch((e: unknown) => {
    console.error(`[gloss] could not open ${url}: ${firstLine(e)}`);
  });

  const current = () => context.pages().at(-1) ?? null;
  return {
    currentUrl: () => current()?.url() ?? null,
    navigate: async (to) => {
      const page = current() ?? (await context.newPage());
      await page.bringToFront();
      await page.goto(to, { waitUntil: 'domcontentloaded' });
    },
    reload: async () => {
      await Promise.all(context.pages().map((page) => page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})));
    },
    closed,
    close: () => browser.close().catch(() => {}),
  };
}
