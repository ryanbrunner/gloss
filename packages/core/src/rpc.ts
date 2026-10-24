import { z } from 'zod';
import { BAR_HEIGHT } from './bar/styles.js';
import type { Delivery } from './bar/transport.js';
import type { Author, Box, CommentStore, Pin, RoundState } from './store.js';
import { firstLine } from './util.js';

/**
 * The session's side of the bar's calls, wherever they arrive from: checked,
 * applied to the store, and answered with the round. Nothing here knows how
 * the call travelled; the caller says where it came from, as something other
 * than the page saw it.
 */

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
  suggestion: z.string().max(4_000).optional(),
});

const rpcCall = z.discriminatedUnion('method', [
  z.object({ method: z.literal('state') }),
  z.object({ method: z.literal('add'), body: z.string().max(20_000), pin: pinDraft.optional() }),
  z.object({ method: z.literal('remove'), id: z.string() }),
  z.object({ method: z.literal('edit'), id: z.string(), body: z.string().max(20_000) }),
  z.object({ method: z.literal('submit') }),
  z.object({ method: z.literal('approve'), discardUnsent: z.boolean() }),
  z.object({ method: z.literal('setLive'), live: z.boolean() }),
]);

/** Takes a picture of a pinned element, and says where it put it, or nothing if it could not. */
export type Capture = (pin: Pin) => Promise<string | undefined>;

/** Where a call on the binding came from, as Playwright saw it rather than as the page says. */
export interface RpcSource {
  /** The URL of the page that made it. */
  url: string;
  /** Whether it came from the page itself rather than a frame inside it, where the bar never is. */
  topFrame: boolean;
  /** Who is at the bar, where the host knows: it signed them in, the page did not say so. */
  author?: Author;
}

/**
 * What the bar asks of the session, answered with the round as it stands.
 * Only the bar's world has the binding, but what comes down it is still
 * checked, and nothing that changes the round is taken from a frame, or from
 * a page that is not on http or https (a blank popup the page opened and
 * scripts).
 */
export async function handleRpc(
  store: CommentStore,
  call: unknown,
  from: RpcSource,
  capture?: Capture,
): Promise<RoundState> {
  const parsed = rpcCall.safeParse(call);
  if (!parsed.success) throw new Error('Gloss did not understand that request');
  const { data } = parsed;
  if (data.method === 'state') return store.snapshot();
  if (!from.topFrame || !/^https?:/.test(from.url)) throw new Error('Gloss takes changes only from the page under review');
  if (data.method === 'add') {
    // The draft is the page's; the screenshot is the session's alone.
    const pin: Pin | undefined = data.pin && { ...data.pin };
    if (pin && data.body.trim() && capture) pin.screenshot = await capture(pin);
    store.add(data.body, from.url, pin, from.author);
  }
  if (data.method === 'remove') store.remove(data.id);
  // The pin does not move, so the screenshot taken for it still stands.
  if (data.method === 'edit') store.edit(data.id, data.body);
  if (data.method === 'submit') store.submit(from.url);
  if (data.method === 'approve') store.approve(from.url, { discardUnsent: data.discardUnsent });
  if (data.method === 'setLive') store.setLive(data.live);
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

const rpcRequest = z.object({ id: z.number(), call: z.unknown() });

/**
 * One call on the binding, as the JSON `bindingTransport` in
 * ../bar/transport.ts sends, and the answer to hand back. A payload that is
 * not a numbered call gets no answer, since there is nothing to answer it by.
 */
export async function answerRpc(
  store: CommentStore,
  payload: string,
  from: RpcSource,
  capture?: Capture,
): Promise<Delivery | null> {
  let request: unknown;
  try {
    request = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = rpcRequest.safeParse(request);
  if (!parsed.success) return null;
  const { id, call } = parsed.data;
  try {
    return { id, state: await handleRpc(store, call, from, capture) };
  } catch (e) {
    return { id, error: firstLine(e) };
  }
}
