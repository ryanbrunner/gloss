import { parseArgs } from 'node:util';
import { CliError, parseOrUsage, print } from '../output.js';
import { api } from '../session/client.js';
import { isRemote, liveSession, readRemote, sessionRef } from '../session/state.js';

/**
 * `gloss working [message]`: the agent has the round. The bar says Claude is
 * working, with the message, and the reviewer cannot submit or approve until
 * `gloss ready`. Said again, it only changes the message.
 */
export async function working(args: string[]): Promise<void> {
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, allowPositionals: true, options: { name: { type: 'string' } } }),
  );
  const ref = sessionRef(process.cwd(), values.name ?? '');
  const state = readRemote(ref) ?? (await liveSession(ref));
  if (!state) throw new CliError('no Gloss session is running');

  const message = positionals.join(' ').trim() || null;
  await api.working(state, message);
  const where = isRemote(state) ? `The Gloss bar at ${state.server}` : 'The Gloss bar';
  print(message ? `${where} shows Claude is working: ${message}` : `${where} shows Claude is working.`);
}
