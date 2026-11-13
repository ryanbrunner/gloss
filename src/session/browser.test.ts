import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { missingSystemLibraries } from './browser.js';

describe('missingSystemLibraries', () => {
  test('matches the dependency check Playwright runs before spawning Chromium', () => {
    const cause = new Error(
      '\n╔══════════════════════════════════════════════════════╗\n║ Host system is missing dependencies to run browsers.    ║\n║ Please install them with the following command:         ║\n║                                                          ║\n║     sudo npx playwright install-deps                    ║\n╚══════════════════════════════════════════════════════╝',
    );
    assert.ok(missingSystemLibraries(cause));
  });

  test('is false for other launch failures, or a non-Error', () => {
    assert.equal(missingSystemLibraries(new Error('spawn ENOENT')), false);
    assert.equal(missingSystemLibraries('boom'), false);
    assert.equal(missingSystemLibraries(undefined), false);
  });
});
