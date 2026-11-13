import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import { CommentStore } from '#core/store.js';
import { openHost, type GlossMessage, type HostMessage } from './host.js';

/** A host at the other end of the pipes: what Gloss said, in order, and a way to answer. */
function fakeHost() {
  const input = new PassThrough();
  const output = new PassThrough();
  const said: GlossMessage[] = [];
  const waiting: Array<{ match: (m: GlossMessage) => boolean; resolve: (m: GlossMessage) => void }> = [];
  createInterface({ input: output }).on('line', (line) => {
    const message = JSON.parse(line) as GlossMessage;
    said.push(message);
    const at = waiting.findIndex((w) => w.match(message));
    if (at >= 0) waiting.splice(at, 1)[0]!.resolve(message);
  });
  return {
    input,
    output,
    said,
    send: (message: HostMessage) => input.write(`${JSON.stringify(message)}\n`),
    next: (match: (m: GlossMessage) => boolean) =>
      new Promise<GlossMessage>((resolve) => {
        const found = said.find(match);
        if (found) resolve(found);
        else waiting.push({ match, resolve });
      }),
  };
}

const URL = 'http://127.0.0.1:4400/';

/** Opens a host session, answering the first navigate as a host would. */
async function open(store = new CommentStore()) {
  const host = fakeHost();
  const shotsDir = mkdtempSync(join(tmpdir(), 'gloss-host-'));
  const opening = openHost(URL, store, { shotsDir, input: host.input, output: host.output });
  const nav = await host.next((m) => m.type === 'request');
  host.send({ type: 'page', url: URL });
  host.send({ type: 'reply', id: (nav as { id: number }).id, result: null });
  return { host, store, shotsDir, browser: await opening };
}

describe('the host channel', () => {
  test('says hello with the bar first, then asks the host to open the url', async () => {
    const { host, browser } = await open();
    assert.equal(host.said[0]!.type, 'hello');
    const hello = host.said[0] as Extract<GlossMessage, { type: 'hello' }>;
    assert.equal(hello.binding, '__glossRpc');
    assert.equal(hello.deliver, '__glossDeliver');
    assert.ok(hello.script.includes('__glossRpc'));
    assert.deepEqual(host.said[1], { type: 'request', id: 1, method: 'navigate', url: URL });
    assert.equal(browser.currentUrl(), URL);
    await browser.close();
  });

  test('answers the bar through the host and tells it of every change', async () => {
    const { host, store, browser } = await open();
    host.send({ type: 'rpc', payload: JSON.stringify({ id: 7, call: { method: 'add', body: 'Bigger' } }), url: URL, topFrame: true });
    const answer = (await host.next((m) => m.type === 'deliver' && 'id' in m.delivery)) as Extract<GlossMessage, { type: 'deliver' }>;
    assert.equal((answer.delivery as { id: number }).id, 7);
    assert.equal(store.snapshot().comments.length, 1);
    assert.ok(host.said.some((m) => m.type === 'deliver' && !('id' in m.delivery)));
    await browser.close();
  });

  test('takes no change from a frame, as the host saw it', async () => {
    const { host, store, browser } = await open();
    host.send({ type: 'rpc', payload: JSON.stringify({ id: 1, call: { method: 'submit' } }), url: URL, topFrame: false });
    const answer = (await host.next((m) => m.type === 'deliver' && 'id' in m.delivery)) as Extract<GlossMessage, { type: 'deliver' }>;
    assert.ok('error' in answer.delivery);
    assert.equal(store.snapshot().phase, 'reviewing');
    await browser.close();
  });

  test('photographs a pinned element through the host', async () => {
    const { host, store, shotsDir, browser } = await open();
    const pin = { url: URL, selector: '#total', tag: 'p', text: '$12', box: { x: 10, y: 100, width: 50, height: 20 }, viewport: { width: 800, height: 600 } };
    host.send({ type: 'rpc', payload: JSON.stringify({ id: 2, call: { method: 'add', body: 'Wrong', pin } }), url: URL, topFrame: true });
    const view = (await host.next((m) => m.type === 'request' && m.method === 'view')) as { id: number };
    host.send({ type: 'reply', id: view.id, result: { scrollX: 0, scrollY: 0, width: 800, height: 600 } });
    const shot = (await host.next((m) => m.type === 'request' && m.method === 'snapshot')) as Extract<GlossMessage, { method: 'snapshot' }>;
    assert.deepEqual(shot.clip, { x: 10, y: 100, width: 50, height: 20 });
    assert.ok(shot.path.startsWith(shotsDir));
    host.send({ type: 'reply', id: shot.id, result: null });
    await host.next((m) => m.type === 'deliver' && 'id' in m.delivery && m.delivery.id === 2);
    assert.equal(store.snapshot().comments[0]!.pin?.screenshot, shot.path);
    assert.equal(existsSync(shotsDir), true);
    await browser.close();
  });

  test('a pin the host cannot photograph is kept without a picture', async () => {
    const { host, store, browser } = await open();
    const pin = { url: URL, selector: '#total', tag: 'p', text: '$12', box: { x: 10, y: 100, width: 50, height: 20 }, viewport: { width: 800, height: 600 } };
    host.send({ type: 'rpc', payload: JSON.stringify({ id: 3, call: { method: 'add', body: 'Wrong', pin } }), url: URL, topFrame: true });
    const view = (await host.next((m) => m.type === 'request' && m.method === 'view')) as { id: number };
    host.send({ type: 'reply', id: view.id, error: 'no page' });
    await host.next((m) => m.type === 'deliver' && 'id' in m.delivery && m.delivery.id === 3);
    assert.equal(store.snapshot().comments[0]!.pin?.screenshot, undefined);
    await browser.close();
  });

  test('navigate and reload go to the host, and ready is announced', async () => {
    const { host, browser } = await open();
    const navigating = browser.navigate('http://127.0.0.1:4400/cart');
    const nav = (await host.next((m) => m.type === 'request' && m.method === 'navigate' && m.url.endsWith('/cart'))) as { id: number };
    host.send({ type: 'reply', id: nav.id, result: null });
    await navigating;
    const reloading = browser.reload();
    const reload = (await host.next((m) => m.type === 'request' && m.method === 'reload')) as { id: number };
    host.send({ type: 'reply', id: reload.id, result: null });
    await reloading;
    browser.started('abc', 1234);
    assert.deepEqual(await host.next((m) => m.type === 'ready'), { type: 'ready', id: 'abc', port: 1234 });
    await browser.close();
  });

  test('the host closing its end closes the session', async () => {
    const { host, browser } = await open();
    host.input.end();
    await browser.closed;
  });
});
