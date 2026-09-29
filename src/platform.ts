import type { Config, JobKind, PromptItem, PromptRole, State, WorldbookSource } from './model';
import type { SourceReport } from './sources';
import type { Transition } from './periods';

export type PeriodWork = {
  transition: Transition;
  identity: string;
  historyHash?: string;
  storyFingerprint?: string;
  day: number;
  basis: string;
};

/** `name` is only for display and logs; API requests send role and content only. */
export type PromptMessage = { role: PromptRole; content: string; name?: string };
export type GenerateResult = { content: string; reasoning?: string };
/** A prompt-chain item after placeholders and macros; the data item still holds {{data}}. */
export type RenderedPrompt = {
  id: string;
  kind: PromptItem['kind'];
  name: string;
  role: PromptRole;
  content: string;
};

export type Snapshot = {
  identity: string;
  fingerprint: string;
  historyHash?: string;
  storyFingerprint?: string;
  turn: number;
  day: number;
  state: State;
  context: unknown;
  /** Rendered prompt chain for the job that was read. */
  prompts?: RenderedPrompt[];
  sourceReport?: SourceReport;
};
export type SourceEntry = {
  book: string;
  uid: number;
  name: string;
  enabled: boolean;
  content: string;
  strategy?: { type: string; keys: (string | RegExp)[] };
  recursion?: { prevent_outgoing?: boolean; prevent_incoming?: boolean; delay_until?: number | null };
  position?: { type: string; depth: number; order: number };
};
export type JobStatus = {
  id: string;
  kind: string;
  state: 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'stale';
  message: string;
  time: string;
  inputCharacters?: number;
  /** Extra label such as the country being generated. */
  label?: string;
  /** The candidate a generation job was for, so a failed job can be retried. */
  candidate?: { id: string; name: string; description: string; evidence: string };
  periodWork?: PeriodWork;
  /** Epoch milliseconds when the job started running. */
  started?: number;
  /** Epoch milliseconds when the job finished. */
  finished?: number;
  /** API preset that produced the accepted response. */
  route?: string;
};
/** In-memory debug record, only kept when the player enables the run log. */
export type RunLogEntry = {
  jobId: string;
  kind: string;
  /** What this request was for, e.g. 「修正骨架（第 1/3 輪，5 個問題）」. */
  stage?: string;
  time: string;
  route: string;
  attempt: number;
  durationMs: number;
  messages: PromptMessage[];
  output: string;
  reasoning: string;
  error: string;
};
/** Platform boundary shared by the installed script and the offline preview. */
export interface Platform {
  readonly demo: boolean;
  chatId(): string;
  models(api: Config['apis'][number]): Promise<string[]>;
  read(config: Config, job?: JobKind): Promise<Snapshot>;
  commit(snapshot: Snapshot, state: State): Promise<void>;
  generate(
    messages: PromptMessage[],
    api: Config['apis'][number],
    secret: string,
    signal: AbortSignal,
  ): Promise<GenerateResult>;
  sources(selection?: WorldbookSource): Promise<SourceEntry[]>;
  worldbooks(): Promise<{ character: string[]; all: string[] }>;
  loadConfig(): Config;
  saveConfig(config: Config): void;
  /** 'tavern' when credentials live in Tavern settings, 'local' for browser storage, 'memory' offline. */
  secretLocation?(): string;
  onReady(callback: () => void): () => void;
  onChange(callback: () => void): () => void;
  /** Public state for the story model; `news` adds the recent-news digest. */
  inject(state: State, news?: boolean): void;
  /** News a player may see on one AI floor (the state saved on that floor, fog applied). */
  readNews?(messageId: number): Promise<{ state: State; events: State['events'][string][] } | null>;
  /** The news card in a chat floor asks the script to open its news window. */
  /** The news card asks for the news window (`news`), the national focus panel or the event log. */
  onNewsRequest?(callback: (messageId: number, action: NewsAction) => void): () => void;
}

export type NewsAction = 'news' | 'panel' | 'events';
export function valueAt(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object' && Object.hasOwn(current, key)) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, value);
}
export function storyDay(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }
  // Accept explicit calendar dates only, never wall-clock time or dialogue count.
  if (typeof raw === 'string') {
    const text = raw.trim();
    const match =
      text.match(
        /^(?:复兴纪元|復興紀元)(\d{1,6})年-(\d{1,2})月-(\d{1,2})日-星期[一二三四五六日天]-(\d{1,2}):(\d{2})$/,
      ) ?? text.match(/^(\d{1,6})[-年/](\d{1,2})[-月/](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2}))?$/);
    if (match) {
      const [, y, m, d, h = '0', minute = '0'] = match;
      const date = new Date(0);
      date.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
      date.setUTCHours(Number(h), Number(minute), 0, 0);
      if (
        date.getUTCFullYear() === Number(y) &&
        date.getUTCMonth() === Number(m) - 1 &&
        date.getUTCDate() === Number(d) &&
        Number(h) < 24 &&
        Number(minute) < 60
      ) {
        return date.getTime() / 86400000 + 719528;
      }
    }
  }
  throw new Error(
    '無法辨識故事時間。支援「复兴纪元490年-10月-15日-星期三-14:25」、YYYY-MM-DD HH:mm、YYYY年M月D日或非負數值日序；請確認設定的來源路徑與日期有效，不會以現實時間代算。',
  );
}
export function stamp(value: unknown): string {
  return JSON.stringify(value);
}

export function requestId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
