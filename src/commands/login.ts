import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { CliError, note, parseOrUsage, print, usageError } from '../output.js';
import { forgetToken, originOf, saveToken } from '../session/credentials.js';
import { serverUrl } from '../session/remote.js';

/**
 * Signing this machine in to a Gloss server, with the OAuth device flow
 * (RFC 8628): the server says where to sign in at
 * `/.well-known/gloss.json`, `gloss login` prints a link and a code for the
 * person to approve in their browser, and it waits for the token. Nothing
 * is typed into the terminal, so it works over SSH too.
 */

const discoverySchema = z.object({
  device_authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  client_id: z.string().min(1),
});

const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  verification_uri_complete: z.url().optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().optional(),
});

const tokenSchema = z.union([z.object({ access_token: z.string().min(1) }), z.object({ error: z.string() })]);

/** RFC 8628's default, when the server names none. */
const DEFAULT_INTERVAL_S = 5;

export async function login(args: string[]): Promise<void> {
  const { positionals } = parseOrUsage(() => parseArgs({ args, allowPositionals: true }));
  if (positionals.length !== 1) throw usageError('login needs the url of a Gloss server');
  const server = serverUrl(positionals[0]!);
  await signIn(server);
  print(`Signed in to ${originOf(server)}.`);
}

export async function logout(args: string[]): Promise<void> {
  const { positionals } = parseOrUsage(() => parseArgs({ args, allowPositionals: true }));
  if (positionals.length !== 1) throw usageError('logout needs the url of a Gloss server');
  const origin = originOf(serverUrl(positionals[0]!));
  print(forgetToken(origin) ? `Signed out of ${origin}.` : `This machine was not signed in to ${origin}.`);
}

/** Signs in to `server`'s origin and saves the token for it. */
export async function signIn(server: string): Promise<void> {
  const origin = originOf(server);
  const meta = discoverySchema.safeParse(await getJson(`${origin}/.well-known/gloss.json`));
  if (!meta.success) throw new CliError(`${origin} does not say how to sign in (no /.well-known/gloss.json)`);
  const { device_authorization_endpoint, token_endpoint, client_id } = meta.data;
  // The token is only ever the origin's own, so it is asked for there too.
  for (const endpoint of [device_authorization_endpoint, token_endpoint]) {
    if (new URL(endpoint).origin !== origin) throw new CliError(`${origin} sends sign-in elsewhere (${endpoint}), so Gloss will not sign in there`);
  }

  const device = deviceSchema.safeParse(await postForm(device_authorization_endpoint, { client_id }));
  if (!device.success) throw new CliError(`${origin} did not start a sign-in`);
  const { device_code, user_code, verification_uri, verification_uri_complete, expires_in } = device.data;
  note(
    verification_uri_complete
      ? `To sign this machine in to ${origin}, open ${verification_uri_complete} and check it shows the code ${user_code}.`
      : `To sign this machine in to ${origin}, open ${verification_uri} and enter the code ${user_code}.`,
  );
  note('Waiting for you to approve it…');

  let interval = device.data.interval ?? DEFAULT_INTERVAL_S;
  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const answer = tokenSchema.safeParse(
      await postForm(token_endpoint, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
        client_id,
      }),
    );
    if (!answer.success) throw new CliError(`${origin} answered the sign-in with something Gloss does not understand`);
    if ('access_token' in answer.data) return saveToken(server, answer.data.access_token);
    const { error } = answer.data;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (error === 'access_denied') throw new CliError('the sign-in was turned down');
    if (error === 'expired_token') break;
    throw new CliError(`the sign-in failed: ${error}`);
  }
  throw new CliError('the sign-in code expired before it was approved; run `gloss login` again');
}

async function getJson(url: string): Promise<unknown> {
  return answer(url, () => fetch(url, { headers: { accept: 'application/json' } }));
}

/** The device flow's requests are forms, and its errors come back as 400s with a JSON body worth reading. */
async function postForm(url: string, fields: Record<string, string>): Promise<unknown> {
  return answer(url, () =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields),
    }),
  );
}

async function answer(url: string, send: () => Promise<Response>): Promise<unknown> {
  let res: Response;
  try {
    res = await send();
  } catch (e) {
    throw new CliError(`could not reach ${url}: ${String((e as { cause?: unknown }).cause ?? e)}`);
  }
  return res.json().catch(() => null);
}
