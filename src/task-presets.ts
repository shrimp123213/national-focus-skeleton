import { z } from 'zod';
import {
  jobKinds,
  SourcesSchema,
  TaskPresetSchema,
  TaskSnapshotSchema,
  type Config,
  type TaskPreset,
} from './model';
import { normalizePrompts } from './prompts';

/**
 * Task presets after Workflow Assistant: a named snapshot of every task's prompt chain,
 * schedule, retry and batch settings and recommended model, plus the worldbook/context sources. API routes (primary,
 * fallbacks, route caps) and credentials are never part of a preset.
 */
export function snapshotTasks(config: Config, name: string): TaskPreset {
  const jobs: TaskPreset['jobs'] = {};
  for (const kind of jobKinds) {
    const job = config.jobs[kind];
    jobs[kind] = TaskSnapshotSchema.parse({
      retries: job.retries,
      timeout: job.timeout,
      schedule: job.schedule,
      interval: job.interval,
      ...(kind === 'generate' && job.segmentMax !== undefined ? { segmentMax: job.segmentMax } : {}),
      recommendedModel: job.recommendedModel,
      prompts: structuredClone(job.prompts),
    });
  }
  return TaskPresetSchema.parse({
    name,
    savedAt: Date.now(),
    jobs,
    sources: structuredClone(config.sources),
  });
}

function presetName(name: string): string {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) {
    throw new Error('請輸入任務預設名稱');
  }
  return trimmed;
}

export function saveTaskPreset(config: Config, name: string): Config {
  const entry = snapshotTasks(config, presetName(name));
  const next = structuredClone(config);
  const index = next.taskPresets.findIndex((preset) => preset.name === entry.name);
  if (index >= 0) {
    next.taskPresets[index] = entry;
  } else {
    next.taskPresets.push(entry);
  }
  next.activeTaskPreset = entry.name;
  return next;
}

export function applyTaskPreset(config: Config, name: string): Config {
  const entry = config.taskPresets.find((preset) => preset.name === name);
  if (!entry) {
    throw new Error(`找不到任務預設「${name}」`);
  }
  const next = structuredClone(config);
  for (const kind of jobKinds) {
    const saved = entry.jobs[kind];
    if (saved) {
      // Keep this installation's API routing; take everything else from the preset.
      next.jobs[kind] = {
        ...next.jobs[kind],
        ...structuredClone(saved),
        prompts: normalizePrompts(structuredClone(saved.prompts)),
      };
    }
  }
  if (entry.sources !== undefined) {
    next.sources = SourcesSchema.parse(structuredClone(entry.sources));
  }
  next.activeTaskPreset = entry.name;
  return next;
}

export function deleteTaskPreset(config: Config, name: string): Config {
  if (!config.taskPresets.some((preset) => preset.name === name)) {
    throw new Error(`找不到任務預設「${name}」`);
  }
  const next = structuredClone(config);
  next.taskPresets = next.taskPresets.filter((preset) => preset.name !== name);
  if (next.activeTaskPreset === name) {
    next.activeTaskPreset = '';
  }
  return next;
}

const ExportSchema = z.object({
  kind: z.literal('national-focus-task-presets'),
  version: z.literal(1),
  presets: z.array(TaskPresetSchema).min(1),
});

export function exportTaskPresets(config: Config, name?: string): string {
  const presets = name ? config.taskPresets.filter((preset) => preset.name === name) : config.taskPresets;
  if (!presets.length) {
    throw new Error(name ? `找不到任務預設「${name}」` : '目前沒有可匯出的任務預設');
  }
  return JSON.stringify({ kind: 'national-focus-task-presets', version: 1, presets }, null, 2);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '（根）'}：${issue.message}`)
    .join('；');
}

/** Name the likely mistake instead of showing a schema dump for an unrelated file. */
function explainImport(raw: unknown): never {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (Array.isArray(value.tasks) || Array.isArray(value.promptGroups)) {
    throw new Error(
      '這是工作流助手的預設檔，格式與國策任務預設不同，不能直接匯入。請匯入由本擴展匯出、kind 為 national-focus-task-presets 的檔案（例如「織界國策-任務預設.json」）。',
    );
  }
  if (value.kind === 'national-focus-task-presets') {
    const result = ExportSchema.safeParse(raw);
    throw new Error(`任務預設檔內容有誤：${result.success ? '未知錯誤' : describeIssues(result.error)}`);
  }
  throw new Error('這不是國策任務預設檔。請匯入由本擴展匯出、kind 為 national-focus-task-presets 的 JSON。');
}

/** Accept an export file, a single preset or a list; merge by name (imported wins). */
export function importTaskPresets(config: Config, raw: unknown): { config: Config; names: string[] } {
  const exported = ExportSchema.safeParse(raw);
  let entries: TaskPreset[];
  if (exported.success) {
    entries = exported.data.presets;
  } else {
    const list = Array.isArray(raw) ? raw : [raw];
    const parsed = list.map((item) => TaskPresetSchema.safeParse(item));
    if (!list.length || parsed.some((result) => !result.success)) {
      explainImport(raw);
    }
    entries = parsed.map((result) => result.data!);
  }
  const next = structuredClone(config);
  for (const entry of entries) {
    if (entry.sources !== undefined) {
      SourcesSchema.parse(entry.sources);
    }
    const index = next.taskPresets.findIndex((preset) => preset.name === entry.name);
    if (index >= 0) {
      next.taskPresets[index] = entry;
    } else {
      next.taskPresets.push(entry);
    }
  }
  return { config: next, names: entries.map((entry) => entry.name) };
}
