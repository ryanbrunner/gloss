/**
 * The demo server: the fixture storefront, for trying Gloss against and for
 * the pictures Reeve takes of the bar.
 *
 *   npm run dev -- -port 4400
 *
 * `/` is the storefront alone, a page to point `gloss open` at. The rest are
 * query flags, so every state of the bar is reachable by URL:
 *
 *   ?gloss    the bar, mounted in the page with comments kept in memory. The
 *             real thing comes from `gloss open`; this is the same bundle.
 *   &seed=N   start with N comments already written
 *   &sent=N   and N more already sent to Claude, two to a round
 *   &phase=   submitted, working or approved: where the round has got to
 *   &msg=     what Claude says it is doing, with phase=working
 *   &summary= what Claude says it changed, back with the reviewer
 *   &list     start with the comment list open
 *   &confirm  start with the discard-and-approve prompt open
 *   &pins=N   pin the first N of those comments, sent ones first, to SEED_TARGETS
 *   &select   start in Select mode
 *   &pick=N   start in Select mode with SEED_TARGETS' Nth (from 1) picked and the comment box open
 *   ?fixed    a header that is position: fixed rather than sticky
 *   ?fullheight
 *             an app shell sized to 100vh, with the products scrolling
 *             inside it rather than the page
 *   ?csp      sent with a strict Content-Security-Policy. `gloss open` still
 *             gets its bar onto it; `?gloss` does not, as its script is inline.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleBar } from '../src/bar/bundle.js';
import type { Mode } from '../src/bar/bar.js';
import type { DemoRound, DemoTarget } from '../src/bar/transport.js';

const FIXTURE = new URL('../fixtures/storefront/', import.meta.url);
const DEFAULT_PORT = 4400;

export const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'";

/** What `&sent=N` and then `&seed=N` fill the list with, in order. */
export const SEED_COMMENTS = [
  'The product cards feel cramped — more space between the image and price.',
  'Order summary should show shipping before the total.',
  'Cart (2) in the header should link to a cart page, not the summary.',
  'Prices need a currency for customers outside the US.',
  'The Add to cart buttons are hard to see on the pale cards.',
  'The footer links are too small to tap on a phone.',
];

/**
 * The storefront element each of SEED_COMMENTS is about, for `&pins` and
 * `&pick`. Those flags take a number rather than a selector, whose `#` would
 * end the query and start the URL's fragment.
 */
export const SEED_TARGETS: DemoTarget[] = [
  { selector: '.products > article:nth-of-type(1)', tag: 'article', text: 'Canvas tote $24.00' },
  // A suggested edit, so `&pins=2` shows one beside a plain comment-on-selection item.
  { selector: '#summary > p:nth-of-type(3)', tag: 'p', text: 'Total $43.20', quote: '$43.20', suggestion: '$43.20 (incl. shipping)' },
  { selector: '.site-header > .cart', tag: 'a', text: 'Cart (2)' },
  { selector: '.products > article:nth-of-type(2) > p', tag: 'p', text: '$16.00' },
  { selector: '.products > article:nth-of-type(3)', tag: 'article', text: 'Linen apron $38.00' },
  { selector: '.site-header > .brand', tag: 'a', text: 'Storefront' },
];

const PHASES = ['submitted', 'working', 'approved'] as const;

/** How many of SEED_COMMENTS a flag asks for, within those left over. */
const count = (raw: string | null, left: number) => Math.max(0, Math.min(Number(raw) || 0, left));

export interface DemoOptions {
  round: DemoRound;
  listOpen: boolean;
  confirmOpen: boolean;
  mode?: Mode;
  /** The selector of the element picked. */
  pick?: string;
}

/** The options `GlossDemo.mount` gets for a query: the demo round, and what is open. */
export function demoOptions(query: URLSearchParams): DemoOptions {
  const sentCount = count(query.get('sent'), SEED_COMMENTS.length);
  const seedCount = count(query.get('seed'), SEED_COMMENTS.length - sentCount);
  const pinCount = count(query.get('pins'), sentCount + seedCount);
  const phase = PHASES.find((p) => p === query.get('phase'));
  const pick = SEED_TARGETS[Number(query.get('pick')) - 1];
  return {
    round: {
      sent: SEED_COMMENTS.slice(0, sentCount),
      comments: SEED_COMMENTS.slice(sentCount, sentCount + seedCount),
      ...(phase ? { phase } : {}),
      ...(query.get('msg') ? { message: query.get('msg')! } : {}),
      ...(query.get('summary') ? { summary: query.get('summary')! } : {}),
      ...(pinCount ? { targets: SEED_TARGETS.slice(0, pinCount) } : {}),
    },
    listOpen: query.has('list'),
    confirmOpen: query.has('confirm'),
    ...(query.has('select') || pick ? { mode: 'select' as const } : {}),
    ...(pick ? { pick: pick.selector } : {}),
  };
}

/**
 * The port, from whichever way it was given. Reeve starts a repo's server with
 * `npm run dev -- -port {{port}}`, and `node:util`'s parseArgs reads a single
 * dash as a run of short flags, so the arguments are read by hand.
 */
export function parsePort(argv: string[], env: NodeJS.ProcessEnv = {}): number {
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const inline = /^--?port=(.*)$/.exec(arg);
    if (inline) raw = inline[1];
    else if (arg === '-port' || arg === '--port' || arg === '-p') {
      raw = argv[++i];
      if (raw === undefined) throw new Error(`${arg} needs a port after it`);
    }
  }
  raw ??= env.PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65_535) throw new Error(`the port must be a number from 0 to 65535, not '${raw}'`);
  return port;
}

export interface Page {
  html: string;
  headers: Record<string, string>;
}

/** Puts a value in an inline script without a `</script>` in it ending the element early. */
const inlineSafe = (text: string) => text.replace(/<\/script/gi, '<\\/script');

/** The storefront as a query asks for it. `demoBar` is the demo bundle, needed only for `?gloss`. */
export function renderPage(html: string, query: URLSearchParams, demoBar: string | null): Page {
  const headers: Record<string, string> = {};
  let page = html;
  const classes = [query.has('fixed') && 'fixed-header', query.has('fullheight') && 'full-height'].filter(Boolean);
  if (classes.length) page = page.replace('<body>', `<body class="${classes.join(' ')}">`);
  if (query.has('csp')) headers['content-security-policy'] = STRICT_CSP;
  if (query.has('gloss') && demoBar !== null) {
    const mount = `GlossDemo.mount(${JSON.stringify(demoOptions(query)).replace(/</g, '\\u003c')});`;
    page = page.replace('</head>', `<script>${inlineSafe(demoBar)}</script>\n<script>${mount}</script>\n</head>`);
  }
  return { html: page, headers };
}

export function createDevServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (url.pathname === '/storefront.css') {
      return send(200, 'text/css; charset=utf-8', readFileSync(new URL('storefront.css', FIXTURE), 'utf8'));
    }
    if (url.pathname !== '/' && url.pathname !== '/index.html') return send(404, 'text/plain', 'Not found');

    // Read on every request, so editing the fixture needs no restart.
    const html = readFileSync(new URL('index.html', FIXTURE), 'utf8');
    const bar = url.searchParams.has('gloss') ? bundleBar('demo') : Promise.resolve(null);
    bar.then(
      (demoBar) => {
        const page = renderPage(html, url.searchParams, demoBar);
        send(200, 'text/html; charset=utf-8', page.html, page.headers);
      },
      (e: unknown) => send(500, 'text/plain', `could not build the bar: ${String(e)}`),
    );
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let port: number;
  try {
    port = parsePort(process.argv.slice(2), process.env);
  } catch (e) {
    console.error(`dev: ${(e as Error).message}`);
    process.exit(2);
  }
  const server = createDevServer();
  server.once('error', (e: NodeJS.ErrnoException) => {
    console.error(e.code === 'EADDRINUSE' ? `dev: port ${port} is already in use; pick another with -port N` : `dev: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actual = address && typeof address === 'object' ? address.port : port;
    console.log(`Storefront fixture at http://127.0.0.1:${actual}/ (from ${fileURLToPath(FIXTURE)})`);
    console.log(`With the demo bar:  http://127.0.0.1:${actual}/?gloss&seed=2&list`);
    console.log(`Claude working:     http://127.0.0.1:${actual}/?gloss&sent=2&phase=working&msg=Tightening%20the%20header`);
    console.log(`Pinned comments:    http://127.0.0.1:${actual}/?gloss&seed=3&pins=3`);
  });
}
