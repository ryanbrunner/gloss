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
  return ['install', 'chromium', ...(withDeps ? ['--with-deps'] : [])];
}

/**
 * Said after a successful install, on Linux alone: this only fetches the
 * browser, and Chromium there also needs system libraries the download does
 * not include. CI gets them with `playwright install --with-deps` (sudo, in
 * a runner that already grants it); asking for sudo here on someone's own
 * machine would be a surprise, so this names the command instead of running
 * it, unless they asked for it with `--with-deps`, which already did.
 */
export function linuxDepsHint(platform: string, withDeps = false): string | null {
  if (platform !== 'linux' || withDeps) return null;
  return 'Chromium also needs system libraries on Linux. If `gloss open` cannot launch it, run:\n  npx playwright install-deps chromium\n(or `gloss install-chromium --with-deps` next time, which installs them too)';
}

/**
 * `gloss install-chromium`: download the Chromium this Gloss's Playwright
 * drives. `npx playwright install` would fetch whichever Playwright is newest,
 * and with it a browser revision this one does not look for.
 */
export async function installChromium(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() => parseArgs({ args, options: { 'with-deps': { type: 'boolean' } } }));
  const withDeps = values['with-deps'] ?? false;
  // Playwright's own flag: apt, via sudo, for the libraries Chromium needs to
  // launch. Opt-in, so the sudo prompt is never a surprise. A no-op on macOS.
  const child = spawn(process.execPath, [playwrightCli(), ...installChromiumArgs(withDeps)], { stdio: 'inherit' });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new CliError(`installing Chromium failed (playwright exited with ${code ?? 'a signal'})`);
  const hint = linuxDepsHint(process.platform, withDeps);
  if (hint) note(hint);
}
