import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { verdictJsonSchema, verdictSchema } from './verdict.js';

const SCHEMA_FILE = new URL('../schema/verdict.v1.json', import.meta.url);

const comment = {
  id: 'c1',
  kind: 'general',
  body: 'The header is too tall',
  page: 'http://127.0.0.1:4400/',
  createdAt: 1000,
  sentIn: 1,
  target: null,
};

describe('the verdict schema', () => {
  test('matches schema/verdict.v1.json', () => {
    // Reeve reads the file, not this code: the two must not drift apart.
    assert.equal(readFileSync(SCHEMA_FILE, 'utf8'), verdictJsonSchema(), 'schema/verdict.v1.json is stale: run `npm run schema`');
  });

  test('reserves kind for pinned comments, and target for what they point at', () => {
    const json = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'));
    const props = json.properties.comments.items.properties;
    assert.deepEqual(props.kind.enum, ['general', 'pinned']);
    assert.ok(props.target.anyOf.some((t: { type: string }) => t.type === 'null'));
    assert.ok(props.target.anyOf.some((t: { type: string }) => t.type === 'object'));
  });

  test('takes a pinned comment with a target, so pinning needs no new version', () => {
    const pinned = { ...comment, kind: 'pinned', target: { selector: 'header' } };
    assert.ok(verdictSchema.safeParse({ version: 1, approved: false, round: 1, page: null, comments: [pinned] }).success);
  });

  test('refuses any other version, and an approval that is not a boolean', () => {
    const base = { version: 1, approved: true, round: 1, page: null, comments: [] };
    assert.ok(verdictSchema.safeParse(base).success);
    assert.ok(!verdictSchema.safeParse({ ...base, version: 2 }).success);
    assert.ok(!verdictSchema.safeParse({ ...base, approved: 'true' }).success);
    assert.ok(!verdictSchema.safeParse({ ...base, approved: undefined }).success);
  });
});
