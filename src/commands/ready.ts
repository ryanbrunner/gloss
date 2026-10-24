import { parseArgs } from 'node:util';
import { CliError, parseOrUsage, print } from '../output.js';
import { api } from '../session/client.js';
import { readRemote, liveSession, sessionRef } from '../session/state.js';

/**
 * `gloss ready [summary]`: the agent is done with the round. The window
 * reloads so the reviewer sees the new version, the bar shows the summary,
 * and the next round is the reviewer's, unless live mode has already sent
 * comments written meanwhile on as the next one.
 */
export async function ready(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { name: { type: 'string' } } }),
  );
  const ref = sessionRef(process.cwd(), values.name ?? '');
  const state = readRemote(ref) ?? (await liveSession(ref));
  if (!state) throw new CliError('no Gloss session is running');

  const { phase, reloaded = true } = await api.ready(state, positionals.join(' ').trim() || null);
  // With nothing to reload, as on a server elsewhere, the reviewer reads the
  // summary when they next open the page.
  const done = reloaded ? 'Reloaded the Gloss window' : 'Posted the summary; the reviewer sees it the next time they open the page';
  // In live mode, comments written while the agent worked go out the moment
  // it is ready, so the round may already be back with the agent.
  if (phase === 'submitted') {
    print(`${done}; comments written while you worked have already gone out as the next round: run \`gloss wait\`.`);
  } else {
    print(`${done}; the next round is the reviewer's.`);
  }
}
