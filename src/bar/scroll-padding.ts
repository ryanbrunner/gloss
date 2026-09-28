import { BAR_HEIGHT } from './styles.js';

/**
 * Keeps an anchor jump, or anything else that scrolls an element into view,
 * from landing under the bar.
 *
 * The viewport stops short of its target by the `scroll-padding-top` on
 * `html`, which a page with a sticky header sets to the header's height for
 * the same reason. The bar adds its height to the page's value rather than
 * replacing it, so the target lands below both. The page's value is read with
 * the addition off, and read again after anything that can change it: a
 * stylesheet arriving late, a class or style change, or a breakpoint.
 */
export function addScrollPadding(): void {
  // The bar's height alone until the page's value can be read, so a jump
  // before then still clears the bar.
  let rules = padding('auto');
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(rules);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  let queued = false;

  const read = () => {
    queued = false;
    // An init script can run before the parser has made `html`.
    const html = document.documentElement;
    if (!html) return;
    sheet.disabled = true;
    const own = getComputedStyle(html).scrollPaddingTop;
    sheet.disabled = false;
    const text = padding(own);
    if (text !== rules) sheet.replaceSync((rules = text));
  };

  // Once a frame at most.
  const queue = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(read);
  };
  new MutationObserver(queue).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  window.addEventListener('resize', queue);
  window.addEventListener('load', queue);
  queue();
}

/** `auto` is no padding at all, and not a length `calc()` can add to. */
const padding = (own: string) =>
  `html{scroll-padding-top:${own === 'auto' ? `${BAR_HEIGHT}px` : `calc(${own} + ${BAR_HEIGHT}px)`}!important}`;
