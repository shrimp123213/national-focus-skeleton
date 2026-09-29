import { z } from 'zod';
import { applyProposal, installCountry, removeCountry } from './engine';
import { importTrees, type TreeImport } from './tree-io';
import {
  CandidatesSchema,
  ConfigSchema,
  sizeLimits,
  ProposalSchema,
  TreeSchema,
  type Candidate,
  type Config,
  type JobKind,
  type State,
} from './model';
import { defaultSegmentMax, generateCountry, generationPlan, isSegmented, workingState } from './generation';
import { skeletonPlan, type SkeletonProgress } from './skeleton';
import { checkTransition, periodAnchor, PeriodReplySchema, transitionPeriod } from './periods';
import { DATA_TOKEN, promptText } from './prompts';
import { currentApiName, parseJsonReply, redactApiError, validateApi } from './api-config';
import { repairReply } from './repair';
import { assertInputSize, InputSizeError, messageCharacters } from './sources';
import { RoutePool, routeLimits } from './route-pool';
import {
  requestId,
  type JobStatus,
  type Platform,
  type PromptMessage,
  type RunLogEntry,
  type Snapshot,
  type PeriodWork,
} from './platform';

function taskData(snapshot: Snapshot, full: boolean) {
  return { now: snapshot.day, state: workingState(snapshot.state, full), context: snapshot.context };
}

export class FocusController {
  config: Config;
  state: State | null = null;
  candidates: Candidate[] = [];
  jobs: JobStatus[] = [];
  /** Recent requests and replies; only filled while the run log setting is on. */
  logs: RunLogEntry[] = [];
  error = '';
  private pools = new Map<string, RoutePool>();
  /** Finished generation stages per country and source, so a retry resumes the segmented run. */
  private progress = new Map<string, SkeletonProgress>();
  private listeners = new Set<() => void>();
  private aborters = new Map<string, AbortController>();
  private active = 0;
  private runEpoch = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private waiters: (() => void)[] = [];
  private automatic: Promise<void> | null = null;
  private pendingReady = false;
  private disposed = false;
  private stops: (() => void)[] = [];

  constructor(readonly platform: Platform) {
    this.config = ConfigSchema.parse(platform.loadConfig());
  }
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  private notify(): void {
    if (this.disposed) {
      return;
    }
    for (const listener of this.listeners) {
      listener();
    }
  }
  async initialize(): Promise<void> {
    this.stops.push(
      this.platform.onReady(() => {
        this.cancelAll();
        this.pendingReady = true;
        if (!this.automatic) {
          this.automatic = (async () => {
            while (this.pendingReady && !this.disposed) {
              this.pendingReady = false;
              try {
                await this.runScheduled();
              } catch (error) {
                this.report(error);
              }
            }
          })().finally(() => {
            this.automatic = null;
          });
        }
      }),
    );
    this.stops.push(
      this.platform.onChange(() => {
        this.cancelAll();
        this.pendingReady = false;
        this.candidates = [];
        void this.refresh();
      }),
    );
    await this.refresh();
  }
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.pendingReady = false;
    this.cancelAll();
    for (const stop of this.stops) {
      stop();
    }
    this.listeners.clear();
  }
  report(error: unknown): void {
    this.error = redactApiError(error, this.config.apis);
    this.notify();
  }
  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      const snapshot = await this.platform.read(this.config);
      if (this.disposed) {
        return;
      }
      this.state = snapshot.state;
      this.platform.inject(snapshot.state, this.config.newsPrompt);
      this.error = '';
    } catch (error) {
      this.state = null;
      this.report(error);
    }
    this.notify();
  }
  /** Serialize local saves so concurrent API replies apply to the latest committed state. */
  private writeState(operation: (snapshot: Snapshot) => State, signal?: AbortSignal): Promise<State> {
    const epoch = this.runEpoch;
    const save = this.writes.then(async () => {
      const checkCancelled = () => {
        signal?.throwIfAborted();
        if (this.disposed || epoch !== this.runEpoch) {
          throw new DOMException('任務已取消', 'AbortError');
        }
      };
      checkCancelled();
      const snapshot = await this.platform.read(this.config);
      checkCancelled();
      const next = operation(snapshot);
      await this.platform.commit(snapshot, next);
      return next;
    });
    this.writes = save.catch(() => {});
    return save;
  }
  async mutate(operation: (state: State) => State, changesTimeline = false): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.writeState((snapshot) => {
      if (
        changesTimeline &&
        Object.values(snapshot.state.countries).some(
          (c) => c.enabled && !c.calibration && c.cursor !== snapshot.day,
        )
      ) {
        throw new Error(
          '故事時間已前進，請先完成「更新局勢」，再開始、暫停或交接國策；避免把新操作倒填至過去。',
        );
      }
      return operation(snapshot.state);
    });
    await this.refresh();
  }
  saveSettings(config: unknown): void {
    const parsed = ConfigSchema.parse(config);
    parsed.apis = parsed.apis.map(validateApi);
    const names = new Set(parsed.apis.map((a) => a.name));
    if (names.size !== parsed.apis.length) {
      throw new Error('API 名稱不可重複');
    }
    for (const job of Object.values(parsed.jobs)) {
      if (![job.api, ...job.fallback].every((name) => !name || names.has(name))) {
        throw new Error('任務引用不存在的 API');
      }
    }
    this.platform.saveConfig(parsed);
    this.cancelAll();
    this.config = parsed;
    this.pools.clear();
    if (!parsed.runLog) {
      this.logs = [];
    }
    if (this.state) {
      // The provision mode and the news option apply at once, without waiting for the next floor.
      this.platform.inject(this.state, parsed.newsPrompt);
    }
    this.notify();
  }
  cancel(id: string): void {
    this.aborters.get(id)?.abort();
  }
  cancelAll(): void {
    this.runEpoch++;
    this.progress.clear();
    for (const aborter of this.aborters.values()) {
      aborter.abort();
    }
  }
  async runScheduled(): Promise<void> {
    const epoch = this.runEpoch;
    for (const kind of ['identify', 'update', 'reshape'] as const) {
      if (this.disposed || epoch !== this.runEpoch) {
        return;
      }
      const job = this.config.jobs[kind];
      if (job.schedule === 'manual') {
        continue;
      }
      const snapshot = await this.platform.read(this.config);
      if (this.disposed || epoch !== this.runEpoch) {
        return;
      }
      const last = snapshot.state.schedules[kind];
      const due =
        job.schedule === 'reply'
          ? last?.turn !== snapshot.turn
          : job.schedule === 'rounds'
            ? !last || snapshot.turn - last.turn >= job.interval
            : job.schedule === 'days'
              ? !last || snapshot.day - last.day >= job.interval
              : false;
      if (due && (kind === 'identify' || Object.values(snapshot.state.countries).some((c) => c.enabled))) {
        await this.run(kind);
      }
    }
  }
  /**
   * Delete a country's tree from the current floor. The country goes back to the candidates, so
   * it can be generated again without another identification run.
   */
  async removeCountry(id: string): Promise<void> {
    const country = this.state?.countries[id];
    await this.mutate((state) => removeCountry(state, id));
    for (const key of [...this.progress.keys()]) {
      if (key.endsWith(`\0${id}`)) {
        this.progress.delete(key);
      }
    }
    if (country && !this.candidates.some((candidate) => candidate.id === id)) {
      this.candidates = [
        ...this.candidates,
        { id, name: country.name, description: country.description, evidence: country.evidence },
      ];
    }
    this.notify();
  }
  /** Install trees from a tree file on the current floor (see tree-io.ts). */
  async importTrees(
    entries: TreeImport[],
    options: { withProgress: boolean; replace: boolean },
  ): Promise<void> {
    await this.mutate((state) => importTrees(state, entries, options));
    const ids = new Set(entries.map((entry) => entry.tree.id));
    this.candidates = this.candidates.filter((candidate) => !ids.has(candidate.id));
    this.notify();
  }
  async enable(candidates: Candidate[]): Promise<void> {
    const epoch = this.runEpoch;
    // Each successful country takes a fresh snapshot. Failure keeps previous successes.
    for (const candidate of candidates) {
      await this.run('generate', candidate);
      if (this.disposed || epoch !== this.runEpoch || !this.state?.countries[candidate.id]) {
        break;
      }
    }
  }
  async run(kind: JobKind, candidate?: Candidate, periodWork?: PeriodWork): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (
      this.jobs.some(
        (job) =>
          job.kind === kind &&
          job.candidate?.id === candidate?.id &&
          ['queued', 'running'].includes(job.state) &&
          !this.aborters.get(job.id)?.signal.aborted,
      )
    ) {
      return;
    }
    const id = requestId('job');
    const aborter = new AbortController();
    const status: JobStatus = {
      id,
      kind,
      state: 'queued',
      message: '等待任務空位',
      time: new Date().toLocaleTimeString(),
      ...(candidate ? { label: candidate.name, candidate } : {}),
      ...(periodWork ? { periodWork, label: `${candidate?.name} · 換期` } : {}),
    };
    this.jobs.unshift(status);
    this.jobs = this.jobs.slice(0, 40);
    this.aborters.set(id, aborter);
    this.notify();
    let acquired = false;
    let sourceSignal: AbortSignal | undefined;
    const cancelSource = () => aborter.abort();
    const periods: { candidate: Candidate; work: PeriodWork }[] = [];
    try {
      while (this.active >= this.config.concurrency) {
        await new Promise<void>((resolve, reject) => {
          const wake = () => {
            aborter.signal.removeEventListener('abort', cancel);
            resolve();
          };
          const cancel = () => {
            this.waiters = this.waiters.filter((waiter) => waiter !== wake);
            reject(new Error('任務已取消'));
          };
          aborter.signal.addEventListener('abort', cancel, { once: true });
          this.waiters.push(wake);
        });
      }
      aborter.signal.throwIfAborted();
      this.active++;
      acquired = true;
      status.state = 'running';
      status.started = Date.now();
      status.message = '正在分析本樓資料';
      this.notify();
      const snapshot = await this.platform.read(this.config, kind);
      sourceSignal = snapshot.signal;
      sourceSignal?.addEventListener('abort', cancelSource, { once: true });
      if (sourceSignal?.aborted) {
        aborter.abort();
      }
      aborter.signal.throwIfAborted();
      if (periodWork) {
        checkTransition(snapshot.state, periodWork.transition);
      }
      if (kind === 'generate' && !candidate) {
        throw new Error('請先選擇要生成的候選國家');
      }
      const ask = async <S extends z.ZodType>(
        stage: string,
        data: object,
        schema: S,
        validate?: (value: z.output<S>) => void,
        label?: string,
        shown?: z.ZodType,
      ): Promise<z.output<S>> => {
        aborter.signal.throwIfAborted();
        status.message = label ?? (kind === 'generate' ? '單次生成完整國策樹' : '分析本樓局勢');
        this.notify();
        return this.request(
          kind,
          { job: kind, stage, ...data, schema: z.toJSONSchema(shown ?? schema, { io: 'input' }) },
          schema,
          aborter.signal,
          status,
          validate,
          snapshot.prompts,
        );
      };
      const segmentMax = this.segmentMax();
      const progressKey =
        kind === 'generate'
          ? [snapshot.identity, snapshot.state.settings.size, candidate!.id].join('\0')
          : '';
      const progress: SkeletonProgress = this.progress.get(progressKey) ?? { filled: {} };
      if (kind === 'generate') {
        this.progress.delete(progressKey);
        this.progress.set(progressKey, progress);
        while (this.progress.size > 8) {
          this.progress.delete(this.progress.keys().next().value!);
        }
        if (progress.skeleton) {
          status.message = `沿用先前完成的骨架與 ${Object.keys(progress.filled).length} 項內容`;
          this.notify();
        }
      }
      const result = periodWork
        ? await ask(
            'period',
            {
              now: snapshot.day,
              context: snapshot.context,
              world: Object.values(snapshot.state.countries)
                .filter((country) => country.enabled && country.id !== candidate!.id)
                .map((country) => ({
                  id: country.id,
                  name: country.name,
                  agenda: country.agenda || country.analysis,
                  current: country.nodes[country.current]?.name,
                  capabilities: Object.values(country.capabilities).filter((c) => c.active),
                })),
              state: workingState(
                {
                  ...snapshot.state,
                  countries: { [candidate!.id]: snapshot.state.countries[candidate!.id] },
                  events: Object.fromEntries(
                    Object.entries(snapshot.state.events).filter(([, event]) =>
                      event.countries.includes(candidate!.id),
                    ),
                  ),
                },
                true,
              ),
              candidate,
              transition: periodWork.transition,
              anchor: periodAnchor(
                snapshot.state.countries[candidate!.id],
                periodWork.transition.invalidateActive,
              ),
              prefix: `p${snapshot.state.countries[candidate!.id].period.number + 1}_`,
              limits: {
                min: sizeLimits[snapshot.state.settings.size][0],
                max: sizeLimits[snapshot.state.settings.size][1],
              },
              instructions:
                '生成下一期與舊期摘要。tree.nodes 只輸出新節點，承接節點由程式原樣保留；新節點可引用 anchor 作必要前置，不相關議程可獨立推進。節點與互斥組使用 prefix。不得生成 historical 或改變既有能力、數值、事實及事件。保留仍有效的 longTerm 的 id 與原文，修訂理由寫 analysis。summary 只敘述已發生事實與舊期終止原因，不把新計畫當成果。總數含 anchor，以 limits 為篇幅目標，不湊數。',
            },
            PeriodReplySchema,
            (value) => {
              transitionPeriod(snapshot.state, periodWork.transition, value);
            },
            '生成下一期與舊期摘要',
          )
        : kind === 'generate'
          ? await generateCountry(
              snapshot,
              candidate!,
              ask,
              progress,
              segmentMax,
              this.config.jobs.generate.retries,
            )
          : await ask(
              kind,
              taskData(snapshot, kind === 'reshape'),
              kind === 'identify' ? CandidatesSchema : ProposalSchema,
              (value) => {
                this.proposedState(kind, snapshot, value, candidate);
              },
            );
      aborter.signal.throwIfAborted();
      // Apply to current data in save order, without comparing it to the request input.
      const next = await this.writeState((current) => {
        const state = periodWork
          ? transitionPeriod(current.state, periodWork.transition, PeriodReplySchema.parse(result))
          : this.proposedState(kind, current, result, candidate);
        state.schedules[kind] = { turn: snapshot.turn, day: snapshot.day };
        return state;
      }, aborter.signal);
      if (kind === 'update' && !snapshot.state.receipts.includes(ProposalSchema.parse(result).id)) {
        for (const transition of ProposalSchema.parse(result).transitions) {
          const country = next.countries[transition.country];
          if (!country.enabled || !country.autoPeriod || country.calibration) {
            continue;
          }
          periods.push({
            candidate: {
              id: country.id,
              name: country.name,
              description: country.description,
              evidence: country.evidence,
            },
            work: {
              transition,
            },
          });
        }
      }
      if (kind === 'identify') {
        this.candidates = CandidatesSchema.parse(result).countries.filter((c) => !next.countries[c.id]);
      }
      if (kind === 'generate') {
        this.progress.delete(progressKey);
      }
      status.state = 'success';
      status.message = kind === 'identify' ? '候選國家已就緒，請勾選啟用' : '驗證通過，已保存至本樓';
      await this.refresh();
    } catch (error) {
      const message = redactApiError(error, this.config.apis);
      status.state =
        aborter.signal.aborted || (error instanceof Error && error.name === 'AbortError')
          ? 'cancelled'
          : 'failed';
      // Logs omit model output and credentials; private proposal details stay in MVU.
      status.message =
        status.state === 'cancelled' ? '已取消，未套用結果' : `未提交：${message.slice(0, 1500)}`;
    } finally {
      sourceSignal?.removeEventListener('abort', cancelSource);
      status.finished = Date.now();
      if (acquired) {
        this.active--;
      }
      this.aborters.delete(id);
      this.waiters.shift()?.();
      this.notify();
    }
    // Release the update job's slot before starting its per-country background generation.
    for (const period of periods) {
      if (this.disposed || aborter.signal.aborted) {
        break;
      }
      await this.run('generate', period.candidate, period.work);
    }
  }
  /**
   * Focuses per segmented request: the generate task's own value; configs from before v0.13.3
   * fall back to the value that used to live on its primary API preset. Fallbacks use the same
   * plan, since it is made before the first call.
   */
  segmentMax(config: Config = this.config): number {
    if (config.jobs.generate.segmentMax !== undefined) {
      return config.jobs.generate.segmentMax;
    }
    const name = config.jobs.generate.api || currentApiName(config, this.platform.chatId());
    return config.apis.find((api) => api.name === name)?.segmentMax ?? defaultSegmentMax;
  }
  /** Final messages: the rendered chain with the data item's {{data}} replaced by the payload. */
  messages(
    kind: JobKind,
    prompts: Snapshot['prompts'],
    payload: object,
    config: Config = this.config,
  ): PromptMessage[] {
    const chain =
      prompts ??
      config.jobs[kind].prompts
        .filter((item) => item.enabled || item.kind === 'data')
        .map((item) => ({ ...item, content: promptText(item, kind) }));
    const json = JSON.stringify(payload);
    return chain.map((item) => ({
      role: item.role,
      name: item.name,
      content:
        item.kind !== 'data'
          ? item.content
          : item.content.includes(DATA_TOKEN)
            ? item.content.split(DATA_TOKEN).join(json)
            : `${item.content}\n${json}`,
    }));
  }
  /**
   * Build the exact messages a task would send now, without calling the API. The data item is
   * shown with its real JSON so the player can read the whole chain.
   */
  async preview(kind: JobKind, config: Config = this.config): Promise<PromptMessage[]> {
    const snapshot = await this.platform.read(config, kind);
    if (kind === 'generate') {
      const candidate = this.candidates[0] ?? {
        id: 'example_country',
        name: '（執行時為勾選的國家）',
        description: '預覽用示例候選國家',
        evidence: '預覽',
      };
      // Larger sizes start with the skeleton request; preview that one.
      const segmented = isSegmented(snapshot.state.settings.size);
      const plan = segmented ? skeletonPlan(snapshot, candidate) : generationPlan(snapshot, candidate);
      return this.messages(
        kind,
        snapshot.prompts,
        {
          job: kind,
          stage: segmented ? 'skeleton' : kind,
          ...plan.data,
          schema: z.toJSONSchema(plan.schema, { io: 'input' }),
          correction: '',
        },
        config,
      );
    }
    return this.messages(
      kind,
      snapshot.prompts,
      {
        job: kind,
        stage: kind,
        ...taskData(snapshot, kind === 'reshape'),
        schema: z.toJSONSchema(kind === 'identify' ? CandidatesSchema : ProposalSchema, { io: 'input' }),
        correction: '',
      },
      config,
    );
  }
  private pool(kind: JobKind, chain: string[]): RoutePool {
    const job = this.config.jobs[kind];
    const limits = routeLimits(chain, job.primaryMaxConcurrency, job.fallbackMaxConcurrencies);
    const key = `${kind}\0${chain.map((route) => `${route}:${limits.get(route)}`).join('>')}`;
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new RoutePool(limits);
      this.pools.set(key, pool);
    }
    return pool;
  }
  private log(entry: RunLogEntry): void {
    if (this.config.runLog) {
      this.logs.unshift(entry);
      this.logs = this.logs.slice(0, 20);
    }
  }
  private async request<S extends z.ZodType>(
    kind: JobKind,
    data: object,
    schema: S,
    signal: AbortSignal,
    status: JobStatus,
    validate?: (value: z.output<S>) => void,
    prompts?: Snapshot['prompts'],
  ): Promise<z.output<S>> {
    const settings = this.config.jobs[kind];
    let lastError: unknown;
    let feedback = '';
    const stageMessage = status.message;
    const chain = [
      ...new Set([settings.api || currentApiName(this.config, this.platform.chatId()), ...settings.fallback]),
    ];
    for (const route of chain) {
      if (!this.config.apis.some((a) => a.name === route)) {
        throw new Error('任務引用不存在的 API');
      }
    }
    const pool = this.pool(kind, chain);
    // Start on the first route with a free slot, then fail over through the rest of the chain.
    const first = await pool.acquire(chain, signal);
    const index = chain.indexOf(first);
    const order = [...chain.slice(index), ...chain.slice(0, index)];
    for (const [position, route] of order.entries()) {
      const held = position === 0 ? first : await pool.acquire([route], signal);
      try {
        // Strict JSON lives on the API preset only (v0.13.3); the retired task switch is ignored.
        const api = this.config.apis.find((a) => a.name === route)!;
        for (let attempt = 0; attempt <= settings.retries; attempt++) {
          signal.throwIfAborted();
          const request = new AbortController();
          const cancel = () => request.abort();
          signal.addEventListener('abort', cancel, { once: true });
          const timer = setTimeout(() => request.abort(), settings.timeout * 1000);
          const started = Date.now();
          let output = '';
          let reasoning = '';
          let messages: PromptMessage[] = [];
          let phase: 'request' | 'validate' = 'request';
          try {
            messages = this.messages(kind, prompts, { ...data, correction: feedback });
            status.inputCharacters = messageCharacters(messages);
            assertInputSize(messages, this.config.sources.maxInputCharacters);
            const reply = await new Promise<Awaited<ReturnType<Platform['generate']>>>((resolve, reject) => {
              const stopWaiting = () => reject(new Error('API 任務已取消或逾時'));
              request.signal.addEventListener('abort', stopWaiting, { once: true });
              this.platform
                .generate(messages, api, api.apiKey, request.signal)
                .then(resolve, reject)
                .finally(() => request.signal.removeEventListener('abort', stopWaiting));
            });
            output = reply.content;
            reasoning = reply.reasoning ?? '';
            signal.throwIfAborted();
            phase = 'validate';
            const result = schema.parse(
              repairReply(parseJsonReply(output), (data as { stage?: string }).stage),
            );
            validate?.(result);
            status.route = route;
            this.log({
              jobId: status.id,
              kind,
              stage: stageMessage,
              time: new Date().toLocaleTimeString(),
              route,
              attempt: attempt + 1,
              durationMs: Date.now() - started,
              messages,
              output,
              reasoning,
              error: '',
            });
            return result;
          } catch (error) {
            if (messages.length) {
              this.log({
                jobId: status.id,
                kind,
                stage: stageMessage,
                time: new Date().toLocaleTimeString(),
                route,
                attempt: attempt + 1,
                durationMs: Date.now() - started,
                messages,
                output,
                reasoning,
                error: redactApiError(error, this.config.apis),
              });
            }
            if (error instanceof InputSizeError) {
              throw error;
            }
            lastError = error;
            // Only local validation feedback is useful to a model; never echo provider errors or credentials.
            const reason =
              phase !== 'validate'
                ? ''
                : error instanceof z.ZodError
                  ? JSON.stringify(error.issues.map((i) => ({ path: i.path, message: i.message }))).slice(
                      0,
                      2000,
                    )
                  : error instanceof SyntaxError
                    ? `回應不是完整的 JSON（${error.message}），可能超出輸出長度而被截斷；請精簡文字並輸出完整物件`
                    : error instanceof Error
                      ? error.message.slice(0, 1000)
                      : '';
            feedback = reason
              ? `上次回應未通過本機驗證：${reason}。請修正後重新輸出完整 JSON。`
              : '前次回應未通過，請重新核對 Schema 與本階段所有約束。';
            status.message = `${stageMessage} · ${route} 嘗試 ${attempt + 1}/${settings.retries + 1} 未通過${reason ? `：${reason.slice(0, 120)}` : ''}`;
            this.notify();
          } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', cancel);
          }
        }
      } finally {
        pool.release(held);
      }
    }
    signal.throwIfAborted();
    throw lastError ?? new Error('沒有可用的 API 回應');
  }
  private proposedState(kind: JobKind, snapshot: Snapshot, result: unknown, candidate?: Candidate): State {
    if (kind === 'identify') {
      const next = structuredClone(snapshot.state);
      next.revision++;
      return next;
    }
    if (kind === 'generate') {
      const tree = TreeSchema.parse(result);
      if (tree.id !== candidate?.id) {
        throw new Error('生成的國家 ID 與選取國家不一致');
      }
      const limits = sizeLimits;
      const [min, max] = limits[snapshot.state.settings.size];
      if (!tree.nodes.length || tree.nodes.length > max) {
        throw new Error(`生成規模須為 ${min}–${max} 節點`);
      }
      return installCountry(snapshot.state, { ...tree, autoPeriod: true }, snapshot.day);
    }
    const proposal = ProposalSchema.parse(result);
    if (proposal.until !== snapshot.day) {
      throw new Error('更新終點必須等於來源故事時間');
    }
    const next = applyProposal(snapshot.state, proposal, kind === 'reshape');
    if (proposal.transitions.length && kind !== 'update') {
      throw new Error('只有局勢更新可發起換期');
    }
    const countries = new Set<string>();
    for (const transition of proposal.transitions) {
      const country = next.countries[transition.country];
      if (!country) {
        throw new Error('換期引用不存在的國家');
      }
      if (country.enabled && country.autoPeriod && !country.calibration) {
        checkTransition(next, transition);
      }
      if (countries.has(transition.country)) {
        throw new Error('同一次更新不可對同國重複換期');
      }
      countries.add(transition.country);
    }
    return next;
  }
}
