import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { handleRpc, visibleClip } from './browser.js';
import { CommentStore, type PinDraft } from './store.js';

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
    const added = await handleRpc(store, { method: 'add', body: 'Too tall' });
    assert.deepEqual(added.comments.map((c) => c.body), ['Too tall']);
    assert.deepEqual(await handleRpc(store, { method: 'state' }), added);
    assert.deepEqual((await handleRpc(store, { method: 'remove', id: added.comments[0]!.id })).comments, []);
  });

  test('adds a pinned comment with the screenshot the session took', async () => {
    const store = new CommentStore();
    const photographed: string[] = [];
    const state = await handleRpc(store, { method: 'add', body: 'Total is wrong', pin: draft() }, async (pin) => {
      photographed.push(pin.selector);
      return '/shots/pin-1.png';
    });
    assert.deepEqual(photographed, ['#summary > p:nth-of-type(3)']);
    assert.deepEqual(state.comments[0]?.pin, { ...draft(), screenshot: '/shots/pin-1.png' });
  });

  test('keeps the pin when there is no screenshot to be had', async () => {
    const store = new CommentStore();
    const state = await handleRpc(store, { method: 'add', body: 'x', pin: draft() }, async () => undefined);
    assert.equal(state.comments[0]?.pin?.screenshot, undefined);
    assert.equal(state.comments[0]?.pin?.selector, draft().selector);
  });

  test('takes no screenshot for a comment with nothing in it', async () => {
    let shots = 0;
    const state = await handleRpc(new CommentStore(), { method: 'add', body: '  ', pin: draft() }, async () => {
      shots++;
      return 'x.png';
    });
    assert.equal(shots, 0);
    assert.deepEqual(state.comments, []);
  });

  test('refuses a screenshot path, or a malformed pin, from the page', async () => {
    const store = new CommentStore();
    const bad = [
      { method: 'add', body: 'x', pin: { ...draft(), screenshot: '/etc/passwd' } },
      { method: 'add', body: 'x', pin: { ...draft(), selector: '' } },
      { method: 'add', body: 'x', pin: { ...draft(), box: { x: 0, y: 0 } } },
      { method: 'nope' },
    ];
    for (const call of bad) await assert.rejects(handleRpc(store, call), /did not understand/);
    assert.deepEqual(store.snapshot().comments, []);
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
