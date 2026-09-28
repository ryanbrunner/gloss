import { parseArgs } from 'node:util';
import { CliError, parseOrUsage, print } from '../output.js';
import { api } from '../session/client.js';
import { liveSession, sessionRef } from '../session/state.js';

/**
 * `gloss ready [summary]`: the agent is done with the round. The window
 * reloads so the reviewer sees the new version, the bar shows the summary,
 * and the next round is the reviewer's.
 */
export async function ready(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { name: { type: 'string' } } }),
  );
  const state = await liveSession(sessionRef(process.cwd(), values.name ?? ''));
  if (!state) throw new CliError('no Gloss session is running');

  await api.ready(state, positionals.join(' ').trim() || null);
  print('Reloaded the Gloss window; the next round is the reviewer\'s.');
}
