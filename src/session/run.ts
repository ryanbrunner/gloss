import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CommentStore } from '#core/store.js';
import { CliError, parseOrUsage, usageError } from '../output.js';
import { BrowserUnavailable, openBrowser, type SessionBrowser } from './browser.js';
import { openHost, type HostBrowser } from './host.js';
import { createApp, startServer, Waits, type RunningServer } from './server.js';
import { acquireLock, liveSession, removeState, sessionRef, writeState } from './state.js';

/**
 * `gloss __session`: the long-lived process `gloss open` starts and leaves
 * behind. It holds the round's comments, serves the API the CLI talks to, and
 * owns the browser. Its stdout and stderr are the session's log file.
 *
 * It writes the state file only once both halves are up, so a state file
 * always names a session that can answer. Every way out goes through `stop`,
 * which takes the file away first, so nothing finds a session that is going,
 * and tells any `gloss wait` why before the server goes, so the wait ends
 * with a reason rather than a cut connection.
 *
 * With `--host`, an app shows the page instead of Chromium, and talks to the
 * session over stdin and stdout (./host.ts). Nobody went through `gloss open`
 * to start it, so it takes the directory's lock and refuses to start over a
 * session already running there.
 */
export async function runSession(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      options: {
        cwd: { type: 'string' },
        name: { type: 'string' },
        url: { type: 'string' },
        live: { type: 'boolean' },
        host: { type: 'boolean' },
      },
    }),
  );
  if (!values.cwd || !values.url) throw usageError('__session is started by `gloss open`, with --cwd and --url');

  const ref = sessionRef(values.cwd, values.name ?? '');
  const hosted = values.host ?? false;
  let release: (() => void) | null = null;
  if (hosted) {
    release = await acquireLock(ref, LOCK_WAIT_MS);
    if (!release) throw new CliError('a `gloss open` in this directory is still starting a session');
    const running = await liveSession(ref);
    if (running) {
      release();
      throw new CliError(`this directory already has a Gloss session (pid ${running.pid}): run \`gloss close\` there first`);
    }
  }
  // The pid's own, so a session going away late cannot take a newer one's pictures with it.
  const shotsDir = join(ref.shotsPath, String(process.pid));
  const url = values.url;
  const store = new CommentStore(Date.now, values.live ?? false);
  const waits = new Waits();
  const token = randomBytes(24).toString('base64url');
  let browser: SessionBrowser | null = null;
  let host: HostBrowser | null = null;
  let server: RunningServer | null = null;
  let stopping = false;

  const stop = async (why: string, exitCode = 0) => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${why}`);
    removeState(ref, process.pid);
    release?.();
    waits.end(`the Gloss session ended: ${why}`);
    await browser?.close();
    await server?.close();
    // The comments go with the session, so their pictures do too.
    rmSync(shotsDir, { recursive: true, force: true });
    process.exit(exitCode);
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void stop(signal));

  let phase = store.snapshot().phase;
  store.onChange((s) => {
    if (s.phase !== phase) log(`round ${s.round}: ${phase} → ${s.phase}`);
    phase = s.phase;
  });

  server = await startServer(
    createApp({
      token,
      store,
      waits,
      currentUrl: () => browser?.currentUrl() ?? null,
      health: () => ({ pid: process.pid }),
      navigate: async (to) => {
        if (!browser) throw new Error('the browser is not open yet');
        await browser.navigate(to);
        log(`navigated to ${to}`);
      },
      reload: async () => {
        await browser?.reload();
        log(`ready: reloaded for round ${store.snapshot().round}`);
      },
      close: () => void stop('asked to close'),
    }),
  );

  try {
    browser = hosted
      ? (host = await openHost(url, store, { shotsDir }))
      : await openBrowser(url, store, {
          headless: process.env.GLOSS_HEADLESS === '1',
          cdpPort: process.env.GLOSS_CDP_PORT ? Number(process.env.GLOSS_CDP_PORT) : undefined,
          shotsDir,
        });
  } catch (e) {
    await server.close();
    release?.();
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
  release?.();
  release = null;
  host?.started(ref.id, server.port);
  log(`session ${ref.id} listening on http://127.0.0.1:${server.port}, showing ${url}${hosted ? ' in its host' : ''}`);
  void browser.closed.then(() => stop(hosted ? 'the preview was closed' : 'the window was closed'));
}

/** Long enough for a `gloss open` already starting Chromium here to finish. */
const LOCK_WAIT_MS = 20_000;

/** To stderr: with `--host`, stdout is the channel to the host. Both go to the log file otherwise. */
function log(line: string): void {
  console.error(`[gloss] ${new Date().toISOString()} ${line}`);
}
