import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { handleRpc, type RpcSource } from './browser.js';
import { CommentStore } from './store.js';

const PAGE: RpcSource = { url: 'http://127.0.0.1:4400/', topFrame: true };
const call = (store: CommentStore, c: unknown, from = PAGE) => handleRpc(store, JSON.stringify(c), from);

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

  test('refuses what it does not understand, including a call that is not JSON', () => {
    const store = new CommentStore();
    assert.throws(() => handleRpc(store, { method: 'approve', discardUnsent: true }, PAGE), /did not understand/);
    assert.throws(() => handleRpc(store, '{nope', PAGE), /did not understand/);
    assert.throws(() => call(store, { method: 'approve' }), /did not understand/);
    assert.equal(store.snapshot().phase, 'reviewing');
  });
});
