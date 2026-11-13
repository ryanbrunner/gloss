import type { Verdict } from './verdict.js';

/**
 * The review as it stands: the comments, the round they belong to, and whose
 * move it is. The session holds the one that counts, so it outlives a reload
 * and every tab sees the same thing; the demo page holds its own in memory. No
 * Node imports, because the bar bundles this for the demo.
 *
 * A round goes reviewing → submitted → working → reviewing, or ends approved:
 *
 * - `submit` sends the comments not yet sent, as round N, and moves on to N+1.
 * - `working` is the agent saying it has picked the round up.
 * - `ready` is the agent saying it is done, with a summary of what changed.
 * - `approve` ends the review. Only the reviewer does that.
 *
 * The verdict a submit or an approval makes is kept until the agent moves, so
 * asking for it twice gets the same answer rather than losing a round.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a comment was made, for someone who cannot see the screen: enough to
 * find the element again, and the code that draws it.
 */
export interface Pin {
  /** The page, as it was when the comment was made. */
  url: string;
  /** A CSS selector that matched this one element when it was picked. */
  selector: string;
  tag: string;
  /** The element's visible text, squeezed to one line and cut short. */
  text: string;
  /** Where the element was, in CSS pixels from the top left of the document. */
  box: Box;
  /** The window's size then, since a layout can depend on it. */
  viewport: { width: number; height: number };
  /** The words the reviewer selected, when they commented on a selection. */
  quote?: string;
  /** The reviewer's proposed replacement for `quote`, when they suggested an edit rather than commenting. */
  suggestion?: string;
  /** A PNG of the element, as the session saw it. Set by the session, never the page. */
  screenshot?: string;
}

/** A pin as the page makes it, before the session has photographed the element. */
export type PinDraft = Omit<Pin, 'screenshot'>;

export type Phase = 'reviewing' | 'submitted' | 'working' | 'approved';

/**
 * Who wrote a comment, where a review has more than one reviewer and the
 * host knows who each is. Set by the host, never the page.
 */
export interface Author {
  id: string;
  name: string | null;
}

export interface Comment {
  id: string;
  body: string;
  createdAt: number;
  /** The page the reviewer was on when they wrote it. */
  page: string | null;
  /** The round it went out in, or null while it is still the reviewer's to change. */
  sentIn: number | null;
  /** Absent for a general comment. */
  pin?: Pin;
  /** Absent where the host does not say: the CLI's session has the one reviewer at the window. */
  author?: Author;
}

/** What the bar renders, and what `GET /api/state` answers with. */
export interface RoundState {
  /** The round being written now. Comments sent earlier carry their own. */
  round: number;
  phase: Phase;
  /** What the agent says it is doing, while it works. */
  message: string | null;
  /** What the agent says it changed, from its last `ready` until the next round goes out. */
  summary: string | null;
  /** The round `summary` is about, since `round` can move past it before the reviewer has seen it. */
  summaryRound: number | null;
  /** Whether a comment goes to the agent the moment it is written, rather than waiting for Submit. */
  live: boolean;
  comments: Comment[];
}

type Listener = (state: RoundState) => void;

/**
 * Everything a store holds, as plain data: what `toJSON` gives and
 * `CommentStore.from` takes back, for a host that keeps a review across
 * restarts. `parseStoreData` (./store-data.ts) checks one read back from
 * storage.
 */
export interface StoreData {
  v: 1;
  round: number;
  phase: Phase;
  message: string | null;
  summary: string | null;
  summaryRound: number | null;
  live: boolean;
  pending: Verdict | null;
  delivered: Verdict | null;
  comments: Comment[];
  seq: number;
  lastPage: string | null;
}

export class CommentStore {
  private round = 1;
  private phase: Phase = 'reviewing';
  private message: string | null = null;
  private summary: string | null = null;
  private summaryRound: number | null = null;
  private pending: Verdict | null = null;
  /** The round the agent last picked up, so one it dropped can be handed out again. */
  private delivered: Verdict | null = null;
  private comments: Comment[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();
  /** The page the reviewer was last on, for a submit the store makes itself rather than the reviewer. */
  private lastPage: string | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private live = false,
  ) {}

  snapshot(): RoundState {
    return {
      round: this.round,
      phase: this.phase,
      message: this.message,
      summary: this.summary,
      summaryRound: this.summaryRound,
      live: this.live,
      comments: this.comments.map(copy),
    };
  }

  /** All of it, for `CommentStore.from` to take back. */
  toJSON(): StoreData {
    return structuredClone({
      v: 1 as const,
      round: this.round,
      phase: this.phase,
      message: this.message,
      summary: this.summary,
      summaryRound: this.summaryRound,
      live: this.live,
      pending: this.pending,
      delivered: this.delivered,
      comments: this.comments,
      seq: this.seq,
      lastPage: this.lastPage,
    });
  }

  /** A store as `toJSON` left it, carrying on from there: the next comment is numbered after the last. */
  static from(data: StoreData, now: () => number = Date.now): CommentStore {
    const d = structuredClone(data);
    const store = new CommentStore(now, d.live);
    store.round = d.round;
    store.phase = d.phase;
    store.message = d.message;
    store.summary = d.summary;
    store.summaryRound = d.summaryRound;
    store.pending = d.pending;
    store.delivered = d.delivered;
    store.comments = d.comments;
    store.seq = d.seq;
    store.lastPage = d.lastPage;
    return store;
  }

  /** The submitted or approved round, until the agent picks it up. */
  verdict(): Verdict | null {
    return this.pending && structuredClone(this.pending);
  }

  /** A comment is its text trimmed; one with nothing in it is not added. */
  add(body: string, page: string | null = null, pin?: Pin, author?: Author): Comment | null {
    const text = body.trim();
    if (!text) return null;
    if (this.phase === 'approved') throw new Error('the review is approved; there is nothing more to comment on');
    const comment: Comment = { id: `c${++this.seq}`, body: text, createdAt: this.now(), page, sentIn: null };
    if (pin) comment.pin = copyPin(pin);
    if (author) comment.author = { ...author };
    this.comments.push(comment);
    this.lastPage = page;
    // Live: the comment just written is its own round, sent at once rather
    // than waiting for Submit.
    if (this.live && this.phase === 'reviewing') this.submit(page);
    else this.changed();
    return copy(comment);
  }

  /** False when there was no such comment, which is not worth telling anyone about. */
  remove(id: string): boolean {
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) return false;
    if (comment.sentIn !== null) throw new Error(`that comment went out in round ${comment.sentIn} and cannot be taken back`);
    this.comments = this.comments.filter((c) => c !== comment);
    this.changed();
    return true;
  }

  /**
   * Changes an unsent comment's text. Null when there is no such comment, or
   * nothing to put in it: an empty box leaves the comment as it was, and the
   * list is where a comment is deleted.
   */
  edit(id: string, body: string): Comment | null {
    const text = body.trim();
    if (!text) return null;
    const comment = this.comments.find((c) => c.id === id);
    if (!comment) return null;
    if (comment.sentIn !== null) throw new Error(`that comment went out in round ${comment.sentIn} and cannot be changed`);
    comment.body = text;
    this.changed();
    return copy(comment);
  }

  /**
   * Sends every comment not yet sent as this round, and starts the next.
   * `keepSummary` leaves Claude's last summary in place, for the auto-submit
   * `ready()` makes on a round that was only queued because it was busy: the
   * reviewer has not seen that summary yet, so this submit must not be the
   * thing that clears it.
   */
  submit(page: string | null, options: { keepSummary?: boolean } = {}): Verdict {
    this.expect('reviewing', 'submit');
    const unsent = this.unsent();
    if (!unsent.length) throw new Error('there are no new comments to submit');
    for (const c of unsent) c.sentIn = this.round;
    this.pending = {
      version: 1,
      approved: false,
      round: this.round,
      page,
      comments: unsent.map(({ pin, ...c }) => ({
        ...c,
        sentIn: this.round,
        kind: pin ? ('pinned' as const) : ('general' as const),
        target: pin ? target(pin) : null,
      })),
    };
    this.round++;
    this.phase = 'submitted';
    if (!options.keepSummary) {
      this.summary = null;
      this.summaryRound = null;
    }
    this.changed();
    return structuredClone(this.pending);
  }

  /**
   * Ends the review. Comments never sent would be lost without the agent
   * hearing of them, so they are refused unless the reviewer has said to
   * drop them, and then they are deleted rather than kept out of sight.
   */
  approve(page: string | null, options: { discardUnsent?: boolean } = {}): Verdict {
    this.expect('reviewing', 'approve');
    const unsent = this.unsent();
    if (unsent.length && !options.discardUnsent) {
      throw new Error(`${plural(unsent.length, 'comment')} not sent yet; submit them, or approve and discard them`);
    }
    this.comments = this.comments.filter((c) => c.sentIn !== null);
    this.pending = { version: 1, approved: true, round: this.round, page, comments: [] };
    this.phase = 'approved';
    this.message = null;
    this.changed();
    return structuredClone(this.pending);
  }

  /** The agent has the round. Said again, it only changes the message. */
  working(message: string | null): void {
    this.expect(['submitted', 'working'], 'be marked working');
    this.phase = 'working';
    this.message = message?.trim() || null;
    if (this.pending) this.delivered = this.pending;
    this.pending = null;
    this.changed();
  }

  /**
   * The agent that had the round has gone without finishing it, so it goes
   * back to waiting for one, as it was submitted. For a host that hands
   * rounds to agents it cannot see, and notices when one stops answering.
   */
  requeue(): void {
    this.expect('working', 'be handed back to wait for the agent');
    if (!this.delivered) throw new Error('there is no round to hand back');
    this.phase = 'submitted';
    this.message = null;
    this.pending = this.delivered;
    this.changed();
  }

  /** The agent is done with the round; the reviewer has the next one. */
  ready(summary: string | null): void {
    this.expect(['submitted', 'working'], 'be marked ready');
    const finishedRound = this.round - 1;
    this.phase = 'reviewing';
    this.message = null;
    this.summary = summary?.trim() || null;
    this.summaryRound = this.summary ? finishedRound : null;
    this.pending = null;
    this.delivered = null;
    // Live: anything written while the agent was busy goes out at once,
    // rather than waiting on the reviewer to notice it is their move again.
    // The summary just set is kept, so it is not lost in the same tick.
    if (this.live && this.unsent().length) this.submit(this.lastPage, { keepSummary: true });
    else this.changed();
  }

  /**
   * Turns live mode on or off. Turning it on while the round is the
   * reviewer's, with something already unsent, sends it at once: a
   * deliberate side effect, not a silent one, since flipping the toggle is
   * itself the reviewer's action.
   */
  setLive(live: boolean): void {
    if (this.phase === 'approved') throw new Error('the review is approved; there is nothing more to comment on');
    this.live = live;
    if (live && this.phase === 'reviewing' && this.unsent().length) this.submit(this.lastPage);
    else this.changed();
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private unsent(): Comment[] {
    return this.comments.filter((c) => c.sentIn === null);
  }

  private expect(allowed: Phase | Phase[], what: string): void {
    if ([allowed].flat().includes(this.phase)) return;
    throw new Error(`the review cannot ${what} while it is ${PHASE_WORDS[this.phase]}`);
  }

  private changed(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}

const copyPin = (pin: Pin): Pin => ({ ...pin, box: { ...pin.box }, viewport: { ...pin.viewport } });

/** A pin as a verdict's `target`: the same fields, as the loose record the schema takes. */
const target = (pin: Pin): Record<string, unknown> => ({ ...copyPin(pin) });
const copy = (c: Comment): Comment => {
  const out = { ...c };
  if (c.pin) out.pin = copyPin(c.pin);
  if (c.author) out.author = { ...c.author };
  return out;
};

/** The markers' numbers: pinned comments count 1, 2, 3 in the order they were made. */
export function pinNumbers(comments: Comment[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const c of comments) if (c.pin) numbers.set(c.id, numbers.size + 1);
  return numbers;
}

const PHASE_WORDS: Record<Phase, string> = {
  reviewing: 'with the reviewer',
  submitted: 'waiting for the agent to pick up the round',
  working: 'with the agent',
  approved: 'approved',
};

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
