import type { Phase, RoundState } from '#core/store.js';
import { CliError } from '../output.js';
import { tokenFor } from './credentials.js';
import { isRemote, type RemoteState, type SessionState } from './state.js';

/**
 * The CLI's side of a running session: authed requests to its loopback API.
 * The token comes from the state file, which only its owner can read, so
 * another user on the machine cannot drive someone else's browser.
 *
 * Or of a server elsewhere, for a directory `gloss connect`ed to one: the
 * same routes, at the server's URL, with the token `gloss login` saved for
 * its origin. docs/protocol.md has what such a server answers.
 */

/** Whoever the commands are talking to: this directory's session, or the server it is connected to. */
export type Target = SessionState | RemoteState;

/** A health check that hangs is as good as none; a session answers at once. */
const HEALTH_TIMEOUT_MS = 2_000;

export const sessionUrl = (state: Pick<SessionState, 'port'>) => `http://127.0.0.1:${state.port}`;

export const baseUrl = (target: Target) => (isRemote(target) ? target.server : sessionUrl(target));

/** What `GET /api/health` answers with. */
export interface Health {
  ok: true;
  pid: number;
  /** The page the window is on now, which a navigation or a click may have changed. */
  url: string | null;
}

/** A session's health; a server elsewhere has no pid of ours to match. */
export async function health(state: Target): Promise<Health | null> {
  try {
    const res = await fetch(`${baseUrl(state)}/api/health`, {
      headers: authHeaders(state),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<Health>;
    if (body.ok !== true) return null;
    return isRemote(state) || body.pid === state.pid ? (body as Health) : null;
  } catch {
    return null;
  }
}

export const isHealthy = async (state: SessionState) => (await health(state)) !== null;

export function authHeaders(target: Target): Record<string, string> {
  if (!isRemote(target)) return { authorization: `Bearer ${target.token}` };
  const token = tokenFor(target.server);
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'x-gloss-client': target.clientId,
  };
}

/** The session did not answer at all, as against answering no. */
export class Unreachable extends CliError {}

/** A server elsewhere does not know who this is: no token for it, or one it no longer takes. */
export class Unauthorized extends CliError {}

async function request<T>(state: Target, path: string, init: RequestInit = {}): Promise<T> {
  const base = baseUrl(state);
  const what = isRemote(state) ? `the Gloss server at ${base}` : `the Gloss session at ${base}`;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...authHeaders(state), ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
  } catch (e) {
    throw new Unreachable(`could not reach ${what}: ${String((e as { cause?: unknown }).cause ?? e)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  // A server elsewhere sits behind proxies and restarts that answer 5xx for
  // a moment; that is no answer, like a connection that failed.
  if (res.status >= 500 && isRemote(state)) throw new Unreachable(`${what} answered ${res.status}`);
  if (res.status === 401 && isRemote(state)) {
    throw new Unauthorized(`${base} did not take this machine's token: run \`gloss login ${base}\``);
  }
  if (!res.ok) throw new CliError(body.error ?? `HTTP ${res.status} from ${what}'s ${path}`);
  return body as T;
}

/**
 * What a server holding many reviews needs to know which one a call is
 * about: the review of the round `gloss wait` last printed. Nothing, for a
 * session, which has the one.
 */
function about(state: Target): { review?: string } {
  if (!isRemote(state) || !state.reviews) return {};
  if (!state.review) throw new CliError(`no round has come from ${state.server} yet: run \`gloss wait\` first`);
  return { review: state.review };
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  state: (state: Target) => {
    const review = isRemote(state) && state.reviews ? state.review : null;
    return request<RoundState>(state, review ? `/api/state?review=${encodeURIComponent(review)}` : '/api/state');
  },
  navigate: (state: SessionState, url: string) => request<{ ok: true; url: string }>(state, '/api/navigate', post({ url })),
  close: (state: SessionState) => request<{ ok: true }>(state, '/api/close', { method: 'POST' }),
  /** The verdict, or `{pending: true}` if the reviewer has not answered within `waitSeconds`. Checked by the caller. */
  verdict: (state: Target, waitSeconds: number) => request<unknown>(state, `/api/verdict?wait=${waitSeconds}`),
  working: (state: Target, message: string | null) =>
    request<{ ok: true; phase: Phase }>(state, '/api/working', post({ message, ...about(state) })),
  /** `reloaded` is false where there were no pages to reload: the reviewer sees the summary when they next open one. */
  ready: (state: Target, summary: string | null) =>
    request<{ ok: true; phase: Phase; reloaded?: boolean }>(state, '/api/ready', post({ summary, ...about(state) })),
  live: (state: SessionState, live: boolean) => request<{ ok: true; live: boolean }>(state, '/api/live', post({ live })),
};
