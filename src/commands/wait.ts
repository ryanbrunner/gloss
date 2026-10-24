import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { anyVerdictSchema, verdictSchema } from '#core/verdict.js';
import { CliError, note, parseOrUsage, printJson } from '../output.js';
import { api, Unreachable } from '../session/client.js';
import { saveScreenshots } from '../session/remote.js';
import {
  isRemote,
  liveSession,
  readRemote,
  remoteShotsPath,
  sessionRef,
  writeState,
  type RemoteState,
  type SessionRef,
} from '../session/state.js';

/** How long each ask is held: under the session's cap, and far under the 300 seconds Node's fetch waits for an answer. */
const POLL_SECONDS = 25;
/** A session that is there but did not answer is given a moment before the next ask. */
const RETRY_MS = 500;
/** A server elsewhere that does not answer is asked again less and less often, down to this. */
const REMOTE_RETRY_MAX_MS = 30_000;

/**
 * `gloss wait`: block until the reviewer submits a round or approves, then
 * print the verdict on stdout and exit 0. Stdout carries that one JSON
 * document and nothing else; everything said to a person goes to stderr.
 *
 * No verdict is exit 1 with nothing on stdout: no session, a session that
 * ended (the window closed, `gloss close`), or an answer that is not a
 * version 1 verdict. The verdict stays put until `gloss working` or `gloss
 * ready`, so a second wait before either prints the same round again, and
 * a wait while the agent is marked working is refused, since the reviewer
 * cannot submit until `gloss ready`.
 *
 * Connected to a server elsewhere (`gloss connect`), it waits on that
 * instead, for as long as it takes: a server that does not answer is asked
 * again, since there is no window to have closed. Its verdict may be
 * version 2, from one of many reviews; that review is the one `working`
 * and `ready` then act on. Pictures it links to are fetched first, so the
 * verdict's `screenshot` paths are files here.
 */
export async function wait(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() => parseArgs({ args, options: { name: { type: 'string' } } }));
  const ref = sessionRef(process.cwd(), values.name ?? '');
  let waiting = false;
  let misses = 0;

  for (;;) {
    // Checked between asks, so a session that has gone is an answer rather than a retry.
    const state = readRemote(ref) ?? (await liveSession(ref));
    if (!state) {
      throw new CliError(
        waiting ? 'the Gloss session ended before the reviewer answered' : 'no Gloss session is running; start one with `gloss open <url>`',
      );
    }
    if (!waiting) note('Waiting for the reviewer to submit a round or approve…');
    waiting = true;

    let answer: unknown;
    try {
      answer = await api.verdict(state, POLL_SECONDS);
    } catch (e) {
      if (!(e instanceof Unreachable)) throw e;
      if (!isRemote(state)) {
        await sleep(RETRY_MS);
        continue;
      }
      if (misses++ === 0) note(`gloss: ${e.message}; trying again until it answers`);
      await sleep(Math.min(RETRY_MS * 2 ** misses, REMOTE_RETRY_MAX_MS));
      continue;
    }
    if (misses && isRemote(state)) note(`gloss: ${state.server} is answering again`);
    misses = 0;
    if ((answer as { pending?: unknown } | null)?.pending === true) continue;
    if (isRemote(state)) return printJson(await received(ref, state, answer));

    const verdict = verdictSchema.safeParse(answer);
    if (!verdict.success) throw new CliError('the session answered with something that is not a version 1 verdict');
    return printJson(verdict.data);
  }
}

/**
 * A server's verdict, of either version, with its pictures fetched. Its
 * review is remembered first, so `gloss working` knows which review it is
 * about even if printing it is the last thing this process does.
 */
async function received(ref: SessionRef, state: RemoteState, answer: unknown) {
  const verdict = anyVerdictSchema.safeParse(answer);
  if (!verdict.success) throw new CliError(`${state.server} answered with something that is not a verdict`);
  const review = verdict.data.version === 2 ? verdict.data.review : null;
  // Read again: a reconnect while this waited may have written a newer record.
  const latest = readRemote(ref);
  if (latest?.server === state.server) writeState(ref, { ...latest, review });
  return saveScreenshots(verdict.data, state, remoteShotsPath(ref));
}
