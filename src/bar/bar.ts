import { plural, type Comment, type RoundState } from '../session/store.js';
import { BAR_STYLES, NARROW, PAGE_OFFSET, STATUS_OFFSET } from './styles.js';
import type { Transport } from './transport.js';

/**
 * The Gloss bar: a strip across the top of the page under review, where the
 * reviewer writes the round's comments, submits them to Claude, and in the
 * end approves. While Claude has the round, the bar says so and nothing can
 * be submitted; when Claude is done, its summary is there to check against.
 *
 * Submit, Approve and the approve confirmation act only on a click the
 * browser made (`isTrusted`). The page under review can reach into the
 * shadow root, and its `button.click()` must not approve anything.
 *
 * It runs inside someone else's page, so it keeps to itself. Its DOM is in a
 * shadow root on one `<gloss-bar>` element, hung off `<html>` rather than
 * `<body>` so a framework that owns the body never sees it. Its styles are
 * constructed stylesheets, which a strict CSP's `style-src` does not block the
 * way it would an inline `<style>`, and its DOM is built node by node rather
 * than through `innerHTML`, for pages that enforce Trusted Types. The one
 * mark it leaves on the page's own styles is PAGE_OFFSET, and on a phone,
 * STATUS_OFFSET while the status shows.
 */

const HOST_TAG = 'gloss-bar';
const MOUNTED = Symbol.for('gloss.bar');

export interface BarOptions {
  /** Open the comment list at once. The demo page uses it to show the list by URL. */
  listOpen?: boolean;
  /** Open the discard-and-approve prompt at once, as the demo page does by URL. */
  confirmOpen?: boolean;
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
  private state: RoundState = { round: 1, phase: 'reviewing', message: null, summary: null, comments: [] };
  private listOpen: boolean;

  private readonly bar = h('div', { class: 'bar', role: 'toolbar', 'aria-label': 'Gloss' });
  private readonly round = h('span', { class: 'round' });
  private readonly input = h('textarea', { rows: '1', 'aria-label': 'Add a general comment' });
  private readonly count = h('span');
  private readonly toggle = h(
    'button',
    { class: 'toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'gloss-list' },
    h('span', { class: 'toggle-label' }, 'Comments '),
    this.count,
    h('span', { class: 'caret', 'aria-hidden': 'true' }),
  );
  private readonly error = h('span', { class: 'error', role: 'status' });
  private readonly status = h('span', { class: 'status', role: 'status' });
  private readonly add = h('button', { class: 'add', type: 'button' }, 'Add');
  private readonly submit = h('button', { class: 'submit', type: 'button' }, 'Submit');
  private readonly approve = h('button', { class: 'approve', type: 'button' }, 'Approve');
  private readonly confirmCount = h('span');
  private readonly confirmYes = h('button', { class: 'approve', type: 'button' }, 'Discard & approve');
  private readonly confirmNo = h('button', { type: 'button' }, 'Cancel');
  private readonly confirm = h(
    'span',
    { class: 'confirm', role: 'group', 'aria-label': 'Approve with unsent comments', hidden: '' },
    h('span', { class: 'confirm-text' }, 'Approve and discard ', this.confirmCount, '?'),
    this.confirmYes,
    this.confirmNo,
  );
  private confirming: boolean;
  private readonly confirmOnLoad: boolean;
  /** Pushes the page down a little further while the status hangs under a narrow bar. */
  private readonly statusOffset = sheet(STATUS_OFFSET);
  private readonly list = h('ul', { class: 'list', id: 'gloss-list', hidden: '' });

  constructor(
    private readonly transport: Transport,
    options: BarOptions,
  ) {
    this.listOpen = options.listOpen ?? false;
    this.confirming = false;
    this.confirmOnLoad = options.confirmOpen ?? false;
  }

  attach(): void {
    this.root.adoptedStyleSheets = [sheet(BAR_STYLES)];
    this.bar.append(
      h('span', { class: 'mark' }, 'Gloss'),
      this.round,
      this.input,
      this.add,
      this.toggle,
      this.error,
      h('span', { class: 'spacer' }),
      this.status,
      this.submit,
      this.approve,
      this.confirm,
    );
    this.root.append(this.bar, this.list);

    this.add.addEventListener('click', () => this.addComment());
    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      this.addComment();
    });
    this.toggle.addEventListener('click', () => this.setListOpen(!this.listOpen));
    this.submit.addEventListener('click', (e) => e.isTrusted && this.act(() => this.transport.submit()));
    this.approve.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      // Unsent comments would go nowhere: say so, and let the reviewer choose.
      if (this.unsent().length) this.setConfirming(true);
      else this.act(() => this.transport.approve(false));
    });
    this.confirmYes.addEventListener('click', (e) => e.isTrusted && this.act(() => this.transport.approve(true)));
    this.confirmNo.addEventListener('click', () => this.setConfirming(false));
    this.root.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Escape') return;
      this.setListOpen(false);
      this.setConfirming(false);
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
    this.transport.state().then(
      (s) => {
        this.confirming = this.confirmOnLoad;
        this.render(s);
      },
      (e: unknown) => this.fail(e),
    );
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
    this.act(() => this.transport.remove(id));
  }

  private act(change: () => Promise<RoundState>): void {
    change().then((s) => this.render(s), (e: unknown) => this.fail(e));
  }

  private setListOpen(open: boolean): void {
    this.listOpen = open;
    this.render(this.state);
  }

  private setConfirming(open: boolean): void {
    this.confirming = open;
    this.render(this.state);
  }

  private fail(e: unknown): void {
    this.error.textContent = e instanceof Error ? e.message : String(e);
  }

  private unsent(): Comment[] {
    return this.state.comments.filter((c) => c.sentIn === null);
  }

  private render(state: RoundState): void {
    this.state = state;
    const unsent = this.unsent();
    const reviewing = state.phase === 'reviewing';
    // A prompt about comments that have gone, or a round that is not the reviewer's, is no longer a question.
    if (!unsent.length || !reviewing) this.confirming = false;

    this.error.textContent = '';
    this.round.textContent = `Round ${state.round}`;
    this.count.textContent = `(${unsent.length})`;
    this.input.disabled = this.add.disabled = state.phase === 'approved';
    this.submit.disabled = !reviewing || !unsent.length;
    this.submit.title = !reviewing ? '' : unsent.length ? `Send ${plural(unsent.length, 'comment')} to Claude` : 'Add a comment to submit';
    this.approve.disabled = !reviewing;
    this.submit.hidden = this.approve.hidden = this.confirming || state.phase === 'approved';
    this.confirm.hidden = !this.confirming;
    this.bar.classList.toggle('confirming', this.confirming);
    this.confirmCount.textContent = `${plural(unsent.length, 'unsent comment')}`;
    this.renderStatus(state);

    this.toggle.setAttribute('aria-expanded', String(this.listOpen));
    this.list.hidden = !this.listOpen;
    this.list.replaceChildren(...this.items(state, unsent));
    this.place();
  }

  /** Whose move it is, and what the agent last said. */
  private renderStatus(state: RoundState): void {
    const [text, title] = statusText(state);
    this.status.textContent = this.confirming ? '' : text;
    this.status.title = title;
    this.status.dataset.phase = state.phase;
    const others = document.adoptedStyleSheets.filter((s) => s !== this.statusOffset);
    document.adoptedStyleSheets = this.status.textContent ? [...others, this.statusOffset] : others;
  }

  /** The unsent comments, which can still be deleted, then each round already sent, newest first. */
  private items(state: RoundState, unsent: Comment[]): HTMLLIElement[] {
    const items: HTMLLIElement[] = [];
    if (state.summary) {
      items.push(h('li', { class: 'summary' }, h('span', { class: 'label' }, `Claude, after round ${state.round - 1}`), state.summary));
    }
    items.push(...unsent.map((c) => this.item(c)));
    if (!unsent.length) {
      const empty = state.phase === 'approved' ? 'Approved. There is nothing more to send.' : 'No new comments. Type one above and press Enter.';
      items.push(h('li', { class: 'empty' }, empty));
    }
    for (let round = state.round - 1; round >= 1; round--) {
      const sent = state.comments.filter((c) => c.sentIn === round);
      if (!sent.length) continue;
      items.push(h('li', { class: 'group' }, `Sent in round ${round}`));
      items.push(...sent.map((c) => this.item(c)));
    }
    return items;
  }

  private item(comment: Comment): HTMLLIElement {
    if (comment.sentIn !== null) return h('li', { class: 'item sent' }, h('span', { class: 'body' }, comment.body));
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
}

/** The status strip's text, and the whole of it for a tooltip when the strip cuts it short. */
export function statusText(state: RoundState): [text: string, title: string] {
  const sent = state.round - 1;
  switch (state.phase) {
    case 'submitted':
      return [`Sent round ${sent}, waiting for Claude`, ''];
    case 'working':
      return state.message ? [`Claude is working: ${state.message}`, state.message] : ['Claude is working…', ''];
    case 'approved':
      return ['Approved', ''];
    case 'reviewing':
      return state.summary ? [`Claude: ${state.summary}`, state.summary] : ['', ''];
  }
}
