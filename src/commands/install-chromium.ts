import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, note, parseOrUsage } from '../output.js';

/**
 * The CLI of the Playwright Gloss runs on. Found through its package.json,
 * which Playwright exports, as `cli.js` is not.
 */
export function playwrightCli(): string {
  const pkg = createRequire(import.meta.url).resolve('playwright/package.json');
  return join(dirname(pkg), 'cli.js');
}

/**
 * The playwright CLI argv for `gloss install-chromium`, given whether
 * `--with-deps` was passed. Pulled out so the mapping can be tested without
 * spawning playwright.
 */
export function installChromiumArgs(withDeps: boolean): string[] {
  return withDeps ? ['install', '--with-deps', 'chromium'] : ['install', 'chromium'];
}

/**
 * Said after a successful install, on Linux alone: this only fetches the
 * browser, and Chromium there also needs system libraries the download does
 * not include. `--with-deps` gets them too (sudo, in a runner that already
 * grants it, or a person typing it as an explicit ask); asking for sudo
 * unprompted here would be a surprise, so this names the flag instead of
 * running it. Quiet once `--with-deps` has already installed them.
 */
export function linuxDepsHint(platform: string, withDeps = false): string | null {
  if (platform !== 'linux' || withDeps) return null;
  return 'Chromium also needs system libraries on Linux. If `gloss open` cannot launch it, run:\n  gloss install-chromium --with-deps';
}

/**
 * `gloss install-chromium [--with-deps]`: download the Chromium this Gloss's
 * Playwright drives. `npx playwright install` would fetch whichever
 * Playwright is newest, and with it a browser revision this one does not
 * look for.
 *
 * `--with-deps` also installs the system libraries Chromium needs on Linux,
 * which Playwright does with `apt-get` under sudo. Plain `install-chromium`
 * leaves that to `linuxDepsHint` instead of running it unasked; typing
 * `--with-deps` is that ask.
 */
export async function installChromium(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() => parseArgs({ args, options: { 'with-deps': { type: 'boolean' } } }));
  const withDeps = values['with-deps'] ?? false;
  const child = spawn(process.execPath, [playwrightCli(), ...installChromiumArgs(withDeps)], { stdio: 'inherit' });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new CliError(`installing Chromium failed (playwright exited with ${code ?? 'a signal'})`);
  const hint = linuxDepsHint(process.platform, withDeps);
  if (hint) note(hint);
}
