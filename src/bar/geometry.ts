import { BAR_HEIGHT } from './styles.js';

/**
 * The arithmetic behind pinning, kept apart from the DOM so the unit tests can
 * reach it: an element's text as a pin keeps it, whether a pin belongs to the
 * page on screen, and where the comment box goes beside an element.
 */

/** A box in the viewport's coordinates, as `getBoundingClientRect` gives it. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** How far anything the bar draws keeps from the edges of the window. */
const MARGIN = 8;

/** Text on one line, cut short with an ellipsis. */
export function squeeze(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/**
 * Whether a pin made at one URL belongs to the page at another. An anchor jump
 * changes only the hash, and the elements are the same ones.
 */
export function samePage(pinUrl: string, href: string): boolean {
  const unhashed = (url: string) => {
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      return parsed.href;
    } catch {
      return null;
    }
  };
  const pinned = unhashed(pinUrl);
  return pinned !== null && pinned === unhashed(href);
}

/**
 * Where a popover of `size` goes beside `rect`: below it if there is room,
 * else above it, and wherever it lands, inside the window and clear of the bar.
 */
export function placePopover(rect: Rect, size: Size, viewport: Size): { left: number; top: number } {
  const floor = viewport.height - size.height - MARGIN;
  const ceiling = BAR_HEIGHT + MARGIN;
  const below = rect.top + rect.height + MARGIN;
  const above = rect.top - MARGIN - size.height;
  const top = below <= floor ? below : above >= ceiling ? above : below;
  return {
    left: clamp(rect.left, MARGIN, viewport.width - size.width - MARGIN),
    top: clamp(top, ceiling, floor),
  };
}

/** Within `min` and `max`, and at `min` when there is no room for both. */
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max));
