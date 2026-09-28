import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CliError, parseOrUsage, usageError } from '../output.js';
import { BrowserUnavailable, openBrowser, type SessionBrowser } from './browser.js';
import { createApp, startServer, type RunningServer } from './server.js';
import { removeState, sessionRef, writeState } from './state.js';
import { CommentStore } from './store.js';

/**
 * `gloss __session`: the long-lived process `gloss open` starts and leaves
 * behind. It holds the round's comments, serves the API the CLI talks to, and
 * owns the browser. Its stdout and stderr are the session's log file.
 *
 * It writes the state file only once both halves are up, so a state file
 * always names a session that can answer. Every way out goes through `stop`,
 * which takes the file away first, so nothing finds a session that is going.
 */
export async function runSession(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: { cwd: { type: 'string' }, name: { type: 'string' }, url: { type: 'string' } },
    }),
  );
  if (!values.cwd || !values.url) throw usageError('__session is started by `gloss open`, with --cwd and --url');

  const ref = sessionRef(values.cwd, values.name ?? '');
  // The pid's own, so a session going away late cannot take a newer one's pictures with it.
  const shotsDir = join(ref.shotsPath, String(process.pid));
  const url = values.url;
  const store = new CommentStore();
  const token = randomBytes(24).toString('base64url');
  let browser: SessionBrowser | null = null;
  let server: RunningServer | null = null;
  let stopping = false;

  const stop = async (why: string, exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${why}`);
    removeState(ref, process.pid);
    await browser?.close();
    await server?.close();
    // The comments go with the session, so their pictures do too.
    rmSync(shotsDir, { recursive: true, force: true });
    process.exit(exitCode);
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void stop(signal));

  server = await startServer(
    createApp({
      token,
      store,
      currentUrl: () => browser?.currentUrl() ?? null,
      navigate: async (to) => {
        if (!browser) throw new Error('the browser is not open yet');
        await browser.navigate(to);
        log(`navigated to ${to}`);
      },
      close: () => void stop('asked to close'),
    }),
  );

  try {
    browser = await openBrowser(url, store, {
      headless: process.env.GLOSS_HEADLESS === '1',
      cdpPort: process.env.GLOSS_CDP_PORT ? Number(process.env.GLOSS_CDP_PORT) : undefined,
      shotsDir,
    });
  } catch (e) {
    await server.close();
    if (e instanceof BrowserUnavailable) throw new CliError(e.message);
    throw e;
  }

  writeState(ref, {
    pid: process.pid,
    port: server.port,
    token,
    cwd: ref.cwd,
    name: ref.name,
    url,
    startedAt: Date.now(),
  });
  log(`session ${ref.id} listening on http://127.0.0.1:${server.port}, showing ${url}`);
  void browser.closed.then(() => stop('the window was closed'));
}

function log(line: string): void {
  console.log(`[gloss] ${new Date().toISOString()} ${line}`);
}
