import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CommentStore, type RoundState } from './store.js';

describe('CommentStore', () => {
  test('starts on round 1 with nothing in it', () => {
    assert.deepEqual(new CommentStore().snapshot(), { round: 1, comments: [] });
  });

  test('adds comments in order, trimmed, with ids of their own', () => {
    const store = new CommentStore(() => 1000);
    const a = store.add('  The header is too tall  ');
    const b = store.add('Cart count is wrong');
    assert.ok(a && b);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(store.snapshot().comments, [
      { id: a.id, body: 'The header is too tall', createdAt: 1000 },
      { id: b.id, body: 'Cart count is wrong', createdAt: 1000 },
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
  });
});
