import { z } from 'zod';
import { worldMember, type WorldMember } from './world-proposal';

export const PREDICTION_WAIT_MS = 10_000;
export type ScheduleSource = {
  chatId: string;
  messageId: number;
  swipeId: number;
  content: string;
};
export type PredictionReason =
  | 'unavailable'
  | 'member_unknown'
  | 'disabled'
  | 'unsupported_schedule'
  | 'unsupported_source'
  | 'invalid_time'
  | 'unknown_anchor'
  | 'first_run'
  | 'different_chat'
  | 'time_regressed'
  | 'interval_due'
  | 'interval_pending';
export type WorldSchedulePrediction = {
  status: 'due' | 'not_due' | 'unknown';
  reason: PredictionReason;
  member?: WorldMember;
};
export type ScheduleCoordination = {
  status: 'idle' | 'prediction_wait' | 'proposal_wait' | 'running' | 'cancelled';
  source?: Omit<ScheduleSource, 'content'>;
  prediction?: WorldSchedulePrediction;
  startedAt?: number;
  deadline?: number;
  reason?: 'nonce' | 'timeout' | 'result' | 'source_changed' | 'manual' | 'cancelled' | 'not_due';
};
export type RollbackNotice = {
  chatId: string;
  messageId: number;
  swipeId: number;
  proposalId: string;
  detectedAt: number;
  receiptMissing: boolean;
  returnedToBefore: boolean;
};

const units = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 31 * 86_400_000,
  year: 372 * 86_400_000,
};
const ScheduleSchema = z.object({
  mode: z.enum(['round', 'time']).optional(),
  timeInterval: z.object({
    enabled: z.boolean().optional(),
    value: z.number().positive(),
    unit: z.enum(['minute', 'hour', 'day', 'week', 'month', 'year']),
    timeSource: z.unknown(),
  }),
});

/** Restricted mirror of Workflow Assistant 1dc0d38: calendar time, current AI <tp> only.
 * This axis must never be passed to storyDay or national-focus progress calculations.
 */
function calendarTime(raw: unknown): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.split(' @')[0].trim();
  const match = /^复兴纪元(\d{1,6})年-(\d{1,2})月-(\d{1,2})日-星期[一二三四五六日天]-(\d{1,2}):(\d{2})$/.exec(
    text,
  );
  if (!match) {
    return null;
  }
  const [, year, month, day, hour, minute] = match.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return null;
  }
  return (((year * 372 + (month - 1) * 31 + day - 1) * 24 + hour) * 60 + minute) * 60_000;
}

export function predictWorldSchedule(
  settings: unknown,
  chatKey: string,
  content: string,
): WorldSchedulePrediction {
  const member = worldMember(settings);
  if (!member) {
    return { status: 'unknown', reason: 'member_unknown' };
  }
  const root = settings as {
    enabled?: boolean;
    tasks: { id: string; enabled?: boolean; schedule?: unknown }[];
    scheduleState?: Record<string, unknown>;
  };
  const task = root.tasks.find((entry) => entry.id === member.taskId)!;
  if (root.enabled === false || task.enabled === false) {
    return { status: 'not_due', reason: 'disabled', member };
  }
  const parsed = ScheduleSchema.safeParse(task.schedule);
  if (
    task.enabled !== true ||
    !parsed.success ||
    (parsed.data.mode ?? (parsed.data.timeInterval.enabled ? 'time' : 'round')) !== 'time'
  ) {
    return { status: 'unknown', reason: 'unsupported_schedule', member };
  }
  const interval = parsed.data.timeInterval;
  const source = z
    .object({
      type: z.literal('message_tag'),
      scope: z.literal('current_ai'),
      tagNames: z.tuple([z.literal('tp')]),
    })
    .safeParse(interval.timeSource);
  if (!source.success) {
    return { status: 'unknown', reason: 'unsupported_source', member };
  }
  const raw = [...content.matchAll(/<tp\s*>([\s\S]*?)<\/tp\s*>/g)].at(-1)?.[1];
  const now = calendarTime(raw);
  if (now === null) {
    return { status: 'unknown', reason: 'invalid_time', member };
  }
  const state = root.scheduleState?.[task.id];
  if (state === undefined) {
    return { status: 'due', reason: 'first_run', member };
  }
  const anchor = z
    .object({
      lastRunChatKey: z.string().optional(),
      lastRunGameTimeRaw: z.string().optional(),
      lastRunGameTimeMs: z.number().optional(),
    })
    .safeParse(state);
  if (!anchor.success) {
    return { status: 'unknown', reason: 'unknown_anchor', member };
  }
  if (chatKey.trim() && anchor.data.lastRunChatKey?.trim() !== chatKey.trim()) {
    return { status: 'due', reason: 'different_chat', member };
  }
  const previous = calendarTime(anchor.data.lastRunGameTimeRaw);
  if (previous === null) {
    if (anchor.data.lastRunGameTimeRaw || anchor.data.lastRunGameTimeMs !== undefined) {
      return { status: 'unknown', reason: 'unknown_anchor', member };
    }
    return { status: 'due', reason: 'first_run', member };
  }
  const elapsed = now - previous;
  if (elapsed < 0) {
    return { status: 'due', reason: 'time_regressed', member };
  }
  const due = elapsed >= interval.value * units[interval.unit];
  return { status: due ? 'due' : 'not_due', reason: due ? 'interval_due' : 'interval_pending', member };
}
