import { z } from 'zod';
import { ProposalSchema, type Proposal, type State } from './model';
import { repairReply } from './repair';
import type { IntegrationReason, IntegrationRegistration } from './integration';

export const FOCUS_WORLD = '阿斯塔利亚';
export const WORLD_FAMILY = '世界状态摘要@world';
const TaskSchema = z.object({
  id: z.string(),
  syncAsReplicaFamily: z.boolean().optional(),
  replicaFamilySpec: z.string().optional(),
  replicaFamilyRootId: z.string().optional(),
  replicaFamilyAttrValue: z.string().optional(),
});
const ResultSchema = z.object({
  taskId: z.string(),
  success: z.boolean(),
  skipped: z.boolean().optional(),
  skipReason: z.string().optional(),
  extractedTags: z.record(z.string(), z.string()).optional(),
});
export const RunStatusSchema = z.object({
  messageId: z.number(),
  at: z.number(),
  taskResults: z.array(ResultSchema),
});
export type WorldMember = { taskId: string; rootId: string };
export type WorldObservation = {
  member: WorldMember | null;
  run: z.infer<typeof RunStatusSchema> | null;
  fingerprint: string | null;
  patchLog: unknown;
};
export type WorldEvidence = {
  taskId: string;
  rootId: string;
  at: number;
  success: boolean;
  skipped: boolean;
  skipReason?: string;
  changed: boolean | null;
  patch: {
    known: boolean;
    operationCount: number | null;
    issues: { kind: string; message: string; path: string }[];
    failedFragments: { index: number; message: string }[];
    unassigned: number;
  };
};
export type ProposalReason =
  | IntegrationReason
  | 'waiting_workflow'
  | 'workflow_unknown'
  | 'member_mismatch'
  | 'missing_proposal'
  | 'invalid_proposal'
  | 'nonce_mismatch'
  | 'invalid_rules'
  | 'until_mismatch'
  | 'world_failed'
  | 'world_skipped'
  | 'world_patch_failed'
  | 'preview_changed'
  | 'user_rejected'
  | 'save_failed'
  | 'overwritten';
export type ProposalReceptionState = {
  status:
    | 'none'
    | 'waiting'
    | 'pending'
    | 'accepted'
    | 'rejected'
    | 'expired'
    | 'unavailable'
    | 'overwritten';
  reason?: ProposalReason;
  detail?: string;
  source?: Pick<IntegrationRegistration, 'chatId' | 'messageId' | 'swipeId' | 'now' | 'nonce'>;
  proposal?: Proposal;
  preview?: State;
  evidence?: WorldEvidence;
};
export type ProposalDiagnostic = {
  at: number;
  status: ProposalReceptionState['status'];
  reason?: ProposalReason;
  detail?: string;
  source?: ProposalReceptionState['source'];
  proposalId?: string;
  evidence?: WorldEvidence;
};

/** Resolve a unique replica root and its member; display names are deliberately ignored. */
export function worldMember(settings: unknown): WorldMember | null {
  const parsed = z.object({ tasks: z.array(TaskSchema) }).safeParse(settings);
  if (!parsed.success) {
    return null;
  }
  const roots = parsed.data.tasks.filter(
    (task) =>
      task.syncAsReplicaFamily && task.replicaFamilySpec === WORLD_FAMILY && !task.replicaFamilyRootId,
  );
  if (roots.length !== 1) {
    return null;
  }
  const members = parsed.data.tasks.filter(
    (task) => task.replicaFamilyRootId === roots[0].id && task.replicaFamilyAttrValue === FOCUS_WORLD,
  );
  return members.length === 1 ? { taskId: members[0].id, rootId: roots[0].id } : null;
}

/** A compact comparison value, used only as review evidence, never as proof of a successful write. */
export function worldFingerprint(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(canonical);
    }
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return item;
  };
  const text = JSON.stringify(canonical(value));
  let hash = 2166136261;
  let second = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    second = Math.imul(second, 33) ^ text.charCodeAt(i);
  }
  return `${text.length}:${hash >>> 0}:${second >>> 0}`;
}

export function parseWorldProposal(raw: string): { nonce: string; proposal: Proposal } {
  const matches = [...raw.matchAll(/<国策提案\s*>([\s\S]*?)<\/国策提案\s*>/g)];
  let text = (matches.at(-1)?.[1] ?? raw).trim();
  text = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // One residual JSON string-escaping layer from structured analysis output.
    value = JSON.parse(JSON.parse(`"${text.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`));
  }
  if (typeof value === 'string') {
    value = JSON.parse(value);
  }
  const envelope = z.object({ nonce: z.string().trim().min(1), proposal: z.unknown() }).parse(value);
  return { nonce: envelope.nonce, proposal: ProposalSchema.parse(repairReply(envelope.proposal, 'update')) };
}

function worldPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    [`/${FOCUS_WORLD}`, `/世界/${FOCUS_WORLD}`].some((root) => path === root || path.startsWith(`${root}/`))
  );
}
function operationPath(op: unknown): string | null {
  if (!op || typeof op !== 'object') {
    return null;
  }
  const data = op as Record<string, unknown>;
  return [data.path, data.from, data.to].find(worldPath) ?? null;
}
export function worldEvidence(
  observation: WorldObservation,
  registration: IntegrationRegistration,
  result: z.infer<typeof ResultSchema>,
): WorldEvidence {
  const log = z
    .object({
      messageId: z.number(),
      timestamp: z.number(),
      ops: z.array(z.unknown()),
      issues: z.array(z.object({ kind: z.string(), message: z.string(), op: z.unknown().optional() })),
      failedFragments: z.array(z.object({ index: z.number(), message: z.string(), snippet: z.string() })),
    })
    .safeParse(observation.patchLog);
  const patch: WorldEvidence['patch'] = {
    known: false,
    operationCount: null,
    issues: [],
    failedFragments: [],
    unassigned: 0,
  };
  if (
    log.success &&
    log.data.messageId === registration.messageId &&
    log.data.timestamp >= registration.registeredAt
  ) {
    patch.known = true;
    patch.operationCount = log.data.ops.filter((op) => operationPath(op)).length;
    for (const issue of log.data.issues) {
      const path = operationPath(issue.op);
      if (path) {
        patch.issues.push({ kind: issue.kind, message: issue.message.slice(0, 500), path });
      } else if (!issue.op) {
        patch.unassigned++;
      }
    }
    for (const fragment of log.data.failedFragments) {
      // Malformed fragments cannot reliably be assigned by searching their prose for a world name.
      try {
        const op: unknown = JSON.parse(fragment.snippet);
        if (operationPath(op)) {
          patch.failedFragments.push({ index: fragment.index, message: fragment.message.slice(0, 500) });
        } else {
          patch.unassigned++;
        }
      } catch {
        patch.unassigned++;
      }
    }
  }
  return {
    ...observation.member!,
    at: observation.run!.at,
    success: result.success,
    skipped: result.skipped === true,
    skipReason: result.skipReason?.slice(0, 500),
    changed:
      registration.world?.fingerprint != null && observation.fingerprint != null
        ? registration.world.fingerprint !== observation.fingerprint
        : null,
    patch,
  };
}
