import { customRequest, extractApiResult, hasAdvancedApi, readStream, redactApiError } from './api-config';
import {
  extractSecrets,
  hasSecrets,
  mergeSecrets,
  stripSecrets,
  TavernSecretStore,
  type SecretStore,
} from './secrets';
import { createState, floorNews, migrateCountryKeys, NEWS_EVENT, NEWS_TAG, stampNews } from './engine';
import {
  ConfigSchema,
  defaultConfig,
  StateSchema,
  type Config,
  type State,
  type JobKind,
  type WorldbookSource,
} from './model';
import { buildNewsBar, insiders, timeText, type NewsBar } from './newsbar';
import { unavailable, type IntegrationApi, type IntegrationRead } from './integration';
import type { ProposalRepairMaterial } from './proposal-repair';
import { predictWorldSchedule, type ScheduleSource, type WorldSchedulePrediction } from './world-schedule';
import {
  FOCUS_WORLD,
  RunStatusSchema,
  worldFingerprint,
  worldMember,
  type WorldObservation,
} from './world-proposal';
import { bookEntries, promptText, promptView, reconcileBook, type WorldbookEntryLike } from './prompt-view';
import {
  buildSourceContext,
  effectiveSources,
  segmentPlaceholders,
  type Placeholder,
  type TemplateSource,
} from './sources';
import {
  type GenerateResult,
  type PromptMessage,
  requestId,
  stamp,
  storyDay,
  valueAt,
  type NewsAction,
  type Platform,
  type Snapshot,
  type SourceEntry,
} from './platform';

type MvuData = {
  stat_data: Record<string, unknown>;
  国策?: unknown;
  [key: string]: unknown;
};
type Message = { message_id: number; swipe_id: number; swipes: string[]; role: string; message?: string };
type ChatCompletionService = {
  processRequest(
    data: Record<string, unknown>,
    options: Record<string, unknown>,
    extract: boolean,
    signal: AbortSignal,
  ): Promise<unknown>;
};
export type TavernContext = {
  chatId?: string;
  ChatCompletionService?: ChatCompletionService;
  extensionSettings?: Record<string, unknown>;
  saveSettingsDebounced?: () => unknown;
  powerUserSettings?: { persona_description?: string };
};
export type TavernApi = {
  Mvu?: {
    getMvuData(options: { type: 'message'; message_id: number }): MvuData;
    replaceMvuData(data: MvuData, options: { type: 'message'; message_id: number }): Promise<void>;
    isDuringExtraAnalysis(): boolean;
    events: Record<string, string>;
  };
  SillyTavern: TavernContext & {
    getCurrentChatId(): string;
    getContext?(): TavernContext;
  };
  getModelList?(api: { apiurl: string; key?: string }): Promise<string[]>;
  getLastMessageId(): number;
  getChatMessages(range: string | number, options?: { include_swipes?: boolean }): Message[];
  generateRaw(config: Record<string, unknown>): Promise<string>;
  stopGenerationById(id: string): boolean;
  eventOn(event: string, listener: (...args: any[]) => void): { stop(): void };
  eventEmit?(event: string, ...args: unknown[]): Promise<void> | void;
  tavern_events: Record<string, string>;
  getGlobalWorldbookNames(): string[];
  getWorldbookNames?(): string[];
  getCharWorldbookNames(name: string): { primary: string | null; additional: string[] };
  getWorldbook(name: string): Promise<Omit<SourceEntry, 'book'>[]>;
  getCharData?(name: 'current'): { description?: string } | null;
  getCharacter?(name: 'current'): Promise<{ description?: string }>;
  getPersona?(id: 'current'): { description?: string } | null;
  /** Database plugin (shujuku) snapshot for $5 and protagonist names. */
  parent?: {
    SillyTavern?: { getContext?(): { chatId?: string } };
    AutoCardUpdaterAPI?: { exportTableAsJson?(): unknown };
    NationalFocusIntegration?: IntegrationApi;
    AcuPostProcessAPI?: {
      getEffectiveSettings(): unknown;
      getRunStatusForFloor(messageId: number): unknown;
    };
    Addon?: { getLastPatchLog(): unknown };
  };
  indexedDB?: IDBFactory;
  substitudeMacros?(text: string): string;
  formatAsTavernRegexedString?(
    text: string,
    source: string,
    mode: string,
    options: { depth: number },
  ): string;
  EjsTemplate?: {
    prepareContext?(data: object, messageId: number): Promise<object>;
    evalTemplate?(text: string, context: object): Promise<string>;
    evaltemplate?(text: string, context: object): Promise<string>;
  };
  injectPrompts(prompts: Record<string, unknown>[]): { uninject(): void };
  getChatWorldbookName?(chat: 'current'): string | null;
  toastr?: { warning(message: string, title?: string): void };
  updateWorldbookWith?(
    name: string,
    updater: (entries: WorldbookEntryLike[]) => WorldbookEntryLike[],
  ): Promise<unknown>;
  setChatMessages?(
    messages: { message_id: number; message?: string }[],
    options?: { refresh?: 'none' | 'affected' | 'all' },
  ): Promise<void>;
  uninjectPrompts(ids: string[]): void;
  waitGlobalInitialized?(name: string): Promise<void>;
};
/** Skeleton edition settings; the first load copies the v0.11 settings (legacyStorageKey). */
const storageKey = 'national-focus-skeleton.config.v1';
const legacyStorageKey = 'national-focus.config.v1';
const injectionId = 'national-focus-public-state';

/** Providers and proxies sometimes return an error without a reason; say what usually causes it. */
export function explainOpaqueError(detail: string): string {
  // Proxies behind Cloudflare return an HTML error page; keep the code, drop the page.
  if (/<!DOCTYPE html|<html[\s>]/i.test(detail)) {
    const code = /Error code (\d{3})/i.exec(detail)?.[1] ?? /\b(52[0-9])\b/.exec(detail)?.[1];
    const title = /<title>([^<]*)<\/title>/i.exec(detail)?.[1]?.trim();
    return code === '524'
      ? `反向代理超时（Cloudflare 524：约 100 秒内没有开始回应）。请在 API 预设开启「流式传输」（代理若有假流式也可开启），或调低推理强度、每批填写国策数，或改用没有此限制的连接${title ? `。代理页面：${title}` : ''}`
      : `反向代理返回错误页（${code ? `错误码 ${code}` : '无错误码'}${title ? `：${title}` : ''}）。这通常是代理或上游服务的问题，请稍后重试或改用其他连接`;
  }
  const bare = detail.replace(/^(Error:\s*)+/i, '').trim();
  if (!bare || /^(<none>|none|null|undefined|true|Response not OK|Unknown error)$/i.test(bare)) {
    return `${detail}（API 或反向代理没有提供原因。常见原因：回应被供应商的安全过滤挡下、思考用完输出上限而没有正文、代理超时或上游断线。请开启执行记录查看请求，或改用其他连接／降低输出上限后重试）`;
  }
  return detail;
}

export class TavernPlatform implements Platform {
  readonly demo = false;
  chatId(): string {
    return this.api.SillyTavern.getCurrentChatId();
  }
  async models(api: Config['apis'][number]): Promise<string[]> {
    if (!api.url.trim()) {
      throw new Error('请先填写端点（基础 URL），也可以直接手动输入模型名称');
    }
    if (!this.api.getModelList) {
      throw new Error('目前酒馆助手未提供模型加载功能，请更新助手或手动输入模型名称');
    }
    try {
      const models = await this.api.getModelList({ apiurl: api.url.trim(), key: api.apiKey || undefined });
      return [
        ...new Set(
          models.filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim()),
        ),
      ].sort();
    } catch (error) {
      throw new Error(redactApiError(error, [api]));
    }
  }
  private writing = false;
  /** Settings of the last read, for the prompt view saved with each floor. */
  private config: Config | null = null;
  /** Whether the floor being shown already carries `国策.prompt` (saved by v0.12.6 or later). */
  private promptSaved = false;
  /** Worldbook writes run one at a time; a floor switch during a write queues the next one. */
  private bookQueue: Promise<void> = Promise.resolve();
  /** Each inject gets a token; a queued worldbook job only runs while it is still the newest. */
  private bookToken = 0;
  /** Bumped when the chat, swipe or floors change, so older worldbook jobs never write. */
  private bookEpoch = 0;
  /** One warning per failure streak; a later success resets it. */
  private bookWarned = false;
  private writtenBook: { chat: string; name: string } | null = null;
  private disposed = false;
  private annotating: Promise<void> | null = null;
  private newsQueue: Promise<void> = Promise.resolve();
  private generating = false;
  private mvuBusy = false;
  private readyIdentity = '';
  private sourceRun = new AbortController();
  private stops: (() => void)[] = [];
  private readyListeners = new Set<() => void>();
  private changeListeners = new Set<() => void>();
  private integrationListeners = new Set<() => void>();
  private pending: {
    identity: string;
    received: boolean;
    ended: boolean;
    mvu: boolean;
    since: number;
  } | null = null;
  private timer: ReturnType<typeof setInterval>;

  private readonly secrets: SecretStore;
  constructor(
    private readonly api: TavernApi,
    private readonly storage: Storage,
    secrets?: SecretStore,
  ) {
    this.secrets = secrets ?? new TavernSecretStore(() => this.context(), api.indexedDB);
    const listen = (event: string | undefined, callback: (...args: any[]) => void) => {
      if (event) {
        const listener = api.eventOn(event, callback);
        this.stops.push(() => listener.stop());
      }
    };
    listen('national-focus:refresh-news', (messageId: unknown) => {
      if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId < 0) {
        return;
      }
      const signal = this.sourceRun.signal;
      this.newsQueue = this.newsQueue
        .then(async () => {
          await this.annotating;
          if (this.disposed || signal.aborted) {
            return;
          }
          await this.annotate(messageId);
        })
        .catch((error) => console.warn('[国策档案] 无法更新本楼快讯资料：', error));
    });
    for (const name of ['CHAT_CHANGED', 'MESSAGE_SWIPED', 'MESSAGE_DELETED']) {
      listen(api.tavern_events[name], () => {
        this.pending = null;
        this.readyIdentity = '';
        this.generating = false;
        this.mvuBusy = false;
        api.uninjectPrompts([injectionId]);
        this.sourceRun.abort();
        this.sourceRun = new AbortController();
        this.bookEpoch++;
        for (const callback of this.changeListeners) {
          callback();
        }
      });
    }
    listen(api.tavern_events.GENERATION_STARTED, (type: string, _options: unknown, dryRun: boolean) => {
      if (dryRun || type === 'quiet') {
        return;
      }
      this.generating = true;
      this.readyIdentity = '';
      this.sourceRun.abort();
      this.sourceRun = new AbortController();
    });
    listen(api.tavern_events.GENERATION_STOPPED, () => {
      this.generating = false;
      this.pending = null;
    });
    listen(api.tavern_events.MESSAGE_RECEIVED, (_id: number, type: string) => {
      if (['quiet', 'impersonate', 'extension'].includes(type)) {
        return;
      }
      const item = this.pendingForCurrent();
      if (item) {
        item.received = true;
      }
    });
    listen(api.tavern_events.GENERATION_ENDED, () => {
      if (!this.generating && !this.pending?.received) {
        return;
      }
      this.generating = false;
      const item = this.pendingForCurrent();
      if (item) {
        item.ended = true;
      }
    });
    // Mvu may initialize after this script; attach its listeners once when available.
    let boundMvu = false;
    const bindMvu = () => {
      if (boundMvu || !api.Mvu) {
        return;
      }
      boundMvu = true;
      listen(api.Mvu.events.VARIABLE_UPDATE_STARTED, () => {
        this.mvuBusy = true;
      });
      listen(api.Mvu.events.VARIABLE_UPDATE_ENDED, (after: MvuData, before: MvuData) => {
        this.mvuBusy = false;
        // General variable generation does not own this namespace.
        const saved = before?.国策 !== undefined ? before.国策 : before?.stat_data?.国策;
        if (saved !== undefined) {
          after.国策 = structuredClone(saved);
          delete after.stat_data.国策;
        }
      });
      listen(api.Mvu.events.BEFORE_MESSAGE_UPDATE, (context: { message_content?: string }) => {
        if (this.writing) {
          return;
        }
        // MVU reads message.mes; include_swipes only returns the separately updated swipe cache.
        const message = this.api.getChatMessages(-1)[0];
        if (
          message &&
          (this.generating || this.pending?.received || this.pending?.ended) &&
          context?.message_content === (message.message ?? message.swipes[message.swipe_id])
        ) {
          const item = this.pendingForCurrent();
          if (item) {
            item.mvu = true;
          }
        }
        this.mvuBusy = false;
      });
    };
    bindMvu();
    for (const event of ['MESSAGE_EDITED', 'MESSAGE_UPDATED']) {
      listen(api.tavern_events[event], () => {
        for (const callback of this.integrationListeners) {
          callback();
        }
      });
    }
    this.timer = setInterval(() => {
      bindMvu();
      for (const callback of this.integrationListeners) {
        callback();
      }
      const pending = this.pending;
      if (!pending || this.writing || this.generating || this.mvuBusy || api.Mvu?.isDuringExtraAnalysis()) {
        return;
      }
      if (pending.identity !== this.identity()) {
        this.pending = null;
        return;
      }
      if (pending.received && pending.ended && pending.mvu && !this.annotating) {
        const signal = this.sourceRun.signal;
        this.pending = null;
        this.readyIdentity = pending.identity;
        // Publish the newspaper before background tasks collect their input.
        this.annotating = this.annotate()
          .catch((error) => console.warn('[国策档案] 无法更新快讯条资料：', error))
          .finally(() => {
            this.annotating = null;
            if (this.disposed || signal.aborted) {
              return;
            }
            for (const callback of this.readyListeners) {
              callback();
            }
          });
      }
      // Never guess that MVU completed after a fixed delay.
    }, 200);
  }
  private context(): TavernContext | undefined {
    try {
      return this.api.SillyTavern.getContext?.() ?? this.api.SillyTavern;
    } catch {
      return this.api.SillyTavern;
    }
  }
  /** Tavern Helper's "disable macros" switch, as Workflow Assistant reads it. */
  private macrosEnabled(): boolean {
    const root = this.context()?.extensionSettings as
      | {
          tavern_helper?: { macro?: { enabled?: unknown } };
          TavernHelper?: { macro?: { enabled?: unknown } };
        }
      | undefined;
    const value = root?.tavern_helper?.macro?.enabled ?? root?.TavernHelper?.macro?.enabled;
    return typeof value === 'boolean' ? value : true;
  }
  /** Macros and Tavern regex → EJS when present → macros again (Workflow Assistant template-process). */
  private renderer(messageId: number) {
    const memo = new Map<string, Promise<string>>();
    const depth = Math.max(0, this.api.getLastMessageId() - messageId);
    const macros = (text: string, source: TemplateSource) => {
      const substitute = () => {
        try {
          return this.api.substitudeMacros?.(text) ?? text;
        } catch {
          return text;
        }
      };
      if (!this.macrosEnabled() || !this.api.formatAsTavernRegexedString) {
        return substitute();
      }
      try {
        return this.api.formatAsTavernRegexedString(text, source, 'prompt', { depth });
      } catch {
        return substitute();
      }
    };
    const run = async (text: string, source: TemplateSource) => {
      let output = macros(text, source);
      const template = this.api.EjsTemplate;
      const evaluate = template?.evaltemplate ?? template?.evalTemplate;
      if (evaluate && (text.includes('<%') || output.includes('<%'))) {
        try {
          const context = (await template?.prepareContext?.({}, messageId)) ?? {};
          output = await evaluate.call(template, output, context);
        } catch (error) {
          console.warn('[国策档案] EJS 模板处理失败，保留原文：', error);
        }
      }
      return macros(output, source);
    };
    return (text: string, source: TemplateSource = 'world_info') => {
      if (!text?.trim()) {
        return Promise.resolve(text ?? '');
      }
      const key = `${source}\0${text}`;
      let pending = memo.get(key);
      if (!pending) {
        pending = run(text, source);
        memo.set(key, pending);
      }
      return pending;
    };
  }
  private tables(): Record<string, unknown> | null {
    try {
      const value = this.api.parent?.AutoCardUpdaterAPI?.exportTableAsJson?.();
      return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  private persona(): string {
    try {
      return (
        this.context()?.powerUserSettings?.persona_description ||
        this.api.getPersona?.('current')?.description ||
        ''
      );
    } catch {
      return '';
    }
  }
  private async characterDescription(): Promise<string> {
    try {
      return (
        (await this.api.getCharacter?.('current'))?.description ??
        this.api.getCharData?.('current')?.description ??
        ''
      );
    } catch {
      try {
        return this.api.getCharData?.('current')?.description ?? '';
      } catch {
        return '';
      }
    }
  }
  private current(): Message | undefined {
    return this.api.getChatMessages(-1, { include_swipes: true })[0];
  }
  private identity(): string {
    const message = this.current();
    return stamp([this.api.SillyTavern.getCurrentChatId(), this.api.getLastMessageId(), message?.swipe_id]);
  }
  private pendingForCurrent() {
    const message = this.current();
    if (!message || message.role !== 'assistant') {
      return null;
    }
    const identity = this.identity();
    if (this.readyIdentity === identity) {
      return null;
    }
    if (this.pending?.identity !== identity) {
      this.pending = { identity, received: false, ended: false, mvu: false, since: Date.now() };
    }
    return this.pending;
  }
  bindIntegration(api: IntegrationApi): () => void {
    const parent = this.api.parent;
    if (!parent) {
      return () => {};
    }
    parent.NationalFocusIntegration = api;
    const remove = () => {
      if (parent.NationalFocusIntegration === api) {
        delete parent.NationalFocusIntegration;
      }
    };
    this.stops.push(remove);
    return remove;
  }
  readIntegration(messageId: number, config: Config): IntegrationRead {
    if (this.disposed) {
      return unavailable('disposed');
    }
    try {
      const lastMessageId = this.api.getLastMessageId();
      if (!Number.isInteger(messageId) || messageId < 0 || messageId !== lastMessageId) {
        return unavailable('not_latest');
      }
      const message = this.api.getChatMessages(messageId, { include_swipes: true })[0];
      if (!message || message.role !== 'assistant') {
        return unavailable('not_assistant');
      }
      if (message.message_id !== messageId || !this.chatId()) {
        return unavailable('source_changed');
      }
      const mvu = this.api.Mvu;
      if (!mvu) {
        return unavailable('mvu_unavailable');
      }
      if (this.generating || this.mvuBusy || this.writing || mvu.isDuringExtraAnalysis()) {
        return unavailable('mvu_busy');
      }
      const data = mvu.getMvuData({ type: 'message', message_id: messageId });
      const world = this.readWorldProposal(messageId);
      return {
        chatId: this.chatId(),
        messageId,
        swipeId: message.swipe_id,
        lastMessageId,
        role: message.role,
        extraAnalysis: false,
        data,
        world: world?.member ? { ...world.member, fingerprint: world.fingerprint } : undefined,
        timePath: config.sources.timePath,
        signal: this.sourceRun.signal,
      };
    } catch {
      return unavailable('read_failed');
    }
  }
  onIntegrationTick(callback: () => void): () => void {
    this.integrationListeners.add(callback);
    return () => this.integrationListeners.delete(callback);
  }
  readWorldProposal(messageId: number): WorldObservation | null {
    const workflow = this.api.parent?.AcuPostProcessAPI;
    if (!workflow) {
      return null;
    }
    try {
      const member = worldMember(workflow.getEffectiveSettings());
      const status = RunStatusSchema.safeParse(workflow.getRunStatusForFloor(messageId));
      const data = this.api.Mvu?.getMvuData({ type: 'message', message_id: messageId });
      let patchLog: unknown = null;
      try {
        patchLog = this.api.parent?.Addon?.getLastPatchLog() ?? null;
      } catch {
        // Missing review evidence does not establish either success or failure.
      }
      return {
        member,
        run: status.success ? status.data : null,
        fingerprint: worldFingerprint(valueAt(data?.addon_data, `世界.${FOCUS_WORLD}`)),
        patchLog,
        world: structuredClone(valueAt(data?.addon_data, `世界.${FOCUS_WORLD}`)),
      };
    } catch {
      return null;
    }
  }
  loadProposalRepair(): unknown {
    const saved = this.storage.getItem(`national-focus-skeleton.repair.v1.${this.chatId()}`);
    return saved ? JSON.parse(saved) : null;
  }
  saveProposalRepair(material: ProposalRepairMaterial | null, chatId: string): void {
    const key = `national-focus-skeleton.repair.v1.${chatId}`;
    if (material) {
      this.storage.setItem(key, JSON.stringify(material));
    } else {
      this.storage.removeItem(key);
    }
  }
  readScheduleSource(): ScheduleSource | null {
    try {
      const message = this.current();
      if (!message || message.role !== 'assistant' || message.message_id !== this.api.getLastMessageId()) {
        return null;
      }
      return {
        chatId: this.chatId(),
        messageId: message.message_id,
        swipeId: message.swipe_id,
        content: message.swipes[message.swipe_id] ?? message.message ?? '',
      };
    } catch {
      return null;
    }
  }
  predictWorldSchedule(source: ScheduleSource): WorldSchedulePrediction {
    try {
      const workflow = this.api.parent?.AcuPostProcessAPI;
      if (workflow) {
        // Match the third party's chat-key.ts, including its unknown-chat fallback.
        const chatKey =
          String(this.api.parent?.SillyTavern?.getContext?.()?.chatId || '').trim() || 'unknown_chat';
        return predictWorldSchedule(workflow.getEffectiveSettings(), chatKey, source.content);
      }
    } catch {
      // Prediction is optional; uncertainty never grants permission to accept a proposal.
    }
    return { status: 'unknown', reason: 'unavailable' };
  }
  async read(config: Config, job?: JobKind): Promise<Snapshot> {
    const signal = this.sourceRun.signal;
    // Wait for the newspaper data of a just finished floor, so the snapshot includes it.
    await this.annotating;
    signal.throwIfAborted();
    const mvu = this.api.Mvu;
    if (!mvu) {
      throw new Error('尚未检测到 MVU，请先启用 MVU 变数框架');
    }
    if (this.generating || this.mvuBusy || mvu.isDuringExtraAnalysis()) {
      throw new Error('正文或一般 MVU 更新尚未完成，请稍后重试');
    }
    if (this.pending && !this.readyIdentity) {
      throw new Error('等待本楼正文完成及 MVU 写入事件；若已等待过久，请检查 MVU 工作状态后重新加载脚本');
    }
    const message = this.current();
    if (!message || message.role !== 'assistant') {
      throw new Error('请在一则已完成且具有 MVU 变数的 AI 回复后使用');
    }
    const identity = this.identity();
    const data = mvu.getMvuData({ type: 'message', message_id: message.message_id });
    if (!data.stat_data) {
      throw new Error('本楼尚无 MVU stat_data，不能建立另一份聊天存档替代');
    }
    const rawTime = valueAt(data.stat_data, config.sources.timePath);
    let day: number;
    try {
      day = storyDay(rawTime);
    } catch (error) {
      // Name the path and what was there: the usual cause is a card with another time variable.
      const found =
        rawTime === undefined ? '没有这个变量' : `读到「${String(JSON.stringify(rawTime)).slice(0, 60)}」`;
      throw new Error(
        `读不到故事时间（stat_data.${config.sources.timePath}：${found}）。国策进度以故事日计算，所有国策任务暂停；请到「设置 › 世界书与上下文 › 故事时间路径」修正。${error instanceof Error ? error.message : ''}`,
      );
    }
    const saved = data.国策 !== undefined ? data.国策 : data.stat_data.国策;
    this.config = config;
    this.promptSaved = Boolean((data.国策 as { prompt?: unknown } | undefined)?.prompt);
    // Older saves keyed countries by English ID; read them under their worldbook names.
    const state = saved === undefined ? createState(day) : migrateCountryKeys(StateSchema.parse(saved));
    state.time = timeText(rawTime);
    // Reuse this chat read for context and turn counting; do not hash story text.
    const messages = this.api.getChatMessages(`0-${message.message_id}`);
    let sourceData: Awaited<ReturnType<typeof buildSourceContext>> | undefined;
    if (job) {
      const settings = config.sources;
      const cache = new Map<string, Promise<SourceEntry[]>>();
      const selection = effectiveSources(settings, job).worldbook;
      const used = segmentPlaceholders(config.jobs[job].prompts, job);
      const uses = (placeholder: string) => used.has(placeholder as Placeholder);
      const needCharacter = settings.managedEntries || settings.persona || uses('$2') || uses('$U');
      const needCharacterText = settings.characterDescription || uses('$C');
      // $5 and $6 always read the default books, like Workflow Assistant's global settings.
      const needDefault =
        settings.memoryRecallRecentCount > 0 || settings.summaryIndex || uses('$5') || uses('$6');
      const [books, memoryBooks, characterBooks, character] = await Promise.all([
        this.sources(selection, cache),
        needDefault ? this.sources(settings.worldbook, cache) : [],
        needCharacter
          ? this.sources({ source: 'character', manualSelection: [], enabledEntries: {} }, cache)
          : [],
        needCharacterText ? this.characterDescription() : '',
      ]);
      sourceData = await buildSourceContext({
        config,
        job,
        messages,
        currentId: message.message_id,
        entries: books,
        memoryEntries: memoryBooks,
        characterEntries: characterBooks,
        variables: data.stat_data,
        world:
          job === 'update' && this.api.parent?.AcuPostProcessAPI
            ? valueAt(data.addon_data, `世界.${FOCUS_WORLD}`)
            : undefined,
        tables: this.tables(),
        persona: settings.persona || uses('$U') ? this.persona() : '',
        character,
        renderEntry: this.renderer(message.message_id),
      });
    }
    signal.throwIfAborted();
    return {
      identity,
      messageId: message.message_id,
      signal,
      turn: messages.filter((m) => m.role === 'assistant').length,
      day,
      state,
      context: sourceData?.context ?? {},
      prompts: sourceData?.prompts,
      sourceReport: sourceData?.report,
    };
  }
  async commit(snapshot: Snapshot, state: State): Promise<void> {
    if (this.disposed) {
      throw new Error('脚本已卸载');
    }
    snapshot.signal?.throwIfAborted();
    const mvu = this.api.Mvu;
    if (!mvu) {
      throw new Error('尚未检测到 MVU');
    }
    const message = this.api.getChatMessages(snapshot.messageId)[0];
    if (!message || message.role !== 'assistant') {
      throw new Error('目标 AI 楼层不存在');
    }
    const latest = mvu.getMvuData({ type: 'message', message_id: snapshot.messageId });
    const saved = StateSchema.parse(state);
    stampNews(saved, message.message_id);
    // Preserve the current source text separately from the processed day.
    const rawTime = this.config ? timeText(valueAt(latest.stat_data, this.config.sources.timePath)) : '';
    saved.time = rawTime || saved.time;
    // The newspaper data of this floor stays; who the player may hear from follows the new state.
    const bar = (latest.国策 as { 快讯?: NewsBar } | undefined)?.快讯;
    // The story view travels with the floor; chat worldbook entries render it.
    latest.国策 = {
      ...saved,
      prompt: promptView(saved, this.config?.newsPrompt ?? true),
      ...(bar ? { 快讯: { ...bar, insiders: insiders(saved, bar.location) } } : {}),
    };
    // Migrate only this floor on a successful write; never rewrite ancestor saves.
    delete latest.stat_data.国策;
    // Read and mutate the latest full envelope; preserve schema and every other namespace.
    this.writing = true;
    try {
      await mvu.replaceMvuData(latest, { type: 'message', message_id: message.message_id });
    } finally {
      this.writing = false;
    }
    snapshot.signal?.throwIfAborted();
    await this.appendNewsTag(message.message_id);
    await this.api.eventEmit?.('national-focus:news-saved', message.message_id);
  }
  /**
   * Save the newspaper data of the finished AI floor (`国策.快讯`) and add the news tag, so every
   * AI floor of a chat with national data shows its news bar. Floors without national data are
   * left alone. Only this script's `国策` is written; the card's own news is read, never changed.
   */
  private async annotate(messageId?: number): Promise<void> {
    const signal = this.sourceRun.signal;
    const mvu = this.api.Mvu;
    const message = messageId === undefined ? this.current() : this.api.getChatMessages(messageId)[0];
    const config = this.config ?? this.loadConfig();
    if (!mvu || !message || message.role !== 'assistant') {
      return;
    }
    const id = message.message_id;
    const data = mvu.getMvuData({ type: 'message', message_id: id });
    const parsed = StateSchema.safeParse(data?.国策);
    if (!data?.stat_data || !parsed.success) {
      return;
    }
    // Find the nearest earlier AI floor without cloning the full chat history.
    let earlier: Message | undefined;
    for (let previousId = id - 1; previousId >= 0; previousId--) {
      const item = this.api.getChatMessages(previousId)[0];
      if (item?.role === 'assistant' && item.message_id < id) {
        earlier = item;
        break;
      }
    }
    const before = earlier ? mvu.getMvuData({ type: 'message', message_id: earlier.message_id }) : undefined;
    const sources = config.sources;
    const carried = (data.国策 as { 快讯?: NewsBar }).快讯;
    const bar = buildNewsBar({
      state: parsed.data,
      floor: id,
      time: timeText(valueAt(data.stat_data, sources.timePath)),
      location: timeText(valueAt(data.stat_data, sources.locationPath)),
      newsPath: sources.newsPath,
      timePath: sources.timePath,
      locationPath: sources.locationPath,
      news: valueAt(data.stat_data, sources.newsPath),
      previousNews: before?.stat_data ? valueAt(before.stat_data, sources.newsPath) : undefined,
      hasPrevious: Boolean(before?.stat_data),
      previous: (before?.国策 as { 快讯?: NewsBar } | undefined)?.快讯 ?? carried,
    });
    if (stamp([carried]) !== stamp([bar])) {
      this.writing = true;
      try {
        const latest = mvu.getMvuData({ type: 'message', message_id: id });
        if (!latest?.国策 || typeof latest.国策 !== 'object') {
          return;
        }
        latest.国策 = { ...(latest.国策 as object), 快讯: bar };
        await mvu.replaceMvuData(latest, { type: 'message', message_id: id });
      } finally {
        this.writing = false;
      }
    }
    if (!signal.aborted) {
      await this.appendNewsTag(id);
      await this.api.eventEmit?.('national-focus:news-saved', id);
    }
  }
  async readNews(messageId: number) {
    const data = this.api.Mvu?.getMvuData({ type: 'message', message_id: messageId });
    const raw = data?.国策 ?? data?.stat_data?.国策;
    const parsed = StateSchema.safeParse(raw);
    const seen = (raw as { 快讯?: Partial<NewsBar> } | undefined)?.快讯?.insiders;
    return parsed.success
      ? { state: parsed.data, events: floorNews(parsed.data, messageId, seen ?? undefined) }
      : null;
  }
  onNewsRequest(callback: (messageId: number, action: NewsAction) => void): () => void {
    const listener = this.api.eventOn(NEWS_EVENT, (messageId: unknown, action: unknown) => {
      if (typeof messageId === 'number') {
        callback(messageId, action === 'panel' || action === 'events' ? action : 'news');
      }
    });
    return () => listener.stop();
  }
  /** Workflow Assistant style: a tag at the end of the floor that a display regex turns into a card. */
  private async appendNewsTag(messageId: number): Promise<void> {
    const [message] = this.api.getChatMessages(messageId);
    const text = message?.message ?? '';
    if (!this.api.setChatMessages || /<国策快讯\s*\/>/.test(text)) {
      return;
    }
    try {
      await this.api.setChatMessages([{ message_id: messageId, message: `${text}\n\n${NEWS_TAG}` }], {
        refresh: 'affected',
      });
    } catch (error) {
      console.warn('[国策档案] 无法在正文加入新闻标签：', error);
    }
  }
  async generate(
    messages: PromptMessage[],
    api: Config['apis'][number],
    secret: string,
    signal: AbortSignal,
  ): Promise<GenerateResult> {
    signal.throwIfAborted();
    // Keep custom requests isolated from the player's main generation settings.
    if (api.url && !api.proxy) {
      const service = this.context()?.ChatCompletionService;
      if (service) {
        try {
          const response = await service.processRequest(
            customRequest(api, messages, secret),
            {},
            true,
            signal,
          );
          signal.throwIfAborted();
          const result = (api.stream ? await readStream(response) : null) ?? extractApiResult(response);
          signal.throwIfAborted();
          if (!result.content) {
            throw new Error('API 回应没有文字内容');
          }
          return result;
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }
          const detail = explainOpaqueError(redactApiError(error, [{ ...api, apiKey: secret }]));
          if (hasAdvancedApi(api)) {
            // Workflow Assistant: structured parameters need the Chat Completion path; never drop them silently.
            throw new Error(`ChatCompletionService 失败，进阶参数不能回退 generateRaw：${detail}`);
          }
          console.warn('[国策档案] ChatCompletionService 失败，回退 generateRaw：', detail);
        }
      }
    }
    if (hasAdvancedApi(api)) {
      throw new Error('进阶 API 参数需要酒馆 ChatCompletionService 及明确 URL；未送出省略设置的请求');
    }
    const id = requestId('national_focus');
    const stop = () => this.api.stopGenerationById(id);
    signal.addEventListener('abort', stop, { once: true });
    try {
      const result = await this.api.generateRaw({
        generation_id: id,
        should_silence: true,
        // generateRaw returns the final text either way; streaming keeps the proxy connection busy.
        should_stream: api.stream,
        max_chat_history: 0,
        overrides: {
          world_info_before: '',
          world_info_after: '',
          persona_description: '',
          char_description: '',
          char_personality: '',
          scenario: '',
          dialogue_examples: '',
          chat_history: { with_depth_entries: false, prompts: [] },
        },
        ordered_prompts: messages.map(({ role, content }) => ({ role, content })),
        custom_api: {
          max_tokens: api.maxTokens,
          temperature: api.temperature,
          ...(api.url || api.model || api.proxy
            ? {
                apiurl: api.url || undefined,
                model: api.model || undefined,
                proxy_preset: api.proxy || undefined,
                key: secret || undefined,
                source: api.url || api.proxy ? 'openai' : undefined,
              }
            : {}),
        },
      });
      signal.throwIfAborted();
      if (typeof result !== 'string') {
        throw new Error('API 回应不是文字 JSON');
      }
      return { content: result };
    } catch (error) {
      throw new Error(explainOpaqueError(redactApiError(error, [{ ...api, apiKey: secret }])));
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }
  async worldbooks(): Promise<{ character: string[]; all: string[] }> {
    const character = this.api.getCharWorldbookNames('current');
    const names = [...new Set([...(character.primary ? [character.primary] : []), ...character.additional])];
    return { character: names, all: this.api.getWorldbookNames?.() ?? names };
  }
  async sources(
    selection = this.loadConfig().sources.worldbook,
    cache?: Map<string, Promise<SourceEntry[]>>,
  ): Promise<SourceEntry[]> {
    const names =
      selection.source === 'manual'
        ? [...new Set(selection.manualSelection)]
        : (await this.worldbooks()).character;
    const read = (book: string) => {
      // One job read shares each getWorldbook call across $1/$2/$5/$6/$U (Workflow Assistant read cache).
      let pending = cache?.get(book);
      if (!pending) {
        pending = this.api.getWorldbook(book).then((entries) => entries.map((entry) => ({ ...entry, book })));
        cache?.set(book, pending);
      }
      return pending;
    };
    return (await Promise.all(names.map(read))).flat();
  }
  loadConfig(): Config {
    // Tavern settings follow the account across browsers; localStorage keeps working as a local copy.
    const shared = this.secrets.durable ? this.secrets.loadConfig() : null;
    const saved = shared ?? this.storage.getItem(storageKey) ?? this.storage.getItem(legacyStorageKey);
    const raw = saved ? JSON.parse(saved) : undefined;
    let config = raw ? ConfigSchema.parse(raw) : defaultConfig();
    if (!config.defaultApi) {
      config.defaultApi = config.apis[0].name;
    }
    // Older releases used this literal for the implicit default connection.
    if (raw && raw.apiBindings === undefined) {
      for (const job of Object.values(config.jobs)) {
        if (job.api === '目前连线' || job.api === '目前連線') {
          job.api = '';
        }
      }
    }
    if (!this.secrets.durable) {
      return config;
    }
    const stored = this.secrets.load();
    if (hasSecrets(config)) {
      // Move credentials saved by v0.2.x out of localStorage; stored secrets win on conflict.
      const legacy = extractSecrets(config);
      const merged = { version: 1 as const, byPreset: { ...legacy.byPreset, ...(stored?.byPreset ?? {}) } };
      this.secrets.save(merged);
      this.writeConfig(JSON.stringify(stripSecrets(config)));
      return mergeSecrets(stripSecrets(config), merged);
    }
    if (saved && !shared) {
      this.secrets.saveConfig(saved);
    }
    return mergeSecrets(config, stored);
  }
  saveConfig(config: Config): void {
    this.config = config;
    if (!this.secrets.durable) {
      // No Tavern settings store: keep the v0.2 behaviour rather than lose credentials on reload.
      this.storage.setItem(storageKey, JSON.stringify(config));
      return;
    }
    this.secrets.save(extractSecrets(config));
    this.writeConfig(JSON.stringify(stripSecrets(config)));
  }
  private writeConfig(text: string): void {
    this.secrets.saveConfig(text);
    this.storage.setItem(storageKey, text);
  }
  /** Where API credentials are kept, for the settings notice. */
  secretLocation(): string {
    return this.secrets.durable ? 'tavern' : 'local';
  }
  onReady(callback: () => void): () => void {
    this.readyListeners.add(callback);
    return () => this.readyListeners.delete(callback);
  }
  onChange(callback: () => void): () => void {
    this.changeListeners.add(callback);
    return () => this.changeListeners.delete(callback);
  }
  /** True when chat worldbook entries can render the saved view (ST-Prompt-Template present). */
  private bookMode(): boolean {
    return (
      this.config?.promptMode !== 'inject' &&
      Boolean(this.api.EjsTemplate) &&
      Boolean(this.api.updateWorldbookWith)
    );
  }
  inject(state: State, news = true): void {
    if (this.disposed) {
      return;
    }
    const view = promptView(state, news);
    // Always provide the data by injection first; the worldbook takes over only after it is in
    // place for this chat, so a failed or skipped sync never leaves the story without it.
    const content = promptText(view);
    if (content) {
      this.api.injectPrompts([
        { id: injectionId, position: 'in_chat', depth: 0, role: 'system', should_scan: false, content },
      ]);
    } else {
      this.api.uninjectPrompts([injectionId]);
    }
    const book = this.bookMode();
    this.queueBook(book ? view : null, {
      chat: this.api.SillyTavern.getCurrentChatId(),
      epoch: this.bookEpoch,
      token: ++this.bookToken,
      // Floors saved before v0.12.6 have no `国策.prompt` for the entries to read yet.
      handOff: book && this.promptSaved && Boolean(content),
    });
  }
  private bookCurrent(source: { chat: string; epoch: number; token: number }): boolean {
    return (
      !this.disposed &&
      source.token === this.bookToken &&
      source.epoch === this.bookEpoch &&
      this.api.SillyTavern.getCurrentChatId() === source.chat
    );
  }
  /**
   * Keep this script's character primary worldbook entries in line with the countries on this floor, then hand
   * the prompt over from injection to the entries. The job is bound to the chat and floor it was
   * queued for and checks that again after every wait. A chat without countries never gets a
   * worldbook; injection mode removes the entries this script made before.
   */
  private queueBook(
    view: ReturnType<typeof promptView> | null,
    source: { chat: string; epoch: number; token: number; handOff: boolean },
  ): void {
    const api = this.api;
    this.bookQueue = this.bookQueue
      .then(async () => {
        if (!this.bookCurrent(source) || !api.updateWorldbookWith) {
          return;
        }
        const wanted = view ? bookEntries(view, this.config?.countryEntries !== 'keyword') : [];
        const name = api.getCharWorldbookNames('current').primary?.trim() || null;
        if (!name && wanted.length) {
          throw new Error('当前角色尚未设置主世界书。请在酒馆的角色设置中绑定主世界书；不会自动建立新书。');
        }
        const previous = this.writtenBook?.chat === source.chat ? this.writtenBook.name : null;
        if (previous && previous !== name) {
          const entries = (await api.getWorldbook(previous)) as unknown as WorldbookEntryLike[];
          if (!this.bookCurrent(source)) {
            return;
          }
          if (reconcileBook(entries, []) !== null) {
            await api.updateWorldbookWith(previous, (entries) => reconcileBook(entries, []) ?? entries);
          }
          if (!this.bookCurrent(source)) {
            return;
          }
          this.writtenBook = null;
        }
        if (!name || !this.bookCurrent(source)) {
          return;
        }
        // Read first: Tavern Helper rewrites the whole worldbook on every update call.
        const current = (await api.getWorldbook(name)) as unknown as WorldbookEntryLike[];
        if (!this.bookCurrent(source)) {
          return;
        }
        if (reconcileBook(current, wanted) !== null) {
          await api.updateWorldbookWith(name, (entries) => reconcileBook(entries, wanted) ?? entries);
          console.info('[国策档案] 已更新角色主世界书条目', name);
          if (!this.bookCurrent(source)) {
            return;
          }
        }
        const character = api.getCharWorldbookNames('current');
        const activeBooks = [
          api.getChatWorldbookName?.('current'),
          character.primary,
          ...character.additional,
          ...api.getGlobalWorldbookNames(),
        ];
        if (source.handOff && activeBooks.includes(name)) {
          api.uninjectPrompts([injectionId]);
        }
        this.writtenBook = wanted.length ? { chat: source.chat, name } : null;
        if (wanted.length && !activeBooks.includes(name)) {
          if (!this.bookWarned) {
            api.toastr?.warning(
              `条目已写入「${name}」，但此书未在本聊天启用。国策资料暂用直接注入；请在酒馆中绑定或启用该书。`,
              '国策档案',
            );
          }
          this.bookWarned = true;
          return;
        }
        this.bookWarned = false;
      })
      .catch((error) => {
        console.warn('[国策档案] 角色主世界书条目更新失败', error);
        if (this.bookCurrent(source) && !this.bookWarned) {
          this.bookWarned = true;
          api.toastr?.warning(
            `世界书条目更新失败，国策资料暂用直接注入。${error instanceof Error ? error.message : '详情见浏览器主控台。'}`,
            '国策档案',
          );
        }
      });
  }
  dispose(): void {
    this.sourceRun.abort();
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearInterval(this.timer);
    for (const stop of this.stops) {
      stop();
    }
    this.api.uninjectPrompts([injectionId]);
  }
}
