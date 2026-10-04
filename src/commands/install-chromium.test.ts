import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { linuxDepsHint, playwrightCli } from './install-chromium.js';

test('finds the CLI of the Playwright Gloss imports, without running it', () => {
  const cli = playwrightCli();
  assert.ok(existsSync(cli), `no Playwright CLI at ${cli}`);
  const pkg = JSON.parse(readFileSync(join(dirname(cli), 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'playwright');
});

test('linuxDepsHint names install-deps on Linux alone', () => {
  assert.match(linuxDepsHint('linux') ?? '', /gloss install-chromium --with-deps/);
  assert.equal(linuxDepsHint('darwin'), null);
  assert.equal(linuxDepsHint('win32'), null);
});
