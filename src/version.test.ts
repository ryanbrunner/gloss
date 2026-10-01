import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VERSION } from './version.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the package and the Claude Code plugin have the same version', () => {
  // A release tag is checked against both, so they move together.
  const plugin = JSON.parse(read('../plugin/.claude-plugin/plugin.json'));
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
  assert.equal(plugin.version, VERSION, 'bump plugin/.claude-plugin/plugin.json with package.json');
});

test('the Homebrew formula template points at this version', () => {
  // The release fills the url in anyway; this keeps what CI audits current.
  assert.ok(
    read('../packaging/homebrew/gloss.rb').includes(`/archive/refs/tags/v${VERSION}.tar.gz"`),
    "bump the url in packaging/homebrew/gloss.rb with package.json's version",
  );
});
