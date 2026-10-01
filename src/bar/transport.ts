import { CommentStore, type RoundState } from '../session/store.js';

/**
 * How the bar reaches whatever holds the round's comments. The bar does not
 * know which it has: a Gloss session, through the binding Playwright exposes,
 * or the demo page's own memory.
 */
export interface Transport {
  state(): Promise<RoundState>;
  add(body: string): Promise<RoundState>;
  remove(id: string): Promise<RoundState>;
  /** Changes made somewhere else: another tab, or later on, the CLI. */
  subscribe(listener: (state: RoundState) => void): void;
}

/** The request the binding carries. See `answerRpc` in ../session/channel.ts. */
export type RpcCall = { method: 'state' } | { method: 'add'; body: string } | { method: 'remove'; id: string };

/**
 * What the session sends back: the answer to request `seq`, or, with no
 * `seq`, a change made somewhere else.
 */
export type RpcReply = { seq: number; error: string } | { seq?: number; state: RoundState };

declare global {
  // Both live in the bar's own world, not on the page's window.
  interface Window {
    __glossRpc?: (payload: string) => void;
    __glossReceive?: (reply: RpcReply) => void;
  }
}

/**
 * The session's transport. It calls `window.__glossRpc` rather than fetching
 * the session's URL, because the binding is a channel the page's CSP cannot
 * see: a `connect-src 'self'` would block the fetch.
 *
 * A CDP binding takes a string and returns nothing, so each request carries a
 * number, and the session answers it by calling `__glossReceive`.
 */
export function bindingTransport(): Transport {
  const binding = window.__glossRpc;
  const pending = new Map<number, { resolve: (state: RoundState) => void; reject: (e: Error) => void }>();
  const listeners: Array<(state: RoundState) => void> = [];
  let seq = 0;

  window.__glossReceive = (reply) => {
    if (reply.seq === undefined) {
      if ('state' in reply) for (const listener of listeners) listener(reply.state);
      return;
    }
    const waiting = pending.get(reply.seq);
    pending.delete(reply.seq);
    if ('error' in reply) waiting?.reject(new Error(reply.error));
    else waiting?.resolve(reply.state);
  };

  const rpc = (call: RpcCall) =>
    new Promise<RoundState>((resolve, reject) => {
      if (!binding) return reject(new Error('the Gloss session is not connected'));
      pending.set(++seq, { resolve, reject });
      binding(JSON.stringify({ seq, call }));
    });
  return {
    state: () => rpc({ method: 'state' }),
    add: (body) => rpc({ method: 'add', body }),
    remove: (id) => rpc({ method: 'remove', id }),
    subscribe: (listener) => listeners.push(listener),
  };
}

/** The demo page's transport: the same store the session uses, kept in the page. */
export function memoryTransport(seed: string[] = []): Transport {
  const store = new CommentStore();
  for (const body of seed) store.add(body);
  return {
    state: async () => store.snapshot(),
    add: async (body) => {
      store.add(body);
      return store.snapshot();
    },
    remove: async (id) => {
      store.remove(id);
      return store.snapshot();
    },
    // One page, one store: nothing else can change it.
    subscribe: () => {},
  };
}
