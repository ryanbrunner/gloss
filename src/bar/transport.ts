import { CommentStore, type Phase, type Pin, type PinDraft, type RoundState } from '../session/store.js';

/**
 * How the bar reaches whatever holds the round. The bar does not know which
 * it has: a Gloss session, through a DevTools binding in the bar's own world,
 * or the demo page's own memory.
 */
export interface Transport {
  state(): Promise<RoundState>;
  /** A general comment, or with a pin, one about an element on the page. */
  add(body: string, pin?: PinDraft): Promise<RoundState>;
  remove(id: string): Promise<RoundState>;
  /** Changes the text of a comment not yet sent. */
  edit(id: string, body: string): Promise<RoundState>;
  submit(): Promise<RoundState>;
  /** Refused while there are unsent comments, unless `discardUnsent` says to drop them. */
  approve(discardUnsent: boolean): Promise<RoundState>;
  /** Changes made somewhere else: another tab, or the agent through the CLI. */
  subscribe(listener: (state: RoundState) => void): void;
}

/** What the bar asks of the session. See `handleRpc` in ../session/browser.ts. */
export type RpcCall =
  | { method: 'state' }
  | { method: 'add'; body: string; pin?: PinDraft }
  | { method: 'remove'; id: string }
  | { method: 'edit'; id: string; body: string }
  | { method: 'submit' }
  | { method: 'approve'; discardUnsent: boolean };

/** A call as it goes down the binding, in JSON: numbered, so its answer finds its way back. */
export interface RpcRequest {
  id: number;
  call: RpcCall;
}

/**
 * What the session hands the bar through DELIVER: the answer to a call, or,
 * with no id, the round after a change made somewhere else.
 */
export type Delivery = { id: number; state: RoundState } | { id: number; error: string } | { state: RoundState };

/** The DevTools binding the session adds to the bar's world. It takes a string and returns nothing. */
export const BINDING = '__glossRpc';
/** Where the session calls the bar back, in the same world. */
export const DELIVER = '__glossDeliver';

/**
 * The session's transport. The bar runs in an isolated world of its own (see
 * ../session/browser.ts), and both ends of this channel live there: the
 * binding it calls, and DELIVER, which the session calls with each answer
 * and with the round after every change.
 *
 * The page under review is the code the agent is editing, and whoever can
 * call the binding can approve the round. The page shares the bar's DOM but
 * not its globals or builtins, so it cannot reach the binding, and nothing it
 * patches (JSON, a prototype, `Map`, `Promise`) is on the path a call takes.
 *
 * The binding is also a channel the page's CSP cannot see: a
 * `connect-src 'self'` would block a fetch to the session's URL.
 */
export function bindingTransport(): Transport {
  const g = globalThis as unknown as Record<string, unknown>;
  const binding = g[BINDING] as ((payload: string) => void) | undefined;
  const pending = new Map<number, { resolve: (state: RoundState) => void; reject: (e: Error) => void }>();
  const listeners: Array<(state: RoundState) => void> = [];
  let last = 0;
  g[DELIVER] = (d: Delivery) => {
    if (!('id' in d)) {
      for (const listener of listeners) listener(d.state);
      return;
    }
    const call = pending.get(d.id);
    pending.delete(d.id);
    if ('error' in d) call?.reject(new Error(d.error));
    else call?.resolve(d.state);
  };
  const call = (c: RpcCall) =>
    typeof binding === 'function'
      ? new Promise<RoundState>((resolve, reject) => {
          const id = ++last;
          pending.set(id, { resolve, reject });
          binding(JSON.stringify({ id, call: c } satisfies RpcRequest));
        })
      : Promise.reject(new Error('the Gloss session is not connected'));
  return {
    state: () => call({ method: 'state' }),
    add: (body, pin) => call(pin ? { method: 'add', body, pin } : { method: 'add', body }),
    remove: (id) => call({ method: 'remove', id }),
    edit: (id, body) => call({ method: 'edit', id, body }),
    submit: () => call({ method: 'submit' }),
    approve: (discardUnsent) => call({ method: 'approve', discardUnsent }),
    subscribe: (listener) => listeners.push(listener),
  };
}

/** Where the demo page's round starts, so each phase of the bar can be seen by URL. */
export interface DemoRound {
  /** Written and never sent. */
  comments?: string[];
  /** Sent already, two to a round. */
  sent?: string[];
  phase?: Exclude<Phase, 'reviewing'>;
  message?: string;
  summary?: string;
  /** The elements the first comments are pinned to, the sent ones first. */
  targets?: DemoTarget[];
}

/** Enough of a pin for the demo to find its element by. */
export type DemoTarget = Pick<Pin, 'selector' | 'tag' | 'text'>;

/**
 * The demo page's transport: the same store the session uses, kept in the
 * page. With nobody to pick a round up, a submitted one stays submitted, and
 * with no session to take them, its pins have no screenshots.
 */
export function memoryTransport(seed: DemoRound = {}): Transport {
  // The page, so the seeded pins are this page's and get their markers.
  const store = demoStore(seed, location.href);
  const page = () => location.href;
  const act = async (change: () => unknown) => {
    change();
    return store.snapshot();
  };
  return {
    state: async () => store.snapshot(),
    add: (body, pin) => act(() => store.add(body, page(), pin)),
    remove: (id) => act(() => store.remove(id)),
    edit: (id, body) => act(() => store.edit(id, body)),
    submit: () => act(() => store.submit(page())),
    approve: (discardUnsent) => act(() => store.approve(page(), { discardUnsent })),
    // One page, one store: nothing else can change it.
    subscribe: () => {},
  };
}

/**
 * Plays the seed through the store as a reviewer and an agent would have.
 * No DOM: the tests run it in Node. A seeded pin has no box of its own, and
 * its marker is placed from its selector alone.
 */
export function demoStore(seed: DemoRound, page: string | null = null): CommentStore {
  const store = new CommentStore();
  const targets: Array<DemoTarget | undefined> = [...(seed.targets ?? [])];
  const pin = (): Pin | undefined => {
    const target = targets.shift();
    return target && {
      url: page ?? '',
      ...target,
      box: { x: 0, y: 0, width: 0, height: 0 },
      viewport: { width: 1280, height: 800 },
    };
  };
  const sent = [...(seed.sent ?? [])];
  // Submitted, working and a summary all need a round to have gone out.
  const needsRound = seed.phase === 'submitted' || seed.phase === 'working' || seed.summary !== undefined;
  if (needsRound && !sent.length) {
    sent.push('The header is too tall');
    // Stood in for the round, and pinned to nothing: the targets are the seed's.
    targets.unshift(undefined);
  }
  for (let i = 0; i < sent.length; i += 2) {
    for (const body of sent.slice(i, i + 2)) store.add(body, page, pin());
    store.submit(page);
    const last = i + 2 >= sent.length;
    if (!last) store.ready(null);
    else if (seed.phase === 'working') store.working(seed.message ?? null);
    else if (seed.phase !== 'submitted') store.ready(seed.summary ?? null);
  }
  for (const body of seed.comments ?? []) store.add(body, page, pin());
  if (seed.phase === 'approved') store.approve(page, { discardUnsent: true });
  return store;
}
