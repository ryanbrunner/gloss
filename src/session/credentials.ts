import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { glossHome } from './state.js';

/**
 * The tokens `gloss login` got from Gloss servers, one per origin, in a file
 * only its owner can read. A token is sent to the origin it came from and
 * nowhere else. `GLOSS_TOKEN` stands in for the file, for a machine that
 * cannot sign in in a browser, such as CI.
 */

const credentialsSchema = z.record(z.string(), z.object({ token: z.string().min(1), savedAt: z.number() }));
type Credentials = z.infer<typeof credentialsSchema>;

export const credentialsPath = () => join(glossHome(), 'credentials.json');

function read(): Credentials {
  try {
    const parsed = credentialsSchema.safeParse(JSON.parse(readFileSync(credentialsPath(), 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function write(credentials: Credentials): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The origin a token is kept under: scheme, host and port, so a path on the server never matters. */
export const originOf = (server: string) => new URL(server).origin;

export function tokenFor(server: string): string | null {
  return process.env.GLOSS_TOKEN || read()[originOf(server)]?.token || null;
}

export function saveToken(server: string, token: string): void {
  write({ ...read(), [originOf(server)]: { token, savedAt: Date.now() } });
}

/** False when there was no token to forget. */
export function forgetToken(server: string): boolean {
  const credentials = read();
  const origin = originOf(server);
  if (!credentials[origin]) return false;
  delete credentials[origin];
  write(credentials);
  return true;
}
