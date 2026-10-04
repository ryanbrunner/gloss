import { OFFSET } from './styles.js';

/**
 * Keeps a layout sized to the viewport inside what the bar leaves of it.
 *
 * PAGE_OFFSET pushes the page down by the bar's height, but `100vh` still
 * resolves against the whole window, so a full-height app shell overflows by
 * exactly that much. No rule added to the page can change what `vh` means,
 * so the page's own rules are rewritten in place: each `Nvh` becomes what it
 * would be in a viewport shorter by OFFSET, which follows the status line
 * onto a phone. A fixed panel `100vh` tall comes out right too, as pinned.ts
 * moves its top down by the bar's height.
 *
 * Shrinking the real viewport instead would not help while the bar is drawn
 * inside the page, and drawing it outside means framing the page, which Gloss
 * does not do.
 *
 * It reaches what the CSSOM lets it: every same-origin stylesheet, including
 * those added or replaced later, as a dev server's hot reload does.
 * Cross-origin sheets, inline `style` attributes, the page's own adopted and
 * shadow-root sheets, and rules inserted into a sheet it has already been
 * through are left as they are.
 */

/**
 * A viewport-height length, or a url or string to step over. Outside those,
 * the number must stand alone, so `--gap-10vh` is a name and not a length.
 */
const VIEWPORT_HEIGHT = /(url\([^)]*\)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?<![\w.-])(-?(?:\d*\.)?\d+(?:e[+-]?\d+)?)([dsl]?vh)(?![\w-])/gi;

/**
 * A declared value with every `vh`, `dvh`, `svh` and `lvh` taken down in
 * proportion: `Nvh` loses N% of the offset, so `100vh` is 44px shorter and
 * `50vh` 22px, and a `--vh: 1vh` multiplied up later comes out right too.
 * Anything else is returned as it was.
 */
export function shortenViewportUnits(value: string): string {
  return value.replace(VIEWPORT_HEIGHT, (match, skipped: string | undefined, number: string, unit: string) => {
    if (skipped || Number(number) === 0) return match;
    const share = Number(number) === 100 ? '' : ` * ${number} / 100`;
    return `calc(${number}${unit} - ${OFFSET}${share})`;
  });
}

/**
 * Rewrites the page's stylesheets now and whenever one arrives. A new
 * `<style>`, or new text in one, gives the document a new sheet, which a
 * mutation brings to light; a `<link>` or `@import` has its rules only once
 * it has loaded. Each declaration is rewritten once, since the rewritten
 * value still has its `vh` in it.
 */
export function fitViewportUnits(): void {
  const walked = new WeakSet<CSSStyleSheet>();
  const fitted = new WeakSet<CSSStyleDeclaration>();

  const fitRules = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if ('style' in rule && rule.style instanceof CSSStyleDeclaration && !fitted.has(rule.style)) {
        fitted.add(rule.style);
        fitDeclaration(rule.style);
      }
      // @media, @supports, @layer and nested rules hold rules of their own.
      if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList) fitRules(rule.cssRules);
      if (rule instanceof CSSImportRule && rule.styleSheet) fitSheet(rule.styleSheet);
    }
  };
  const fitSheet = (sheet: CSSStyleSheet) => {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return; // Cross-origin: the CSSOM will not show its rules.
    }
    fitRules(rules);
  };

  // Run on every mutation, so kept to a look at which sheets are new.
  const fitNew = () => {
    for (const sheet of document.styleSheets) {
      if (walked.has(sheet)) continue;
      walked.add(sheet);
      fitSheet(sheet);
    }
  };

  new MutationObserver(fitNew).observe(document, { childList: true, subtree: true, characterData: true });
  // `load` does not bubble, but it can be caught on the way down.
  document.addEventListener(
    'load',
    (e) => {
      if (e.target instanceof HTMLLinkElement || e.target instanceof HTMLStyleElement) {
        if (e.target.sheet) fitSheet(e.target.sheet);
      }
      fitNew();
    },
    true,
  );
  fitNew();
}

function fitDeclaration(style: CSSStyleDeclaration): void {
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    const value = style.getPropertyValue(name);
    const shorter = shortenViewportUnits(value);
    if (shorter !== value) style.setProperty(name, shorter, style.getPropertyPriority(name));
  }
}
