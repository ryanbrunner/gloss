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
