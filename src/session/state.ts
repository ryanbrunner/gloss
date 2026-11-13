import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { isHealthy } from './client.js';

/**
 * Where a running session is found. `gloss open` starts one long-lived process
 * per working directory (and `--name`, for two at once), and it writes a state
 * file saying where it listens. Every later command reads that file to reach it.
 *
 * The files live under ~/.gloss rather than in the repo, so a session never
 * dirties a worktree. `GLOSS_HOME` moves them, which is what the tests do.
 */

export const sessionStateSchema = z.object({
  /** Absent in files written before there were remote connections, which are all local. */
  kind: z.literal('local').optional(),
  pid: z.number().int(),
  port: z.number().int(),
  token: z.string().min(1),
  cwd: z.string(),
  name: z.string(),
  /** The page the session was opened on. Where it is now is `/api/health`'s answer. */
  url: z.string(),
  startedAt: z.number(),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

/**
 * A directory connected to a Gloss server elsewhere (`gloss connect`)
 * rather than running a session of its own. There is no process or port:
 * the commands talk to `server` over HTTPS, with the token saved for its
 * origin (./credentials.ts). It sits where a session's state file would, so
 * a directory has one or the other, and `readState` never mistakes it for a
 * session.
 */
export const remoteStateSchema = z.object({
  kind: z.literal('remote'),
  /** Where the API is: its routes are `${server}/api/…`. */
  server: z.string(),
  /** Says which agent is asking, so a server handing rounds to many can keep each with the one it gave it to. */
  clientId: z.string().min(1),
  /** Whether the server holds many reviews, so a round's review has to be named. */
  reviews: z.boolean(),
  /** The review of the last round `gloss wait` printed: the one `working` and `ready` act on. */
  review: z.string().nullable(),
  cwd: z.string(),
  name: z.string(),
  startedAt: z.number(),
});
export type RemoteState = z.infer<typeof remoteStateSchema>;

export const isRemote = (state: SessionState | RemoteState): state is RemoteState => state.kind === 'remote';

/** Everything about one session that can be known before it is running. */
export interface SessionRef {
  cwd: string;
  name: string;
  id: string;
  statePath: string;
  logPath: string;
  lockPath: string;
  /** Screenshots of pinned elements go in a directory here named for the session's pid. */
  shotsPath: string;
}

export const glossHome = () => process.env.GLOSS_HOME ?? join(homedir(), '.gloss');

/**
 * The session for a directory and name. The path is resolved first, so a
 * symlinked checkout and its real path share one session rather than racing
 * for two windows.
 */
export function sessionRef(cwd: string, name = ''): SessionRef {
  const real = realpathSync(cwd);
  const id = createHash('sha1').update(`${real}\0${name}`).digest('hex').slice(0, 16);
  const home = glossHome();
  return {
    cwd: real,
    name,
    id,
    statePath: join(home, 'sessions', `${id}.json`),
    logPath: join(home, 'logs', `${id}.log`),
    lockPath: join(home, 'sessions', `${id}.lock`),
    shotsPath: join(home, 'shots', id),
  };
}

/** The state file, or null when there is none or it is not one this version wrote. */
export function readState(ref: SessionRef): SessionState | null {
  return readAs(ref, sessionStateSchema);
}

/** The directory's connection to a server elsewhere, or null when it has none. */
export function readRemote(ref: SessionRef): RemoteState | null {
  return readAs(ref, remoteStateSchema);
}

function readAs<T>(ref: SessionRef, schema: z.ZodType<T>): T | null {
  let text: string;
  try {
    text = readFileSync(ref.statePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Written beside and renamed over, so a reader never sees half a file. */
export function writeState(ref: SessionRef, state: SessionState | RemoteState): void {
  mkdirSync(dirname(ref.statePath), { recursive: true });
  const tmp = `${ref.statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, ref.statePath);
}

/**
 * Removes the state file if it is still `pid`'s. A session shutting down late
 * must not delete the file a newer session has written over it.
 */
export function removeState(ref: SessionRef, pid: number): void {
  if (readState(ref)?.pid !== pid) return;
  rmSync(ref.statePath, { force: true });
}

/** Ends the directory's connection to a server, if it has one, and drops the pictures saved from it. */
export function removeRemote(ref: SessionRef): void {
  if (!readRemote(ref)) return;
  rmSync(ref.statePath, { force: true });
  rmSync(remoteShotsPath(ref), { recursive: true, force: true });
}

/** Where `gloss wait` saves the pictures a server's verdicts link to, a directory per review. */
export const remoteShotsPath = (ref: SessionRef) => join(ref.shotsPath, 'remote');

/** Whether a process is there. EPERM means it is, and belongs to someone else. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The running session, or null. A live pid is not enough: after a `kill -9`
 * the number can come back as some other process, so the session also has to
 * answer its health check with the token it wrote. A file whose process is
 * gone is stale and is removed on the way.
 */
export async function liveSession(ref: SessionRef): Promise<SessionState | null> {
  const state = readState(ref);
  if (!state) return null;
  if (!pidAlive(state.pid)) {
    removeState(ref, state.pid);
    return null;
  }
  return (await isHealthy(state)) ? state : null;
}

/**
 * Takes the directory's lock, waiting up to `waitMs` for whoever holds it, so
 * two `gloss open`s at once start one session between them rather than two.
 * A lock whose holder has died is taken over. Resolves to the release, or null
 * if the wait ran out.
 */
export async function acquireLock(ref: SessionRef, waitMs: number): Promise<(() => void) | null> {
  mkdirSync(dirname(ref.lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(ref.lockPath, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(ref.lockPath, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    // Empty for the moment between another process creating it and writing
    // its pid, so only a pid that is there and dead counts as abandoned.
    const holder = Number(readLock(ref) || NaN);
    if (Number.isInteger(holder) && holder > 0 && !pidAlive(holder)) {
      rmSync(ref.lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}

function readLock(ref: SessionRef): string {
  try {
    return readFileSync(ref.lockPath, 'utf8').trim();
  } catch {
    return '';
  }
}
