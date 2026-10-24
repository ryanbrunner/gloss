/**
 * Comment on selection: while the reviewer is in Interact mode, selecting
 * text on the page is a way to pin a comment to it, with the words
 * themselves kept as the pin's `quote`.
 *
 * Select mode swallows mousedown, so there is never a selection to read while
 * it is active; this only has to watch `selectionchange` while Interact is
 * on, and report what is selected, or null, to the bar.
 */

/** A selection worth commenting on: its text, the element to pin the comment to, and its range to place the affordance by. */
export interface Selected {
  el: Element;
  quote: string;
  range: Range;
}

export class SelectionWatcher {
  active = false;
  onChange: (selected: Selected | null) => void = () => {};

  /** `isOwn` says whether an element is the bar's rather than the page's. */
  constructor(private readonly isOwn: (el: Element) => boolean) {
    document.addEventListener('selectionchange', () => this.active && this.onChange(this.read()));
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.onChange(active ? this.read() : null);
  }

  private read(): Selected | null {
    const selection = document.getSelection();
    const quote = selection?.toString().trim() ?? '';
    if (!selection || selection.isCollapsed || !quote) return null;
    const range = selection.getRangeAt(0);
    const el = elementFor(range);
    if (!el || el === document.documentElement || el === document.body || this.isOwn(el)) return null;
    return { el, quote, range };
  }
}

/** The element enclosing a range: its common ancestor, or that node's parent when it is text. */
function elementFor(range: Range): Element | null {
  const node = range.commonAncestorContainer;
  return node instanceof Element ? node : node.parentElement;
}

/** Starts listening at once, switched off. */
export function createSelectionWatcher(isOwn: (el: Element) => boolean): SelectionWatcher {
  return new SelectionWatcher(isOwn);
}
