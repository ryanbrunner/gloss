import { CommentStore, type Phase, type PinDraft, type RoundState } from '../session/store.js';

/**
 * How the bar reaches whatever holds the round. The bar does not know which
 * it has: a Gloss session, through the binding Playwright exposes, or the
 * demo page's own memory.
 */
export interface Transport {
  state(): Promise<RoundState>;
  /** A general comment, or with a pin, one about an element on the page. */
  add(body: string, pin?: PinDraft): Promise<RoundState>;
  remove(id: string): Promise<RoundState>;
  submit(): Promise<RoundState>;
  /** Refused while there are unsent comments, unless `discardUnsent` says to drop them. */
  approve(discardUnsent: boolean): Promise<RoundState>;
  /** Changes made somewhere else: another tab, or the agent through the CLI. */
  subscribe(listener: (state: RoundState) => void): void;
}

/** The request the binding carries, as JSON. See `handleRpc` in ../session/browser.ts. */
export type RpcCall =
  | { method: 'state' }
  | { method: 'add'; body: string; pin?: PinDraft }
  | { method: 'remove'; id: string }
  | { method: 'submit' }
  | { method: 'approve'; discardUnsent: boolean };

/** The event the session dispatches on every page's window after each change. */
export const STATE_EVENT = 'gloss:state';

type Rpc = (call: RpcCall) => Promise<RoundState>;

const BINDING = '__glossRpc';
// Playwright's names for what sits behind every exposed binding: the object
// that numbers calls and hands back answers, and the raw DevTools binding it
// sends them down. Both are found by name, and the page could use either to
// call the session as though it were the bar.
const PW_CONTROLLER = '__playwright__binding__controller__';
const PW_BINDING = '__playwright__binding__';

/**
 * Takes the session's binding out of the page's reach, and returns the one
 * way left to call it. The page under review is the code the agent is
 * editing, and whoever can call the binding can approve the round.
 *
 * It runs in every frame as part of the init script, before any script of
 * the page's, so what it holds in this closure the page never sees:
 *
 * - `__glossRpc` is taken off `window`.
 * - Playwright's controller is replaced, for the page, by a sealed stand-in
 *   that passes answers back but will not make a call to this binding.
 * - The raw DevTools binding is moved from `window` to the controller alone.
 * - A call goes as a JSON string, which Playwright passes through untouched,
 *   and not at all if the page has patched what writes it out. Its own
 *   `JSON.stringify`, or a `toJSON` or index setter on the prototypes, could
 *   otherwise rewrite a harmless call into an approval.
 *
 * This hardens the page's own realm; it cannot seal it. The check runs
 * before Playwright's `callBinding`, which calls builtins of its own (a
 * Map's `get`, `new Promise`) before it writes the call out, and a page that
 * has replaced one of those can patch JSON after the check has passed. Only
 * an isolated world closes that. The loop spike checks each route named here.
 * If Playwright's names change, the bar still works and the spike says the
 * seal is gone.
 */
export function sealBinding(): Rpc | null {
  const g = globalThis as unknown as Record<string, unknown>;
  const exposed = g[BINDING] as ((json: string) => Promise<unknown>) | undefined;
  delete g[BINDING];
  if (typeof exposed !== 'function') return null;

  // Held from before the page ran, and checked without a method the page
  // could have replaced: no `.some`, no iterator.
  const { stringify } = JSON;
  const { hasOwn } = Object;
  const objectProto = Object.prototype;
  const arrayProto = Array.prototype;
  const tampered = () =>
    JSON.stringify !== stringify ||
    hasOwn(objectProto, 'toJSON') ||
    hasOwn(arrayProto, 'toJSON') ||
    hasOwn(objectProto, '0') ||
    hasOwn(arrayProto, '0');

  let send = exposed;
  const controller = g[PW_CONTROLLER] as PlaywrightController | undefined;
  const raw = g[PW_BINDING];
  if (controller && typeof controller.callBinding === 'function' && typeof raw === 'function' && '_global' in controller) {
    controller._global = { [PW_BINDING]: raw };
    delete g[PW_BINDING];
    const standIn = Object.freeze({
      deliverBindingResult: (arg: unknown) => controller.deliverBindingResult(arg),
      addBinding: (name: string, noGlobal: boolean) => controller.addBinding(name, noGlobal),
      removeBinding: (name: string) => controller.removeBinding(name),
      parseInitScriptArg: (value: unknown) => controller.parseInitScriptArg(value),
      callBinding: (name: string, ...args: unknown[]) =>
        name === BINDING ? Promise.reject(new Error('not from the page')) : controller.callBinding(name, ...args),
    });
    Object.defineProperty(g, PW_CONTROLLER, { value: standIn, writable: false, configurable: false });
    // Called on the controller rather than through `exposed`, whose spread of
    // its arguments goes through an iterator the page could replace.
    send = (json) => controller.callBinding(BINDING, json);
  }

  return (call) =>
    tampered()
      ? Promise.reject(new Error('this page has changed how JSON is written, so Gloss will not send through it'))
      : (send(stringify(call)) as Promise<RoundState>);
}

interface PlaywrightController {
  _global: Record<string, unknown>;
  callBinding(name: string, ...args: unknown[]): Promise<unknown>;
  deliverBindingResult(arg: unknown): void;
  addBinding(name: string, noGlobal: boolean): void;
  removeBinding(name: string): void;
  parseInitScriptArg(value: unknown): unknown;
}

/**
 * The session's transport. It calls the binding rather than fetching the
 * session's URL, because the binding is a channel the page's CSP cannot see:
 * a `connect-src 'self'` would block the fetch.
 */
export function bindingTransport(rpc: Rpc | null): Transport {
  const call = (c: RpcCall) => (rpc ? rpc(c) : Promise.reject(new Error('the Gloss session is not connected')));
  return {
    state: () => call({ method: 'state' }),
    add: (body, pin) => call(pin ? { method: 'add', body, pin } : { method: 'add', body }),
    remove: (id) => call({ method: 'remove', id }),
    submit: () => call({ method: 'submit' }),
    approve: (discardUnsent) => call({ method: 'approve', discardUnsent }),
    subscribe: (listener) =>
      window.addEventListener(STATE_EVENT, (e) => listener((e as CustomEvent<RoundState>).detail)),
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
}

/**
 * The demo page's transport: the same store the session uses, kept in the
 * page. With nobody to pick a round up, a submitted one stays submitted, and
 * with no session to take them, its pins have no screenshots.
 */
export function memoryTransport(seed: DemoRound = {}): Transport {
  const store = demoStore(seed);
  const page = () => location.href;
  const act = async (change: () => unknown) => {
    change();
    return store.snapshot();
  };
  return {
    state: async () => store.snapshot(),
    add: (body, pin) => act(() => store.add(body, page(), pin)),
    remove: (id) => act(() => store.remove(id)),
    submit: () => act(() => store.submit(page())),
    approve: (discardUnsent) => act(() => store.approve(page(), { discardUnsent })),
    // One page, one store: nothing else can change it.
    subscribe: () => {},
  };
}

/** Plays the seed through the store as a reviewer and an agent would have. */
export function demoStore(seed: DemoRound, page: string | null = null): CommentStore {
  const store = new CommentStore();
  const sent = [...(seed.sent ?? [])];
  // Submitted, working and a summary all need a round to have gone out.
  const needsRound = seed.phase === 'submitted' || seed.phase === 'working' || seed.summary !== undefined;
  if (needsRound && !sent.length) sent.push('The header is too tall');
  for (let i = 0; i < sent.length; i += 2) {
    for (const body of sent.slice(i, i + 2)) store.add(body, page);
    store.submit(page);
    const last = i + 2 >= sent.length;
    if (!last) store.ready(null);
    else if (seed.phase === 'working') store.working(seed.message ?? null);
    else if (seed.phase !== 'submitted') store.ready(seed.summary ?? null);
  }
  for (const body of seed.comments ?? []) store.add(body, page);
  if (seed.phase === 'approved') store.approve(page, { discardUnsent: true });
  return store;
}
