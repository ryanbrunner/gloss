import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { bundleBar } from '../bar/bundle.js';
import { attachBar, type BarChannel } from './channel.js';
import { firstLine } from './server.js';
import type { CommentStore } from './store.js';

/**
 * The browser half of a session: a Playwright Chromium whose every page gets
 * the bar.
 *
 * Playwright rather than a proxy that rewrites the dev server's HTML. The page
 * loads from its real origin, untouched: no decompressing and rewriting
 * responses, no relaying HMR websockets, no stripping CSP or X-Frame-Options.
 * A script added over CDP runs whatever the page's CSP says, and the bar
 * talks to the session through a binding rather than `fetch`, so
 * `connect-src` cannot cut it off either. Both live in a world of their own
 * (see ./channel.ts), and follow the reviewer into new tabs and across
 * reloads.
 *
 * The session process owns the browser, because a Chromium Playwright
 * launched dies with the process that launched it.
 */

const INSTALL_HINT = 'Run `npx playwright install chromium`.';

/** Why Chromium cannot start, before trying: said by `gloss open` rather than found in a log. */
export function chromiumMissing(): string | null {
  const path = chromium.executablePath();
  return existsSync(path) ? null : `Chromium is not installed (there is nothing at ${path}). ${INSTALL_HINT}`;
}

export class BrowserUnavailable extends Error {}

export interface SessionBrowser {
  /** The page most recently opened, where it is now. */
  currentUrl(): string | null;
  navigate(url: string): Promise<void>;
  /** Settles when the last page is closed or the browser goes away. */
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface BrowserOptions {
  headless: boolean;
  /** A DevTools port, so the end-to-end spike can look inside the window. */
  cdpPort?: number;
}

export async function openBrowser(url: string, store: CommentStore, options: BrowserOptions): Promise<SessionBrowser> {
  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: options.headless,
      args: options.cdpPort ? [`--remote-debugging-port=${options.cdpPort}`] : [],
    });
  } catch (cause) {
    throw new BrowserUnavailable(`could not start Chromium (${firstLine(cause)}). ${INSTALL_HINT}`);
  }

  // A headed window without `viewport: null` is pinned to 1280×720 however
  // it is resized. Headless has no window to follow, so it gets a size.
  const context = await browser.newContext({
    viewport: options.headless ? { width: 1280, height: 800 } : null,
    ignoreHTTPSErrors: true,
  });
  const script = await bundleBar('session');
  const channels = new Map<Page, Promise<BarChannel>>();
  const attach = (page: Page) => {
    let channel = channels.get(page);
    if (!channel) {
      channel = attachBar(page, script, store);
      channels.set(page, channel);
      page.on('close', () => channels.delete(page));
    }
    return channel;
  };
  // A tab the page opens may have loaded before it is attached; the bar
  // mounts on what it shows then, and on everything after.
  context.on('page', (page) => {
    attach(page).catch((e: unknown) => console.error(`[gloss] could not put the bar on ${page.url()}: ${firstLine(e)}`));
  });

  // Every tab is told of each change, so two tabs on the same round agree.
  // A page part-way through navigating has no bar to tell; it asks for the
  // state anyway once its new bar mounts.
  store.onChange((state) => {
    for (const channel of channels.values()) channel.then((c) => c.push(state), () => {});
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
  await attach(first);
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
      await attach(page);
      await page.bringToFront();
      await page.goto(to, { waitUntil: 'domcontentloaded' });
    },
    closed,
    close: () => browser.close().catch(() => {}),
  };
}
