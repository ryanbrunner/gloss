import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { answerRpc, handleRpc, type RpcSource } from './browser.js';
import { CommentStore } from './store.js';

const PAGE: RpcSource = { url: 'http://127.0.0.1:4400/', topFrame: true };
const call = (store: CommentStore, c: unknown, from = PAGE) => handleRpc(store, c, from);

describe('handleRpc', () => {
  test('adds a comment with the page it was written on, as Playwright saw it', () => {
    const store = new CommentStore();
    const state = call(store, { method: 'add', body: 'The header is too tall' });
    assert.equal(state.comments[0]?.page, 'http://127.0.0.1:4400/');
  });

  test('submits, and approves only with discardUnsent when there is something unsent', () => {
    const store = new CommentStore();
    call(store, { method: 'add', body: 'one' });
    assert.equal(call(store, { method: 'submit' }).phase, 'submitted');
    assert.equal(store.verdict()?.page, 'http://127.0.0.1:4400/');
    store.ready(null);
    call(store, { method: 'add', body: 'two' });
    assert.throws(() => call(store, { method: 'approve', discardUnsent: false }), /not sent yet/);
    assert.equal(call(store, { method: 'approve', discardUnsent: true }).phase, 'approved');
  });

  test('takes nothing that changes the round from a frame, or from a page off http', () => {
    const store = new CommentStore();
    store.add('one');
    const frame = { ...PAGE, topFrame: false };
    const blank = { url: 'about:blank', topFrame: true };
    for (const from of [frame, blank]) {
      assert.throws(() => call(store, { method: 'submit' }, from), /only from the page under review/);
      assert.throws(() => call(store, { method: 'approve', discardUnsent: true }, from), /only from the page/);
      assert.throws(() => call(store, { method: 'add', body: 'x' }, from), /only from the page/);
      assert.equal(call(store, { method: 'state' }, from).comments.length, 1);
    }
    assert.equal(store.snapshot().phase, 'reviewing');
  });

  test('refuses what it does not understand', () => {
    const store = new CommentStore();
    assert.throws(() => call(store, JSON.stringify({ method: 'approve', discardUnsent: true })), /did not understand/);
    assert.throws(() => call(store, { method: 'approve' }), /did not understand/);
    assert.throws(() => call(store, { method: 'approve', discardUnsent: 'yes' }), /did not understand/);
    assert.equal(store.snapshot().phase, 'reviewing');
  });
});

describe('answerRpc', () => {
  const send = (store: CommentStore, request: unknown, from = PAGE) => answerRpc(store, JSON.stringify(request), from);

  test('answers a numbered call with its number and the round', () => {
    const store = new CommentStore();
    const answer = send(store, { id: 7, call: { method: 'add', body: 'The header is too tall' } });
    assert.deepEqual(answer, { id: 7, state: store.snapshot() });
    assert.equal(store.snapshot().comments.length, 1);
  });

  test('answers a refused call with its number and why', () => {
    const store = new CommentStore();
    store.add('one');
    const answer = send(store, { id: 3, call: { method: 'approve', discardUnsent: false } });
    assert.equal(answer && 'error' in answer && answer.id, 3);
    assert.match(answer && 'error' in answer ? answer.error : '', /not sent yet/);
    assert.deepEqual(send(store, { id: 4, call: { method: 'nope' } }), { id: 4, error: 'Gloss did not understand that request' });
    assert.equal(store.snapshot().phase, 'reviewing');
  });

  test('gives no answer to what is not JSON, or has no number to answer by', () => {
    const store = new CommentStore();
    assert.equal(answerRpc(store, '{nope', PAGE), null);
    assert.equal(send(store, { method: 'approve', discardUnsent: true }), null);
    assert.equal(send(store, { id: '1', call: { method: 'approve', discardUnsent: true } }), null);
    assert.equal(store.snapshot().phase, 'reviewing');
  });
});
