import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AnyVerdict } from '#core/verdict.js';
import { firstLine } from '#core/util.js';
import { note, usageError } from '../output.js';
import { authHeaders } from './client.js';
import { originOf } from './credentials.js';
import type { RemoteState } from './state.js';

/** Plain http only to this machine: anywhere else, a token on the wire is anyone's. */
export function secureOrLocal(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A server URL as `gloss connect` and `gloss login` take it: https, with no query, and no trailing slash. */
export function serverUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usageError(`'${raw}' is not a url`);
  }
  if (!secureOrLocal(url)) throw usageError(`a Gloss server is reached over https (or http on this machine), not ${url.protocol}//${url.host}`);
  if (url.search || url.hash) throw usageError('a Gloss server url has no query or fragment');
  return url.href.replace(/\/+$/, '');
}

const SHOT_TIMEOUT_MS = 15_000;
const SHOT_MAX_BYTES = 10 * 1024 * 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A name from the server, made safe to be a file's. */
const safe = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100) || '_';

/**
 * A server's verdict links each pinned element's picture as
 * `target.screenshotUrl`. What a verdict's `target.screenshot` promises is a
 * file the agent can open, so `gloss wait` fetches each picture first, into
 * a directory of the review's own under `dir`, and points `screenshot` at it.
 * A `screenshot` the server sent is not a path on this machine and is
 * dropped. A picture that cannot be had leaves the comment without one,
 * which the verdict allows, rather than losing the round.
 *
 * The token goes only to the server's own origin; a link elsewhere (a
 * signed storage URL) is fetched without it, and fetch drops it from a
 * redirect that leaves the origin.
 */
export async function saveScreenshots<V extends AnyVerdict>(verdict: V, state: RemoteState, dir: string): Promise<V> {
  const out = structuredClone(verdict);
  const folder = join(dir, safe(out.version === 2 ? out.review : 'session'));
  for (const comment of out.comments) {
    const target = comment.target;
    if (!target) continue;
    delete target.screenshot;
    if (typeof target.screenshotUrl !== 'string') continue;
    try {
      const path = join(folder, `${safe(comment.id)}.png`);
      writeShot(path, await fetchShot(new URL(target.screenshotUrl, `${state.server}/`), state));
      target.screenshot = path;
    } catch (e) {
      note(`gloss: could not fetch the picture for comment ${comment.id}: ${firstLine(e)}`);
    }
  }
  return out;
}

async function fetchShot(url: URL, state: RemoteState): Promise<Uint8Array> {
  if (!secureOrLocal(url)) throw new Error(`${url.protocol}//${url.host} is not https`);
  const ours = url.origin === originOf(state.server);
  const res = await fetch(url, {
    headers: ours ? authHeaders(state) : {},
    signal: AbortSignal.timeout(SHOT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > SHOT_MAX_BYTES) throw new Error('it is too big');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > SHOT_MAX_BYTES) throw new Error('it is too big');
  if (!PNG.every((b, i) => bytes[i] === b)) throw new Error('it is not a PNG');
  return bytes;
}

function writeShot(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
}
