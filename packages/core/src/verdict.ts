import { z } from 'zod';

/**
 * What `gloss wait` prints: the reviewer's answer to one round, as a document
 * another program parses. Reeve does, so this is a contract with another repo
 * and it only grows: the objects are loose, so a field added later breaks no
 * consumer, and a field that changes meaning is a new `version`.
 * schema/verdict.v1.json is this, written out for anyone not reading
 * TypeScript (`npm run schema` writes it). docs/verdict.md says how to read it.
 *
 * Approval is `approved: true` and nothing else. A consumer that got no
 * document, or one it cannot parse, has no verdict, not an approval.
 */

export const VERDICT_VERSION = 1;

export const verdictCommentSchema = z
  .looseObject({
    id: z.string().describe('Unique within the session.'),
    kind: z
      .enum(['general', 'pinned'])
      .describe('`general` is a comment on the page as a whole; `pinned` is one about an element on it.'),
    body: z.string().describe('What the reviewer wrote, trimmed. May hold newlines.'),
    page: z.string().nullable().describe('The page the reviewer was on when they wrote it.'),
    createdAt: z.number().describe('When it was written, in milliseconds since the epoch.'),
    sentIn: z.number().int().positive().describe('The round it went out in: always the round of the verdict it is in.'),
    target: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        'What a pinned comment points at, and null for a general comment: the element\'s `url`, a CSS ' +
          '`selector` that matched it, its `tag`, visible `text`, `box` and the `viewport` it was measured in, ' +
          'the `quote` the reviewer selected, the `suggestion` they proposed in its place when they suggested ' +
          'an edit rather than commenting, and a `screenshot` of it. The screenshot is a path belonging to ' +
          'the session that wrote the verdict, and it is deleted when that session stops. More fields may be ' +
          'added, so read the ones you know.',
      ),
  })
  .describe('One comment, sent in this round.');

export const verdictSchema = z
  .looseObject({
    version: z.literal(VERDICT_VERSION),
    approved: z.boolean().describe('True only when the reviewer pressed Approve.'),
    round: z
      .number()
      .int()
      .positive()
      .describe('The round this answers. Two verdicts with the same round are the same verdict.'),
    page: z.string().nullable().describe('The page the reviewer was on when they submitted or approved.'),
    comments: z
      .array(verdictCommentSchema)
      .describe('The comments sent in this round and no other. Empty on approval.'),
  })
  .meta({
    title: 'Gloss verdict, version 1',
    description: 'What `gloss wait` prints on stdout when the reviewer submits a round or approves.',
  });

export type Verdict = z.infer<typeof verdictSchema>;
export type VerdictComment = z.infer<typeof verdictCommentSchema>;

/** The schema as JSON Schema: what schema/verdict.v1.json holds. */
export function verdictJsonSchema(): string {
  return `${JSON.stringify(z.toJSONSchema(verdictSchema), null, 2)}\n`;
}

/**
 * Version 2: a verdict from a server holding many reviews at once, such as
 * an inbox several reviewers write to. Version 1's `round` and comment `id`
 * are unique only within one review, and its approval ends the review the
 * agent was in, so a verdict from such a server says which review it is
 * about, and an approval there ends that review alone. Otherwise the same
 * document. A Gloss session on this machine still writes version 1, and a
 * consumer that reads only version 1 sees no verdict here, never approval.
 */
export const VERDICT_V2_VERSION = 2;

export const authorSchema = z
  .looseObject({
    id: z.string().describe('The reviewer, as the server knows them. The same id is the same person.'),
    name: z.string().nullable().describe('What to call them, when the server knows.'),
  })
  .describe('Who wrote the comment, as the server signed them in.');

export const verdictV2CommentSchema = verdictCommentSchema
  .extend({
    id: z.string().describe('Unique within the review.'),
    author: authorSchema.optional(),
    target: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        'As in version 1, except for the picture: `screenshotUrl` is where the server keeps it, and ' +
          '`screenshot`, when present, is a local path the client that printed this verdict saved it to.',
      ),
  })
  .describe('One comment, sent in this round.');

export const verdictV2Schema = verdictSchema
  .extend({
    version: z.literal(VERDICT_V2_VERSION),
    review: z.string().min(1).describe('The review this answers. A round is a round of this review alone.'),
    approved: z.boolean().describe('True only when the reviewer pressed Approve. It ends this review, not any other.'),
    round: z
      .number()
      .int()
      .positive()
      .describe('The round this answers. Two verdicts with the same `review` and `round` are the same verdict.'),
    comments: z
      .array(verdictV2CommentSchema)
      .describe('The comments sent in this round and no other. Empty on approval.'),
  })
  .meta({
    title: 'Gloss verdict, version 2',
    description: 'What `gloss wait` prints when it is connected to a server holding many reviews.',
  });

export type VerdictV2 = z.infer<typeof verdictV2Schema>;
export type VerdictV2Comment = z.infer<typeof verdictV2CommentSchema>;

/** Either version, told apart by `version`: what a client of any Gloss server reads. */
export const anyVerdictSchema = z.discriminatedUnion('version', [verdictSchema, verdictV2Schema]);
export type AnyVerdict = z.infer<typeof anyVerdictSchema>;

/** A store's verdict as a server holding many reviews hands it out: the same round, said to be `review`'s. */
export function forReview(verdict: Verdict, review: string): VerdictV2 {
  return { ...structuredClone(verdict), version: VERDICT_V2_VERSION, review };
}

/** Version 2 as JSON Schema: what schema/verdict.v2.json holds. */
export function verdictV2JsonSchema(): string {
  return `${JSON.stringify(z.toJSONSchema(verdictV2Schema), null, 2)}\n`;
}
