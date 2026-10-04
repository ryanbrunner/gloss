import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { installChromiumArgs, linuxDepsHint, playwrightCli } from './install-chromium.js';

test('finds the CLI of the Playwright Gloss imports, without running it', () => {
  const cli = playwrightCli();
  assert.ok(existsSync(cli), `no Playwright CLI at ${cli}`);
  const pkg = JSON.parse(readFileSync(join(dirname(cli), 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'playwright');
});

test('installChromiumArgs passes --with-deps through only when asked', () => {
  assert.deepEqual(installChromiumArgs(false), ['install', 'chromium']);
  assert.deepEqual(installChromiumArgs(true), ['install', 'chromium', '--with-deps']);
});

test('linuxDepsHint names install-deps on Linux alone', () => {
  assert.match(linuxDepsHint('linux') ?? '', /playwright install-deps chromium/);
  assert.equal(linuxDepsHint('darwin'), null);
  assert.equal(linuxDepsHint('win32'), null);
});

test('linuxDepsHint stays quiet once --with-deps has installed the libraries', () => {
  assert.equal(linuxDepsHint('linux', true), null);
});
