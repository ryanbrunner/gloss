import { readFileSync } from 'node:fs';

/** Gloss's version, from its package.json, which ships beside `src/` in every install. */
export const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
