import type { Pin, PinDraft } from '../session/store.js';
import { h, sendOnEnter } from './dom.js';
import { placePopover, samePage, type Rect } from './geometry.js';
import { BAR_HEIGHT } from './styles.js';
import { resolvePin } from './target.js';

/**
 * What the bar draws over the page itself: the outline on the element under
 * the pointer in Select mode, the comment box beside the one picked, and a
 * numbered marker on each pinned element.
 *
 * One `.layer` in the bar's shadow root holds it all, as `position: fixed`
 * children the way the comment list already is; the host is fixed with no
 * transform, so they are placed against the viewport. Each is placed from its
 * element's box through CSSOM, which a page's `style-src` does not refuse the
 * way it would a style attribute, and placed again at most once a frame after
 * anything that can move an element: a scroll, in the page or any box inside
 * it, a resize, the page finishing loading, or a change to the page's DOM.
 */

/** A pinned comment, as its marker shows it. */
export interface Marker {
  id: string;
  n: number;
  body: string;
  pin: Pin;
  /** Sent in an earlier round: drawn dimmed, and only where its element can still be found. */
  sent: boolean;
}

export class Overlay {
  readonly layer = h('div', { class: 'layer' });
  private readonly hoverBox = highlight();
  private readonly pickedBox = highlight('picked');
  private readonly markerLayer = h('div');
  private readonly heading = h('div', { class: 'composer-heading' });
  readonly input = h('textarea', { rows: '3', 'aria-label': 'Comment on this element' });
  private readonly cancel = h('button', { type: 'button' }, 'Cancel');
  private readonly send = h('button', { class: 'send', type: 'button' }, 'Add');
  private readonly composer = h(
    'div',
    { class: 'composer', role: 'dialog', 'aria-label': 'Comment on an element' },
    this.heading,
    this.input,
    h('div', { class: 'composer-actions' }, this.cancel, this.send),
  );

  private hovered: Element | null = null;
  /** The element a marker the pointer is on was made on. */
  private markerHovered: Element | null = null;
  private picked: Element | null = null;
  /** Where the picked element was last seen, for when it goes from the page while the box is open. */
  private pickedRect: Rect | null = null;
  private markers: Array<[HTMLElement, Marker]> = [];
  /** Kept, since the markers are made again on every render. */
  private readonly onMarker: (marker: Marker) => void;
  private queued = false;

  constructor(actions: { add: () => void; cancel: () => void; edit: (marker: Marker) => void }) {
    this.onMarker = actions.edit;
    this.layer.append(this.hoverBox, this.pickedBox, this.markerLayer);
    this.send.addEventListener('click', actions.add);
    this.cancel.addEventListener('click', actions.cancel);
    sendOnEnter(this.input, actions.add);

    // Nothing to follow while nothing is drawn.
    const follow = () => (this.hovered || this.picked || this.markers.length) && this.queue();
    document.addEventListener('scroll', follow, { capture: true, passive: true });
    window.addEventListener('resize', follow);
    window.addEventListener('load', follow);
    new MutationObserver(follow).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  }

  /** The comment box is open on an element. */
  get composing(): boolean {
    return this.picked !== null;
  }

  hover(el: Element | null): void {
    if (el === this.hovered) return;
    this.hovered = el;
    this.queue();
  }

  /** Freezes the outline on the element and opens the comment box beside it, with the cursor in it. */
  open(el: Element, draft: PinDraft): void {
    this.picked = el;
    this.pickedRect = null;
    this.heading.textContent = draft.text ? `Comment on ${draft.tag} · ${draft.text}` : `Comment on ${draft.tag}`;
    this.heading.title = this.heading.textContent;
    this.input.value = '';
    this.input.readOnly = false;
    this.send.hidden = false;
    this.send.textContent = 'Add';
    this.cancel.textContent = 'Cancel';
    // In the layer only while it is open: nothing looking for the bar's own textarea finds this one instead.
    this.layer.append(this.composer);
    this.draw();
    this.input.focus({ preventScroll: true });
  }

  close(): void {
    this.picked = null;
    this.composer.remove();
    this.queue();
  }

  /**
   * The box on an element that already has a comment, with its text in it: to
   * change, or, for a comment already sent, only to read. A sent comment is
   * history the agent has acted on, so there is nothing to save.
   */
  openExisting(el: Element, marker: Marker): void {
    this.open(el, marker.pin);
    this.input.value = marker.body;
    this.input.readOnly = marker.sent;
    this.send.hidden = marker.sent;
    this.send.textContent = 'Save';
    this.cancel.textContent = marker.sent ? 'Close' : 'Cancel';
  }

  /** Hidden, all of it, while the session photographs the page. */
  setCapturing(capturing: boolean): void {
    this.layer.classList.toggle('capturing', capturing);
    if (!capturing && this.composing) this.input.focus({ preventScroll: true });
  }

  setMarkers(markers: Marker[]): void {
    this.markers = markers.map((m) => {
      const el = h(
        'span',
        {
          class: m.sent ? 'marker sent' : 'marker',
          title: m.body,
          role: 'button',
          tabindex: '0',
          'aria-label': `Comment ${m.n}: ${m.body}`,
        },
        String(m.n),
      );
      el.addEventListener('click', () => this.onMarker(m));
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        this.onMarker(m);
      });
      el.addEventListener('pointerenter', () => {
        this.markerHovered = resolvePin(m.pin);
        this.queue();
      });
      el.addEventListener('pointerleave', () => {
        this.markerHovered = null;
        this.queue();
      });
      return [el, m];
    });
    this.markerLayer.replaceChildren(...this.markers.map(([el]) => el));
    this.draw();
  }

  /** Once a frame at most. */
  private queue(): void {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    this.queued = false;
    const hovered = this.markerHovered ?? this.hovered;
    place(this.hoverBox, hovered === this.picked ? null : hovered);
    const picked = place(this.pickedBox, this.picked);
    if (this.picked) {
      this.pickedRect = picked ?? this.pickedRect;
      if (this.pickedRect) {
        const size = { width: this.composer.offsetWidth, height: this.composer.offsetHeight };
        const at = placePopover(this.pickedRect, size, { width: innerWidth, height: innerHeight });
        this.composer.style.left = `${at.left}px`;
        this.composer.style.top = `${at.top}px`;
      }
    }
    for (const [el, marker] of this.markers) {
      const rect = markerRect(marker);
      el.hidden = !rect;
      if (!rect) continue;
      // On the element's top right corner, kept inside the window.
      el.style.left = `${Math.min(Math.max(rect.left + rect.width, 12), innerWidth - 12)}px`;
      el.style.top = `${rect.top}px`;
    }
  }
}

function highlight(kind?: string): HTMLDivElement {
  return h(
    'div',
    { class: kind ? `highlight ${kind}` : 'highlight', hidden: '' },
    h('span', { class: 'chip' }, h('span', { class: 'chip-tag' }), h('span')),
  );
}

/** Outlines the element, or hides the outline; says where the element is, if it is anywhere. */
function place(box: HTMLElement, el: Element | null): Rect | null {
  const rect = el?.isConnected ? el.getBoundingClientRect() : null;
  box.hidden = !rect || (!rect.width && !rect.height);
  if (!rect || box.hidden) return null;
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  // The label sits above the outline, or inside it when that would put it under the bar.
  box.classList.toggle('low', rect.top < BAR_HEIGHT + 22);
  const [tag, size] = box.firstElementChild!.children;
  tag!.textContent = el!.localName;
  size!.textContent = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
  return rect;
}

/**
 * Where a marker goes: nowhere on another page, which a client-side route
 * change can make this one without the bar hearing of it; otherwise on its
 * element, as the selector finds it now. A comment
 * not yet sent was made moments ago, so while its selector finds nothing its
 * marker stays where the element was. A sent one is history, shown only
 * where its element is still there to see.
 */
function markerRect(marker: Marker): Rect | null {
  if (!samePage(marker.pin.url, location.href)) return null;
  const el = resolvePin(marker.pin);
  if (el) {
    const rect = el.getBoundingClientRect();
    return rect.width || rect.height ? rect : null;
  }
  const { box } = marker.pin;
  if (marker.sent || (!box.width && !box.height)) return null;
  return { left: box.x - scrollX, top: box.y - scrollY, width: box.width, height: box.height };
}
