import { z } from 'zod';
import { StateSchema } from './model';

/** One failed handoff per chat. Kept outside MVU so saving it cannot change its own base state. */
export const ProposalRepairSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  registration: z.object({
    chatId: z.string(),
    messageId: z.number(),
    swipeId: z.number(),
    timePath: z.string(),
    now: z.number(),
    cursors: z.record(z.string(), z.number()),
    state: StateSchema,
    nonce: z.string(),
    requestId: z.string(),
    registeredAt: z.number(),
    world: z
      .object({ taskId: z.string(), rootId: z.string(), fingerprint: z.string().nullable() })
      .optional(),
  }),
  reason: z.enum(['invalid_proposal', 'invalid_rules', 'until_mismatch']),
  raw: z.string(),
  errors: z.array(z.string()),
  world: z.unknown().optional(),
  evidence: z.object({
    taskId: z.string(),
    rootId: z.string(),
    at: z.number(),
    success: z.boolean(),
    skipped: z.boolean(),
    skipReason: z.string().optional(),
    changed: z.boolean().nullable(),
    patch: z.object({
      known: z.boolean(),
      operationCount: z.number().nullable(),
      issues: z.array(z.object({ kind: z.string(), message: z.string(), path: z.string() })),
      failedFragments: z.array(z.object({ index: z.number(), message: z.string() })),
      unassigned: z.number(),
    }),
  }),
  evidenceKey: z.string(),
  expired: z.boolean().optional(),
});

export type ProposalRepairMaterial = z.infer<typeof ProposalRepairSchema>;
export type ProposalRepairStatus = {
  status: 'available' | 'running' | 'failed' | 'expired';
  error?: string;
  storageError?: string;
};
