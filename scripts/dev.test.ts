import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { demoStore } from '../src/bar/transport.js';
import type { RoundState } from '../src/session/store.js';
import { createDevServer, demoOptions, parsePort, renderPage, SEED_COMMENTS, SEED_TARGETS, STRICT_CSP } from './dev.js';

describe('parsePort', () => {
  test('reads the single-dash -port Reeve passes', () => {
    assert.equal(parsePort(['-port', '4400']), 4400);
  });

  test('reads --port, --port= and PORT', () => {
    assert.equal(parsePort(['--port', '5000']), 5000);
    assert.equal(parsePort(['--port=5001']), 5001);
    assert.equal(parsePort(['-port=5002']), 5002);
    assert.equal(parsePort([], { PORT: '5003' }), 5003);
  });

  test('prefers the flag to PORT, and falls back to 4400', () => {
    assert.equal(parsePort(['-port', '5004'], { PORT: '5005' }), 5004);
    assert.equal(parsePort([]), 4400);
    assert.equal(parsePort(['--', '-port', '5006']), 5006);
  });

  test('refuses a port that is not one', () => {
    assert.throws(() => parsePort(['-port', 'abc']), /not 'abc'/);
    assert.throws(() => parsePort(['--port', '70000']));
    assert.throws(() => parsePort(['-port']), /needs a port/);
  });
});

const HTML = '<html><head><title>x</title></head><body><header>Storefront</header></body></html>';
const q = (s: string) => new URLSearchParams(s);
const mounted = (html: string) => JSON.parse(/GlossDemo\.mount\((.*)\);/.exec(html)![1]!.replace(/\\u003c/g, '<'));
const pick = (s: RoundState) => ({ round: s.round, phase: s.phase, sent: s.comments.map((c) => c.sentIn) });

describe('renderPage', () => {
  test('serves the storefront untouched by default', () => {
    assert.deepEqual(renderPage(HTML, q(''), null), { html: HTML, headers: {} });
  });

  test('?gloss inlines the bar and mounts it with no comments', () => {
    const { html } = renderPage(HTML, q('gloss'), 'var GlossDemo = {};');
    assert.match(html, /<script>var GlossDemo = \{\};<\/script>/);
    assert.deepEqual(mounted(html), { round: { sent: [], comments: [] }, listOpen: false, confirmOpen: false });
    assert.ok(html.indexOf('GlossDemo.mount') < html.indexOf('</head>'));
  });

  test('&seed=2&list starts with two comments and the list open', () => {
    const options = mounted(renderPage(HTML, q('gloss&seed=2&list'), '').html);
    assert.deepEqual(options, { round: { sent: [], comments: SEED_COMMENTS.slice(0, 2) }, listOpen: true, confirmOpen: false });
  });

  test('keeps a seed count within the comments there are', () => {
    assert.equal(mounted(renderPage(HTML, q('gloss&seed=99'), '').html).round.comments.length, SEED_COMMENTS.length);
  });

  test('&sent=N sends the first N, and &seed follows on from them', () => {
    const { round } = mounted(renderPage(HTML, q('gloss&sent=3&seed=1'), '').html);
    assert.deepEqual(round, { sent: SEED_COMMENTS.slice(0, 3), comments: SEED_COMMENTS.slice(3, 4) });
    const all = mounted(renderPage(HTML, q('gloss&sent=5&seed=5'), '').html).round;
    assert.equal(all.sent.length + all.comments.length, SEED_COMMENTS.length);
  });

  test('&phase, &msg, &summary and &confirm reach every state of the bar', () => {
    const working = mounted(renderPage(HTML, q('gloss&phase=working&msg=Tightening%20the%20header'), '').html);
    assert.deepEqual(working.round, { sent: [], comments: [], phase: 'working', message: 'Tightening the header' });
    const ready = mounted(renderPage(HTML, q('gloss&summary=Moved%20shipping&sent=2'), '').html);
    assert.deepEqual(ready.round, { sent: SEED_COMMENTS.slice(0, 2), comments: [], summary: 'Moved shipping' });
    assert.equal(mounted(renderPage(HTML, q('gloss&seed=2&confirm'), '').html).confirmOpen, true);
    assert.equal(mounted(renderPage(HTML, q('gloss&phase=reviewing'), '').html).round.phase, undefined);
  });

  test('plays each demo round through the real store into the phase it asks for', () => {
    const phase = (s: string) => demoStore(demoOptions(q(s)).round).snapshot();
    assert.deepEqual(pick(phase('phase=submitted&sent=2')), { round: 2, phase: 'submitted', sent: [1, 1] });
    assert.deepEqual(pick(phase('phase=working&msg=On%20it')), { round: 2, phase: 'working', sent: [1] });
    assert.equal(phase('phase=working&msg=On%20it').message, 'On it');
    assert.deepEqual(pick(phase('sent=3&seed=1')), { round: 3, phase: 'reviewing', sent: [1, 1, 2, null] });
    assert.equal(phase('summary=Done&sent=2').summary, 'Done');
    assert.deepEqual(pick(phase('phase=approved&sent=2')), { round: 2, phase: 'approved', sent: [1, 1] });
  });

  test('&pins=N pins the first N seeded comments, sent ones first, and no more than there are', () => {
    assert.equal(SEED_TARGETS.length, SEED_COMMENTS.length);
    const { round } = mounted(renderPage(HTML, q('gloss&sent=2&seed=1&pins=3'), '').html);
    assert.deepEqual(round, { sent: SEED_COMMENTS.slice(0, 2), comments: SEED_COMMENTS.slice(2, 3), targets: SEED_TARGETS.slice(0, 3) });
    assert.equal(mounted(renderPage(HTML, q('gloss&seed=2&pins=9'), '').html).round.targets.length, 2);
    assert.equal(mounted(renderPage(HTML, q('gloss&pins=3'), '').html).round.targets, undefined);
  });

  test('&select starts in Select mode, and &pick=N with the Nth target picked', () => {
    assert.equal(mounted(renderPage(HTML, q('gloss&select'), '').html).mode, 'select');
    const picked = mounted(renderPage(HTML, q('gloss&select&pick=2'), '').html);
    assert.deepEqual({ mode: picked.mode, pick: picked.pick }, { mode: 'select', pick: '#summary > p:nth-of-type(3)' });
    assert.equal(mounted(renderPage(HTML, q('gloss&pick=1'), '').html).mode, 'select');
    const none = mounted(renderPage(HTML, q('gloss&pick=99'), '').html);
    assert.ok(!('pick' in none) && !('mode' in none));
  });

  test('pins the demo round\'s comments to the page, sent ones too', () => {
    const page = 'http://127.0.0.1:4400/?gloss';
    const store = (s: string) => demoStore(demoOptions(q(s)).round, page).snapshot();
    const pins = store('sent=2&seed=2&pins=3').comments.map((c) => c.pin && { url: c.pin.url, selector: c.pin.selector, sent: c.sentIn });
    assert.deepEqual(pins, [
      { url: page, selector: SEED_TARGETS[0]!.selector, sent: 1 },
      { url: page, selector: SEED_TARGETS[1]!.selector, sent: 1 },
      { url: page, selector: SEED_TARGETS[2]!.selector, sent: null },
      undefined,
    ]);
    // The comment that stands in for a round goes unpinned; the seed's own takes the first target.
    const working = store('phase=working&seed=1&pins=1').comments;
    assert.deepEqual(working.map((c) => c.pin?.selector), [undefined, SEED_TARGETS[0]!.selector]);
  });

  test('cannot be closed early by a </script> in the bundle', () => {
    const { html } = renderPage(HTML, q('gloss'), 'const s = "</script><b>";');
    assert.equal(html.match(/<\/script>/g)?.length, 2);
  });

  test('?fixed marks the body, and ?csp sends a strict policy', () => {
    assert.match(renderPage(HTML, q('fixed'), null).html, /<body class="fixed-header">/);
    assert.deepEqual(renderPage(HTML, q('csp'), null).headers, { 'content-security-policy': STRICT_CSP });
  });

  test('?fullheight marks the body, alongside ?fixed', () => {
    assert.match(renderPage(HTML, q('fullheight'), null).html, /<body class="full-height">/);
    assert.match(renderPage(HTML, q('fixed&fullheight'), null).html, /<body class="fixed-header full-height">/);
  });
});

describe('the dev server', () => {
  test('serves the storefront, its stylesheet and the demo bar', async () => {
    const server = createDevServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const plain = await (await fetch(`${base}/`)).text();
      assert.match(plain, /Canvas tote/);
      assert.doesNotMatch(plain, /GlossDemo/);
      assert.equal((await fetch(`${base}/storefront.css`)).headers.get('content-type'), 'text/css; charset=utf-8');
      assert.match(await (await fetch(`${base}/?gloss`)).text(), /GlossDemo\.mount/);
      assert.equal((await fetch(`${base}/nope`)).status, 404);
    } finally {
      server.close();
    }
  });
});
