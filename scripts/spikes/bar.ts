import type { Page } from 'playwright';

/**
 * The spikes' way into the bar. Its shadow root is closed, so neither the
 * page's scripts nor Playwright's locators can see inside it. DevTools can:
 * the root is found in the DOM tree over CDP, read from there, and clicked
 * and typed into with the mouse and keyboard, as the reviewer would.
 *
 * Functions run in the page with the root as their first argument. No named
 * functions inside them: tsx's transform would wrap those in a helper the
 * page does not have.
 */

interface DomNode {
  nodeName: string;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  backendNodeId: number;
}

function findRoot(node: DomNode): DomNode | null {
  if (node.nodeName === 'GLOSS-BAR') return node.shadowRoots?.[0] ?? null;
  for (const child of node.children ?? []) {
    const found = findRoot(child);
    if (found) return found;
  }
  return null;
}

/** Runs `fn` against the bar's shadow root. Throws when there is no bar. */
export async function inBar<A extends unknown[], T>(page: Page, fn: (root: ShadowRoot, ...args: A) => T, ...args: A): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root: document } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const root = findRoot(document as DomNode);
    if (!root) throw new Error('there is no bar on the page');
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: root.backendNodeId });
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: String(fn),
      arguments: [{ objectId: object.objectId }, ...args.map((value) => ({ value }))],
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value as T;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Whether the bar is mounted, with its toolbar in it. */
export const barThere = (page: Page) => inBar(page, (root) => !!root.querySelector('.bar')).catch(() => false);

/** The text of the first element matching `selector`, or null. */
export const barText = (page: Page, selector: string) =>
  inBar(page, (root, s) => (root.querySelector(s) as HTMLElement | null)?.innerText ?? null, selector);

/** How many elements match `selector`. */
export const barCount = (page: Page, selector: string) => inBar(page, (root, s) => root.querySelectorAll(s).length, selector);

/** What is in the comment box. */
export const barValue = (page: Page) => inBar(page, (root) => root.querySelector('textarea')!.value);

/**
 * Clicks the `nth` element matching `selector`, or with `text`, the `nth` of
 * those whose label or text it is, with the mouse.
 */
export async function barClick(page: Page, selector: string, { text, nth = 0 }: { text?: string; nth?: number } = {}): Promise<void> {
  const at = await inBar(
    page,
    (root, s, t, n) => {
      const all = [...root.querySelectorAll(s)].filter(
        (el) => t === null || el.getAttribute('aria-label') === t || el.textContent?.trim() === t,
      );
      const box = all[n]?.getBoundingClientRect();
      return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
    },
    selector,
    text ?? null,
    nth,
  );
  if (!at) throw new Error(`there is no ${text ?? selector} in the bar`);
  await page.mouse.click(at.x, at.y);
}

/** Replaces what is in the comment box, typed from the keyboard, leaving it focused. */
export async function barFill(page: Page, text: string): Promise<void> {
  await barClick(page, 'textarea');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  if (text) await page.keyboard.insertText(text);
}
