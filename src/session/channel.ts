import type { Page } from 'playwright';
import { z } from 'zod';
import type { RpcReply } from '../bar/transport.js';
import type { CommentStore, RoundState } from './store.js';

/**
 * The bar's channel to the session, kept where the page under review cannot
 * reach it.
 *
 * The page is the app being reviewed, the code the agent is editing, so
 * nothing it runs may speak for the reviewer. Playwright's `exposeBinding`
 * cannot promise that: the binding is a property of the page's own window,
 * and deleting it leaves `__playwright__binding__` underneath, which any
 * script can call under the binding's name. So the bar runs in an isolated
 * world of its own, set up over CDP. The world shares the page's DOM but none
 * of its JavaScript, and the binding exists only there.
 *
 * A world is per page, so every tab is attached as it opens.
 */

export const BAR_WORLD = 'gloss';
const BINDING = '__glossRpc';

const rpcRequest = z.object({ seq: z.number().int(), call: z.unknown() });
const rpcCall = z.discriminatedUnion('method', [
  z.object({ method: z.literal('state') }),
  z.object({ method: z.literal('add'), body: z.string().max(20_000) }),
  z.object({ method: z.literal('remove'), id: z.string() }),
]);

/**
 * The answer to what the bar sent, or null for something with no number to
 * answer to. Only the bar's world can call the binding, but what comes over
 * it is checked all the same.
 */
export function answerRpc(store: CommentStore, payload: string): RpcReply | null {
  let request;
  try {
    request = rpcRequest.safeParse(JSON.parse(payload));
  } catch {
    return null;
  }
  if (!request.success) return null;
  const { seq } = request.data;
  const call = rpcCall.safeParse(request.data.call);
  if (!call.success) return { seq, error: 'Gloss did not understand that request' };
  if (call.data.method === 'add') store.add(call.data.body);
  if (call.data.method === 'remove') store.remove(call.data.id);
  return { seq, state: store.snapshot() };
}

export interface BarChannel {
  /** Tells the page's bar of a change made somewhere else. */
  push(state: RoundState): void;
}

/** Puts the bar on `page`, on what it shows now and on every document it loads after. */
export async function attachBar(page: Page, script: string, store: CommentStore): Promise<BarChannel> {
  const cdp = await page.context().newCDPSession(page);
  // The bar's world in each document, from the id a call arrives with to the
  // id a reply can trust: plain ids start again when a navigation moves the
  // page to another process.
  const worlds = new Map<number, string>();
  // The world whose bar last called: the top frame's, as only it mounts one.
  let bar: string | null = null;

  const send = (uniqueContextId: string, reply: RpcReply) =>
    void cdp
      .send('Runtime.callFunctionOn', {
        functionDeclaration: 'function (reply) { window.__glossReceive?.(reply); }',
        arguments: [{ value: reply }],
        uniqueContextId,
      })
      .catch(() => {});

  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.name === BAR_WORLD) worlds.set(context.id, context.uniqueId);
  });
  cdp.on('Runtime.executionContextDestroyed', (e) => {
    worlds.delete(e.executionContextId);
    if (bar === e.executionContextUniqueId) bar = null;
  });
  cdp.on('Runtime.executionContextsCleared', () => {
    worlds.clear();
    bar = null;
  });
  cdp.on('Runtime.bindingCalled', (e) => {
    const world = e.name === BINDING ? worlds.get(e.executionContextId) : undefined;
    if (!world) return;
    bar = world;
    const reply = answerRpc(store, e.payload);
    if (reply) send(world, reply);
  });

  // Without both enabled, neither the binding nor the script reaches a
  // document loaded later.
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Runtime.addBinding', { name: BINDING, executionContextName: BAR_WORLD });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script, worldName: BAR_WORLD, runImmediately: true });

  return {
    push: (state) => {
      if (bar) send(bar, { state });
    },
  };
}
