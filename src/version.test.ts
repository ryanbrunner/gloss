import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VERSION } from './version.js';

test('the package and the Claude Code plugin have the same version', () => {
  // A release tag is checked against both, so they move together.
  const plugin = JSON.parse(readFileSync(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
  assert.equal(plugin.version, VERSION, 'bump plugin/.claude-plugin/plugin.json with package.json');
});
