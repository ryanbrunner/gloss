/**
 * The few ways the bar makes its DOM. Node by node rather than through
 * `innerHTML`, and styles as constructed sheets, for pages that enforce
 * Trusted Types or a strict `style-src`.
 */

export function sheet(css: string): CSSStyleSheet {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  return s;
}

/** One element, its attributes and its children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

/** A 16×16 line icon, from the `d` of each of its paths. */
export function icon(...paths: string[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const attrs = {
    viewBox: '0 0 16 16',
    width: '14',
    height: '14',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Enter sends what is in the box; Shift+Enter is a new line, and so is Enter part way through an IME composition. */
export function sendOnEnter(box: HTMLTextAreaElement, send: () => void): void {
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    send();
  });
}

interface GuardedValue {
  trusted: string;
  /** A trusted edit is under way on this box, started by its own `beforeinput`. */
  expecting: boolean;
  get(): string;
  set(v: string): void;
}

/**
 * Keeps a registered box's `value` to what the reviewer actually typed,
 * pasted or deleted, not whatever `document.execCommand` last put there.
 * `execCommand` edits whatever has focus, including this box, and in
 * Chromium it fires only a trusted `input` event: no `keydown`, and no
 * `beforeinput` first. A real edit always fires a trusted `beforeinput`
 * immediately before its `input`, so an `input` on a box not expecting one
 * is `execCommand`, or something like it, and gets put back.
 *
 * The flag is set on the box's own `beforeinput`, at target phase, which
 * runs after every capture listener a page has further up the tree - on
 * `document`, say - has already had its turn. A page listener there could
 * otherwise call `execCommand` from inside the real edit's own dispatch,
 * before the box had marked that edit as its own, and have the forged
 * `input` taken for it. `bar.ts` stops `beforeinput` and `input` from
 * bubbling past the shadow root, so nothing a page listener does in the
 * gap between the flag going up and the matching `input` arriving can run
 * from a bubble listener either.
 *
 * What consumes the flag is on `window`, in the capture phase, registered
 * once, at the top of `mountBar`, before the page's own scripts run - the
 * same reasoning as picker.ts's. It is still the first to see every
 * `input`, real or nested, which is what stops a forged one fired from
 * inside a page capture listener on the real `input`'s own dispatch,
 * further up the tree, from arriving at the box first. It cannot read
 * which box an event is for once the shadow root is closed - events
 * crossing out of a closed root carry no path past its host - so instead
 * it checks every registered box's `value` against what it last trusted,
 * and corrects only the one that changed.
 *
 * `value`'s own setter is replaced on each registered box so the bar's
 * writes - clearing the box, filling it with a comment to edit - count as
 * trusted too, without having to touch every place that sets it.
 */
export function createValueGuard(): (box: HTMLTextAreaElement) => void {
  const all = new Set<GuardedValue>();
  window.addEventListener(
    'beforeinput',
    (e) => {
      if (!e.isTrusted) return;
      // Registered before any box's own listener, so this queues ahead of a
      // timer a page capture listener sets in response to the same event.
      // A `beforeinput` that gets no `input` at all - backspace in an empty
      // box - must not leave the next one's `input` mistaken for its match.
      setTimeout(() => {
        for (const v of all) v.expecting = false;
      }, 0);
    },
    true,
  );
  window.addEventListener(
    'input',
    () => {
      for (const v of all) {
        // Taken before the comparison: typing over a selection with what it
        // already held leaves `value` unchanged, and the flag must still
        // come down, or a page listener nested in this same dispatch would
        // find it up.
        const expecting = v.expecting;
        v.expecting = false;
        const now = v.get();
        if (now === v.trusted) continue;
        if (expecting) v.trusted = now;
        else v.set(v.trusted);
      }
    },
    true,
  );
  return (box) => {
    const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!;
    const get = () => native.get!.call(box);
    const set = (val: string) => native.set!.call(box, val);
    const v: GuardedValue = { trusted: get(), expecting: false, get, set };
    all.add(v);
    box.addEventListener('beforeinput', (e) => {
      if (e.isTrusted && !e.defaultPrevented) v.expecting = true;
    });
    Object.defineProperty(box, 'value', {
      get,
      set(val: string) {
        v.trusted = val;
        set(val);
      },
    });
  };
}
