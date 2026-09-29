import type { Config, ContextRules, JobKind, PromptItem, SourceSettings } from './model';
import { valueAt, type PromptMessage, type RenderedPrompt, type SourceEntry } from './platform';
import { isModified, promptText } from './prompts';
import { stripNewsTag } from './engine';

/**
 * Source assembly follows the Workflow Assistant placeholders:
 * $1 plot worldbook, $2 managed entries, $5 chronicle index, $6 memory recall,
 * $7 recent AI context, $8 latest user input, $U persona/protagonist, $C character description.
 */
export type SourceMessage = { message_id: number; role: string; message?: string };
export type TemplateSource = 'world_info' | 'slash_command';
export type SourceBlock = {
  name: string;
  placeholder: string;
  characters: number;
  /** json = inside the request JSON; segment = placed by a prompt segment; off = not sent. */
  placement: 'json' | 'segment' | 'off';
};
export type SourceReport = {
  history: { id: number; before: number; after: number; extractionMissed: boolean }[];
  entries: { book: string; uid: number; name: string; status: string; characters: number }[];
  blocks: SourceBlock[];
  segments: { name: string; role: string; kind: string; characters: number }[];
  notes: string[];
  characters: number;
  limit: number;
};
export class InputSizeError extends Error {}

export const placeholders = {
  $1: '劇情世界書',
  $2: '工作流托管條目',
  $5: '紀要索引',
  $6: '記憶回溯',
  $7: 'AI 上下文',
  $8: '使用者輸入',
  $U: '使用者設定與主角資料',
  $C: '角色描述',
} as const;
export type Placeholder = keyof typeof placeholders;
const placeholderPattern = /\$(?:[125678]|U|C)/g;
const contextKeys: Record<Placeholder, string> = {
  $1: 'worldbook',
  $2: 'managedWorldbook',
  $5: 'summaryIndex',
  $6: 'memory',
  $7: 'history',
  $8: 'user',
  $U: 'persona',
  $C: 'character',
};

export function effectiveSources(settings: SourceSettings, job: JobKind) {
  return {
    context: settings.taskContextOverridesEnabled
      ? (settings.overrides[job]?.context ?? settings.context)
      : settings.context,
    worldbook: settings.taskWorldbookOverridesEnabled
      ? (settings.overrides[job]?.worldbook ?? settings.worldbook)
      : settings.worldbook,
  };
}

// ---------------------------------------------------------------------------
// Boundary rules (Workflow Assistant tasks/context-tags.ts)

type Boundary = { start: string; end: string };
function rules(values: Boundary[]): Boundary[] {
  const unique = new Map<string, Boundary>();
  for (const value of values) {
    const start = String(value.start ?? '').trim();
    const end = String(value.end ?? '').trim();
    if (start && end) {
      unique.set(`${start}\0${end}`, { start, end });
    }
  }
  return [...unique.values()];
}

/** A start such as `<tp` is an incomplete open tag: it may match `<tp>` or `<tp="x">`, never `<tpx>`. */
function validPrefixMatch(text: string, index: number, length: number): boolean {
  if (index > 0 && text[index - 1] === '/') {
    return false;
  }
  const next = text[index + length];
  if (next === undefined || next === '>' || next === '=' || /\s/.test(next)) {
    return true;
  }
  return !/[A-Za-z0-9_-]/.test(next);
}

function lastBoundary(text: string, rule: Boundary): [number, number] | undefined {
  const lower = text.toLowerCase();
  const end = lower.lastIndexOf(rule.end.toLowerCase());
  if (end < 0) {
    return;
  }
  const start = rule.start.toLowerCase();
  const prefix = rule.start.startsWith('<') && !rule.start.endsWith('>');
  let index = lower.lastIndexOf(start, Math.max(0, end - 1));
  while (index >= 0 && prefix && !validPrefixMatch(text, index, start.length)) {
    index = index === 0 ? -1 : lower.lastIndexOf(start, index - 1);
  }
  if (index < 0 || end + rule.end.length <= index) {
    return;
  }
  return [index, end + rule.end.length];
}

export function excludeContext(text: string, values: Boundary[]): string {
  let result = String(text ?? '');
  const list = rules(values);
  if (!result || !list.length) {
    return result;
  }
  for (const rule of list) {
    const range = lastBoundary(result, rule);
    if (range) {
      result = result.slice(0, range[0]) + result.slice(range[1]);
    }
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

export function extractContext(text: string, config: ContextRules) {
  const extracts = rules(config.contextExtractRules);
  const parts = extracts.flatMap((rule) => {
    const range = lastBoundary(text, rule);
    return range ? [text.slice(...range)] : [];
  });
  return {
    // Match Workflow Assistant: a non-matching extraction retains the original text.
    text: excludeContext(parts.length ? parts.join('\n\n') : text, config.contextExcludeRules).trim(),
    missed: extracts.length > 0 && parts.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Entry classification (Workflow Assistant worldbook/blocked.ts)

export function normalizedEntryName(name: string): string {
  return String(name || '')
    .replace(/^ACU-\[[^\]]+\]-/, '')
    .replace(/^外部导入-(?:[^-]+-)?/, '');
}
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function databaseEntry(name: string): boolean {
  return /^(?:TavernDB-ACU-|总结条目|小总结条目|重要人物条目)/.test(name);
}
function memoryRow(name: string): boolean {
  return /CustomExport-纪要-\d+$/.test(name) || /^(?:小总结条目|总结条目)/.test(name);
}
function memoryEntry(name: string): boolean {
  return memoryRow(name) || /CustomExport-纪要-(?:包裹-[上下]|表头)$/.test(name);
}
function indexEntry(name: string): boolean {
  return name === 'TavernDB-ACU-CustomExport-纪要索引' || /CustomExport-.+-索引$/.test(name);
}
function summaryIndexEntry(name: string): boolean {
  return /^TavernDB-ACU-(?:OutlineTable|CustomExport-纪要索引)/.test(name);
}
export function managedEntry(name: string): boolean {
  return normalizedEntryName(name).startsWith('WorkflowHelper-');
}
type TableNames = { entry: string; table: string };
const defaultTableNames: TableNames = { entry: '主角信息', table: '主角信息表' };
/** Resolve the protagonist export names from a database table snapshot, as Workflow Assistant does. */
export function protagonistNames(tables: Record<string, unknown> | null | undefined): TableNames {
  for (const table of Object.values(tables ?? {})) {
    const value = table as { name?: unknown; exportConfig?: { entryName?: unknown } } | null;
    if (String(value?.name ?? '').trim() === defaultTableNames.table) {
      return {
        table: defaultTableNames.table,
        entry: String(value?.exportConfig?.entryName ?? '').trim() || defaultTableNames.entry,
      };
    }
  }
  return defaultTableNames;
}
function protagonistEntry(name: string, names: TableNames): boolean {
  const escaped = escapeRegExp(names.entry);
  return (
    new RegExp(`^TavernDB-ACU-CustomExport-${escaped}(?:-(?:表头|包裹-上|包裹-下|[1-9]\\d*))?$`).test(name) ||
    new RegExp(`^TavernDB-ACU-CustomExport-${escaped}-索引$`).test(name)
  );
}
const blockedWords = [
  '规则',
  '規則',
  '思维链',
  '思維鏈',
  'cot',
  'MVU',
  'mvu',
  '变量',
  '變量',
  '状态',
  '狀態',
  'Status',
  'Rule',
  'rule',
  '检定',
  '檢定',
  '判断',
  '判斷',
  '叙事',
  '敘事',
  '文风',
  '文風',
  'InitVar',
  '格式',
];

/** Empty when the entry belongs to $1; otherwise the reason it is routed elsewhere. */
export function entryExclusion(
  entry: Pick<SourceEntry, 'name'>,
  names: TableNames = defaultTableNames,
): string {
  const name = normalizedEntryName(entry.name);
  if (summaryIndexEntry(name)) {
    return '紀要索引專用（$5）';
  }
  if (memoryEntry(name)) {
    return '記憶回溯專用（$6）';
  }
  if (managedEntry(name)) {
    return '工作流托管條目（$2）';
  }
  if (protagonistEntry(name, names)) {
    return '主角資料專用（$U）';
  }
  if (!databaseEntry(name) && blockedWords.some((word) => entry.name.includes(word))) {
    return '規則／變量／格式條目';
  }
  return '';
}
/** Database exports other than memory/protagonist/managed rows (Workflow Assistant auto-includes these in $1). */
export function tableEntry(entry: Pick<SourceEntry, 'name'>, names: TableNames = defaultTableNames): boolean {
  const name = normalizedEntryName(entry.name);
  return databaseEntry(name) && !entryExclusion(entry, names);
}

export function selectedEntry(entry: SourceEntry, selected: Record<string, number[]>): boolean {
  const ids = selected[entry.book];
  return ids === undefined ? entry.enabled : ids.includes(entry.uid);
}

// ---------------------------------------------------------------------------
// Ordering and scanning (Workflow Assistant worldbook/entry-order.ts, scan.ts)

type Ordered = SourceEntry & { originalIndex?: number };
function orderKey(entry: Ordered): [number, number, number] {
  const type = String(entry.position?.type ?? '').toLowerCase();
  const order = Number.isFinite(entry.position?.order) ? entry.position!.order : Number.MAX_SAFE_INTEGER;
  if (['before_character_definition', 'before_char', 'before_character', '0'].includes(type)) {
    return [0, 0, order];
  }
  if (['after_character_definition', 'after_char', 'after_character', '1'].includes(type)) {
    return [1, 0, order];
  }
  return [2, -(Number(entry.position?.depth) || 0), order];
}
export function orderEntries<T extends SourceEntry>(entries: T[]): T[] {
  const indexed = entries.map((entry, index) => ({ entry, index }));
  return indexed
    .sort((a, b) => {
      const left = orderKey(a.entry);
      const right = orderKey(b.entry);
      return (
        left[0] - right[0] ||
        left[1] - right[1] ||
        left[2] - right[2] ||
        ((a.entry as Ordered).originalIndex ?? a.index) - ((b.entry as Ordered).originalIndex ?? b.index) ||
        a.entry.book.localeCompare(b.entry.book, 'zh-Hans-CN') ||
        a.entry.uid - b.entry.uid
      );
    })
    .map((row) => row.entry);
}

const maxRecursion = 10;
const delayUntil = (entry: SourceEntry) => {
  const value = entry.recursion?.delay_until;
  return typeof value === 'number' && value > 0 ? value : 0;
};
function keywords(entry: SourceEntry): string[] {
  return (entry.strategy?.keys ?? [])
    .map((key) => (typeof key === 'string' ? key : key.source).toLowerCase())
    .filter(Boolean);
}

/**
 * Constants activate once `delay_until` allows it. Depth 0 scans only the chat text; later
 * depths scan triggered entry content that does not prevent outgoing recursion. Entries that
 * prevent incoming recursion only match at depth 0.
 */
export function scanWorldbook<T extends SourceEntry>(entries: T[], scan: string): T[] {
  const constants = entries.filter((entry) => entry.strategy?.type === 'constant');
  let remaining = entries.filter((entry) => entry.strategy?.type === 'selective');
  const triggered = new Set<T>();
  const activate = (depth: number) => {
    for (const entry of [...constants]) {
      if (depth >= delayUntil(entry)) {
        triggered.add(entry);
        constants.splice(constants.indexOf(entry), 1);
      }
    }
  };
  const match = (haystack: string, depth: number) => {
    remaining = remaining.filter((entry) => {
      const eligible = depth >= delayUntil(entry) && !(depth > 0 && entry.recursion?.prevent_incoming);
      if (eligible && keywords(entry).some((key) => haystack.includes(key))) {
        triggered.add(entry);
        return false;
      }
      return true;
    });
  };
  activate(0);
  match(String(scan ?? '').toLowerCase(), 0);
  for (let depth = 1; depth <= maxRecursion && remaining.length + constants.length > 0; depth++) {
    const before = triggered.size;
    activate(depth);
    match(
      [...triggered]
        .filter((entry) => !entry.recursion?.prevent_outgoing)
        .map((entry) => entry.content || '')
        .join('\n')
        .toLowerCase(),
      depth,
    );
    const waiting = [...remaining, ...constants].some((entry) => delayUntil(entry) > depth);
    if (triggered.size === before && !waiting) {
      break;
    }
  }
  // Keep input order as the final tie-breaker, like Workflow Assistant's original index.
  return orderEntries(entries.filter((entry) => triggered.has(entry)));
}

// ---------------------------------------------------------------------------
// Entry text (Workflow Assistant worldbook/entry-placeholder-format.ts, blocked.ts)

/** Keep only the table of a default database export (`# title`, blank line, table). */
export function stripTableTitle(content: string): string {
  const text = String(content || '')
    .replace(/\r\n/g, '\n')
    .trim();
  const lines = text.split('\n');
  if (!text.startsWith('# ') || lines.length < 4 || lines[1]?.trim() !== '') {
    return text;
  }
  if (!lines[2]?.trim().startsWith('|') || !lines[3]?.trim().startsWith('|')) {
    return text;
  }
  const rows: string[] = [];
  for (const line of lines.slice(2)) {
    if (!line.trim().startsWith('|')) {
      break;
    }
    rows.push(line);
  }
  return rows.length >= 2 ? rows.join('\n').trim() : text;
}
function sectionPattern(title: string, global = false) {
  return new RegExp(
    `(?:^|\\n)# ${escapeRegExp(title.trim())}\\n\\n([\\s\\S]*?)(?=(\\n# )|$)`,
    global ? 'g' : '',
  );
}
export function removeMarkdownSection(content: string, title: string): string {
  const body = String(content || '').replace(/\r\n/g, '\n');
  if (!title.trim()) {
    return body.trim();
  }
  return body
    .replace(sectionPattern(title, true), (_match, _inner, next) => (next ? '\n' : ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
export function extractMarkdownSection(content: string, title: string): string {
  if (!title.trim()) {
    return '';
  }
  return (sectionPattern(title).exec(String(content || '').replace(/\r\n/g, '\n'))?.[1] ?? '').trim();
}
function entryText(entry: SourceEntry): string {
  const name = normalizedEntryName(entry.name);
  const raw = String(entry.content || '').replace(/\r\n/g, '\n');
  return databaseEntry(name) && !indexEntry(name) ? stripTableTitle(raw) : raw;
}

// ---------------------------------------------------------------------------
// User input (Workflow Assistant tasks/sanitize-context.ts)

function tagInstances(text: string, tag: string): { inner: string; index: number }[] {
  const escaped = escapeRegExp(tag);
  const pattern = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</${escaped}\\s*>`, 'gi');
  return [...text.matchAll(pattern)].map((match) => ({ inner: match[1], index: match.index ?? 0 }));
}
/** $8: last tag whose name contains 输入/input, otherwise text before the preset boilerplate line. */
export function cleanLatestUser(text: string): string {
  if (!text?.trim()) {
    return '';
  }
  let best = -1;
  let inner = '';
  const names = new Set<string>();
  for (const match of text.matchAll(/<([^>]+)>/g)) {
    const open = match[1].trim();
    if (!open || open.startsWith('/')) {
      continue;
    }
    const name = /\s[\w:-]+\s*=/.test(open) ? open.split(/\s+/)[0] : open;
    if (name.includes('输入') || name.includes('輸入') || /input/i.test(name)) {
      names.add(name);
    }
  }
  for (const name of names) {
    const last = tagInstances(text, name).at(-1);
    if (last?.inner.trim() && last.index > best) {
      best = last.index;
      inner = last.inner.trim();
    }
  }
  let body = inner;
  if (!body) {
    const boilerplate =
      /^\s*以上是(?:(?:用户|Participant)的本轮输入|<用户本轮输入>|<本轮用户输入>)\s*$/m.exec(text);
    body = (boilerplate ? text.slice(0, boilerplate.index) : text).trim();
  }
  return body
    .replace(/\(\s*⚠️\s*:[^)]*\)/g, '')
    .replace(/（\s*⚠️\s*[:：][^）]*）/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Summary index (Workflow Assistant bridge/summary-index.ts)

type Sheet = { name: string; content: unknown[][] };
function sheets(tables: Record<string, unknown> | null | undefined): Sheet[] {
  return Object.values(tables ?? {}).filter(
    (value): value is Sheet =>
      Boolean(value) &&
      typeof value === 'object' &&
      'name' in (value as object) &&
      'content' in (value as object),
  );
}
export function formatSummaryIndex(tables: Record<string, unknown> | null | undefined): string {
  const table = sheets(tables).find((sheet) => ['纪要表', '总结表'].includes(String(sheet.name).trim()));
  if (!table || !Array.isArray(table.content) || table.content.length <= 1) {
    return '';
  }
  const header = Array.isArray(table.content[0])
    ? table.content[0].map((cell) => String(cell ?? '').trim())
    : [];
  const summary = header.findIndex((cell) => cell === '概览' || cell === '概要');
  const code = header.indexOf('编码索引');
  if (summary < 0 || code < 0) {
    return '';
  }
  const rows = table.content
    .slice(1)
    .filter(Array.isArray)
    .map((row, index) => {
      const text = String(row[summary] ?? '').trim();
      const id = String(row[code] ?? '').trim();
      return text || id ? `- [${index}] 概要: ${text} | 编码索引: ${id}` : '';
    })
    .filter(Boolean);
  return `## 表格: 纪要索引\nColumns: 概要, 编码索引\n${rows.length ? rows.join('\n') : '(无数据行)'}\n`;
}
export function formatOutlineTable(tables: Record<string, unknown> | null | undefined): string {
  const table = sheets(tables).find((sheet) => String(sheet.name).trim() === '总体大纲');
  if (!table || !Array.isArray(table.content) || !table.content.length) {
    return '';
  }
  const headers = (Array.isArray(table.content[0]) ? table.content[0] : [])
    .slice(1)
    .map((cell) => String(cell ?? '').trim())
    .filter(Boolean);
  const rows = table.content
    .slice(1)
    .filter(Array.isArray)
    .map((row, index) => {
      const cells = row.slice(1);
      const parts = headers.flatMap((header, i) => {
        const value = String(cells[i] ?? '').trim();
        return value ? [`${header}: ${value}`] : [];
      });
      return parts.length ? `- [${index}] ${parts.join(' | ')}` : '';
    })
    .filter(Boolean);
  return `## 表格: 总体大纲\nColumns: ${headers.length ? headers.join(', ') : '(无表头)'}\n${rows.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Assembly

/** Placeholders used by enabled, non-data items of a prompt chain. */
export function segmentPlaceholders(items: PromptItem[], job: JobKind): Set<Placeholder> {
  const used = new Set<Placeholder>();
  for (const item of items) {
    if (item.enabled && item.kind !== 'data') {
      for (const match of promptText(item, job).matchAll(placeholderPattern)) {
        used.add(match[0] as Placeholder);
      }
    }
  }
  return used;
}
/** Single pass, so placeholder-like text inside inserted sources is never replaced again. */
export function replacePlaceholders(text: string, values: Partial<Record<Placeholder, string>>): string {
  return text.replace(placeholderPattern, (match) => values[match as Placeholder] ?? '');
}

export type SourceInput = {
  config: Config;
  job: JobKind;
  messages: SourceMessage[];
  currentId: number;
  /** Books selected for $1 in the effective (job) worldbook settings. */
  entries: SourceEntry[];
  /** Books from the default worldbook settings; $5 and $6 are global, like Workflow Assistant. */
  memoryEntries: SourceEntry[];
  /** Character-bound books for $2 and $U. */
  characterEntries?: SourceEntry[];
  variables: Record<string, unknown>;
  tables?: Record<string, unknown> | null;
  persona?: string;
  character?: string;
  renderEntry: (text: string, source?: TemplateSource) => Promise<string>;
};

export async function buildSourceContext(input: SourceInput) {
  const settings = input.config.sources;
  const job = input.config.jobs[input.job];
  const effective = effectiveSources(settings, input.job);
  const chain = job.prompts.filter((item) => item.enabled || item.kind === 'data');
  const used = segmentPlaceholders(chain, input.job);
  // Player-written text joins the worldbook scan (as Workflow Assistant scans prompt groups);
  // unmodified built-in rules do not, so their vocabulary cannot trigger entries.
  const scanPrompts = chain
    .filter((item) => item.kind === 'custom' || isModified(item))
    .filter((item) => item.kind !== 'data')
    .map((item) => promptText(item, input.job));
  const wanted = (placeholder: Placeholder, enabled: boolean) => enabled || used.has(placeholder);
  const names = protagonistNames(input.tables);
  const notes: string[] = [];
  const render = async (text: string, source: TemplateSource = 'world_info') =>
    text.trim() ? input.renderEntry(text, source) : '';
  const joinRendered = async (entries: SourceEntry[], transform = entryText) => {
    const parts: string[] = [];
    for (const entry of entries) {
      const content = (await render(transform(entry))).trim();
      if (content) {
        parts.push(content);
      }
    }
    return parts.join('\n\n');
  };

  // $7: recent AI replies, including the current reply and swipe.
  const available = input.messages.filter(
    (message) => message.role === 'assistant' && message.message_id <= input.currentId,
  );
  const recent = available.slice(-Math.max(1, effective.context.contextTurnCount));
  const historyReport: SourceReport['history'] = [];
  const history = recent.flatMap((message) => {
    // The news tag is display markup appended by this script, not story text.
    const raw = stripNewsTag(message.message ?? '');
    const filtered = extractContext(raw, effective.context);
    historyReport.push({
      id: message.message_id,
      before: raw.length,
      after: filtered.text.length,
      extractionMissed: filtered.missed,
    });
    return filtered.text ? [{ role: 'assistant', content: filtered.text }] : [];
  });

  // $8: only the user message directly before the current AI reply.
  const previous = input.messages.find((message) => message.message_id === input.currentId - 1);
  const user =
    wanted('$8', settings.includeLatestUser) && previous?.role === 'user'
      ? cleanLatestUser(previous.message ?? '')
      : '';

  const scan = [...history.map((message) => message.content), user, settings.extra, ...scanPrompts]
    .filter(Boolean)
    .join('\n');

  // $1: selected plot entries.
  const selection = effective.worldbook.enabledEntries;
  const entryReports: SourceReport['entries'] = [];
  const eligible: (SourceEntry & { originalIndex: number })[] = [];
  input.entries.forEach((entry, originalIndex) => {
    const excluded = entryExclusion(entry, names);
    const table = tableEntry(entry, names);
    const status = excluded
      ? excluded
      : table && settings.autoIncludeTables
        ? ''
        : selectedEntry(entry, selection)
          ? ''
          : '未勾選';
    entryReports.push({ book: entry.book, uid: entry.uid, name: entry.name, characters: 0, status });
    if (status) {
      return;
    }
    const content =
      normalizedEntryName(entry.name) === 'TavernDB-ACU-ReadableDataTable'
        ? removeMarkdownSection(removeMarkdownSection(entry.content, names.table), names.entry)
        : entry.content;
    if (content.trim()) {
      eligible.push({ ...entry, content, originalIndex });
    }
  });
  const triggered = scanWorldbook(eligible, scan);
  const worldParts: string[] = [];
  for (const entry of triggered) {
    const content = (await render(entryText(entry))).trim();
    const row = entryReports.find((item) => item.book === entry.book && item.uid === entry.uid)!;
    row.status = '已送入';
    row.characters = content.length;
    if (content) {
      worldParts.push(content);
    }
  }
  for (const row of entryReports) {
    row.status ||= '未觸發';
  }
  const worldbook = excludeContext(worldParts.join('\n\n'), effective.context.contextExcludeRules);

  // $2: WorkflowHelper-* entries from character books, enabled only.
  let managed = '';
  if (wanted('$2', settings.managedEntries)) {
    const pool = (input.characterEntries ?? []).filter((entry) => entry.enabled && managedEntry(entry.name));
    managed = excludeContext(
      await joinRendered(scanWorldbook(pool, scan)),
      effective.context.contextExcludeRules,
    );
  }

  // $5: chronicle index entry, else database snapshot.
  let summaryIndex = '';
  if (wanted('$5', settings.summaryIndex)) {
    const indexRow = input.memoryEntries.find((entry) =>
      String(entry.name || '')
        .trim()
        .endsWith('TavernDB-ACU-CustomExport-纪要索引'),
    );
    const raw = indexRow?.content || formatSummaryIndex(input.tables) || formatOutlineTable(input.tables);
    summaryIndex = (await render(raw, 'slash_command')).trim();
    if (!summaryIndex) {
      notes.push('$5 找不到紀要索引條目或資料庫表格，未送出。');
    }
  }

  // $6: newest N chronicle rows by AM code, in chronological order, with wrappers.
  const memory = await joinRendered(
    memoryRows(input.memoryEntries, settings.memoryRecallRecentCount),
    (entry) => String(entry.content || ''),
  );

  // $U: persona description plus protagonist export.
  let persona = '';
  if (wanted('$U', settings.persona)) {
    const books = input.characterEntries ?? [];
    const rows = orderEntries(
      books.filter((entry) => entry.enabled && protagonistEntry(normalizedEntryName(entry.name), names)),
    );
    let protagonist = await joinRendered(rows, (entry) => String(entry.content || ''));
    if (!protagonist) {
      for (const entry of books) {
        if (entry.enabled && normalizedEntryName(entry.name) === 'TavernDB-ACU-ReadableDataTable') {
          const content = await render(entry.content);
          protagonist =
            extractMarkdownSection(content, names.table) || extractMarkdownSection(content, names.entry);
          if (protagonist) {
            break;
          }
        }
      }
    }
    persona = (
      await render(
        [
          '<{{user}}初始设定>',
          input.persona ?? '',
          '</{{user}}初始设定>',
          '<{{user}}最新数据>',
          protagonist,
          '</{{user}}最新数据>',
        ].join('\n'),
        'slash_command',
      )
    ).trim();
  }

  // $C: current character description.
  const character = wanted('$C', settings.characterDescription)
    ? (await render(input.character ?? '', 'slash_command')).trim()
    : '';

  const values: Record<Placeholder, string> = {
    $1: worldbook ? `\n<worldbook_context>\n${worldbook}\n</worldbook_context>\n` : '',
    $2: managed ? `\n<worldbook_extra>\n${managed}\n</worldbook_extra>\n` : '',
    $5: summaryIndex,
    $6: memory,
    $7: history.map((message) => message.content).join('\n\n'),
    $8: user,
    $U: persona,
    $C: character,
  };
  const enabled: Record<Placeholder, boolean> = {
    $1: true,
    $2: settings.managedEntries,
    $5: settings.summaryIndex,
    $6: settings.memoryRecallRecentCount > 0,
    $7: true,
    $8: settings.includeLatestUser,
    $U: settings.persona,
    $C: settings.characterDescription,
  };
  const jsonValues: Record<Placeholder, unknown> = {
    $1: worldbook,
    $2: managed,
    $5: summaryIndex,
    $6: memory,
    $7: history,
    $8: user,
    $U: persona,
    $C: character,
  };
  const context: Record<string, unknown> = {};
  const blocks: SourceBlock[] = [];
  for (const key of Object.keys(placeholders) as Placeholder[]) {
    const placement = used.has(key) ? 'segment' : enabled[key] ? 'json' : 'off';
    const value = jsonValues[key];
    const empty = Array.isArray(value) ? false : !value;
    if (placement === 'json' && (!empty || key === '$1' || key === '$7' || key === '$6')) {
      context[contextKeys[key]] = value;
    }
    blocks.push({
      name: contextKeys[key],
      placeholder: key,
      placement,
      characters:
        placement === 'segment'
          ? values[key].length
          : placement === 'json'
            ? JSON.stringify(value).length
            : 0,
    });
  }
  context.variables = Object.fromEntries(
    settings.variables
      .filter((path) => path && path !== '国策' && !path.startsWith('国策.'))
      .map((path) => [path, valueAt(input.variables, path)]),
  );
  context.requirements = settings.extra;
  if (used.size) {
    context.segmentSources = [...used].map((key) => contextKeys[key]);
  }
  blocks.push(
    {
      name: 'variables',
      placeholder: '',
      placement: 'json',
      characters: JSON.stringify(context.variables).length,
    },
    {
      name: 'requirements',
      placeholder: '',
      placement: 'json',
      characters: JSON.stringify(settings.extra).length,
    },
  );

  // Prompt chain: placeholders first, then Tavern macros/EJS (Workflow Assistant order).
  // The data item is left raw: its {{data}} token is filled with the request JSON later.
  const prompts: RenderedPrompt[] = [];
  const segmentReports: SourceReport['segments'] = [];
  for (const item of chain) {
    const text = promptText(item, input.job);
    const content =
      item.kind === 'data' ? text : (await render(replacePlaceholders(text, values), 'slash_command')).trim();
    segmentReports.push({
      name: item.name || '未命名段',
      role: item.role,
      kind: item.kind,
      characters: content.length,
    });
    if (content) {
      prompts.push({ id: item.id, kind: item.kind, name: item.name, role: item.role, content });
    }
  }
  // Count player-written text only; unmodified built-in rules are part of the fixed request.
  const written = new Set(
    chain.filter((item) => item.kind === 'custom' || isModified(item)).map((item) => item.id),
  );
  const segmentCharacters = prompts
    .filter((prompt) => prompt.kind !== 'data' && written.has(prompt.id))
    .reduce((sum, prompt) => sum + prompt.content.length, 0);
  const report: SourceReport = {
    history: historyReport,
    entries: entryReports,
    blocks,
    segments: segmentReports,
    notes,
    characters: JSON.stringify(context).length + segmentCharacters,
    limit: settings.maxInputCharacters,
  };
  return { context, prompts, report };
}

function memoryRows(entries: SourceEntry[], count: number): SourceEntry[] {
  if (count <= 0) {
    return [];
  }
  const enabled = entries.filter((entry) => entry.enabled);
  const rows = enabled
    .flatMap((entry) => {
      const name = normalizedEntryName(entry.name);
      if (!memoryRow(name)) {
        return [];
      }
      const code = [...(entry.strategy?.keys ?? []).map(String), entry.name]
        .map((value) => /\bAM(\d{4})\b/i.exec(value)?.[1])
        .find(Boolean);
      return code ? [{ entry, code: Number(code) }] : [];
    })
    .sort((a, b) => b.code - a.code || a.entry.uid - b.entry.uid)
    .slice(0, count)
    .sort((a, b) => a.code - b.code || a.entry.uid - b.entry.uid);
  if (!rows.length) {
    return [];
  }
  const before = enabled.find((entry) => /CustomExport-纪要-包裹-上$/.test(normalizedEntryName(entry.name)));
  const after = enabled.find((entry) => /CustomExport-纪要-包裹-下$/.test(normalizedEntryName(entry.name)));
  return [...(before ? [before] : []), ...rows.map((row) => row.entry), ...(after ? [after] : [])];
}

export function messageCharacters(messages: PromptMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}
export function assertInputSize(messages: PromptMessage[], limit: number): void {
  const count = messageCharacters(messages);
  if (count > limit) {
    throw new InputSizeError(
      `輸入過大：${count.toLocaleString()} 字元，超過上限 ${limit.toLocaleString()}。未呼叫 API；請在「世界書與上下文」預覽並調整條目、提取／排除規則、提示詞段或上限。字元數不是 Token 數。`,
    );
  }
}
