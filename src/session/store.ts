/**
 * The comments of the round being reviewed. The session holds the one that
 * counts, so they outlive a reload and every tab sees the same list; the demo
 * page holds its own in memory. No Node imports, because the bar bundles this
 * for the demo.
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
  /** A PNG of the element, as the session saw it. Set by the session, never the page. */
  screenshot?: string;
}

/** A pin as the page makes it, before the session has photographed the element. */
export type PinDraft = Omit<Pin, 'screenshot'>;

export interface Comment {
  id: string;
  body: string;
  createdAt: number;
  /** Absent for a general comment. */
  pin?: Pin;
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
    return { round: this.round, comments: this.comments.map(copy) };
  }

  /** A comment is its text trimmed; one with nothing in it is not added. */
  add(body: string, pin?: Pin): Comment | null {
    const text = body.trim();
    if (!text) return null;
    const comment: Comment = { id: `c${++this.seq}`, body: text, createdAt: this.now() };
    if (pin) comment.pin = copyPin(pin);
    this.comments.push(comment);
    this.changed();
    return copy(comment);
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

const copyPin = (pin: Pin): Pin => ({ ...pin, box: { ...pin.box }, viewport: { ...pin.viewport } });
const copy = (c: Comment): Comment => (c.pin ? { ...c, pin: copyPin(c.pin) } : { ...c });

/** The markers' numbers: pinned comments count 1, 2, 3 in the order they were made. */
export function pinNumbers(comments: Comment[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const c of comments) if (c.pin) numbers.set(c.id, numbers.size + 1);
  return numbers;
}
