import { CliError } from '../output.js';
import type { SessionState } from './state.js';
import type { RoundState } from './store.js';

/**
 * The CLI's side of a running session: authed requests to its loopback API.
 * The token comes from the state file, which only its owner can read, so
 * another user on the machine cannot drive someone else's browser.
 */

/** A health check that hangs is as good as none; a session answers at once. */
const HEALTH_TIMEOUT_MS = 2_000;

export const sessionUrl = (state: Pick<SessionState, 'port'>) => `http://127.0.0.1:${state.port}`;

/** What `GET /api/health` answers with. */
export interface Health {
  ok: true;
  pid: number;
  /** The page the window is on now, which a navigation or a click may have changed. */
  url: string | null;
}

export async function health(state: SessionState): Promise<Health | null> {
  try {
    const res = await fetch(`${sessionUrl(state)}/api/health`, {
      headers: authHeaders(state),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<Health>;
    return body.ok === true && body.pid === state.pid ? (body as Health) : null;
  } catch {
    return null;
  }
}

export const isHealthy = async (state: SessionState) => (await health(state)) !== null;

const authHeaders = (state: SessionState) => ({ authorization: `Bearer ${state.token}` });

async function request<T>(state: SessionState, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${sessionUrl(state)}${path}`, {
      ...init,
      headers: { ...authHeaders(state), ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
  } catch (e) {
    throw new CliError(`could not reach the Gloss session at ${sessionUrl(state)}: ${String((e as { cause?: unknown }).cause ?? e)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new CliError(body.error ?? `HTTP ${res.status} from the session's ${path}`);
  return body as T;
}

export const api = {
  state: (state: SessionState) => request<RoundState>(state, '/api/state'),
  navigate: (state: SessionState, url: string) =>
    request<{ ok: true; url: string }>(state, '/api/navigate', { method: 'POST', body: JSON.stringify({ url }) }),
  close: (state: SessionState) => request<{ ok: true }>(state, '/api/close', { method: 'POST' }),
};
