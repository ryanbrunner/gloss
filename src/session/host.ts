import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { BINDING, DELIVER, type Delivery } from '#core/bar/transport.js';
import { answerRpc, visibleClip, type Capture } from '#core/rpc.js';
import type { Box, CommentStore, Pin } from '#core/store.js';
import { firstLine } from '#core/util.js';
import type { SessionBrowser } from './browser.js';
import { bundleBar } from './bundle.js';

/**
 * The browser half of a session when an app shows the page itself, as Reeve
 * does in a card's Preview tab, rather than Gloss opening Chromium. The app
 * starts `gloss __session --host` and the two talk in JSON lines over the
 * process's stdin and stdout. Everything else is the session as ever: the
 * store, the state file and the API that `wait`, `working` and `ready` use.
 *
 * What the host owes the bar is what ./browser.ts gives it over DevTools: the
 * `hello` script run at the start of every top-level document in a world of
 * its own, apart from the page's scripts (a WKContentWorld, say), with a
 * function named `binding` there that hands its one string argument to the
 * host, and `deliver` called in that world with each `deliver` message. Each
 * call is passed on as an `rpc` message with the URL of the page that made it
 * and whether it came from the top frame, as the host saw them rather than as
 * the page said.
 *
 * Gloss to host:
 *   {type: 'hello', script, binding, deliver}   first, before anything else
 *   {type: 'deliver', delivery}                 an answer to a call, or the round after a change
 *   {type: 'request', id, method: 'navigate', url}
 *   {type: 'request', id, method: 'reload'}
 *   {type: 'request', id, method: 'view'}       answered with {scrollX, scrollY, width, height}
 *   {type: 'request', id, method: 'snapshot', clip, path}   a PNG of the clip, in viewport pixels, saved at path
 *   {type: 'ready', id, port}                   the session is up and its state file written
 *
 * Host to Gloss:
 *   {type: 'rpc', payload, url, topFrame}
 *   {type: 'page', url}                         the page the host shows now
 *   {type: 'reply', id, result?, error?}
 *
 * The host closing stdin is the reviewer closing the window: the session ends.
 */

export type HostMessage =
  | { type: 'rpc'; payload: string; url: string; topFrame: boolean }
  | { type: 'page'; url: string }
  | { type: 'reply'; id: number; result?: unknown; error?: string };

export type GlossMessage =
  | { type: 'hello'; script: string; binding: string; deliver: string }
  | { type: 'deliver'; delivery: Delivery }
  | { type: 'request'; id: number; method: 'navigate'; url: string }
  | { type: 'request'; id: number; method: 'reload' }
  | { type: 'request'; id: number; method: 'view' }
  | { type: 'request'; id: number; method: 'snapshot'; clip: Box; path: string }
  | { type: 'ready'; id: string; port: number };

/** How long a request waits on the host before the session gives up on it. */
const REQUEST_TIMEOUT_MS = 15_000;

export interface HostBrowser extends SessionBrowser {
  /** Tells the host the session is up, once its state file is written. */
  started(id: string, port: number): void;
}

export interface HostOptions {
  /** Where pinned elements' screenshots go. */
  shotsDir: string;
  input?: Readable;
  output?: Writable;
}

export async function openHost(url: string, store: CommentStore, options: HostOptions): Promise<HostBrowser> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const send = (message: GlossMessage) => void output.write(`${JSON.stringify(message)}\n`);

  let current: string | null = null;
  let last = 0;
  let shots = 0;
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (e: Error) => void }>();
  const request = (call: { method: 'navigate'; url: string } | { method: 'reload' } | { method: 'view' } | { method: 'snapshot'; clip: Box; path: string }) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++last;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`the host did not answer ${call.method}`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: (result) => (clearTimeout(timer), resolve(result)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      send({ type: 'request', id, ...call } as GlossMessage);
    });

  const capture: Capture = async (pin: Pin) => {
    try {
      const view = (await request({ method: 'view' })) as { scrollX: number; scrollY: number; width: number; height: number };
      const clip = visibleClip(pin, view);
      if (!clip) return undefined;
      mkdirSync(options.shotsDir, { recursive: true });
      const path = join(options.shotsDir, `pin-${++shots}.png`);
      await request({ method: 'snapshot', clip, path });
      return path;
    } catch (e) {
      console.error(`[gloss] could not photograph ${pin.selector}: ${firstLine(e)}`);
      return undefined;
    }
  };

  let settle = () => {};
  const closed = new Promise<void>((resolve) => (settle = resolve));
  const lines = createInterface({ input });
  lines.on('close', () => {
    for (const call of pending.values()) call.reject(new Error('the host went away'));
    pending.clear();
    settle();
  });
  lines.on('line', (line) => {
    let message: HostMessage;
    try {
      message = JSON.parse(line) as HostMessage;
    } catch {
      console.error(`[gloss] the host sent something that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (message.type === 'page' && typeof message.url === 'string') current = message.url;
    if (message.type === 'reply') {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) call?.reject(new Error(message.error));
      else call?.resolve(message.result);
    }
    if (message.type === 'rpc' && typeof message.payload === 'string') {
      const from = { url: String(message.url), topFrame: message.topFrame === true };
      void answerRpc(store, message.payload, from, capture).then((delivery) => {
        if (delivery) send({ type: 'deliver', delivery });
      });
    }
  });

  // Every change goes to the page, as every tab hears of it from a session's Chromium.
  store.onChange((state) => send({ type: 'deliver', delivery: { state } }));

  send({ type: 'hello', script: await bundleBar('session'), binding: BINDING, deliver: DELIVER });
  // A page that is down is the page's problem, not the session's, as in Chromium.
  await request({ method: 'navigate', url }).catch((e: unknown) => console.error(`[gloss] could not open ${url}: ${firstLine(e)}`));

  return {
    currentUrl: () => current,
    navigate: async (to) => {
      await request({ method: 'navigate', url: to });
    },
    reload: async () => {
      await request({ method: 'reload' }).catch(() => {});
    },
    closed,
    close: async () => {
      lines.close();
    },
    started: (id, port) => send({ type: 'ready', id, port }),
  };
}
