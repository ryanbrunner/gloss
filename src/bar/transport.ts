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

/** The request the binding carries. See `handleRpc` in ../session/browser.ts. */
export type RpcCall = { method: 'state' } | { method: 'add'; body: string } | { method: 'remove'; id: string };

/** The event the session dispatches on every page's window after each change. */
export const STATE_EVENT = 'gloss:state';

declare global {
  interface Window {
    __glossRpc?: (call: RpcCall) => Promise<RoundState>;
  }
}

/**
 * The session's transport. It calls `window.__glossRpc` rather than fetching
 * the session's URL, because the binding is a channel the page's CSP cannot
 * see: a `connect-src 'self'` would block the fetch.
 */
export function bindingTransport(): Transport {
  const rpc = (call: RpcCall) => {
    const binding = window.__glossRpc;
    if (!binding) return Promise.reject(new Error('the Gloss session is not connected'));
    return binding(call);
  };
  return {
    state: () => rpc({ method: 'state' }),
    add: (body) => rpc({ method: 'add', body }),
    remove: (id) => rpc({ method: 'remove', id }),
    subscribe: (listener) =>
      window.addEventListener(STATE_EVENT, (e) => listener((e as CustomEvent<RoundState>).detail)),
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
