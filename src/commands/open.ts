import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError, parseOrUsage, print, usageError } from '../output.js';
import { chromiumMissing } from '../session/browser.js';
import { api, sessionUrl } from '../session/client.js';
import { acquireLock, liveSession, sessionRef, type SessionRef, type SessionState } from '../session/state.js';

/** How long `open` waits for a new session to say it is up. Chromium's first start is most of it. */
const READY_WAIT_MS = 15_000;
/** How long a second `open` waits on a first one still starting the session. */
const LOCK_WAIT_MS = READY_WAIT_MS + 5_000;
const LOG_TAIL_LINES = 20;

const BIN = fileURLToPath(new URL('../../bin/gloss.js', import.meta.url));

/**
 * `gloss open <url>`: show the page in the session's window, starting the
 * session if this directory has none.
 *
 * It returns once the window is up rather than staying with it. The session
 * runs detached, with its output in a log file: a child holding this
 * process's stdout would keep a caller such as Claude's Bash tool waiting
 * for an end of file that never comes.
 */
export async function open(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { name: { type: 'string' } } }),
  );
  if (positionals.length !== 1) throw usageError('open needs one url');
  const url = normalizeUrl(positionals[0]!);
  const ref = sessionRef(process.cwd(), values.name ?? '');

  const live = await liveSession(ref);
  if (live) return reuse(live, url);

  const missing = chromiumMissing();
  if (missing) throw new CliError(missing);

  const release = await acquireLock(ref, LOCK_WAIT_MS);
  if (!release) throw new CliError(`another \`gloss open\` in this directory is still starting a session`);
  try {
    // Whoever held the lock may have started the session this one wanted.
    const started = await liveSession(ref);
    if (started) return reuse(started, url);
    report(await start(ref, url), url, false);
  } finally {
    release();
  }
}

/** A bare `localhost:3000` is taken to mean http. */
export function normalizeUrl(raw: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw usageError(`'${raw}' is not a url`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw usageError(`gloss opens http and https urls, not ${url.protocol}`);
  return url.href;
}

async function reuse(state: SessionState, url: string): Promise<void> {
  await api.navigate(state, url);
  report(state, url, true);
}

function report(state: SessionState, url: string, reused: boolean): void {
  print(`${reused ? 'Showing' : 'Opened'} ${url} in the Gloss window${reused ? ' already open' : ''}.`);
  print(`session  ${sessionUrl(state)} (pid ${state.pid})`);
}

async function start(ref: SessionRef, url: string): Promise<SessionState> {
  mkdirSync(dirname(ref.logPath), { recursive: true });
  const log = openSync(ref.logPath, 'a');
  const args = [BIN, '__session', '--cwd', ref.cwd, '--url', url, ...(ref.name ? ['--name', ref.name] : [])];
  const child = spawn(process.execPath, args, { cwd: ref.cwd, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);

  let exited: number | null | undefined;
  child.once('exit', (code) => (exited = code));
  try {
    const deadline = Date.now() + READY_WAIT_MS;
    while (Date.now() < deadline) {
      if (exited !== undefined) {
        throw new CliError(`the session exited before it was ready (code ${exited ?? 'unknown'}):\n${logTail(ref)}`);
      }
      const state = await liveSession(ref);
      if (state && state.pid === child.pid) return state;
      await sleep(100);
    }
    child.kill();
    throw new CliError(`the session was not ready after ${READY_WAIT_MS / 1000}s; its log is ${ref.logPath}`);
  } finally {
    child.unref();
  }
}

/** The end of the session's log: this run's, since the file is appended to. */
function logTail(ref: SessionRef): string {
  try {
    const lines = readFileSync(ref.logPath, 'utf8').trimEnd().split('\n');
    return lines.slice(-LOG_TAIL_LINES).map((l) => `  ${l}`).join('\n');
  } catch {
    return `  (no log at ${ref.logPath})`;
  }
}
