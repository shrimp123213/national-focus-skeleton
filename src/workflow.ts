import { z } from 'zod';
import {
  applyProposal,
  countryKey,
  dueFocuses,
  focusEvent,
  focusEventId,
  idleChoices,
  installCountry,
  outcomeFocuses,
  outcomeGraceDays,
  removeCountry,
  type UpdateReport,
} from './engine';
import { importTrees, type TreeImport } from './tree-io';
import {
  CandidatesSchema,
  ConfigSchema,
  focusDays,
  periodDays,
  sizeLimits,
  ProposalSchema,
  TreeSchema,
  type Candidate,
  type Config,
  type JobKind,
  type Proposal,
  type State,
} from './model';
import {
  defaultSegmentMax,
  generateCountry,
  generationPlan,
  isSegmented,
  shapeLimits,
  workingState,
} from './generation';
import { skeletonPlan, type SkeletonProgress } from './skeleton';
import {
  checkGovernment,
  checkTransition,
  periodAnchor,
  PeriodReplySchema,
  transitionPeriod,
} from './periods';
import { drawStructure, signature, structureData, type Structure, type TreeType } from './structure';
import {
  DATA_TOKEN,
  GENERATE_POLITICS_TASK,
  GOVERNMENT_TASK,
  GUIDANCE_TASK,
  POLITICS_TASK,
  promptText,
} from './prompts';
import { currentApiName, parseJsonReply, redactApiError, validateApi } from './api-config';
import { repairReply } from './repair';
import { storyTime } from './story-time';
import { letterDigest } from './proposal-view';
import { assertInputSize, InputSizeError, messageCharacters } from './sources';
import { RoutePool, routeLimits } from './route-pool';
import {
  FocusIntegration,
  INTEGRATION_VERSION,
  sameData,
  unavailable,
  type IntegrationRegistration,
} from './integration';
import {
  GUIDANCE_TAG,
  parseWorldGuidance,
  worldFingerprint,
  type GuidanceReason,
  type GuidanceSource,
  type GuidanceState,
  type WorldGuidance,
  type WorldObservation,
} from './world-proposal';
import {
  PREDICTION_WAIT_MS,
  type ScheduleSource,
  type ScheduleCoordination,
  type RollbackNotice,
} from './world-schedule';
import {
  FloorNotReady,
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
/** What an update has to know about selections and outcomes, so the model need not work out the rules. */
function updateData(state: State, now: number) {
  const idle = idleChoices(state);
  const due = dueFocuses(state, now);
  const pending = outcomeFocuses(state).filter((item) => !due.some((d) => d.node === item.node));
  const listed = ({ country, node, missing, due: dueAt }: (typeof due)[number]) => ({
    country: country.id,
    name: country.name,
    node: node.id,
    nodeName: node.name,
    dueAt,
    missing: missing.map((r) => ({ kind: r.kind, ...('id' in r ? { id: r.id } : {}), label: r.label })),
    event: focusEvent(state, country.id, node.id)?.id ?? focusEventId(country.id, node.id),
  });
  return {
    selectionNote:
      'AI 国的选策规则：主国策完成之后才能选下一项，到 until 时主国策仍在进行的国家不用选。长跳时每国选一项就够，不必排满整段时间，直接放在 at=until 的步骤也可以。只能选前置已完成的国策；工期已满但 outcomes 未达成的国策仍占着主国策，此时不能选。不合这些规则的选策会被略过，其余内容照常保存。',
    ...(idle.length
      ? {
          idle: {
            note: '以下 AI 国在上次更新结束时没有主国策，但已有可开始的国策。本次更新须在 selections 为每国选一项，放在第一个步骤或依剧情较晚的时点。',
            countries: idle.map(({ country, options }) => ({
              country: country.id,
              name: country.name,
              options: options.map((node) => ({ id: node.id, name: node.name })),
            })),
          },
        }
      : {}),
    ...(pending.length
      ? {
          pendingOutcomes: {
            note: '以下国策（含玩家国）还缺成果，系统已为每项开了一个进行中事件（event 是事件 ID；它可能还不在 state.events 中，照样使用）。工期内用 eventUpdates 推进它：text 写本期进展，current 写现况，steps 写阶段（整份取代），不要为同一件事另建事件。内容写这个成果是怎么被争取的：谁出面、谁反对、开出什么条件、对方有什么顾虑；依国策 description、当事方立场与当前局势来写，可以受挫，不要每次都顺利。这段时间确实没有动静可以不写。结果留到 dueAt 裁决，只有局势已明确定案才提前。玩家国同样由你推进与裁决：玩家只决定选哪项国策，不必亲自参与。',
            focuses: pending.map(listed),
          },
        }
      : {}),
    ...(due.length
      ? {
          dueOutcomes: {
            note: `以下国策（含玩家国）工期已满或将在本次更新内届满，但完成还缺成果。必须依当时的国力、关系、局势与事件发展逐项裁决，在 dueAt 或之后的步骤写出结果；失败是正常结果，不要一律判成功；正文已写出结果时照正文。裁决就是结束事件：在 eventUpdates 对 event 写结局并填 result。achieved＝成，系统写入成果并完成国策（kind=capability 的成果要用事件 changes 取得）。failed＝败，系统终止国策，不给效果，该国可在同一步骤选下一项（玩家国等玩家选）。这里的裁决是例外，不必等正文或世界后台引擎，也不受「不替玩家决定」限制。届满 ${outcomeGraceDays} 个故事日后仍未裁决，系统判为失败。`,
            focuses: due.map(listed),
          },
        }
      : {}),
  };
}
/** The saved message of an update that left something out; the panel lists each item on its own line. */
function reportMessage({ skipped, expired }: UpdateReport, state: State): string {
  const items = [
    ...skipped.map(({ country, node, at, reason }) => {
      const owner = state.countries[country];
      return `${owner.name}在 ${storyTime(at, false, state.time)}选「${owner.nodes[node].name}」：${reason.replaceAll('；', '、')}`;
    }),
    ...expired.map(({ country, node }) => {
      const owner = state.countries[country];
      return `${owner.name}「${owner.nodes[node].name}」`;
    }),
  ];
  const parts = [
    skipped.length ? `略过 ${skipped.length} 项选策` : '',
    expired.length ? `${expired.length} 项国策到期未裁决，判为失败` : '',
  ].filter(Boolean);
  return `已保存至本楼，${parts.join('，')}：${items.join('；')}`;
}
function scheduledDue(job: Config['jobs'][JobKind], snapshot: Snapshot, kind: JobKind): boolean {
  const last = snapshot.state.schedules[kind];
  return job.schedule === 'reply'
    ? last?.turn !== snapshot.turn
    : job.schedule === 'rounds'
      ? !last || snapshot.turn - last.turn >= job.interval
      : job.schedule === 'days'
        ? !last || snapshot.day - last.day >= job.interval
        : false;
}

export type UpdateCommit = {
  state: State;
  /** The saved state the proposal was applied to. */
  before: State;
  periods: { candidate: Candidate; work: PeriodWork }[];
  /** What this update left out or failed by itself, for the task message. */
  report: UpdateReport;
};

class GuidanceBlocked extends Error {
  constructor(readonly reason: GuidanceReason) {
    super(reason);
  }
}

export class FocusController {
  config: Config;
  readonly integration: FocusIntegration;
  state: State | null = null;
  /** Set while `state` is an earlier AI floor shown for reading only, because the latest floor is not ready. */
  readOnly: { messageId: number; reason: string } | null = null;
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
  private runEpoch = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private automatic: Promise<void> | null = null;
  private pendingReady = false;
  private disposed = false;
  private stops: (() => void)[] = [];
  private guidance: GuidanceState = { status: 'none' };
  private worldCache: Map<number, WorldObservation | null> | null = null;
  private rollback: RollbackNotice | null = null;
  private acceptedCheckpoint: {
    source: Omit<ScheduleSource, 'content'>;
    proposalId: string;
    before: string | null;
  } | null = null;
  private coordination: ScheduleCoordination = { status: 'idle' };
  private coordinationEpoch = 0;
  private yieldedSource = '';
  private waitFloor = '';
  private waitedSources = new Set<string>();
  private predictionWait: {
    source: ScheduleSource;
    startedAt: number;
    previousAt: number;
    taskId: string;
    timer: ReturnType<typeof setTimeout>;
    finish: (proceed: boolean) => void;
  } | null = null;

  constructor(readonly platform: Platform) {
    this.config = ConfigSchema.parse(platform.loadConfig());
    this.integration = new FocusIntegration(
      (messageId) => platform.readIntegration?.(messageId, this.config) ?? unavailable('unsupported'),
      (reason) => {
        if (
          this.guidance.status === 'waiting' &&
          this.integration.current()?.nonce !== this.guidance.source?.nonce
        ) {
          this.setGuidance({ ...this.guidance, status: 'ended', reason: reason ?? 'request_expired' });
        }
        this.pollPredictionWait();
        this.notify();
      },
    );
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
    const stopTick = this.platform.onIntegrationTick?.(() => {
      this.checked(() => {
        this.pollPredictionWait();
        this.refreshGuidance();
      });
    });
    if (stopTick) {
      this.stops.push(stopTick);
    }
    const unbind = this.platform.bindIntegration?.({
      version: INTEGRATION_VERSION,
      prepare: (messageId, options) => this.integration.prepare(messageId, options, this.writes),
      lookup: (nonce) => this.integration.lookup(nonce),
    });
    if (unbind) {
      this.stops.push(unbind);
    }
    this.stops.push(
      this.platform.onReady(() => {
        this.cancelAll();
        if (this.readOnly) {
          // The floor is ready now; replace the read-only view with it.
          void this.refresh();
        }
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
        this.dismissRollback();
        this.waitFloor = '';
        this.waitedSources.clear();
        this.yieldedSource = '';
        this.setCoordination({ status: 'idle' });
        this.integration.invalidate();
        this.cancelAll();
        this.pendingReady = false;
        this.candidates = [];
        this.guidance = { status: 'none' };
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
    this.integration.dispose();
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
      this.readOnly = null;
      this.platform.inject(snapshot.state, this.config.newsPrompt);
      this.error = '';
    } catch (error) {
      // The next AI reply builds on the nearest saved floor, so show and inject that state.
      const shown =
        error instanceof FloorNotReady ? await this.platform.peek?.(this.config).catch(() => null) : null;
      if (this.disposed) {
        return;
      }
      if (shown) {
        this.state = shown.state;
        this.readOnly = { messageId: shown.messageId, reason: error instanceof Error ? error.message : '' };
        this.platform.inject(shown.state, this.config.newsPrompt);
        this.error = '';
      } else {
        this.state = null;
        this.readOnly = null;
        this.report(error);
      }
    }
    this.notify();
  }
  /** Serialize local saves so concurrent API replies apply to the latest committed state. */
  private writeState(operation: (snapshot: Snapshot) => State | null, signal?: AbortSignal): Promise<State> {
    const epoch = this.runEpoch;
    const save = this.writes.then(async () => {
      const checkCancelled = () => {
        signal?.throwIfAborted();
        if (this.disposed || epoch !== this.runEpoch) {
          throw new DOMException('任务已取消', 'AbortError');
        }
      };
      checkCancelled();
      const snapshot = await this.platform.read(this.config);
      checkCancelled();
      const next = operation(snapshot);
      if (next === null) {
        return snapshot.state;
      }
      await this.platform.commit(snapshot, next);
      return next;
    });
    this.writes = save.catch(() => {});
    return save;
  }
  /** Commit a parsed update; only the first saved receipt returns work for the next period. */
  async commitUpdate(
    proposal: Proposal,
    source: Snapshot,
    signal?: AbortSignal,
    verifyExternal?: () => void,
  ): Promise<UpdateCommit> {
    if (proposal.until !== source.day) {
      throw new Error('更新终点必须等于来源故事时间');
    }
    const periods: UpdateCommit['periods'] = [];
    let before = source.state;
    let report: UpdateReport = { skipped: [], expired: [] };
    const state = await this.writeState((current) => {
      source.signal?.throwIfAborted();
      verifyExternal?.();
      before = current.state;
      if (current.state.receipts.includes(proposal.id)) {
        return null;
      }
      report = { skipped: [], expired: [] };
      const next = this.proposedState('update', current, proposal, undefined, report);
      next.schedules.update = { turn: source.turn, day: source.day };
      for (const transition of proposal.transitions) {
        const country = next.countries[transition.country];
        if (!country.enabled || !country.autoPeriod || country.calibration) {
          // The player decides on this change of government; a newer one replaces it.
          if (country.enabled && transition.cause === 'government') {
            country.politics!.pending = {
              ruling: transition.ruling!,
              reason: transition.reason,
              at: proposal.until,
            };
          }
          continue;
        }
        periods.push({
          candidate: {
            id: country.id,
            name: country.name,
            description: country.description,
            evidence: country.evidence,
          },
          work: { transition },
        });
      }
      return next;
    }, signal ?? source.signal);
    return { state, before, periods, report };
  }
  /** The world task's guidance for the latest registered request on this floor. */
  get worldGuidance(): GuidanceState {
    return structuredClone(this.guidance);
  }
  private setGuidance(state: GuidanceState): void {
    if (sameData(this.guidance, state)) {
      return;
    }
    this.guidance = structuredClone(state);
    this.notify();
  }
  /** Called by the platform's integration timer. */
  refreshGuidance(): void {
    this.checked(() => this.checkGuidance());
  }
  /** One integration check reads each floor and its world run once. */
  private checked<T>(check: () => T): T {
    if (this.worldCache) {
      return check();
    }
    this.worldCache = new Map();
    try {
      return this.integration.cached(check);
    } finally {
      this.worldCache = null;
    }
  }
  /** Inside a check, callers share the observation; they only read it. */
  private readWorld(messageId: number): WorldObservation | null | undefined {
    const cache = this.worldCache;
    if (!cache) {
      return this.platform.readWorldProposal?.(messageId);
    }
    if (!cache.has(messageId)) {
      cache.set(messageId, this.platform.readWorldProposal?.(messageId) ?? null);
    }
    return cache.get(messageId);
  }
  /**
   * The guidance of the registered world member: its run on the same floor, recorded after the
   * registration. Throws the reason when there is none yet, or when none will come.
   */
  private guidanceText(registration: IntegrationRegistration): string {
    const observation = this.readWorld(registration.messageId);
    if (!observation) {
      throw new GuidanceBlocked('workflow_unknown');
    }
    const { world } = registration;
    if (
      !world ||
      !observation.member ||
      world.taskId !== observation.member.taskId ||
      world.rootId !== observation.member.rootId
    ) {
      throw new GuidanceBlocked('member_mismatch');
    }
    const run = observation.run;
    if (!run || run.messageId !== registration.messageId || run.at < registration.registeredAt) {
      throw new GuidanceBlocked('waiting_workflow');
    }
    const results = run.taskResults.filter((result) => result.taskId === world.taskId);
    if (results.length !== 1) {
      throw new GuidanceBlocked('waiting_workflow');
    }
    const [result] = results;
    if (result.skipped) {
      throw new GuidanceBlocked('world_skipped');
    }
    if (!result.success) {
      throw new GuidanceBlocked('world_failed');
    }
    try {
      return parseWorldGuidance(result.extractedTags?.[GUIDANCE_TAG] ?? '');
    } catch {
      throw new GuidanceBlocked('missing_guidance');
    }
  }
  /** A registered request waits for its world run; guidance starts the local update at once. */
  private checkGuidance(): void {
    if (this.disposed) {
      return;
    }
    this.observeRollback();
    const registration = this.integration.current();
    if (!registration) {
      return;
    }
    const { chatId, messageId, swipeId, now, nonce } = registration;
    const source: GuidanceSource = { chatId, messageId, swipeId, now, nonce };
    if (this.guidance.source?.nonce === nonce && this.guidance.status !== 'waiting') {
      return;
    }
    try {
      const input = this.integration.readSource(messageId);
      if ('status' in input) {
        throw new GuidanceBlocked(input.reason);
      }
      // Guidance only advises; a changed national state is checked again by the update itself.
      if (input.chatId !== chatId || input.swipeId !== swipeId || input.now !== now) {
        throw new GuidanceBlocked('source_changed');
      }
      const text = this.guidanceText(registration);
      this.setGuidance({ status: 'started', source });
      void this.runGuided({ ...source, text }).catch((error) => this.report(error));
    } catch (error) {
      this.endGuidance(error instanceof GuidanceBlocked ? error.reason : 'read_failed', source);
    }
  }
  private endGuidance(reason: GuidanceReason, source: GuidanceSource): void {
    if (['waiting_workflow', 'workflow_unknown', 'mvu_busy', 'update_busy', 'read_failed'].includes(reason)) {
      this.setGuidance({ status: 'waiting', reason, source });
      return;
    }
    this.setGuidance({ status: 'ended', reason, source });
    this.integration.invalidate();
    // The scheduled update stepped aside for this world run. If the run finished without guidance,
    // run it now; if the floor changed instead, the new floor schedules its own update.
    const finished = ['world_failed', 'world_skipped', 'missing_guidance', 'member_mismatch'].includes(
      reason,
    );
    const floor = this.scheduleIdentity({ ...source, content: '' });
    if (this.coordination.status === 'guidance_wait' && this.yieldedSource === floor) {
      this.yieldedSource = '';
      this.setCoordination({
        ...this.coordination,
        status: 'idle',
        reason: finished ? 'result' : 'source_changed',
      });
      if (finished) {
        void this.runTask('update', undefined, undefined, 'scheduled').catch((error) => this.report(error));
      }
    }
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
          '故事时间已前进，请先完成「更新局势」，再开始、暂停或交接国策；避免把新操作倒填至过去。',
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
      throw new Error('API 名称不可重复');
    }
    for (const job of Object.values(parsed.jobs)) {
      if (![job.api, ...job.fallback].every((name) => !name || names.has(name))) {
        throw new Error('任务引用不存在的 API');
      }
    }
    this.platform.saveConfig(parsed);
    this.integration.invalidate();
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
    this.coordinationEpoch++;
    this.finishPredictionWait(false, 'cancelled');
    this.runEpoch++;
    this.progress.clear();
    for (const aborter of this.aborters.values()) {
      aborter.abort();
    }
  }
  async runScheduled(): Promise<void> {
    const epoch = this.runEpoch;
    const coordinationEpoch = this.coordinationEpoch;
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
      const due = scheduledDue(job, snapshot, kind);
      if (due && (kind === 'identify' || Object.values(snapshot.state.countries).some((c) => c.enabled))) {
        if (kind === 'update') {
          await this.scheduledUpdate(snapshot, epoch, coordinationEpoch);
        } else {
          await this.run(kind);
        }
      }
    }
  }
  get rollbackNotice(): RollbackNotice | null {
    return structuredClone(this.rollback);
  }
  dismissRollback(): void {
    this.rollback = null;
    this.acceptedCheckpoint = null;
    this.notify();
  }
  private observeRollback(): void {
    const checkpoint = this.acceptedCheckpoint;
    if (!checkpoint) {
      return;
    }
    const source = this.integration.readSource(checkpoint.source.messageId);
    if ('status' in source) {
      if (source.reason === 'not_latest' || source.reason === 'not_assistant') {
        this.dismissRollback();
      }
      return;
    }
    const identity = { chatId: source.chatId, messageId: source.messageId, swipeId: source.swipeId };
    if (!sameData(identity, checkpoint.source)) {
      this.dismissRollback();
      return;
    }
    if (this.rollback) {
      return;
    }
    const receiptMissing = !source.state.receipts.includes(checkpoint.proposalId);
    if (!receiptMissing) {
      return;
    }
    const returnedToBefore = worldFingerprint(source.state) === checkpoint.before;
    if (receiptMissing || returnedToBefore) {
      this.rollback = {
        ...identity,
        proposalId: checkpoint.proposalId,
        detectedAt: Date.now(),
        receiptMissing,
        returnedToBefore,
      };
      this.notify();
    }
  }
  get scheduleCoordination(): ScheduleCoordination {
    return structuredClone(this.coordination);
  }
  private scheduleIdentity(source: ScheduleSource): string {
    return JSON.stringify([source.chatId, source.messageId, source.swipeId]);
  }
  private setCoordination(state: ScheduleCoordination): void {
    this.coordination = state;
    this.notify();
  }
  private finishPredictionWait(proceed: boolean, reason: ScheduleCoordination['reason']): void {
    const wait = this.predictionWait;
    if (!wait) {
      return;
    }
    clearTimeout(wait.timer);
    this.predictionWait = null;
    this.setCoordination({ ...this.coordination, status: proceed ? 'idle' : 'cancelled', reason });
    wait.finish(proceed);
  }
  private pollPredictionWait(): void {
    const currentSource = this.platform.readScheduleSource?.();
    if (
      currentSource &&
      this.coordination.source &&
      this.scheduleIdentity(currentSource) !==
        this.scheduleIdentity({ ...this.coordination.source, content: '' })
    ) {
      this.yieldedSource = '';
      this.finishPredictionWait(false, 'source_changed');
      this.setCoordination({ status: 'idle' });
    }
    const wait = this.predictionWait;
    if (!wait) {
      return;
    }
    if (!sameData(currentSource, wait.source)) {
      this.finishPredictionWait(false, 'source_changed');
      return;
    }
    const registration = this.integration.current();
    if (registration && this.integration.lookup(registration.nonce)) {
      this.finishPredictionWait(true, 'nonce');
      return;
    }
    const run = this.readWorld(wait.source.messageId)?.run;
    if (
      run &&
      run.messageId === wait.source.messageId &&
      run.at >= wait.startedAt &&
      run.at > wait.previousAt
    ) {
      const result = run.taskResults.find((item) => item.taskId === wait.taskId);
      if (result && (result.skipped || !result.extractedTags?.[GUIDANCE_TAG]?.trim())) {
        this.finishPredictionWait(true, 'result');
      }
    }
  }
  private async scheduledUpdate(snapshot: Snapshot, epoch: number, coordinationEpoch: number): Promise<void> {
    if (this.predictionWait || coordinationEpoch !== this.coordinationEpoch) {
      return;
    }
    const observed = this.platform.readScheduleSource?.();
    if (this.platform.readScheduleSource && (!observed || observed.messageId !== snapshot.messageId)) {
      this.setCoordination({ status: 'cancelled', reason: 'source_changed' });
      return;
    }
    const source = observed ?? {
      chatId: this.platform.chatId(),
      messageId: snapshot.messageId,
      swipeId: 0,
      content: '',
    };
    const floor = this.scheduleIdentity(source);
    if (this.waitFloor !== floor) {
      this.waitFloor = floor;
      this.waitedSources.clear();
      this.yieldedSource = '';
    }
    const yieldToWorld = () => {
      const registration = this.integration.current();
      const valid = registration && this.integration.lookup(registration.nonce);
      if (valid || this.yieldedSource === floor) {
        this.yieldedSource = floor;
        const { content: _content, ...identity } = source;
        this.setCoordination({ status: 'guidance_wait', source: identity, reason: 'nonce' });
        this.refreshGuidance();
        return true;
      }
      return false;
    };
    if (yieldToWorld()) {
      return;
    }
    const prediction = this.platform.predictWorldSchedule?.(source) ?? {
      status: 'unknown' as const,
      reason: 'unavailable' as const,
    };
    const key = JSON.stringify([source, snapshot.day, worldFingerprint(snapshot.state)]);
    const { content: _content, ...identity } = source;
    this.setCoordination({ status: 'idle', source: identity, prediction });
    if (
      prediction.status === 'due' &&
      prediction.member &&
      this.platform.readScheduleSource &&
      !this.waitedSources.has(key)
    ) {
      this.waitedSources.add(key);
      const startedAt = Date.now();
      const previousAt = this.platform.readWorldProposal?.(source.messageId)?.run?.at ?? -1;
      const proceed = await new Promise<boolean>((finish) => {
        const timer = setTimeout(() => {
          this.pollPredictionWait();
          this.finishPredictionWait(true, 'timeout');
        }, PREDICTION_WAIT_MS);
        this.predictionWait = {
          source,
          startedAt,
          previousAt,
          taskId: prediction.member!.taskId,
          timer,
          finish,
        };
        this.setCoordination({
          status: 'prediction_wait',
          source: identity,
          prediction,
          startedAt,
          deadline: startedAt + PREDICTION_WAIT_MS,
        });
      });
      if (
        !proceed ||
        this.disposed ||
        epoch !== this.runEpoch ||
        coordinationEpoch !== this.coordinationEpoch
      ) {
        return;
      }
      if (yieldToWorld()) {
        return;
      }
      const current = await this.platform.read(this.config);
      if (
        this.disposed ||
        epoch !== this.runEpoch ||
        coordinationEpoch !== this.coordinationEpoch ||
        current.identity !== snapshot.identity ||
        current.day !== snapshot.day ||
        !sameData(this.platform.readScheduleSource(), source)
      ) {
        this.setCoordination({ ...this.coordination, status: 'cancelled', reason: 'source_changed' });
        return;
      }
      const job = this.config.jobs.update;
      const due = scheduledDue(job, current, 'update');
      if (!due || !Object.values(current.state.countries).some((country) => country.enabled)) {
        this.setCoordination({ ...this.coordination, status: 'idle', reason: 'not_due' });
        return;
      }
    }
    // runTask checks the nonce and takes ownership synchronously, including arrivals after the await.
    await this.runTask('update', undefined, undefined, 'scheduled');
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
  /** Structures drawn for running generations, so countries generated together differ. */
  private drawing = new Map<string, Structure>();
  /** Draw structure lots for a country, avoiding the shapes of other countries and running drafts. */
  private drawFor(state: State, id: string): Structure {
    const taken = [
      ...Object.values(state.countries)
        .filter((country) => country.id !== id && country.shape)
        .map((country) => signature(country.shape!)),
      ...[...this.drawing].filter(([other]) => other !== id).map(([, structure]) => signature(structure)),
    ];
    return drawStructure({ large: state.settings.size === 'large', taken });
  }
  async enable(candidates: Candidate[]): Promise<void> {
    // Route pools limit requests; independent countries keep their own result and failure state.
    await Promise.all(candidates.map((candidate) => this.run('generate', candidate)));
  }
  /**
   * Start the next period for the country's pending change of government (spec 五「待决」). The
   * player approves it, so the autoPeriod switch does not apply. A country in calibration is refused.
   */
  async approvePending(id: string): Promise<void> {
    const country = this.state?.countries[id];
    const pending = country?.politics?.pending;
    if (!country || !pending) {
      throw new Error('此国没有待决的执政更替');
    }
    const work: PeriodWork = {
      transition: {
        country: id,
        cause: 'government',
        ruling: pending.ruling,
        reason: pending.reason,
        invalidateActive: true,
      },
      approved: true,
    };
    checkTransition(this.state!, work.transition, true);
    const { name, description, evidence } = country;
    await this.run('generate', { id, name, description, evidence }, work);
  }
  async run(kind: JobKind, candidate?: Candidate, periodWork?: PeriodWork): Promise<void> {
    if (kind === 'update') {
      this.coordinationEpoch++;
      this.finishPredictionWait(false, 'manual');
      this.yieldedSource = '';
      this.setCoordination({ ...this.coordination, status: 'idle', reason: 'manual' });
    }
    await this.runTask(kind, candidate, periodWork, 'manual');
  }
  /** Update this floor by the world task's guidance; a failed run can retry with the same guidance. */
  runGuided(guidance: WorldGuidance): Promise<void> {
    this.coordinationEpoch++;
    this.finishPredictionWait(false, 'result');
    this.yieldedSource = '';
    return this.runTask('update', undefined, undefined, 'guided', guidance);
  }
  private async runTask(
    kind: JobKind,
    candidate?: Candidate,
    periodWork?: PeriodWork,
    mode: 'manual' | 'scheduled' | 'guided' = 'manual',
    guidance?: WorldGuidance,
  ): Promise<void> {
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
    // A guided update owns its own registration, so it starts like a manual one.
    const access =
      kind === 'update'
        ? this.integration.beginUpdate(mode === 'scheduled' ? 'scheduled' : 'manual')
        : undefined;
    if (access && access.status !== 'acquired') {
      if (access.status === 'waiting') {
        this.yieldedSource = this.waitFloor;
        this.setCoordination({ ...this.coordination, status: 'guidance_wait', reason: 'nonce' });
        this.refreshGuidance();
      }
      return;
    }
    if (kind === 'update' && mode !== 'manual') {
      this.setCoordination({ ...this.coordination, status: 'running' });
    }
    const releaseUpdate = () => {
      if (access?.status === 'acquired') {
        this.integration.endUpdate(access.token);
      }
    };
    const id = requestId('job');
    const aborter = new AbortController();
    aborter.signal.addEventListener('abort', releaseUpdate, { once: true });
    const status: JobStatus = {
      id,
      kind,
      state: 'queued',
      message: '准备任务',
      time: new Date().toLocaleTimeString(),
      ...(candidate ? { label: candidate.name, candidate } : {}),
      ...(periodWork ? { periodWork, label: `${candidate?.name} · 换期` } : {}),
      ...(guidance ? { guidance, label: '依世界指引' } : {}),
    };
    this.jobs.unshift(status);
    this.jobs = this.jobs.slice(0, 40);
    this.aborters.set(id, aborter);
    this.notify();
    let sourceSignal: AbortSignal | undefined;
    const cancelSource = () => aborter.abort();
    const periods: UpdateCommit['periods'] = [];
    try {
      aborter.signal.throwIfAborted();
      status.state = 'running';
      status.started = Date.now();
      status.message = '正在分析本楼资料';
      this.notify();
      const snapshot = await this.platform.read(this.config, kind);
      if (guidance && (snapshot.messageId !== guidance.messageId || snapshot.day !== guidance.now)) {
        throw new Error('世界指引所属的楼层或故事时间已改变，没有套用。');
      }
      sourceSignal = snapshot.signal;
      sourceSignal?.addEventListener('abort', cancelSource, { once: true });
      if (sourceSignal?.aborted) {
        aborter.abort();
      }
      aborter.signal.throwIfAborted();
      if (periodWork) {
        checkTransition(snapshot.state, periodWork.transition, periodWork.approved);
      }
      // One draw per run: retries in this run keep the same lots.
      const structure =
        kind === 'generate' && candidate ? this.drawFor(snapshot.state, candidate.id) : undefined;
      if (structure) {
        this.drawing.set(candidate!.id, structure);
      }
      if (kind === 'generate' && !candidate) {
        throw new Error('请先选择要生成的候选国家');
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
        status.message = label ?? (kind === 'generate' ? '单次生成完整国策树' : '分析本楼局势');
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
          status.message = `沿用先前完成的骨架与 ${Object.keys(progress.filled).length} 项内容`;
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
                days: focusDays,
                periodDays: periodDays[snapshot.state.settings.pace],
                ...shapeLimits(snapshot.state.settings, structure?.type.key as TreeType | undefined),
              },
              ...(structure ? { structure: structureData(structure) } : {}),
              instructions: `生成下一期与旧期摘要。tree.nodes 只输出新节点，承接节点由程序原样保留；${
                periodWork.transition.cause === 'government'
                  ? '政权已更替，anchor 只作历史保留，新节点不得以它为前置'
                  : '新节点可引用 anchor 作必要前置，不相关议程可独立推进'
              }。节点与互斥组使用 prefix。不得生成 historical 或改变既有能力、数值、事实及事件。保留仍有效的 longTerm 的 id 与原文，修订理由写 analysis。summary 只叙述已发生事实与旧期终止原因，不把新计划当成果。总数含 anchor，以 limits 为篇幅目标，不凑数。`,
            },
            PeriodReplySchema,
            (value) => {
              transitionPeriod(snapshot.state, periodWork.transition, value, periodWork.approved);
            },
            '生成下一期与旧期摘要',
          )
        : kind === 'generate'
          ? await generateCountry(
              snapshot,
              candidate!,
              ask,
              progress,
              segmentMax,
              this.config.jobs.generate.retries,
              structure,
            )
          : await ask(
              kind,
              {
                ...taskData(snapshot, kind === 'reshape'),
                ...(kind === 'update' ? updateData(snapshot.state, snapshot.day) : {}),
                ...(guidance ? { guidance: guidance.text } : {}),
              },
              kind === 'identify' ? CandidatesSchema : ProposalSchema,
              (value) => {
                this.proposedState(kind, snapshot, value, candidate);
              },
            );
      aborter.signal.throwIfAborted();
      // Apply to current data in save order, without comparing it to the request input.
      let next: State;
      let saved = '验证通过，已保存至本楼';
      if (kind === 'update') {
        const proposal = ProposalSchema.parse(result);
        const committed = await this.commitUpdate(proposal, snapshot, aborter.signal);
        next = committed.state;
        periods.push(...committed.periods);
        status.changes = {
          until: proposal.until,
          countries: letterDigest(committed.before, committed.state, proposal),
        };
        if (committed.report.skipped.length || committed.report.expired.length) {
          saved = reportMessage(committed.report, committed.state);
        }
        if (guidance && !committed.before.receipts.includes(proposal.id)) {
          // A workflow re-run on this floor may write back the floor without this update.
          this.acceptedCheckpoint = {
            source: { chatId: guidance.chatId, messageId: guidance.messageId, swipeId: guidance.swipeId },
            proposalId: proposal.id,
            before: worldFingerprint(committed.before),
          };
          this.rollback = null;
        }
      } else {
        next = await this.writeState((current) => {
          const state = periodWork
            ? transitionPeriod(
                current.state,
                periodWork.transition,
                PeriodReplySchema.parse(result),
                periodWork.approved,
              )
            : this.proposedState(kind, current, result, candidate);
          if (structure && state.countries[candidate!.id]) {
            state.countries[candidate!.id].shape = structure;
          }
          state.schedules[kind] = { turn: snapshot.turn, day: snapshot.day };
          return state;
        }, aborter.signal);
      }
      if (kind === 'identify') {
        this.candidates = candidateKeys(CandidatesSchema.parse(result).countries, next);
      }
      if (kind === 'generate') {
        this.progress.delete(progressKey);
      }
      status.state = 'success';
      status.message = kind === 'identify' ? '候选国家已就绪，请勾选启用' : saved;
      await this.refresh();
    } catch (error) {
      const message = redactApiError(error, this.config.apis);
      status.state =
        aborter.signal.aborted || (error instanceof Error && error.name === 'AbortError')
          ? 'cancelled'
          : 'failed';
      // Logs omit model output and credentials; private proposal details stay in MVU.
      status.message =
        status.state === 'cancelled' ? '已取消，未套用结果' : `未提交：${message.slice(0, 1500)}`;
    } finally {
      if (kind === 'update' && mode !== 'manual' && this.coordination.status === 'running') {
        this.setCoordination({ ...this.coordination, status: 'idle' });
      }
      releaseUpdate();
      aborter.signal.removeEventListener('abort', releaseUpdate);
      sourceSignal?.removeEventListener('abort', cancelSource);
      status.finished = Date.now();
      this.aborters.delete(id);
      // A saved country keeps its shape in the state; a failed draft frees its draw.
      if (kind === 'generate' && candidate) {
        this.drawing.delete(candidate.id);
      }
      this.notify();
    }
    // Each country's next period shares the same generation route pools as initial trees.
    if (!this.disposed && !aborter.signal.aborted) {
      await Promise.all(periods.map((period) => this.run('generate', period.candidate, period.work)));
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
    let chain =
      prompts ??
      config.jobs[kind].prompts
        .filter((item) => item.enabled || item.kind === 'data')
        .map((item) => ({ ...item, content: promptText(item, kind) }));
    // These notes reach the model even if the task was customized or disabled.
    const note = (content: string, name: string) => {
      if (chain.some((item) => item.kind === 'task')) {
        chain = chain.map((item) =>
          item.kind === 'task' ? { ...item, content: `${item.content}\n${content}` } : item,
        );
      } else {
        const task = { id: 'task', kind: 'task' as const, name, role: 'system' as const, content };
        chain = [task, ...chain];
      }
    };
    // The state lists enabled countries only.
    const countries = (payload as { state?: { countries?: { politics?: unknown }[] } }).state?.countries;
    if ((kind === 'update' || kind === 'reshape') && countries?.some((country) => country.politics)) {
      note(POLITICS_TASK, '派系说明');
      // Only the update task may propose transitions.
      if (kind === 'update') {
        note(GOVERNMENT_TASK, '执政更替说明');
      }
    }
    // Generation may write politics: the first generation and the period stage, not skeleton stages.
    const stage = (payload as { stage?: unknown }).stage;
    if (kind === 'generate' && (stage === 'generate' || stage === 'period')) {
      note(GENERATE_POLITICS_TASK, '派系说明');
    }
    if (typeof (payload as { guidance?: unknown }).guidance === 'string') {
      note(GUIDANCE_TASK, '世界指引说明');
    }
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
        name: '（执行时为勾选的国家）',
        description: '预览用示例候选国家',
        evidence: '预览',
      };
      // Larger sizes start with the skeleton request; preview that one.
      const segmented = isSegmented(snapshot.state.settings.size);
      // The preview shows an example draw; each real run draws its own lots.
      const plan = segmented
        ? skeletonPlan(snapshot, candidate)
        : generationPlan(snapshot, candidate, this.drawFor(snapshot.state, candidate.id));
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
    normalize?: (value: unknown) => unknown,
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
        throw new Error('任务引用不存在的 API');
      }
    }
    const pool = this.pool(kind, chain);
    // Start on the first route with a free slot, then fail over through the rest of the chain.
    status.state = 'queued';
    status.message = '等待 API 连接空位';
    this.notify();
    const first = await pool.acquire(chain, signal);
    status.state = 'running';
    status.message = stageMessage;
    this.notify();
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
              const stopWaiting = () => reject(new Error('API 任务已取消或超时'));
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
            const parsed = parseJsonReply(output);
            const result = schema.parse(
              repairReply(normalize ? normalize(parsed) : parsed, (data as { stage?: string }).stage),
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
                    ? `回应不是完整的 JSON（${error.message}），可能超出输出长度而被截断；请精简文字并输出完整对象`
                    : error instanceof Error
                      ? // The idle check lists every idle AI country, which can pass 1,000 characters.
                        error.message.slice(0, 2000)
                      : '';
            feedback = reason
              ? `上次回应未通过本机验证：${reason}。请修正后重新输出完整 JSON。`
              : '前次回应未通过，请重新核对 Schema 与本阶段所有约束。';
            status.message = `${stageMessage} · ${route} 尝试 ${attempt + 1}/${settings.retries + 1} 未通过${reason ? `：${reason.slice(0, 120)}` : ''}`;
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
    throw lastError ?? new Error('没有可用的 API 回应');
  }
  private proposedState(
    kind: JobKind,
    snapshot: Snapshot,
    result: unknown,
    candidate?: Candidate,
    report: UpdateReport = { skipped: [], expired: [] },
  ): State {
    if (kind === 'identify') {
      const next = structuredClone(snapshot.state);
      next.revision++;
      return next;
    }
    if (kind === 'generate') {
      const tree = TreeSchema.parse(result);
      if (tree.id !== candidate?.id) {
        throw new Error('生成的国家 ID 与选取国家不一致');
      }
      const limits = sizeLimits;
      const [min, max] = limits[snapshot.state.settings.size];
      if (!tree.nodes.length || tree.nodes.length > max) {
        throw new Error(`生成规模须为 ${min}–${max} 节点`);
      }
      return installCountry(snapshot.state, { ...tree, autoPeriod: true }, snapshot.day);
    }
    const proposal = ProposalSchema.parse(result);
    if (proposal.until !== snapshot.day) {
      throw new Error('更新终点必须等于来源故事时间');
    }
    const next = applyProposal(
      snapshot.state,
      proposal,
      kind === 'reshape',
      kind === 'update' ? report : undefined,
    );
    if (proposal.transitions.length && kind !== 'update') {
      throw new Error('只有局势更新可发起换期');
    }
    const countries = new Set<string>();
    for (const transition of proposal.transitions) {
      const country = next.countries[transition.country];
      if (!country) {
        throw new Error('换期引用不存在的国家');
      }
      if (country.enabled && country.autoPeriod && !country.calibration) {
        checkTransition(next, transition);
      } else {
        // Such a change waits for the player, but it must still name a valid ruling faction.
        checkGovernment(next, transition);
      }
      if (countries.has(transition.country)) {
        throw new Error('同一次更新不可对同国重复换期');
      }
      countries.add(transition.country);
    }
    return next;
  }
}

/**
 * Candidates are keyed by their name as written in the worldbook, whatever ID the model chose, so
 * the floor variable and the worldbook entry use the same name. Known countries and repeats drop.
 */
export function candidateKeys(candidates: Candidate[], state: State): Candidate[] {
  const names = new Set(Object.values(state.countries).map((country) => country.name.trim()));
  const seen = new Set<string>();
  return candidates
    .map((candidate) => ({ ...candidate, id: countryKey(candidate.name) ?? candidate.id }))
    .filter((candidate) => {
      const fresh =
        !state.countries[candidate.id] && !names.has(candidate.name.trim()) && !seen.has(candidate.id);
      seen.add(candidate.id);
      return fresh;
    });
}
