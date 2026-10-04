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
 * Said after a successful install, on Linux alone: this only fetches the
 * browser, and Chromium there also needs system libraries the download does
 * not include. CI gets them with `playwright install --with-deps` (sudo, in
 * a runner that already grants it); asking for sudo here on someone's own
 * machine would be a surprise, so this names the command instead of running
 * it.
 */
export function linuxDepsHint(platform: string): string | null {
  if (platform !== 'linux') return null;
  return 'Chromium also needs system libraries on Linux. If `gloss open` cannot launch it, run:\n  npx playwright install-deps chromium';
}

/**
 * `gloss install-chromium`: download the Chromium this Gloss's Playwright
 * drives. `npx playwright install` would fetch whichever Playwright is newest,
 * and with it a browser revision this one does not look for.
 */
export async function installChromium(args: string[]): Promise<void> {
  parseOrUsage(() => parseArgs({ args, options: {} }));
  const child = spawn(process.execPath, [playwrightCli(), 'install', 'chromium'], { stdio: 'inherit' });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new CliError(`installing Chromium failed (playwright exited with ${code ?? 'a signal'})`);
  const hint = linuxDepsHint(process.platform);
  if (hint) note(hint);
}
