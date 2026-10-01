import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { answerRpc } from './channel.js';
import { CommentStore } from './store.js';

const ask = (store: CommentStore, request: unknown) => answerRpc(store, JSON.stringify(request));

describe('answerRpc', () => {
  test('answers a request with its number and the round as it stands', () => {
    const store = new CommentStore(() => 1000);
    store.add('The header is too tall');
    assert.deepEqual(ask(store, { seq: 1, call: { method: 'state' } }), { seq: 1, state: store.snapshot() });
  });

  test('adds and removes comments', () => {
    const store = new CommentStore();
    const added = ask(store, { seq: 2, call: { method: 'add', body: 'Cart count is wrong' } });
    assert.ok(added && 'state' in added);
    assert.deepEqual(added.state.comments.map((c) => c.body), ['Cart count is wrong']);
    const id = added.state.comments[0]!.id;
    assert.deepEqual(ask(store, { seq: 3, call: { method: 'remove', id } }), { seq: 3, state: { round: 1, comments: [] } });
  });

  test('says when it does not understand the call, under the request number', () => {
    const store = new CommentStore();
    assert.deepEqual(ask(store, { seq: 4, call: { method: 'approve' } }), {
      seq: 4,
      error: 'Gloss did not understand that request',
    });
    assert.deepEqual(ask(store, { seq: 5, call: { method: 'add', body: 'x'.repeat(20_001) } }), {
      seq: 5,
      error: 'Gloss did not understand that request',
    });
    assert.deepEqual(store.snapshot().comments, []);
  });

  test('ignores what has no number to answer to', () => {
    const store = new CommentStore();
    assert.equal(answerRpc(store, 'not json'), null);
    assert.equal(ask(store, { call: { method: 'add', body: 'hi' } }), null);
    assert.equal(ask(store, { seq: 'one', call: { method: 'state' } }), null);
    assert.deepEqual(store.snapshot().comments, []);
  });
});
