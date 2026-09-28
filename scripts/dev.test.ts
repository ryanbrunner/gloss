import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { createDevServer, parsePort, renderPage, SEED_COMMENTS, STRICT_CSP } from './dev.js';

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

describe('renderPage', () => {
  test('serves the storefront untouched by default', () => {
    assert.deepEqual(renderPage(HTML, q(''), null), { html: HTML, headers: {} });
  });

  test('?gloss inlines the bar and mounts it with no comments', () => {
    const { html } = renderPage(HTML, q('gloss'), 'var GlossDemo = {};');
    assert.match(html, /<script>var GlossDemo = \{\};<\/script>/);
    assert.match(html, /GlossDemo\.mount\(\{"comments":\[\],"listOpen":false\}\)/);
    assert.ok(html.indexOf('GlossDemo.mount') < html.indexOf('</head>'));
  });

  test('&seed=2&list starts with two comments and the list open', () => {
    const { html } = renderPage(HTML, q('gloss&seed=2&list'), '');
    const options = JSON.parse(/GlossDemo\.mount\((.*)\);/.exec(html)![1]!.replace(/\\u003c/g, '<'));
    assert.deepEqual(options, { comments: SEED_COMMENTS.slice(0, 2), listOpen: true });
  });

  test('keeps a seed count within the comments there are', () => {
    const { html } = renderPage(HTML, q('gloss&seed=99'), '');
    assert.equal(JSON.parse(/GlossDemo\.mount\((.*)\);/.exec(html)![1]!).comments.length, SEED_COMMENTS.length);
  });

  test('cannot be closed early by a </script> in the bundle', () => {
    const { html } = renderPage(HTML, q('gloss'), 'const s = "</script><b>";');
    assert.equal(html.match(/<\/script>/g)?.length, 2);
  });

  test('?fixed marks the body, and ?csp sends a strict policy', () => {
    assert.match(renderPage(HTML, q('fixed'), null).html, /<body class="fixed-header">/);
    assert.deepEqual(renderPage(HTML, q('csp'), null).headers, { 'content-security-policy': STRICT_CSP });
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
