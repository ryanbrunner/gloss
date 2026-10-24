/**
 * Writes schema/verdict.v1.json and schema/verdict.v2.json from the zod
 * schemas in packages/core/src/verdict.ts. The unit tests fail when they
 * differ, and say to run this.
 *
 *   npm run schema
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verdictJsonSchema, verdictV2JsonSchema } from '#core/verdict.js';

mkdirSync(fileURLToPath(new URL('../schema/', import.meta.url)), { recursive: true });
for (const [name, json] of [
  ['verdict.v1.json', verdictJsonSchema()],
  ['verdict.v2.json', verdictV2JsonSchema()],
] as const) {
  const path = fileURLToPath(new URL(`../schema/${name}`, import.meta.url));
  writeFileSync(path, json);
  console.log(`wrote ${path}`);
}
