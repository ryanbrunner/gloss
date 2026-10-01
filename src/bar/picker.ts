import { sheet } from './dom.js';

/**
 * Select mode: while it is on, a click on the page picks the element to
 * comment on rather than doing what the page would do with it.
 *
 * Its listeners are on `window`, in the capture phase, and registered by the
 * init script before any script of the page's runs, so they are the first to
 * hear of a click and can keep it from everything after them. Off, they let
 * everything through. On, they swallow the presses and clicks of every button
 * of the mouse, and leave the wheel and touch alone so the page still
 * scrolls. The bar's own clicks, anything whose path goes through its host,
 * are the bar's, and so are events the page makes itself: only a real
 * reviewer's are swallowed.
 *
 * It says what is under the pointer as the page sees it: an element inside a
 * web component of the page's comes as the component. It never marks the
 * page's elements; pinned.ts and scroll-padding.ts watch their classes and
 * styles, and the page's own code may too.
 */

const SWALLOWED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];

/** The page's own cursor gives way to a crosshair everywhere, the page's `cursor: pointer` too. */
const CROSSHAIR = '*{cursor:crosshair!important}';

export class Picker {
  active = false;
  /** The element under the pointer, or null over the bar, the page's background, or off the window. */
  onHover: (el: Element | null) => void = () => {};
  onPick: (el: Element) => void = () => {};
  /**
   * Escape, from anywhere. The bar's own keydown listener hears only keys
   * pressed while its shadow root has the focus, and after a pick the focus
   * may well be on the page.
   */
  onEscape: () => void = () => {};
  private readonly crosshair = sheet(CROSSHAIR);

  constructor(private readonly isOwn: (e: Event) => boolean) {
    for (const type of SWALLOWED) window.addEventListener(type, (e) => this.swallow(e), true);
    window.addEventListener('pointerover', (e) => this.active && this.onHover(this.target(e)), true);
    window.addEventListener('pointerout', (e) => this.active && !e.relatedTarget && this.onHover(null), true);
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.active || !e.isTrusted || e.key !== 'Escape' || e.isComposing) return;
        // The page's own Escape (closing its dialog, say) waits until the reviewer is back in Interact.
        if (!this.isOwn(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        this.onEscape();
      },
      true,
    );
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    // As Bar.renderStatus does with its offset: in the page's sheets while it applies, out of them after.
    const others = document.adoptedStyleSheets.filter((s) => s !== this.crosshair);
    document.adoptedStyleSheets = active ? [...others, this.crosshair] : others;
    if (!active) this.onHover(null);
  }

  private swallow(e: Event): void {
    if (!this.active || !e.isTrusted || this.isOwn(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = e.type === 'click' ? this.target(e) : null;
    if (el) this.onPick(el);
  }

  /** The page element an event is about, or null for the bar and the page's background. */
  private target(e: Event): Element | null {
    const el = e.target;
    if (!(el instanceof Element) || this.isOwn(e)) return null;
    return el === document.documentElement || el === document.body ? null : el;
  }
}

/**
 * Starts listening at once, switched off. `isOwn` says whether an event came
 * from the bar, which does not exist yet when this runs.
 */
export function createPicker(isOwn: (e: Event) => boolean): Picker {
  return new Picker(isOwn);
}
