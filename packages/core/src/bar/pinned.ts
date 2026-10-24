import { OFFSET } from './styles.js';

/**
 * Keeps the page's own fixed and sticky elements clear of the bar.
 *
 * PAGE_OFFSET moves everything in normal flow down, but an element pinned to
 * the viewport is placed from the viewport's top edge, which is still under
 * the bar: a `position: fixed; top: 0` header sits beneath it, and a sticky
 * one slides under it once the page scrolls. Each such element has OFFSET
 * added to its `top`, so the page lays out as though the viewport began
 * below the bar, and a sidebar stuck below a sticky header stays below it.
 * OFFSET follows the status line onto a narrow viewport, so a pinned element
 * clears that too.
 *
 * Only a `top` the page set counts: an element pinned by its `bottom`, such as
 * a cookie banner, stays where it is. The elements are marked with an
 * attribute and moved by a constructed stylesheet rather than through their
 * `style`, which a framework re-rendering the element would write over.
 */

const MARK = 'data-gloss-pinned';

export function keepPinnedClear(host: Element): void {
  const sheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const ids = new WeakMap<Element, string>();
  let lastId = 0;
  let marked = new Set<Element>();
  let rules = '';
  let queued = false;

  const scan = () => {
    queued = false;
    // Turning the offsets off and on is a style change like any other, and
    // starts whatever transition the page has on `top`: a header with
    // `transition: all` would slide up and back on every scan, and be read
    // part way there. What the scan starts, it cancels.
    const running = new Set([...marked].flatMap(topTransitions));
    const settle = () => {
      for (const el of marked) for (const t of topTransitions(el)) if (!running.has(t)) t.cancel();
    };

    // Read with the offsets off, so each `top` is the page's own.
    sheet.disabled = true;
    settle();
    const pinned: Array<[Element, string]> = [];
    for (const el of document.documentElement.querySelectorAll('*')) {
      if (el === host) continue;
      const position = getComputedStyle(el).position;
      if (position !== 'fixed' && position !== 'sticky') continue;
      // The computed value rather than getComputedStyle's, which gives a
      // positioned element's `top: auto` as the pixels it came to.
      const top = String(el.computedStyleMap().get('top') ?? 'auto');
      if (top !== 'auto' && placedByViewport(el, position)) pinned.push([el, top]);
    }
    sheet.disabled = false;

    const next = new Set<Element>();
    const css = pinned.map(([el, top]) => {
      let id = ids.get(el);
      if (id === undefined) ids.set(el, (id = String(++lastId)));
      if (el.getAttribute(MARK) !== id) el.setAttribute(MARK, id);
      next.add(el);
      return `[${MARK}="${id}"]{top:calc(${top} + ${OFFSET})!important}`;
    });
    for (const el of marked) if (!next.has(el)) el.removeAttribute(MARK);
    marked = next;
    const text = css.join('\n');
    if (text !== rules) sheet.replaceSync((rules = text));
    settle();
  };

  // Looked at again once a frame at most, after anything that can pin or
  // unpin an element: a class or style change (a header that turns fixed on
  // scroll), new content, a breakpoint, or a stylesheet arriving late.
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(scan);
  };
  new MutationObserver(queue).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  window.addEventListener('resize', queue);
  window.addEventListener('load', queue);
  scan();
}

/**
 * Whether the element is placed against the viewport, and so under the bar,
 * rather than against a box inside the page: a fixed element inside a
 * transformed one, or a sticky one inside a scrolling panel. The body's
 * overflow is the viewport's, unless the page gives `html` one of its own.
 */
function placedByViewport(el: Element, position: 'fixed' | 'sticky'): boolean {
  for (let box = el.parentElement; box && box !== document.documentElement; box = box.parentElement) {
    const style = getComputedStyle(box);
    if (position === 'fixed' ? holdsFixed(style) : box !== document.body && scrolls(style)) return false;
  }
  return true;
}

/** Asking flushes pending style changes, so this includes the ones the scan just made. */
const topTransitions = (el: Element) =>
  el.getAnimations().filter((a): a is CSSTransition => a instanceof CSSTransition && a.transitionProperty === 'top');

const scrolls = (style: CSSStyleDeclaration) =>
  [style.overflowX, style.overflowY].some((overflow) => overflow !== 'visible' && overflow !== 'clip');

/** The properties that make a box the containing block of the fixed elements inside it. */
const holdsFixed = (style: CSSStyleDeclaration) =>
  style.transform !== 'none' ||
  style.perspective !== 'none' ||
  style.filter !== 'none' ||
  style.backdropFilter !== 'none' ||
  style.containerType !== 'normal' ||
  /paint|layout|strict|content/.test(style.contain) ||
  /transform|perspective|filter/.test(style.willChange);
