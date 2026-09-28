import type { Comment, RoundState } from '../session/store.js';
import { BAR_STYLES, NARROW, PAGE_OFFSET } from './styles.js';
import type { Transport } from './transport.js';

/**
 * The Gloss bar: a strip across the top of the page under review, where the
 * reviewer writes the round's comments.
 *
 * It runs inside someone else's page, so it keeps to itself. Its DOM is in a
 * shadow root on one `<gloss-bar>` element, hung off `<html>` rather than
 * `<body>` so a framework that owns the body never sees it. Its styles are
 * constructed stylesheets, which a strict CSP's `style-src` does not block the
 * way it would an inline `<style>`, and its DOM is built node by node rather
 * than through `innerHTML`, for pages that enforce Trusted Types. The one
 * mark it leaves on the page's own styles is PAGE_OFFSET.
 */

const HOST_TAG = 'gloss-bar';
const MOUNTED = Symbol.for('gloss.bar');
const LATER = 'Comes in a later card';

export interface BarOptions {
  /** Open the comment list at once. The demo page uses it to show the list by URL. */
  listOpen?: boolean;
}

/**
 * Mounts the bar once per page. The session registers it as an init script,
 * which runs in every frame and again on every navigation; only the top frame
 * gets a bar.
 */
export function mountBar(transport: Transport, options: BarOptions = {}): void {
  if (window.top !== window) return;
  const marked = window as unknown as Record<symbol, boolean>;
  if (marked[MOUNTED]) return;
  marked[MOUNTED] = true;

  // Pushed down straight away, before the page has painted, so the content
  // does not jump when the bar arrives.
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet(PAGE_OFFSET)];

  const start = () => {
    if (!document.querySelector(HOST_TAG)) new Bar(transport, options).attach();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

function sheet(css: string): CSSStyleSheet {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  return s;
}

/** One element, its attributes and its children. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

class Bar {
  private readonly host = document.createElement(HOST_TAG);
  private readonly root = this.host.attachShadow({ mode: 'open' });
  private state: RoundState = { round: 1, comments: [] };
  private listOpen: boolean;

  private readonly round = h('span', { class: 'round' });
  private readonly input = h('textarea', { rows: '1', 'aria-label': 'Add a general comment' });
  private readonly count = h('span');
  private readonly caret = h('span', { class: 'caret', 'aria-hidden': 'true' });
  private readonly toggle = h(
    'button',
    { class: 'toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'gloss-list' },
    h('span', { class: 'toggle-label' }, 'Comments '),
    this.count,
    this.caret,
  );
  private readonly error = h('span', { class: 'error', role: 'status' });
  private readonly note = h('span', { class: 'note', role: 'status' });
  private noteTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly list = h('ul', { class: 'list', id: 'gloss-list', hidden: '' });

  constructor(
    private readonly transport: Transport,
    options: BarOptions,
  ) {
    this.listOpen = options.listOpen ?? false;
  }

  attach(): void {
    this.root.adoptedStyleSheets = [sheet(BAR_STYLES)];
    const add = h('button', { type: 'button' }, 'Add');
    this.root.append(
      h(
        'div',
        { class: 'bar', role: 'toolbar', 'aria-label': 'Gloss' },
        h('span', { class: 'mark' }, 'Gloss'),
        this.round,
        this.input,
        add,
        this.toggle,
        this.error,
        h('span', { class: 'spacer' }),
        this.note,
        this.later('Submit', 'submit'),
        this.later('Approve', 'approve'),
      ),
      this.list,
    );

    add.addEventListener('click', () => this.addComment());
    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      this.addComment();
    });
    this.toggle.addEventListener('click', () => this.setListOpen(!this.listOpen));
    this.root.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') this.setListOpen(false);
    });
    // Typing in the bar is not typing in the page: a page's own shortcuts
    // ("/" to search, "j" for next) must not fire from the comment box.
    for (const type of ['keydown', 'keyup', 'keypress']) this.root.addEventListener(type, (e) => e.stopPropagation());
    // A click anywhere else closes the list, as a menu would.
    document.addEventListener('pointerdown', (e) => {
      if (this.listOpen && !e.composedPath().includes(this.host)) this.setListOpen(false);
    });
    window.addEventListener('resize', () => this.place());
    // On a phone the box is a few words wide; the long placeholder would be cut off mid-word.
    const narrow = window.matchMedia(NARROW);
    const placeholder = () => (this.input.placeholder = narrow.matches ? 'Comment…' : 'Add a general comment…');
    narrow.addEventListener('change', placeholder);
    placeholder();

    this.keepAttached();
    this.transport.subscribe((s) => this.render(s));
    this.render(this.state);
    this.transport.state().then((s) => this.render(s), (e: unknown) => this.fail(e));
  }

  /**
   * Hydration or a router swapping out the document's children can take the
   * host with it. It goes straight back, with its state, since the element
   * and its shadow root are the same objects.
   */
  private keepAttached(): void {
    let observed = document.documentElement;
    const observer = new MutationObserver(() => {
      if (document.documentElement !== observed) {
        observed = document.documentElement;
        observer.observe(observed, { childList: true });
      }
      if (!this.host.isConnected) observed.append(this.host);
    });
    observer.observe(document, { childList: true });
    observer.observe(observed, { childList: true });
    observed.append(this.host);
  }

  private addComment(): void {
    const body = this.input.value;
    if (!body.trim()) return;
    this.transport.add(body).then(
      (s) => {
        // Cleared only once it is kept, so a comment the session never got
        // is still there to try again.
        this.input.value = '';
        this.render(s);
      },
      (e: unknown) => this.fail(e),
    );
  }

  private removeComment(id: string): void {
    this.transport.remove(id).then((s) => this.render(s), (e: unknown) => this.fail(e));
  }

  private setListOpen(open: boolean): void {
    this.listOpen = open;
    this.render(this.state);
  }

  private fail(e: unknown): void {
    this.error.textContent = e instanceof Error ? e.message : String(e);
  }

  private render(state: RoundState): void {
    this.state = state;
    this.error.textContent = '';
    this.round.textContent = `Round ${state.round}`;
    this.count.textContent = `(${state.comments.length})`;
    this.caret.textContent = this.listOpen ? '▴' : '';
    this.toggle.setAttribute('aria-expanded', String(this.listOpen));
    this.list.hidden = !this.listOpen;
    this.list.replaceChildren(
      ...(state.comments.length
        ? state.comments.map((c) => this.item(c))
        : [h('li', { class: 'empty' }, 'No comments yet. Type one above and press Enter.')]),
    );
    this.place();
  }

  private item(comment: Comment): HTMLLIElement {
    const remove = h('button', { class: 'delete', type: 'button', 'aria-label': 'Delete comment', title: 'Delete' }, '×');
    remove.addEventListener('click', () => this.removeComment(comment.id));
    return h('li', { class: 'item' }, h('span', { class: 'body' }, comment.body), remove);
  }

  /** The list hangs under its toggle, kept inside the viewport on a narrow screen. */
  private place(): void {
    if (!this.listOpen) return;
    const left = this.toggle.getBoundingClientRect().left;
    const width = this.list.getBoundingClientRect().width;
    // CSSOM rather than a style attribute, which `style-src` would refuse.
    this.list.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  }

  /** Submit and Approve: there to be seen, and saying they come later when pressed. */
  private later(label: string, kind: string): HTMLButtonElement {
    const button = h('button', { class: `later ${kind}`, type: 'button', 'aria-disabled': 'true', title: LATER }, label);
    button.addEventListener('click', () => {
      this.note.textContent = `${label}: ${LATER.toLowerCase()}`;
      clearTimeout(this.noteTimer);
      this.noteTimer = setTimeout(() => (this.note.textContent = ''), 2500);
    });
    return button;
  }
}
