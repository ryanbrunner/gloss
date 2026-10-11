import type { Pin, PinDraft } from '../session/store.js';
import { squeeze } from './geometry.js';

/**
 * A pin from an element the reviewer picked, and the element back from a pin.
 *
 * The selector is for the agent as much as for the bar, so it is one a person
 * can read: the nearest `#id` up the tree, then a `tag:nth-of-type(n)` step
 * for each element down to this one. Classes are left out, since a page's
 * are often generated and change with each build, and so are attributes,
 * which include the `data-gloss-pinned` pinned.ts puts on sticky headers.
 * With no id to start from, it takes as few steps as match this element alone.
 */

export function pinDraftFor(el: Element, quote?: string, suggestion?: string): PinDraft {
  const rect = el.getBoundingClientRect();
  const trimmed = quote?.trim();
  const trimmedSuggestion = suggestion?.trim();
  return {
    url: location.href,
    selector: selectorFor(el),
    tag: el.localName,
    text: squeeze(textOf(el)),
    // In the document's coordinates, as the session's screenshot reads them:
    // the page's 44px margin under the bar included.
    box: { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height },
    viewport: { width: innerWidth, height: innerHeight },
    // Cut to the zod schema's limit (browser.ts's `pinDraft.quote`/`suggestion`),
    // so a long selection or suggestion does not fail the whole comment with
    // an error nobody sees.
    ...(trimmed && { quote: trimmed.slice(0, 4_000) }),
    ...(trimmedSuggestion && { suggestion: trimmedSuggestion.slice(0, 4_000) }),
  };
}

/** The element a pin was made on, if its selector still finds one. */
export function resolvePin(pin: Pick<Pin, 'selector'>): Element | null {
  try {
    const el = document.querySelector(pin.selector);
    return el?.isConnected ? el : null;
  } catch {
    // A selector that no longer parses, or never did: the session keeps what the page sent.
    return null;
  }
}

function selectorFor(el: Element): string {
  const anchored = Boolean(anchorId(el) ?? ancestors(el).find(anchorId));
  const steps: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    const id = anchorId(node);
    if (id) {
      steps.unshift(id);
      break;
    }
    steps.unshift(typeStep(node));
    if (!anchored && matchesOnly(steps.join(' > '), el)) break;
  }
  const selector = steps.join(' > ');
  // An id the page repeats after all, or an element in an odd place: the
  // whole path from the root is this element and no other.
  return matchesOnly(selector, el) ? selector : [el, ...ancestors(el)].reverse().map(typeStep).join(' > ');
}

const ancestors = (el: Element): Element[] => {
  const all: Element[] = [];
  for (let node = el.parentElement; node; node = node.parentElement) all.push(node);
  return all;
};

/** `#id`, for an id a person wrote and the page uses once; null for one that looks generated. */
function anchorId(el: Element): string | null {
  const { id } = el;
  if (!/^[A-Za-z][\w-]*$/.test(id) || /\d{3,}/.test(id)) return null;
  const selector = `#${CSS.escape(id)}`;
  return document.querySelectorAll(selector).length === 1 ? selector : null;
}

/** The tag, and which of its kind it is among its siblings when it is not the only one. */
function typeStep(el: Element): string {
  const tag = CSS.escape(el.localName);
  const siblings = el.parentElement ? [...el.parentElement.children].filter((s) => s.localName === el.localName) : [el];
  return siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(el) + 1})` : tag;
}

function matchesOnly(selector: string, el: Element): boolean {
  const found = document.querySelectorAll(selector);
  return found.length === 1 && found[0] === el;
}

/** What the element says, or failing that what it is called: an image or an icon button has no text. */
const textOf = (el: Element) =>
  (el instanceof HTMLElement ? el.innerText : el.textContent)?.trim() ||
  el.getAttribute('aria-label') ||
  el.getAttribute('alt') ||
  el.getAttribute('title') ||
  '';
