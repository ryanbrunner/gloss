import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  anyVerdictSchema,
  forReview,
  verdictJsonSchema,
  verdictSchema,
  verdictV2JsonSchema,
  verdictV2Schema,
} from '#core/verdict.js';

const SCHEMA_FILE = new URL('../schema/verdict.v1.json', import.meta.url);
const V2_FILE = new URL('../schema/verdict.v2.json', import.meta.url);

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

describe('version 2', () => {
  const v1 = { version: 1, approved: false, round: 1, page: null, comments: [comment] } as const;

  test('matches schema/verdict.v2.json', () => {
    assert.equal(readFileSync(V2_FILE, 'utf8'), verdictV2JsonSchema(), 'schema/verdict.v2.json is stale: run `npm run schema`');
  });

  test('is a version 1 round said to be one review’s', () => {
    const v2 = forReview(verdictSchema.parse(v1), 'r1');
    assert.equal(v2.version, 2);
    assert.equal(v2.review, 'r1');
    assert.deepEqual(v2.comments, v1.comments);
    assert.ok(verdictV2Schema.safeParse(v2).success);
  });

  test('needs the review it is about', () => {
    assert.ok(!verdictV2Schema.safeParse({ ...v1, version: 2 }).success);
    assert.ok(!verdictV2Schema.safeParse({ ...v1, version: 2, review: '' }).success);
  });

  test('is no verdict at all to a version 1 consumer, approval or not', () => {
    for (const approved of [false, true]) {
      assert.ok(!verdictSchema.safeParse({ ...v1, approved, version: 2, review: 'r1' }).success);
    }
  });

  test('keeps a comment’s author, and fields it does not know', () => {
    const c = { ...comment, author: { id: 'u1', name: 'Ana' }, mood: 'cross' };
    const parsed = verdictV2Schema.parse({ ...v1, version: 2, review: 'r1', comments: [c] });
    assert.deepEqual(parsed.comments[0], c);
  });

  test('either version parses as a verdict, told apart by its version', () => {
    assert.equal(anyVerdictSchema.parse(v1).version, 1);
    assert.equal(anyVerdictSchema.parse({ ...v1, version: 2, review: 'r1' }).version, 2);
    assert.ok(!anyVerdictSchema.safeParse({ ...v1, version: 3 }).success);
  });
});
