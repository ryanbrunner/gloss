import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError, note, parseOrUsage, printJson } from '../output.js';
import { api, Unreachable } from '../session/client.js';
import { liveSession, sessionRef } from '../session/state.js';
import { verdictSchema } from '../verdict.js';

/** How long each ask is held: under the session's cap, and far under the 300 seconds Node's fetch waits for an answer. */
const POLL_SECONDS = 25;
/** A session that is there but did not answer is given a moment before the next ask. */
const RETRY_MS = 500;

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
 */
export async function wait(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() => parseArgs({ args, options: { name: { type: 'string' } } }));
  const ref = sessionRef(process.cwd(), values.name ?? '');
  let waiting = false;

  for (;;) {
    // Checked between asks, so a session that has gone is an answer rather than a retry.
    const state = await liveSession(ref);
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
      await sleep(RETRY_MS);
      continue;
    }
    if ((answer as { pending?: unknown } | null)?.pending === true) continue;

    const verdict = verdictSchema.safeParse(answer);
    if (!verdict.success) throw new CliError('the session answered with something that is not a version 1 verdict');
    return printJson(verdict.data);
  }
}
