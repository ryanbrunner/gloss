import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, parseOrUsage } from '../output.js';

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
 * `gloss install-chromium`: download the Chromium this Gloss's Playwright
 * drives. `npx playwright install` would fetch whichever Playwright is newest,
 * and with it a browser revision this one does not look for.
 */
export async function installChromium(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() => parseArgs({ args, options: { 'with-deps': { type: 'boolean' } } }));
  // Playwright's own flag: apt, via sudo, for the libraries Chromium needs to
  // launch. Debian/Ubuntu only; a no-op elsewhere.
  const child = spawn(process.execPath, [playwrightCli(), ...installChromiumArgs(values['with-deps'] ?? false)], {
    stdio: 'inherit',
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw new CliError(`installing Chromium failed (playwright exited with ${code ?? 'a signal'})`);
}
