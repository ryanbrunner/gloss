/**
 * The Gloss glyph, a G with a ◆ for its crossbar, which is the whole of the
 * bar's mark. The shapes and inks are assets/gloss-glyph-dark.svg's: change the
 * two together. Built node by node, like the rest of the bar, for pages that
 * enforce Trusted Types.
 */

const NS = 'http://www.w3.org/2000/svg';

/** The glyph's box on the 64-unit tile of assets/gloss-mark.svg. */
const VIEW_BOX = '15 12 34 40';
const LETTER = 'M49 12v11H29a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h20a11 11 0 0 1-11 11H29a14 14 0 0 1-14-14V26a14 14 0 0 1 14-14z';
const DIAMOND = 'M42 25l7 7-7 7-7-7z';

/** The G in the bar's text colour; the ◆ in the marks' sky, which is Reeve's too. */
const LETTER_INK = '#e6edf3';
const DIAMOND_INK = '#00a6f4';

/** The glyph, 16px tall. Decorative: the toolbar's own aria-label names the bar. */
export function logo(): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: VIEW_BOX, width: '14', height: '16', 'aria-hidden': 'true' })) {
    svg.setAttribute(k, v);
  }
  const parts: Array<[d: string, fill: string]> = [
    [LETTER, LETTER_INK],
    [DIAMOND, DIAMOND_INK],
  ];
  for (const [d, fill] of parts) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    svg.append(path);
  }
  return svg;
}
