import { pinNumbers, plural, type Comment, type PinDraft, type RoundState } from '../session/store.js';
import { h, icon, sendOnEnter, sheet } from './dom.js';
import { samePage } from './geometry.js';
import { Overlay } from './overlay.js';
import { keepPinnedClear } from './pinned.js';
import { createPicker, type Picker } from './picker.js';
import { addScrollPadding } from './scroll-padding.js';
import { BAR_STYLES, NARROW, PAGE_OFFSET, STATUS_OFFSET } from './styles.js';
import { pinDraftFor, resolvePin } from './target.js';
import type { Transport } from './transport.js';

/**
 * The Gloss bar: a strip across the top of the page under review, where the
 * reviewer writes the round's comments, submits them to Claude, and in the
 * end approves. While Claude has the round, the bar says so and nothing can
 * be submitted; when Claude is done, its summary is there to check against.
 *
 * Its tools are Interact, where the page works as it always does, and
 * Select, where a click on the page picks an element to comment on instead.
 * A comment made that way is pinned: it keeps where the element was, the
 * session photographs it, and a numbered marker stays on the element.
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
 * than through `innerHTML`, for pages that enforce Trusted Types. The marks
 * it leaves on the page's own styles are PAGE_OFFSET, on a phone
 * STATUS_OFFSET while the status shows, its height added to the page's scroll
 * padding, the offsets that keep the page's fixed and sticky elements out
 * from under it, and in Select mode a crosshair cursor.
 */

const HOST_TAG = 'gloss-bar';
const MOUNTED = Symbol.for('gloss.bar');

export interface BarOptions {
  /** Open the comment list at once. The demo page uses it to show the list by URL. */
  listOpen?: boolean;
  /** Open the discard-and-approve prompt at once, as the demo page does by URL. */
  confirmOpen?: boolean;
  /** The tool to start with. */
  mode?: Mode;
  /** A selector for an element to start with picked and the comment box open on, in Select mode. */
  pick?: string;
}

export type Mode = 'interact' | 'select';

/** An element picked in Select mode, and its pin as it was then. */
interface Picked {
  el: Element;
  draft: PinDraft;
}

// ↖ and a crosshair.
const ARROW = ['M11.5 11.5 4.5 4.5', 'M4.5 10V4.5H10'];
const CROSSHAIR = ['M12 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0', 'M8 1v3', 'M8 12v3', 'M1 8h3', 'M12 8h3'];

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
  const showStatusPadding = addScrollPadding();
  // Listening before the page's scripts do, so a click in Select mode is the bar's first.
  let bar: Bar | undefined;
  const picker = createPicker((e) => bar !== undefined && e.composedPath().includes(bar.host));

  const start = () => {
    if (document.querySelector(HOST_TAG)) return;
    bar = new Bar(transport, options, showStatusPadding, picker);
    bar.attach();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

class Bar {
  readonly host = document.createElement(HOST_TAG);
  private readonly root = this.host.attachShadow({ mode: 'open' });
  private state: RoundState = { round: 1, phase: 'reviewing', message: null, summary: null, comments: [] };
  private listOpen: boolean;

  private readonly bar = h('div', { class: 'bar', role: 'toolbar', 'aria-label': 'Gloss' });
  private readonly round = h('span', { class: 'round' });
  private readonly interact = h(
    'button',
    { class: 'tool interact', type: 'button', 'aria-pressed': 'true', 'aria-label': 'Interact', title: 'Use the page' },
    icon(...ARROW),
    h('span', { class: 'tool-label' }, 'Interact'),
  );
  private readonly select = h(
    'button',
    { class: 'tool select', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Select', title: 'Pick an element to comment on' },
    icon(...CROSSHAIR),
    h('span', { class: 'tool-label' }, 'Select'),
  );
  private readonly tools = h('span', { class: 'tools', role: 'group', 'aria-label': 'Tool' }, this.interact, this.select);
  private mode: Mode;
  private picked: Picked | null = null;
  private readonly overlay = new Overlay({ add: () => this.addPinned(), cancel: () => this.closeComposer() });
  /** On a phone the tools are one button, Select, which turns Select mode on and off. */
  private readonly narrow = window.matchMedia(NARROW);
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
  private readonly pickOnLoad: string | null;
  /** Pushes the page down a little further while the status hangs under a narrow bar. */
  private readonly statusOffset = sheet(STATUS_OFFSET);
  private readonly list = h('ul', { class: 'list', id: 'gloss-list', hidden: '' });

  constructor(
    private readonly transport: Transport,
    options: BarOptions,
    /** Tells scroll-padding.ts whether the status line is hanging under the bar. */
    private readonly showStatusPadding: (status: boolean) => void,
    /** Select mode's listeners on the page, there since before the page's own. */
    private readonly picker: Picker,
  ) {
    this.listOpen = options.listOpen ?? false;
    this.confirming = false;
    this.confirmOnLoad = options.confirmOpen ?? false;
    this.mode = options.pick ? 'select' : (options.mode ?? 'interact');
    this.pickOnLoad = options.pick ?? null;
  }

  attach(): void {
    this.root.adoptedStyleSheets = [sheet(BAR_STYLES)];
    this.bar.append(
      h('span', { class: 'mark' }, 'Gloss'),
      this.round,
      this.tools,
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
    this.root.append(this.bar, this.list, this.overlay.layer);

    this.add.addEventListener('click', () => this.addComment());
    sendOnEnter(this.input, () => this.addComment());
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
    this.interact.addEventListener('click', () => this.setMode('interact'));
    this.select.addEventListener('click', () =>
      this.setMode(this.narrow.matches && this.mode === 'select' ? 'interact' : 'select'),
    );
    this.picker.onHover = (el) => this.overlay.hover(el);
    this.picker.onPick = (el) => this.pick(el);
    // In Select mode the picker hears Escape wherever the focus is, the bar included.
    this.picker.onEscape = () => this.escape();
    this.root.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape' && !this.picker.active) this.escape();
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
    const placeholder = () => (this.input.placeholder = this.narrow.matches ? 'Comment…' : 'Add a general comment…');
    this.narrow.addEventListener('change', placeholder);
    placeholder();

    this.keepAttached();
    keepPinnedClear(this.host);
    this.transport.subscribe((s) => this.render(s));
    this.render(this.state);
    this.transport.state().then(
      (s) => {
        this.confirming = this.confirmOnLoad;
        this.render(s);
        const el = this.pickOnLoad === null ? null : resolvePin({ selector: this.pickOnLoad });
        if (el && this.mode === 'select') this.pick(el);
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

  /** Picks an element in Select mode: the comment box opens on it, and the list, which the click never reached, closes. */
  private pick(el: Element): void {
    this.listOpen = false;
    this.render(this.state);
    this.picked = { el, draft: pinDraftFor(el) };
    this.overlay.open(el, this.picked.draft);
  }

  /**
   * Adds the comment in the box, pinned to the picked element. The pin is
   * made again from the element as it is now, in case the page has moved
   * it since the pick, unless it has gone. While the session photographs the
   * element, everything the bar draws over the page is hidden, for the two
   * frames it takes to be sure the hiding has been painted and for as long as
   * the session takes.
   */
  private async addPinned(): Promise<void> {
    const { picked } = this;
    const body = this.overlay.input.value;
    if (!picked || !body.trim()) return;
    const pin = picked.el.isConnected ? pinDraftFor(picked.el) : picked.draft;
    this.setCapturing(true);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    this.transport.add(body, pin).then(
      (s) => {
        this.setCapturing(false);
        // Cleared only once it is kept, as addComment does. Select mode stays
        // on, for the next element.
        this.closeComposer();
        this.render(s);
      },
      (e: unknown) => {
        this.setCapturing(false);
        this.fail(e);
      },
    );
  }

  private closeComposer(): void {
    this.picked = null;
    this.overlay.close();
  }

  private setCapturing(capturing: boolean): void {
    this.list.classList.toggle('capturing', capturing);
    this.overlay.setCapturing(capturing);
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.render(this.state);
  }

  /** Closes what is open, the innermost first: the comment box, the list or prompt, then Select mode. */
  private escape(): void {
    if (this.overlay.composing) this.closeComposer();
    else if (this.listOpen || this.confirming) {
      this.listOpen = this.confirming = false;
      this.render(this.state);
    } else this.setMode('interact');
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
    this.renderMode(state);
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

  /** The tool in use, and the markers on the elements pinned on this page. */
  private renderMode(state: RoundState): void {
    // Nothing more can be commented on, and the page's clicks must not stay dead with the tools disabled.
    if (state.phase === 'approved') this.mode = 'interact';
    const selecting = this.mode === 'select';
    this.interact.disabled = this.select.disabled = state.phase === 'approved';
    this.interact.setAttribute('aria-pressed', String(!selecting));
    this.select.setAttribute('aria-pressed', String(selecting));
    this.picker.setActive(selecting);
    if (!selecting && this.overlay.composing) this.closeComposer();

    const numbers = pinNumbers(state.comments);
    this.overlay.setMarkers(
      state.comments.flatMap((c) =>
        c.pin && samePage(c.pin.url, location.href)
          ? [{ n: numbers.get(c.id)!, body: c.body, pin: c.pin, sent: c.sentIn !== null }]
          : [],
      ),
    );
  }

  /** Whose move it is, and what the agent last said. */
  private renderStatus(state: RoundState): void {
    const [text, title] = statusText(state);
    this.status.textContent = this.confirming ? '' : text;
    this.status.title = title;
    this.status.dataset.phase = state.phase;
    const others = document.adoptedStyleSheets.filter((s) => s !== this.statusOffset);
    const showing = Boolean(this.status.textContent);
    document.adoptedStyleSheets = showing ? [...others, this.statusOffset] : others;
    this.showStatusPadding(showing);
  }

  /** The unsent comments, which can still be deleted, then each round already sent, newest first. */
  private items(state: RoundState, unsent: Comment[]): HTMLLIElement[] {
    const items: HTMLLIElement[] = [];
    if (state.summary) {
      items.push(h('li', { class: 'summary' }, h('span', { class: 'label' }, `Claude, after round ${state.round - 1}`), state.summary));
    }
    const numbers = pinNumbers(state.comments);
    items.push(...unsent.map((c) => this.item(c, numbers)));
    if (!unsent.length) {
      const empty = state.phase === 'approved' ? 'Approved. There is nothing more to send.' : 'No new comments. Type one above and press Enter.';
      items.push(h('li', { class: 'empty' }, empty));
    }
    for (let round = state.round - 1; round >= 1; round--) {
      const sent = state.comments.filter((c) => c.sentIn === round);
      if (!sent.length) continue;
      items.push(h('li', { class: 'group' }, `Sent in round ${round}`));
      items.push(...sent.map((c) => this.item(c, numbers)));
    }
    return items;
  }

  /** A comment, and for a pinned one its marker's number and the element it is on. */
  private item(comment: Comment, numbers: Map<string, number>): HTMLLIElement {
    const { pin } = comment;
    const pinned = pin ? [h('span', { class: 'num' }, String(numbers.get(comment.id)))] : [];
    const body = h('span', { class: 'body' }, comment.body);
    if (pin) body.append(h('span', { class: 'meta' }, pin.text ? `${pin.tag} · ${pin.text}` : pin.tag));
    if (comment.sentIn !== null) return h('li', { class: 'item sent' }, ...pinned, body);
    const remove = h('button', { class: 'delete', type: 'button', 'aria-label': 'Delete comment', title: 'Delete' }, '×');
    remove.addEventListener('click', () => this.removeComment(comment.id));
    return h('li', { class: 'item' }, ...pinned, body, remove);
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
