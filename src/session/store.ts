import type { Verdict } from '../verdict.js';

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

export type Phase = 'reviewing' | 'submitted' | 'working' | 'approved';

export interface Comment {
  id: string;
  body: string;
  createdAt: number;
  /** The page the reviewer was on when they wrote it. */
  page: string | null;
  /** The round it went out in, or null while it is still the reviewer's to change. */
  sentIn: number | null;
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
  comments: Comment[];
}

type Listener = (state: RoundState) => void;

export class CommentStore {
  private round = 1;
  private phase: Phase = 'reviewing';
  private message: string | null = null;
  private summary: string | null = null;
  private pending: Verdict | null = null;
  private comments: Comment[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();

  constructor(private readonly now: () => number = Date.now) {}

  snapshot(): RoundState {
    return {
      round: this.round,
      phase: this.phase,
      message: this.message,
      summary: this.summary,
      comments: this.comments.map((c) => ({ ...c })),
    };
  }

  /** The submitted or approved round, until the agent picks it up. */
  verdict(): Verdict | null {
    return this.pending && structuredClone(this.pending);
  }

  /** A comment is its text trimmed; one with nothing in it is not added. */
  add(body: string, page: string | null = null): Comment | null {
    const text = body.trim();
    if (!text) return null;
    if (this.phase === 'approved') throw new Error('the review is approved; there is nothing more to comment on');
    const comment = { id: `c${++this.seq}`, body: text, createdAt: this.now(), page, sentIn: null };
    this.comments.push(comment);
    this.changed();
    return { ...comment };
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

  /** Sends every comment not yet sent as this round, and starts the next. */
  submit(page: string | null): Verdict {
    this.expect('reviewing', 'submit');
    const unsent = this.unsent();
    if (!unsent.length) throw new Error('there are no new comments to submit');
    for (const c of unsent) c.sentIn = this.round;
    this.pending = {
      version: 1,
      approved: false,
      round: this.round,
      page,
      comments: unsent.map((c) => ({ ...c, sentIn: this.round, kind: 'general' as const, target: null })),
    };
    this.round++;
    this.phase = 'submitted';
    this.summary = null;
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
    this.pending = null;
    this.changed();
  }

  /** The agent is done with the round; the reviewer has the next one. */
  ready(summary: string | null): void {
    this.expect(['submitted', 'working'], 'be marked ready');
    this.phase = 'reviewing';
    this.message = null;
    this.summary = summary?.trim() || null;
    this.pending = null;
    this.changed();
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

const PHASE_WORDS: Record<Phase, string> = {
  reviewing: 'with the reviewer',
  submitted: 'waiting for the agent to pick up the round',
  working: 'with the agent',
  approved: 'approved',
};

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
