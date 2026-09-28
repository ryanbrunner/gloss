import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError, note, parseOrUsage, print } from '../output.js';
import { api } from '../session/client.js';
import { liveSession, pidAlive, sessionRef } from '../session/state.js';

/** Closing Chromium is most of it. */
const CLOSE_WAIT_MS = 10_000;

/**
 * `gloss close`: end this directory's session, window and all. Closing when
 * nothing is open is not an error: the session is gone either way.
 */
export async function close(args: string[]): Promise<void> {
  const { values } = parseOrUsage(() => parseArgs({ args, options: { name: { type: 'string' } } }));
  const ref = sessionRef(process.cwd(), values.name ?? '');
  const state = await liveSession(ref);
  if (!state) return note('No Gloss session was running.');

  await api.close(state);
  // Said once it is true, so `gloss close && gloss open …` starts afresh.
  const deadline = Date.now() + CLOSE_WAIT_MS;
  while (pidAlive(state.pid)) {
    if (Date.now() > deadline) throw new CliError(`the session (pid ${state.pid}) is still shutting down`);
    await sleep(100);
  }
  print('Closed the Gloss session.');
}
