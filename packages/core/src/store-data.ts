import { z } from 'zod';
import type { StoreData } from './store.js';
import { verdictSchema } from './verdict.js';

/**
 * A store's data as read back from storage, checked before
 * `CommentStore.from` takes it. Apart from ./store.ts, which the bar
 * bundles, so the bar does not carry zod for something it never does.
 */

const box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

const pin = z.object({
  url: z.string(),
  selector: z.string(),
  tag: z.string(),
  text: z.string(),
  box,
  viewport: z.object({ width: z.number(), height: z.number() }),
  quote: z.string().optional(),
  suggestion: z.string().optional(),
  screenshot: z.string().optional(),
});

const comment = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.number(),
  page: z.string().nullable(),
  sentIn: z.number().int().positive().nullable(),
  pin: pin.optional(),
  author: z.object({ id: z.string(), name: z.string().nullable() }).optional(),
});

export const storeDataSchema = z.object({
  v: z.literal(1),
  round: z.number().int().positive(),
  phase: z.enum(['reviewing', 'submitted', 'working', 'approved']),
  message: z.string().nullable(),
  summary: z.string().nullable(),
  summaryRound: z.number().int().positive().nullable(),
  live: z.boolean(),
  pending: verdictSchema.nullable(),
  delivered: verdictSchema.nullable(),
  comments: z.array(comment),
  seq: z.number().int().min(0),
  lastPage: z.string().nullable(),
}) satisfies z.ZodType<StoreData>;

/** Null for anything that is not a store's data, as `toJSON` writes it. */
export function parseStoreData(data: unknown): StoreData | null {
  const parsed = storeDataSchema.safeParse(data);
  return parsed.success ? (parsed.data as StoreData) : null;
}
