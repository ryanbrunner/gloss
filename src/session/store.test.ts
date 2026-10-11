import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { verdictSchema } from '../verdict.js';
import { CommentStore, pinNumbers, type Pin, type RoundState } from './store.js';

const PAGE = 'http://127.0.0.1:4400/';

describe('CommentStore', () => {
  test('starts on round 1, with the reviewer, with nothing in it', () => {
    assert.deepEqual(new CommentStore().snapshot(), {
      round: 1,
      phase: 'reviewing',
      message: null,
      summary: null,
      comments: [],
    });
  });

  test('adds comments in order, trimmed, with ids of their own and the page they were written on', () => {
    const store = new CommentStore(() => 1000);
    const a = store.add('  The header is too tall  ', PAGE);
    const b = store.add('Cart count is wrong');
    assert.ok(a && b);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(store.snapshot().comments, [
      { id: a.id, body: 'The header is too tall', createdAt: 1000, page: PAGE, sentIn: null },
      { id: b.id, body: 'Cart count is wrong', createdAt: 1000, page: null, sentIn: null },
    ]);
  });

  test('keeps the newlines inside a comment', () => {
    const store = new CommentStore();
    store.add('first line\nsecond line\n');
    assert.equal(store.snapshot().comments[0]?.body, 'first line\nsecond line');
  });

  test('refuses a comment with nothing in it', () => {
    const store = new CommentStore();
    assert.equal(store.add('   \n '), null);
    assert.equal(store.snapshot().comments.length, 0);
  });

  test('removes a comment by id, and says whether there was one', () => {
    const store = new CommentStore();
    const a = store.add('one');
    store.add('two');
    assert.ok(a);
    assert.equal(store.remove(a.id), true);
    assert.equal(store.remove(a.id), false);
    assert.deepEqual(store.snapshot().comments.map((c) => c.body), ['two']);
  });

  test('edits an unsent comment, trimmed, and leaves it alone for an empty box', () => {
    const store = new CommentStore();
    const a = store.add('one');
    assert.ok(a);
    assert.equal(store.edit(a.id, '  two  ')?.body, 'two');
    assert.equal(store.edit(a.id, '   '), null);
    assert.equal(store.edit('nope', 'three'), null);
    assert.deepEqual(store.snapshot().comments.map((c) => c.body), ['two']);
  });

  test('refuses to edit a comment that has gone out', () => {
    const store = new CommentStore();
    const a = store.add('one');
    assert.ok(a);
    store.submit(PAGE);
    assert.throws(() => store.edit(a.id, 'two'), /went out in round 1/);
    assert.deepEqual(store.snapshot().comments.map((c) => c.body), ['one']);
  });

  test('never reuses an id, even after a delete', () => {
    const store = new CommentStore();
    const a = store.add('one');
    assert.ok(a);
    store.remove(a.id);
    assert.notEqual(store.add('two')?.id, a.id);
  });

  test('tells listeners about each change, and stops when asked', () => {
    const store = new CommentStore();
    const seen: RoundState[] = [];
    const stop = store.onChange((s) => seen.push(s));
    const a = store.add('one');
    assert.ok(a);
    store.add('');
    store.remove('nope');
    store.remove(a.id);
    stop();
    store.add('after');
    assert.deepEqual(seen.map((s) => s.comments.length), [1, 0]);
  });

  test('hands out copies, so a caller cannot edit the list behind its back', () => {
    const store = new CommentStore();
    store.add('one');
    const snap = store.snapshot();
    snap.comments[0]!.body = 'changed';
    snap.comments.pop();
    assert.equal(store.snapshot().comments[0]?.body, 'one');
    store.submit(PAGE);
    store.verdict()!.comments.pop();
    assert.equal(store.verdict()?.comments.length, 1);
  });
});

describe('a round', () => {
  test('submits the unsent comments as round 1 and moves on to round 2', () => {
    const store = new CommentStore(() => 1000);
    store.add('The header is too tall', PAGE);
    store.add('Cart count is wrong', `${PAGE}?cart`);
    const verdict = store.submit(`${PAGE}?cart`);
    assert.deepEqual(verdict, {
      version: 1,
      approved: false,
      round: 1,
      page: `${PAGE}?cart`,
      comments: [
        { id: 'c1', kind: 'general', body: 'The header is too tall', page: PAGE, createdAt: 1000, sentIn: 1, target: null },
        { id: 'c2', kind: 'general', body: 'Cart count is wrong', page: `${PAGE}?cart`, createdAt: 1000, sentIn: 1, target: null },
      ],
    });
    const state = store.snapshot();
    assert.equal(state.round, 2);
    assert.equal(state.phase, 'submitted');
    assert.deepEqual(state.comments.map((c) => c.sentIn), [1, 1]);
  });

  test('refuses to submit with no new comments: that is not an approval', () => {
    const store = new CommentStore();
    assert.throws(() => store.submit(PAGE), /no new comments/);
    assert.equal(store.snapshot().phase, 'reviewing');
    assert.equal(store.verdict(), null);
  });

  test('keeps the verdict until the agent moves, so asking twice gets the same round', () => {
    const store = new CommentStore();
    store.add('one');
    store.submit(PAGE);
    assert.deepEqual(store.verdict(), store.verdict());
    assert.equal(store.verdict()?.round, 1);
    store.working('Fixing it');
    assert.equal(store.verdict(), null);
  });

  test('goes working, then ready with a summary, then back to the reviewer', () => {
    const store = new CommentStore();
    store.add('one');
    store.submit(PAGE);
    store.working('  Fixing the header ');
    assert.deepEqual([store.snapshot().phase, store.snapshot().message], ['working', 'Fixing the header']);
    store.working('Now the cart');
    assert.equal(store.snapshot().message, 'Now the cart');
    store.ready('Tightened the header');
    const state = store.snapshot();
    assert.deepEqual([state.phase, state.message, state.summary], ['reviewing', null, 'Tightened the header']);
  });

  test('can go ready straight from submitted, and an empty message or summary is none', () => {
    const store = new CommentStore();
    store.add('one');
    store.submit(PAGE);
    store.ready('  ');
    assert.deepEqual([store.snapshot().phase, store.snapshot().summary], ['reviewing', null]);
  });

  test('clears the summary once the next round goes out', () => {
    const store = new CommentStore();
    store.add('one');
    store.submit(PAGE);
    store.ready('Did it');
    store.add('two');
    store.submit(PAGE);
    assert.equal(store.snapshot().summary, null);
  });

  test('sends only the comments written since the last round', () => {
    const store = new CommentStore();
    store.add('one');
    store.submit(PAGE);
    store.working(null);
    store.add('written while the agent works');
    store.ready(null);
    store.add('two');
    const verdict = store.submit(PAGE);
    assert.equal(verdict.round, 2);
    assert.deepEqual(verdict.comments.map((c) => [c.body, c.sentIn]), [
      ['written while the agent works', 2],
      ['two', 2],
    ]);
    assert.deepEqual(store.snapshot().comments.map((c) => c.sentIn), [1, 2, 2]);
  });

  test('will not take back a comment that has gone out', () => {
    const store = new CommentStore();
    const a = store.add('one');
    store.submit(PAGE);
    assert.throws(() => store.remove(a!.id), /went out in round 1/);
    assert.equal(store.snapshot().comments.length, 1);
  });

  test('refuses moves the phase does not allow', () => {
    const store = new CommentStore();
    assert.throws(() => store.working('x'), /cannot be marked working while it is with the reviewer/);
    assert.throws(() => store.ready('x'), /cannot be marked ready/);
    store.add('one');
    store.submit(PAGE);
    assert.throws(() => store.submit(PAGE), /cannot submit/);
    assert.throws(() => store.approve(PAGE), /cannot approve/);
    store.working(null);
    store.add('two');
    assert.throws(() => store.submit(PAGE), /cannot submit while it is with the agent/);
    assert.throws(() => store.approve(PAGE, { discardUnsent: true }), /cannot approve/);
  });
});

describe('approving', () => {
  test('with nothing unsent, approves with no comments', () => {
    const store = new CommentStore();
    store.add('one');
    store.submit(PAGE);
    store.ready('Done');
    const verdict = store.approve(PAGE);
    assert.deepEqual(verdict, { version: 1, approved: true, round: 2, page: PAGE, comments: [] });
    assert.deepEqual(store.verdict(), verdict);
    assert.equal(store.snapshot().phase, 'approved');
  });

  test('refuses while there are unsent comments, unless told to discard them', () => {
    const store = new CommentStore();
    store.add('never sent');
    assert.throws(() => store.approve(PAGE), /1 comment not sent yet/);
    assert.equal(store.snapshot().phase, 'reviewing');
    assert.equal(store.snapshot().comments.length, 1);
  });

  test('discarding deletes the unsent comments and keeps the sent ones', () => {
    const store = new CommentStore();
    store.add('sent');
    store.submit(PAGE);
    store.ready(null);
    store.add('dropped');
    store.add('also dropped');
    const verdict = store.approve(PAGE, { discardUnsent: true });
    assert.deepEqual(verdict.comments, []);
    assert.equal(verdict.approved, true);
    assert.deepEqual(store.snapshot().comments.map((c) => c.body), ['sent']);
  });

  test('ends the review: nothing more can be added, worked on or approved', () => {
    const store = new CommentStore();
    store.approve(PAGE);
    assert.throws(() => store.add('late'), /approved/);
    assert.throws(() => store.working(null), /while it is approved/);
    assert.throws(() => store.ready(null), /while it is approved/);
    assert.throws(() => store.approve(PAGE), /while it is approved/);
    assert.equal(store.verdict()?.approved, true);
  });
});

describe('the verdicts a store makes', () => {
  test('parse as version 1', () => {
    const store = new CommentStore();
    store.add('one', PAGE);
    assert.ok(verdictSchema.safeParse(store.submit(PAGE)).success);
    store.ready(null);
    store.add('dropped');
    assert.ok(verdictSchema.safeParse(store.approve(null, { discardUnsent: true })).success);
  });

  test('send a pinned comment as `pinned`, with its pin as the target', () => {
    const store = new CommentStore();
    store.add('Price is wrong', PAGE, pin());
    store.add('The header is too tall', PAGE);
    const verdict = store.submit(PAGE);
    assert.ok(verdictSchema.safeParse(verdict).success);
    assert.deepEqual(verdict.comments.map((c) => c.kind), ['pinned', 'general']);
    assert.deepEqual(verdict.comments[0]?.target, pin());
    assert.equal(verdict.comments[1]?.target, null);
  });
});

describe('pins', () => {
  test('keep with their comment, as a copy rather than the caller’s', () => {
    const store = new CommentStore(() => 1000);
    const given = pin();
    const added = store.add('  Price is wrong ', PAGE, given);
    given.box.x = 999;
    assert.deepEqual(added, { id: 'c1', body: 'Price is wrong', createdAt: 1000, page: PAGE, sentIn: null, pin: pin() });
    const snap = store.snapshot();
    snap.comments[0]!.pin!.box.y = 999;
    assert.deepEqual(store.snapshot().comments[0]?.pin, pin());
  });

  test('are absent from a general comment', () => {
    const store = new CommentStore();
    store.add('general');
    assert.equal('pin' in store.snapshot().comments[0]!, false);
  });
});

describe('pinNumbers', () => {
  test('numbers the pinned comments in order, skipping general ones', () => {
    const store = new CommentStore();
    store.add('general');
    const a = store.add('first pin', PAGE, pin());
    store.add('another general');
    const b = store.add('second pin', PAGE, pin());
    assert.ok(a && b);
    assert.deepEqual([...pinNumbers(store.snapshot().comments)], [
      [a.id, 1],
      [b.id, 2],
    ]);
  });
});

function pin(): Pin {
  return {
    url: 'http://127.0.0.1:4400/',
    selector: 'section.products > article:nth-of-type(2) > p',
    tag: 'p',
    text: '$16.00',
    box: { x: 300, y: 420, width: 180, height: 20 },
    viewport: { width: 1280, height: 800 },
    quote: '$16.00',
    suggestion: '$16.00 (sale)',
  };
}
