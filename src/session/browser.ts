import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import { BINDING, DELIVER, type Delivery } from '#core/bar/transport.js';
import { answerRpc, visibleClip, type Capture } from '#core/rpc.js';
import type { CommentStore, Pin } from '#core/store.js';
import { firstLine } from '#core/util.js';
import { bundleBar } from './bundle.js';

/**
 * The browser half of a session: a Playwright Chromium whose every page gets
 * the bar.
 *
 * Playwright rather than a proxy that rewrites the dev server's HTML. The page
 * loads from its real origin, untouched: no decompressing and rewriting
 * responses, no relaying HMR websockets, no stripping CSP or X-Frame-Options.
 * A script run on each new document runs whatever the page's CSP says, and
 * the bar talks to the session through a DevTools binding rather than
 * `fetch`, so `connect-src` cannot cut it off either. Set up on every page as
 * it opens, both follow the reviewer into new tabs and across reloads.
 *
 * Both are set up over DevTools rather than with Playwright's `addInitScript`
 * and `exposeBinding`, because those put the bar and its binding in the
 * page's own JavaScript world. There the page, which is the code the agent is
 * editing, could replace a builtin the call path uses and forge an approval.
 * In a world of the bar's own, it cannot reach the binding at all.
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
 * Whether a launch failure is Playwright's own check for missing system
 * libraries: the executable is there, but `launch()` ran `ldd` over it
 * before ever spawning it and found a Linux box missing what
 * `--with-deps` installs. That failure carries this exact line (see
 * `validateDependenciesLinux` in Playwright, which throws it ahead of any
 * "cannot open shared object file" error the process itself would raise).
 */
export function missingSystemLibraries(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes('missing dependencies to run browsers');
}

export class BrowserUnavailable extends Error {}

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

/** The isolated world the bar runs in, apart from the page's scripts. */
const WORLD = 'gloss';

/** A page's own DevTools session, and the bar's world in each of its frames. */
interface BarPage {
  cdp: CDPSession;
  mainFrame: string;
  /** Execution context id to frame id, for every frame's gloss world. */
  worlds: Map<number, string>;
}

/**
 * Puts the bar in `page`, in the gloss world of every frame, now and on every
 * new document, and answers its calls from `store`, photographing pinned
 * elements with `capture`.
 */
async function injectBar(page: Page, bundle: string, store: CommentStore, capture: Capture): Promise<BarPage> {
  const cdp = await page.context().newCDPSession(page);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const bar: BarPage = { cdp, mainFrame: frameTree.frame.id, worlds: new Map() };
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    const frame = context.auxData?.frameId;
    if (context.name === WORLD && frame) bar.worlds.set(context.id, frame);
  });
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => bar.worlds.delete(executionContextId));
  cdp.on('Runtime.executionContextsCleared', () => bar.worlds.clear());
  cdp.on('Runtime.bindingCalled', ({ name, payload, executionContextId }) => {
    if (name !== BINDING) return;
    const topFrame = bar.worlds.get(executionContextId) === bar.mainFrame;
    void answerRpc(store, payload, { url: page.url(), topFrame }, capture).then((reply) => {
      if (reply) void deliver(bar, executionContextId, reply);
    });
  });
  // Without the Page domain on, this session's scripts run only in the
  // documents there now, and none after a navigation.
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // The binding first, so the world the script creates has it. `runImmediately`
  // also runs the script in the documents already there: a popup's first one
  // can load before Playwright announces the page.
  await cdp.send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle, worldName: WORLD, runImmediately: true });
  return bar;
}

/**
 * Hands the bar an answer or the latest round, in the world it called from.
 * A world gone with its document is nothing to tell.
 */
async function deliver(bar: BarPage, contextId: number, delivery: Delivery): Promise<void> {
  await bar.cdp
    .send('Runtime.evaluate', { expression: `globalThis.${DELIVER}(${JSON.stringify(delivery)})`, contextId })
    .catch(() => {});
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
  const bundle = await bundleBar('session');
  let shots = 0;

  // Closing the window does not disconnect a launched browser: left alone,
  // the session would sit there with nothing to show. The last page closing
  // is the reviewer saying they are done.
  let settle = () => {};
  const closed = new Promise<void>((resolve) => (settle = resolve));
  browser.on('disconnected', () => settle());

  // Each page gets the bar as Playwright announces it, and anything about to
  // navigate a page waits for it first. A page closed part-way through has
  // nothing to show it in.
  const bars = new Map<Page, Promise<BarPage | null>>();
  const barOf = (page: Page) => {
    let bar = bars.get(page);
    if (!bar) {
      const capture: Capture = (pin) => screenshot(page, pin, options.shotsDir, `pin-${++shots}`);
      bar = injectBar(page, bundle, store, capture).catch((e: unknown) => {
        if (!page.isClosed()) console.error(`[gloss] could not put the bar in ${page.url()}: ${firstLine(e)}`);
        return null;
      });
      bars.set(page, bar);
      page.on('close', () => {
        bars.delete(page);
        if (context.pages().length === 0) settle();
      });
    }
    return bar;
  };
  context.on('page', (page) => void barOf(page));

  // Every tab is told of each change, so two tabs on the same round agree.
  // A world on its way out throws; the bar in the next one asks for the
  // state anyway once it mounts.
  store.onChange((state) => {
    for (const bar of bars.values()) {
      void bar.then((b) => {
        if (!b) return;
        for (const [contextId, frame] of b.worlds) if (frame === b.mainFrame) void deliver(b, contextId, { state });
      });
    }
  });

  const first = await context.newPage();
  await barOf(first);
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
      await barOf(page);
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
