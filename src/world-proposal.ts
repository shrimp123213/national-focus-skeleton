import { z } from 'zod';
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
  /** Current Addon world result, separate from stat_data. */
  world?: unknown;
};
export type GuidanceReason =
  | IntegrationReason
  | 'waiting_workflow'
  | 'workflow_unknown'
  | 'member_mismatch'
  | 'missing_guidance'
  | 'world_failed'
  | 'world_skipped';
/** The floor and request a world guidance belongs to. */
export type GuidanceSource = Pick<
  IntegrationRegistration,
  'chatId' | 'messageId' | 'swipeId' | 'now' | 'nonce'
>;
/** What the world task wrote for national focus, as plain text, with the floor it belongs to. */
export type WorldGuidance = GuidanceSource & { text: string };
/**
 * waiting: the world task asked for data on this floor and has not finished.
 * started: its guidance started a local update. ended: it finished without guidance, or the floor
 * changed first; `reason` says which.
 */
export type GuidanceState = {
  status: 'none' | 'waiting' | 'started' | 'ended';
  reason?: GuidanceReason;
  source?: GuidanceSource;
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

export const GUIDANCE_TAG = '国策指引';

/**
 * The guidance text from the world task's extracted tag. The tag sits in the "analysis" JSON
 * string, so one layer of JSON string escapes may remain; plain text passes through.
 */
export function parseWorldGuidance(raw: string): string {
  const tag = new RegExp(`<${GUIDANCE_TAG}\\s*>([\\s\\S]*?)</${GUIDANCE_TAG}\\s*>`, 'g');
  const matches = [...raw.matchAll(tag)];
  let text = (matches.at(-1)?.[1] ?? raw).trim();
  text = text
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  // Escaped line breaks without real ones: the tag kept the JSON string escapes of "analysis".
  if (/\\[n"\\]/.test(text) && !text.includes('\n')) {
    try {
      text = JSON.parse(`"${text.replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`) as string;
    } catch {
      text = text.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) {
    throw new Error('国策指引是空的');
  }
  return text;
}
