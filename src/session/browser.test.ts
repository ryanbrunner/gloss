import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { answerRpc, handleRpc, visibleClip, type RpcSource } from './browser.js';
import { CommentStore, type PinDraft } from './store.js';

const PAGE: RpcSource = { url: 'http://127.0.0.1:4400/', topFrame: true };
const call = (store: CommentStore, c: unknown, from = PAGE, capture?: Parameters<typeof handleRpc>[3]) =>
  handleRpc(store, c, from, capture);

const draft = (values: Partial<PinDraft> = {}): PinDraft => ({
  url: 'http://127.0.0.1:4400/',
  selector: '#summary > p:nth-of-type(3)',
  tag: 'p',
  text: 'Total $43.20',
  box: { x: 900, y: 300, width: 200, height: 20 },
  viewport: { width: 1280, height: 800 },
  ...values,
});

describe('handleRpc', () => {
  test('adds, lists and removes general comments', async () => {
    const store = new CommentStore();
    const added = await call(store, { method: 'add', body: 'Too tall' });
    assert.deepEqual(added.comments.map((c) => c.body), ['Too tall']);
    assert.deepEqual(await call(store, { method: 'state' }), added);
    assert.deepEqual((await call(store, { method: 'remove', id: added.comments[0]!.id })).comments, []);
  });

  test('adds a comment with the page it was written on, as Playwright saw it', async () => {
    const store = new CommentStore();
    const state = await call(store, { method: 'add', body: 'The header is too tall' });
    assert.equal(state.comments[0]?.page, 'http://127.0.0.1:4400/');
  });

  test('submits, and approves only with discardUnsent when there is something unsent', async () => {
    const store = new CommentStore();
    await call(store, { method: 'add', body: 'one' });
    assert.equal((await call(store, { method: 'submit' })).phase, 'submitted');
    assert.equal(store.verdict()?.page, 'http://127.0.0.1:4400/');
    store.ready(null);
    await call(store, { method: 'add', body: 'two' });
    await assert.rejects(call(store, { method: 'approve', discardUnsent: false }), /not sent yet/);
    assert.equal((await call(store, { method: 'approve', discardUnsent: true })).phase, 'approved');
  });

  test('takes nothing that changes the round from a frame, or from a page off http', async () => {
    const store = new CommentStore();
    store.add('one');
    const frame = { ...PAGE, topFrame: false };
    const blank = { url: 'about:blank', topFrame: true };
    for (const from of [frame, blank]) {
      await assert.rejects(call(store, { method: 'submit' }, from), /only from the page under review/);
      await assert.rejects(call(store, { method: 'approve', discardUnsent: true }, from), /only from the page/);
      await assert.rejects(call(store, { method: 'add', body: 'x' }, from), /only from the page/);
      assert.equal((await call(store, { method: 'state' }, from)).comments.length, 1);
    }
    assert.equal(store.snapshot().phase, 'reviewing');
  });

  test('adds a pinned comment with the screenshot the session took', async () => {
    const store = new CommentStore();
    const photographed: string[] = [];
    const state = await call(store, { method: 'add', body: 'Total is wrong', pin: draft() }, PAGE, async (pin) => {
      photographed.push(pin.selector);
      return '/shots/pin-1.png';
    });
    assert.deepEqual(photographed, ['#summary > p:nth-of-type(3)']);
    assert.deepEqual(state.comments[0]?.pin, { ...draft(), screenshot: '/shots/pin-1.png' });
  });

  test('keeps the pin when there is no screenshot to be had', async () => {
    const store = new CommentStore();
    const state = await call(store, { method: 'add', body: 'x', pin: draft() }, PAGE, async () => undefined);
    assert.equal(state.comments[0]?.pin?.screenshot, undefined);
    assert.equal(state.comments[0]?.pin?.selector, draft().selector);
  });

  test('takes no screenshot for a comment with nothing in it', async () => {
    let shots = 0;
    const state = await call(new CommentStore(), { method: 'add', body: '  ', pin: draft() }, PAGE, async () => {
      shots++;
      return 'x.png';
    });
    assert.equal(shots, 0);
    assert.deepEqual(state.comments, []);
  });

  test('sends a pinned comment on as a pinned comment, with its pin', async () => {
    const store = new CommentStore();
    await call(store, { method: 'add', body: 'Total is wrong', pin: draft() }, PAGE, async () => '/shots/pin-1.png');
    await call(store, { method: 'add', body: 'The header is too tall' });
    const verdict = (await call(store, { method: 'submit' }), store.verdict()!);
    assert.deepEqual(verdict.comments.map((c) => c.kind), ['pinned', 'general']);
    assert.deepEqual(verdict.comments[0]?.target, { ...draft(), screenshot: '/shots/pin-1.png' });
    assert.equal(verdict.comments[1]?.target, null);
  });

  test('refuses a screenshot path, or a malformed pin, from the page', async () => {
    const store = new CommentStore();
    const bad = [
      { method: 'add', body: 'x', pin: { ...draft(), screenshot: '/etc/passwd' } },
      { method: 'add', body: 'x', pin: { ...draft(), selector: '' } },
      { method: 'add', body: 'x', pin: { ...draft(), box: { x: 0, y: 0 } } },
      { method: 'nope' },
    ];
    for (const c of bad) await assert.rejects(call(store, c), /did not understand/);
    assert.deepEqual(store.snapshot().comments, []);
  });

  test('refuses what it does not understand', async () => {
    const store = new CommentStore();
    await assert.rejects(call(store, JSON.stringify({ method: 'approve', discardUnsent: true })), /did not understand/);
    await assert.rejects(call(store, { method: 'approve' }), /did not understand/);
    await assert.rejects(call(store, { method: 'approve', discardUnsent: 'yes' }), /did not understand/);
    assert.equal(store.snapshot().phase, 'reviewing');
  });
});

describe('answerRpc', () => {
  const send = (store: CommentStore, request: unknown, from = PAGE) => answerRpc(store, JSON.stringify(request), from);

  test('answers a numbered call with its number and the round', async () => {
    const store = new CommentStore();
    const answer = await send(store, { id: 7, call: { method: 'add', body: 'The header is too tall' } });
    assert.deepEqual(answer, { id: 7, state: store.snapshot() });
    assert.equal(store.snapshot().comments.length, 1);
  });

  test('answers a refused call with its number and why', async () => {
    const store = new CommentStore();
    store.add('one');
    const answer = await send(store, { id: 3, call: { method: 'approve', discardUnsent: false } });
    assert.equal(answer && 'error' in answer && answer.id, 3);
    assert.match(answer && 'error' in answer ? answer.error : '', /not sent yet/);
    assert.deepEqual(await send(store, { id: 4, call: { method: 'nope' } }), {
      id: 4,
      error: 'Gloss did not understand that request',
    });
    assert.equal(store.snapshot().phase, 'reviewing');
  });

  test('photographs a pinned comment with the capture it is given', async () => {
    const store = new CommentStore();
    const answer = await answerRpc(
      store,
      JSON.stringify({ id: 1, call: { method: 'add', body: 'Total is wrong', pin: draft() } }),
      PAGE,
      async () => '/shots/pin-1.png',
    );
    assert.equal(answer && 'state' in answer && answer.state.comments[0]?.pin?.screenshot, '/shots/pin-1.png');
  });

  test('gives no answer to what is not JSON, or has no number to answer by', async () => {
    const store = new CommentStore();
    assert.equal(await answerRpc(store, '{nope', PAGE), null);
    assert.equal(await send(store, { method: 'approve', discardUnsent: true }), null);
    assert.equal(await send(store, { id: '1', call: { method: 'approve', discardUnsent: true } }), null);
    assert.equal(store.snapshot().phase, 'reviewing');
  });
});

describe('visibleClip', () => {
  const view = { scrollX: 0, scrollY: 1000, width: 1280, height: 800 };

  test('is the box in the viewport’s coordinates', () => {
    assert.deepEqual(visibleClip(draft({ box: { x: 10, y: 1200, width: 100, height: 50 } }), view), {
      x: 10,
      y: 200,
      width: 100,
      height: 50,
    });
  });

  test('leaves out what is off screen or under the bar', () => {
    assert.deepEqual(visibleClip(draft({ box: { x: -20, y: 1020, width: 100, height: 1000 } }), view), {
      x: 0,
      y: 44,
      width: 80,
      height: 756,
    });
  });

  test('is null for a box with nothing on screen', () => {
    assert.equal(visibleClip(draft({ box: { x: 10, y: 100, width: 100, height: 50 } }), view), null);
    assert.equal(visibleClip(draft({ box: { x: 10, y: 1010, width: 100, height: 30 } }), view), null);
    assert.equal(visibleClip(draft({ box: { x: 10, y: 1200, width: 0, height: 30 } }), view), null);
  });
});
