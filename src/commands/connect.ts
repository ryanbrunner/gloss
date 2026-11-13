import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { CliError, parseOrUsage, print, usageError } from '../output.js';
import { authHeaders, baseUrl } from '../session/client.js';
import { serverUrl } from '../session/remote.js';
import { liveSession, readRemote, sessionRef, writeState, type RemoteState } from '../session/state.js';
import { signIn } from './login.js';

const HEALTH_TIMEOUT_MS = 10_000;

/**
 * `gloss connect <server-url>`: this directory takes its rounds from a
 * Gloss server elsewhere rather than from a window of its own. After it,
 * `gloss wait`, `working` and `ready` talk to that server, as they would to
 * a session, until `gloss close`. Signs in first if the server asks.
 *
 * The server is anything that speaks docs/protocol.md: one with a window of
 * its own, or one holding many reviews, such as an inbox reviewers write to.
 */
export async function connect(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { name: { type: 'string' } } }),
  );
  if (positionals.length !== 1) throw usageError('connect needs the url of a Gloss server');
  const server = serverUrl(positionals[0]!);
  const ref = sessionRef(process.cwd(), values.name ?? '');
  if (await liveSession(ref)) {
    throw new CliError('this directory has a Gloss window open: run `gloss close` before connecting it to a server');
  }

  // Kept across a reconnect to the same server, so it still knows this agent
  // as the one it gave its last round to.
  const before = readRemote(ref);
  const same = before?.server === server ? before : null;
  const state: RemoteState = {
    kind: 'remote',
    server,
    clientId: same?.clientId ?? randomUUID(),
    reviews: false,
    review: same?.review ?? null,
    cwd: ref.cwd,
    name: ref.name,
    startedAt: Date.now(),
  };

  let health = await probe(state);
  if (health.status === 401) {
    if (process.env.GLOSS_TOKEN) throw new CliError(`${server} did not take GLOSS_TOKEN`);
    await signIn(server);
    health = await probe(state);
  }
  if (health.status === 401) throw new CliError(`${server} still does not take this machine's token`);
  if (health.status !== 200 || health.body?.ok !== true) {
    throw new CliError(`${server} is not a Gloss server: /api/health answered ${health.status}`);
  }
  state.reviews = health.body.capabilities?.reviews === true;
  writeState(ref, state);
  print(`Connected ${ref.cwd}${ref.name ? ` (${ref.name})` : ''} to ${server}.`);
  print(state.reviews ? 'Run `gloss wait` for the next round from any of its reviews.' : 'Run `gloss wait` for its next round.');
}

interface Probe {
  status: number;
  body: { ok?: unknown; capabilities?: { reviews?: unknown } } | null;
}

async function probe(state: RemoteState): Promise<Probe> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl(state)}/api/health`, {
      headers: authHeaders(state),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new CliError(`could not reach ${state.server}: ${String((e as { cause?: unknown }).cause ?? e)}`);
  }
  return { status: res.status, body: (await res.json().catch(() => null)) as Probe['body'] };
}
