import { parseArgs } from 'node:util';
import { note, parseOrUsage, print, printJson } from '../output.js';
import { api, health, sessionUrl } from '../session/client.js';
import { liveSession, readRemote, sessionRef, type RemoteState, type SessionRef } from '../session/state.js';

/**
 * Whether this directory has a session, as a status rather than a sentence:
 * 0 when it does, 1 when it does not, so a script can ask before it opens one.
 */
export async function status(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() =>
    parseArgs({ args, options: { name: { type: 'string' }, json: { type: 'boolean' } } }),
  );
  const ref = sessionRef(process.cwd(), values.name ?? '');
  const remote = readRemote(ref);
  if (remote) return remoteStatus(ref, remote, values.json ?? false);
  const state = await liveSession(ref);
  const page = state ? ((await health(state))?.url ?? null) : null;
  const round = state ? await api.state(state).catch(() => null) : null;

  // The exit code is the answer, so "no" is set rather than thrown: a refusal
  // would print `gloss: …` as though the question itself had failed.
  if (!state) process.exitCode = 1;

  if (values.json) {
    return printJson(
      state
        ? {
            running: true,
            url: sessionUrl(state),
            page,
            pid: state.pid,
            statePath: ref.statePath,
            phase: round?.phase ?? null,
            round: round?.round ?? null,
            live: round?.live ?? null,
          }
        : { running: false },
    );
  }
  if (!state) return note(`No Gloss session is running for ${ref.cwd}${ref.name ? ` (${ref.name})` : ''}`);
  print(`Gloss session running at ${sessionUrl(state)} (pid ${state.pid})`);
  if (page) print(`showing  ${page}`);
  if (round) print(`round    ${round.round}, ${round.phase}${round.live ? ', live' : ''}`);
  print(`state    ${ref.statePath}`);
}

/**
 * A directory connected to a server elsewhere has a session for as long as
 * it is connected, whether or not the server answers just now: that is
 * `reachable`, and the exit code does not hang on it.
 */
async function remoteStatus(ref: SessionRef, remote: RemoteState, json: boolean): Promise<void> {
  const reachable = (await health(remote)) !== null;
  const round = reachable && (!remote.reviews || remote.review) ? await api.state(remote).catch(() => null) : null;
  if (json) {
    return printJson({
      running: true,
      remote: true,
      url: remote.server,
      reachable,
      review: remote.review,
      statePath: ref.statePath,
      phase: round?.phase ?? null,
      round: round?.round ?? null,
      live: round?.live ?? null,
    });
  }
  print(`Connected to ${remote.server}${reachable ? '' : ' (not answering just now)'}`);
  if (remote.review) print(`review   ${remote.review}`);
  if (round) print(`round    ${round.round}, ${round.phase}${round.live ? ', live' : ''}`);
  print(`state    ${ref.statePath}`);
}
