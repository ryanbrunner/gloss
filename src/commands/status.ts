import { parseArgs } from 'node:util';
import { note, parseOrUsage, print, printJson } from '../output.js';
import { api, health, sessionUrl } from '../session/client.js';
import { liveSession, sessionRef } from '../session/state.js';

/**
 * Whether this directory has a session, as a status rather than a sentence:
 * 0 when it does, 1 when it does not, so a script can ask before it opens one.
 */
export async function status(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() =>
    parseArgs({ args, options: { name: { type: 'string' }, json: { type: 'boolean' } } }),
  );
  const ref = sessionRef(process.cwd(), values.name ?? '');
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
          }
        : { running: false },
    );
  }
  if (!state) return note(`No Gloss session is running for ${ref.cwd}${ref.name ? ` (${ref.name})` : ''}`);
  print(`Gloss session running at ${sessionUrl(state)} (pid ${state.pid})`);
  if (page) print(`showing  ${page}`);
  if (round) print(`round    ${round.round}, ${round.phase}`);
  print(`state    ${ref.statePath}`);
}
