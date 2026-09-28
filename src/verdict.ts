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
      .describe('`general` is the only kind written in version 1. `pinned` is reserved for comments on an element.'),
    body: z.string().describe('What the reviewer wrote, trimmed. May hold newlines.'),
    page: z.string().nullable().describe('The page the reviewer was on when they wrote it.'),
    createdAt: z.number().describe('When it was written, in milliseconds since the epoch.'),
    sentIn: z.number().int().positive().describe('The round it went out in: always the round of the verdict it is in.'),
    target: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe('What a pinned comment points at. Null for a general comment; its shape arrives with pinning.'),
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
