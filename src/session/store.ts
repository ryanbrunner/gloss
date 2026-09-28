/**
 * The comments of the round being reviewed. The session holds the one that
 * counts, so they outlive a reload and every tab sees the same list; the demo
 * page holds its own in memory. No Node imports, because the bar bundles this
 * for the demo.
 */

export interface Comment {
  id: string;
  body: string;
  createdAt: number;
}

/** What the bar renders, and what `GET /api/state` answers with. */
export interface RoundState {
  round: number;
  comments: Comment[];
}

type Listener = (state: RoundState) => void;

export class CommentStore {
  private round = 1;
  private comments: Comment[] = [];
  private seq = 0;
  private listeners = new Set<Listener>();

  constructor(private readonly now: () => number = Date.now) {}

  snapshot(): RoundState {
    return { round: this.round, comments: this.comments.map((c) => ({ ...c })) };
  }

  /** A comment is its text trimmed; one with nothing in it is not added. */
  add(body: string): Comment | null {
    const text = body.trim();
    if (!text) return null;
    const comment = { id: `c${++this.seq}`, body: text, createdAt: this.now() };
    this.comments.push(comment);
    this.changed();
    return { ...comment };
  }

  /** False when there was no such comment, which is not worth telling anyone about. */
  remove(id: string): boolean {
    const before = this.comments.length;
    this.comments = this.comments.filter((c) => c.id !== id);
    if (this.comments.length === before) return false;
    this.changed();
    return true;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }
}
