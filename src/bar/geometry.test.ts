import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pagePath, placePopover, samePage, squeeze } from './geometry.js';
import { BAR_HEIGHT } from './styles.js';

describe('squeeze', () => {
  test('puts the text on one line', () => {
    assert.equal(squeeze('  Canvas tote\n\t$24.00  '), 'Canvas tote $24.00');
  });

  test('cuts long text short with an ellipsis', () => {
    assert.equal(squeeze('Order summary should show shipping', 14), 'Order summary…');
    assert.equal(squeeze('Order summary', 14), 'Order summary');
    assert.equal(squeeze('x'.repeat(200)).length, 80);
  });

  test('leaves nothing as nothing', () => {
    assert.equal(squeeze(' \n '), '');
  });
});

describe('samePage', () => {
  test('ignores the hash', () => {
    assert.ok(samePage('http://127.0.0.1:4400/?gloss', 'http://127.0.0.1:4400/?gloss#summary'));
    assert.ok(samePage('http://127.0.0.1:4400/#summary', 'http://127.0.0.1:4400/'));
  });

  test('tells pages apart by path and query', () => {
    assert.ok(!samePage('http://127.0.0.1:4400/', 'http://127.0.0.1:4400/cart'));
    assert.ok(!samePage('http://127.0.0.1:4400/?gloss', 'http://127.0.0.1:4400/?gloss&seed=1'));
    assert.ok(!samePage('http://127.0.0.1:4400/', 'http://localhost:4400/'));
  });

  test('never matches a pin with no URL of its own', () => {
    assert.ok(!samePage('', 'http://127.0.0.1:4400/'));
  });
});

describe('pagePath', () => {
  const origin = 'http://127.0.0.1:4400';

  test('keeps the path and query, drops the origin and hash', () => {
    assert.equal(pagePath('http://127.0.0.1:4400/cart?gloss#summary', origin), '/cart?gloss');
    assert.equal(pagePath('http://127.0.0.1:4400/', origin), '/');
  });

  test('keeps the host for a URL on another origin, which the path alone would misname', () => {
    assert.equal(pagePath('http://localhost:4400/cart', origin), 'localhost:4400/cart');
  });

  test('is null for a URL that will not parse', () => {
    assert.equal(pagePath('not a url', origin), null);
  });
});

describe('placePopover', () => {
  const viewport = { width: 1280, height: 800 };
  const size = { width: 320, height: 150 };

  test('goes under the element, lined up with its left edge', () => {
    assert.deepEqual(placePopover({ left: 100, top: 200, width: 200, height: 20 }, size, viewport), { left: 100, top: 228 });
  });

  test('goes above when there is no room under', () => {
    assert.deepEqual(placePopover({ left: 100, top: 700, width: 200, height: 40 }, size, viewport), { left: 100, top: 542 });
  });

  test('stays inside the window on the right', () => {
    assert.equal(placePopover({ left: 1100, top: 200, width: 150, height: 20 }, size, viewport).left, 1280 - 320 - 8);
  });

  test('stays below the bar and inside the window when neither side has room', () => {
    const tall = { left: 0, top: 20, width: 1280, height: 780 };
    assert.deepEqual(placePopover(tall, size, viewport), { left: 8, top: 800 - 150 - 8 });
    const offTop = { left: -50, top: -400, width: 100, height: 20 };
    assert.deepEqual(placePopover(offTop, size, viewport), { left: 8, top: BAR_HEIGHT + 8 });
  });

  test('keeps clear of the bar before the bottom when the window is too short for it', () => {
    assert.equal(placePopover({ left: 0, top: 60, width: 10, height: 10 }, size, { width: 390, height: 120 }).top, BAR_HEIGHT + 8);
  });
});
