/**
 * Writes schema/verdict.v1.json from the zod schema in src/verdict.ts. The
 * unit tests fail when the two differ, and say to run this.
 *
 *   npm run schema
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verdictJsonSchema } from '../src/verdict.js';

const path = fileURLToPath(new URL('../schema/verdict.v1.json', import.meta.url));
mkdirSync(fileURLToPath(new URL('../schema/', import.meta.url)), { recursive: true });
writeFileSync(path, verdictJsonSchema());
console.log(`wrote ${path}`);
