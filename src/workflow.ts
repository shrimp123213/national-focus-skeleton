import { z } from 'zod';
import { applyProposal, countryKey, installCountry, removeCountry } from './engine';
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
import { checkTransition, periodAnchor, PeriodReplySchema, transitionPeriod } from './periods';
import { drawStructure, signature, structureData, type Structure, type TreeType } from './structure';
import { DATA_TOKEN, promptText, REPAIR_TASK } from './prompts';
import {
  ProposalRepairSchema,
  type ProposalRepairMaterial,
  type ProposalRepairStatus,
} from './proposal-repair';
import { currentApiName, parseJsonReply, redactApiError, validateApi } from './api-config';
import { repairReply } from './repair';
import { assertInputSize, InputSizeError, messageCharacters } from './sources';
import { RoutePool, routeLimits } from './route-pool';
import { FocusIntegration, sameData, unavailable, type IntegrationRegistration } from './integration';
import {
  parseWorldProposal,
  parseWorldProposalEnvelope,
  worldEvidence,
  worldFingerprint,
  type ProposalDiagnostic,
  type ProposalReason,
  type ProposalReceptionState,
  type WorldEvidence,
  type WorldObservation,
} from './world-proposal';
import {
  PREDICTION_WAIT_MS,
  type ScheduleSource,
  type ScheduleCoordination,
  type RollbackNotice,
} from './world-schedule';
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
  periods: { candidate: Candidate; work: PeriodWork }[];
};

class ProposalBlocked extends Error {
  constructor(
    readonly reason: ProposalReason,
    readonly detail?: string,
  ) {
    super(reason);
  }
}
type ProposalReview = {
  registration: IntegrationRegistration;
  proposal: Proposal;
  preview: State;
  evidence: WorldEvidence;
  evidenceKey: string;
  repair?: ProposalRepairMaterial;
};

export class FocusController {
  config: Config;
  readonly integration: FocusIntegration;
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
  private runEpoch = 0;
  private writes: Promise<unknown> = Promise.resolve();
  private automatic: Promise<void> | null = null;
  private pendingReady = false;
  private disposed = false;
  private stops: (() => void)[] = [];
  private reception: ProposalReceptionState = { status: 'none' };
  private diagnostics: ProposalDiagnostic[] = [];
  private review: ProposalReview | null = null;
  private repairMaterial: ProposalRepairMaterial | null = null;
  private repairStatus: ProposalRepairStatus | null = null;
  private repairing: Promise<boolean> | null = null;
  private repairAborter: AbortController | null = null;
  private accepting: Promise<boolean> | null = null;
  private overwriteTicks = 0;
  private worldCache: Map<number, WorldObservation | null> | null = null;
  private proposalPeriods: AbortController | null = null;
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
        const current = this.integration.current();
        const material = this.repairMaterial ?? this.review?.repair;
        if (
          reason === 'update_started' ||
          (current && material && current.nonce !== material.registration.nonce)
        ) {
          this.invalidateRepair(reason ?? 'request_expired');
        }
        if (this.review && !this.review.repair && current?.nonce !== this.review.registration.nonce) {
          this.proposalPeriods?.abort();
          this.setProposalState({
            ...this.reception,
            status: 'expired',
            reason: reason ?? 'request_expired',
          });
          this.review = null;
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
        this.refreshProposal();
      });
    });
    if (stopTick) {
      this.stops.push(stopTick);
    }
    const unbind = this.platform.bindIntegration?.({
      version: 1,
      prepare: (messageId, options) => this.integration.prepare(messageId, options, this.writes),
      lookup: (nonce) => this.integration.lookup(nonce),
    });
    if (unbind) {
      this.stops.push(unbind);
    }
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
        this.repairSourceFailed(new ProposalBlocked('source_changed'));
        this.dismissRollback();
        this.waitFloor = '';
        this.waitedSources.clear();
        this.yieldedSource = '';
        this.setCoordination({ status: 'idle' });
        this.integration.invalidate();
        this.cancelAll();
        this.pendingReady = false;
        this.candidates = [];
        this.repairMaterial = null;
        this.repairStatus = null;
        this.review = null;
        this.reception = { status: 'none' };
        this.restoreRepair();
        void this.refresh();
      }),
    );
    await this.refresh();
    this.restoreRepair();
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
      this.platform.inject(snapshot.state, this.config.newsPrompt);
      this.error = '';
    } catch (error) {
      this.state = null;
      this.report(error);
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
    const state = await this.writeState((current) => {
      source.signal?.throwIfAborted();
      verifyExternal?.();
      if (current.state.receipts.includes(proposal.id)) {
        return null;
      }
      const next = this.proposedState('update', current, proposal);
      next.schedules.update = { turn: source.turn, day: source.day };
      for (const transition of proposal.transitions) {
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
          work: { transition },
        });
      }
      return next;
    }, signal ?? source.signal);
    return { state, periods };
  }
  get externalProposal(): ProposalReceptionState {
    return structuredClone(this.reception);
  }
  get proposalRepair(): ProposalRepairStatus | null {
    return structuredClone(this.repairStatus);
  }
  private storeRepair(chatId = this.repairMaterial?.registration.chatId ?? this.platform.chatId()): void {
    try {
      this.platform.saveProposalRepair?.(this.repairMaterial, chatId);
    } catch (error) {
      if (this.repairStatus) {
        this.repairStatus.storageError = `修复材料仅保留在本次页面：${redactApiError(error, this.config.apis)}`;
      } else {
        this.report(error);
      }
    }
  }
  private restoreRepair(): void {
    try {
      const raw = this.platform.loadProposalRepair?.();
      if (!raw) {
        return;
      }
      const material = ProposalRepairSchema.parse(raw);
      if (material.registration.chatId !== this.platform.chatId()) {
        return;
      }
      this.repairMaterial = material;
      this.repairStatus = { status: 'available' };
      const { chatId, messageId, swipeId, now, nonce } = material.registration;
      this.setProposalState({
        status: 'rejected',
        reason: material.reason,
        detail: material.errors.join('\n'),
        source: { chatId, messageId, swipeId, now, nonce },
        evidence: material.evidence,
      });
      this.checkRepairSource(material);
    } catch (error) {
      if (this.repairMaterial) {
        this.repairSourceFailed(error);
      } else {
        this.report(error);
      }
    }
  }
  private invalidateRepair(reason: ProposalReason): void {
    this.repairAborter?.abort();
    if (this.review?.repair || this.repairMaterial) {
      this.proposalPeriods?.abort();
      if (this.review?.repair) {
        this.review = null;
      }
      this.setProposalState({ ...this.reception, status: 'expired', reason });
    }
    const chatId = this.repairMaterial?.registration.chatId;
    this.repairMaterial = null;
    this.repairStatus = null;
    if (chatId !== undefined) {
      this.storeRepair(chatId);
    }
  }
  private checkRepairSource(material: ProposalRepairMaterial): void {
    if (this.disposed) {
      throw new ProposalBlocked('disposed');
    }
    if (material.expired) {
      throw new ProposalBlocked('request_expired');
    }
    const {
      nonce: _nonce,
      requestId: _requestId,
      registeredAt: _at,
      world: _world,
      ...expected
    } = material.registration;
    const source = this.integration.readSource(expected.messageId);
    if ('status' in source) {
      throw new ProposalBlocked(source.reason);
    }
    if (!sameData(source, expected)) {
      throw new ProposalBlocked('source_changed');
    }
    const observation = this.readWorld(source.messageId);
    if (!observation?.run) {
      throw new ProposalBlocked('workflow_unknown');
    }
    const result = observation.run.taskResults.filter((item) => item.taskId === material.evidence.taskId);
    if (
      observation.run.messageId !== source.messageId ||
      result.length !== 1 ||
      observation.member?.taskId !== material.evidence.taskId ||
      observation.member.rootId !== material.evidence.rootId
    ) {
      throw new ProposalBlocked('source_changed');
    }
    const evidence = worldEvidence(observation, material.registration, result[0]);
    const key = JSON.stringify({
      at: observation.run.at,
      raw: result[0].extractedTags?.['国策提案'],
      evidence,
      fingerprint: observation.fingerprint,
    });
    if (key !== material.evidenceKey || !sameData(observation.world, material.world)) {
      throw new ProposalBlocked('source_changed');
    }
  }
  private repairSourceFailed(error: unknown): void {
    if (!this.repairMaterial && !this.review?.repair) {
      return;
    }
    const reason = error instanceof ProposalBlocked ? error.reason : 'read_failed';
    if (['mvu_busy', 'workflow_unknown', 'read_failed'].includes(reason)) {
      return;
    }
    this.repairAborter?.abort();
    if (this.repairStatus) {
      this.repairStatus = {
        ...this.repairStatus,
        status: 'expired',
        error: '修复来源已改变，请使用当前楼层重新更新局势。',
      };
    }
    if (this.repairMaterial) {
      this.repairMaterial.expired = true;
      this.storeRepair();
    }
    this.review = null;
    this.setProposalState({ ...this.reception, status: 'expired', reason });
  }
  get proposalDiagnostics(): ProposalDiagnostic[] {
    return structuredClone(this.diagnostics);
  }
  clearProposalDiagnostics(): void {
    this.diagnostics = [];
    this.notify();
  }
  private setProposalState(state: ProposalReceptionState): void {
    if (sameData(this.reception, state)) {
      return;
    }
    this.reception = structuredClone(state);
    this.diagnostics.unshift({
      at: Date.now(),
      status: state.status,
      reason: state.reason,
      detail: state.detail,
      source: structuredClone(state.source),
      proposalId: state.proposal?.id,
      evidence: structuredClone(state.evidence),
    });
    this.diagnostics = this.diagnostics.slice(0, 60);
    this.notify();
  }
  private proposalCandidate(registration: IntegrationRegistration): ProposalReview {
    const source = this.integration.readSource(registration.messageId);
    if ('status' in source) {
      throw new ProposalBlocked(source.reason);
    }
    const observation = this.readWorld(registration.messageId);
    if (!observation) {
      throw new ProposalBlocked('workflow_unknown');
    }
    const { world } = registration;
    if (
      !world ||
      !observation.member ||
      world.taskId !== observation.member.taskId ||
      world.rootId !== observation.member.rootId
    ) {
      throw new ProposalBlocked('member_mismatch');
    }
    const run = observation.run;
    if (!run || run.messageId !== registration.messageId || run.at < registration.registeredAt) {
      throw new ProposalBlocked('waiting_workflow');
    }
    const results = run.taskResults.filter((result) => result.taskId === world.taskId);
    if (results.length !== 1) {
      throw new ProposalBlocked('waiting_workflow');
    }
    const result = results[0];
    const evidence = worldEvidence(observation, registration, result);
    // Evidence is available to the reviewer even when it rules out acceptance.
    this.reception.evidence = structuredClone(evidence);
    if (result.skipped) {
      throw new ProposalBlocked('world_skipped');
    }
    if (!result.success) {
      throw new ProposalBlocked('world_failed');
    }
    // Addon also records successful path/format repairs as issues with kind "heal".
    if (
      evidence.patch.issues.some((issue) => issue.kind !== 'heal') ||
      evidence.patch.failedFragments.length
    ) {
      throw new ProposalBlocked('world_patch_failed');
    }
    const raw = result.extractedTags?.['国策提案'];
    if (!raw?.trim()) {
      throw new ProposalBlocked('missing_proposal');
    }
    const evidenceKey = JSON.stringify({ at: run.at, raw, evidence, fingerprint: observation.fingerprint });
    const failed = (reason: ProposalRepairMaterial['reason'], detail: string): never => {
      let envelope: ReturnType<typeof parseWorldProposalEnvelope> | undefined;
      try {
        envelope = parseWorldProposalEnvelope(raw);
      } catch {
        // Broken JSON still belongs to the matched task run; retain its untouched text.
      }
      if (envelope && envelope.nonce !== registration.nonce) {
        throw new ProposalBlocked('nonce_mismatch');
      }
      const originalId = (envelope?.proposal as { id?: unknown } | undefined)?.id;
      if (typeof originalId === 'string' && registration.state.receipts.includes(originalId)) {
        throw new ProposalBlocked('preview_changed', '原提案已有保存记录，不得以新的修复 ID 重复套用');
      }
      if (this.repairMaterial?.evidenceKey !== evidenceKey) {
        this.repairMaterial = structuredClone({
          version: 1,
          id: requestId('repair-source'),
          registration,
          reason,
          raw,
          errors: [detail],
          world: observation.world,
          evidence,
          evidenceKey,
        });
        this.repairStatus = { status: 'available' };
        this.storeRepair();
      }
      throw new ProposalBlocked(reason, detail);
    };
    let parsed: ReturnType<typeof parseWorldProposal>;
    try {
      parsed = parseWorldProposal(raw);
    } catch (error) {
      return failed('invalid_proposal', error instanceof Error ? error.message : String(error));
    }
    if (parsed.nonce !== registration.nonce) {
      throw new ProposalBlocked('nonce_mismatch');
    }
    if (parsed.proposal.until !== registration.now) {
      return failed(
        'until_mismatch',
        `提案终点 ${parsed.proposal.until} 与来源时间 ${registration.now} 不一致`,
      );
    }
    const snapshot: Snapshot = {
      identity: '',
      messageId: registration.messageId,
      day: registration.now,
      turn: 0,
      state: source.state,
      context: {},
    };
    let preview: State;
    try {
      preview = this.proposedState('update', snapshot, parsed.proposal);
    } catch (error) {
      return failed('invalid_rules', error instanceof Error ? error.message : String(error));
    }
    return {
      registration,
      proposal: parsed.proposal,
      preview,
      evidence,
      evidenceKey,
    };
  }
  private blockProposal(reason: ProposalReason, detail?: string): void {
    const waiting = ['waiting_workflow', 'mvu_busy', 'update_busy'].includes(reason);
    const expired = [
      'source_changed',
      'not_latest',
      'not_assistant',
      'request_expired',
      'preview_changed',
      'invalid_time',
    ].includes(reason);
    const unavailable = [
      'workflow_unknown',
      'missing_proposal',
      'invalid_proposal',
      'read_failed',
      'mvu_unavailable',
    ].includes(reason);
    const state: ProposalReceptionState = {
      ...this.reception,
      status: waiting ? 'waiting' : expired ? 'expired' : unavailable ? 'unavailable' : 'rejected',
      reason,
      detail,
    };
    // An unpaired/late workflow record can block acceptance, but cannot revoke a live request.
    const unpaired = [
      'workflow_unknown',
      'nonce_mismatch',
      'missing_proposal',
      'invalid_proposal',
      'world_failed',
      'world_skipped',
      'world_patch_failed',
    ].includes(reason);
    if (!waiting && !unpaired) {
      this.proposalPeriods?.abort();
      this.review = null;
      this.integration.invalidate();
    }
    this.setProposalState(state);
  }
  /** Called by the existing platform timer, and available for the review panel's refresh button. */
  refreshProposal(): void {
    this.checked(() => this.checkProposal());
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
  private checkProposal(): void {
    if (this.disposed || this.accepting) {
      return;
    }
    this.observeRollback();
    if (this.repairMaterial && this.repairStatus?.status !== 'expired') {
      try {
        this.checkRepairSource(this.repairMaterial);
      } catch (error) {
        this.repairSourceFailed(error);
        return;
      }
    }
    if (this.repairing) {
      return;
    }
    if (this.review?.repair && !['accepted', 'overwritten'].includes(this.reception.status)) {
      this.setProposalState({ ...this.reception, status: 'pending', reason: undefined, detail: undefined });
      return;
    }
    if (this.reception.status === 'accepted' && this.overwriteTicks <= 0) {
      return;
    }
    const registration = this.review?.repair ? this.review.registration : this.integration.current();
    if (!registration) {
      return;
    }
    if (this.reception.status === 'accepted') {
      if (this.overwriteTicks <= 0 || !this.review) {
        return;
      }
      const source = this.integration.readSource(registration.messageId);
      if ('status' in source) {
        if (source.reason !== 'mvu_busy') {
          this.blockProposal(source.reason);
        }
        return;
      }
      this.overwriteTicks--;
      if (
        source.chatId !== registration.chatId ||
        source.swipeId !== registration.swipeId ||
        source.now !== registration.now
      ) {
        this.blockProposal('source_changed');
      } else if (!source.state.receipts.includes(this.review.proposal.id)) {
        this.proposalPeriods?.abort();
        if (sameData(source.state, registration.state)) {
          this.setProposalState({ ...this.reception, status: 'overwritten', reason: 'overwritten' });
        } else {
          this.blockProposal('preview_changed');
        }
      }
      return;
    }
    if (this.reception.status === 'overwritten') {
      const current = this.integration.readSource(registration.messageId);
      if ('status' in current && current.reason === 'mvu_busy') {
        return;
      }
      if (this.review?.repair) {
        try {
          this.checkRepairSource(this.review.repair);
        } catch (error) {
          this.repairSourceFailed(error);
        }
      } else if (!this.integration.retry(registration.nonce)) {
        this.blockProposal('preview_changed');
      }
      return;
    }
    const source = {
      chatId: registration.chatId,
      messageId: registration.messageId,
      swipeId: registration.swipeId,
      now: registration.now,
      nonce: registration.nonce,
    };
    if (this.reception.source?.nonce !== registration.nonce) {
      this.setProposalState({ status: 'waiting', reason: 'waiting_workflow', source });
    }
    try {
      const input = this.integration.readSource(registration.messageId);
      if ('status' in input) {
        throw new ProposalBlocked(input.reason);
      }
      if (!this.integration.lookup(registration.nonce)) {
        throw new ProposalBlocked('source_changed');
      }
      const candidate = this.proposalCandidate(registration);
      if (this.review && candidate.evidenceKey !== this.review.evidenceKey) {
        throw new ProposalBlocked('preview_changed');
      }
      this.review = candidate;
      this.setProposalState({
        status: 'pending',
        source,
        proposal: candidate.proposal,
        preview: candidate.preview,
        evidence: candidate.evidence,
      });
    } catch (error) {
      this.blockProposal(
        error instanceof ProposalBlocked ? error.reason : 'read_failed',
        error instanceof ProposalBlocked ? error.detail : undefined,
      );
    }
  }
  reject(): void {
    if (this.accepting || !['pending', 'waiting', 'overwritten'].includes(this.reception.status)) {
      return;
    }
    this.review = null;
    this.invalidateRepair('user_rejected');
    this.integration.invalidate();
    this.setProposalState({ ...this.reception, status: 'rejected', reason: 'user_rejected' });
  }
  /** Repair the saved handoff through the update route; only accept() may commit its result. */
  repairProposal(): Promise<boolean> {
    if (this.repairing) {
      return this.repairing;
    }
    const material = this.repairMaterial;
    if (
      !material ||
      this.disposed ||
      this.accepting ||
      this.repairStatus?.status === 'expired' ||
      ['pending', 'accepted', 'overwritten'].includes(this.reception.status) ||
      this.jobs.some((job) => job.kind === 'update' && ['queued', 'running'].includes(job.state))
    ) {
      return Promise.resolve(false);
    }
    this.integration.invalidate();
    const id = requestId('repair');
    const aborter = new AbortController();
    this.repairAborter = aborter;
    const status: JobStatus = {
      id,
      kind: 'repair',
      label: '修复世界提案',
      state: 'running',
      message: '修复世界提案',
      time: new Date().toLocaleTimeString(),
      started: Date.now(),
    };
    this.jobs.unshift(status);
    this.jobs = this.jobs.slice(0, 40);
    this.aborters.set(id, aborter);
    this.repairStatus = { ...this.repairStatus, status: 'running', error: undefined };
    this.notify();
    this.repairing = (async () => {
      let sourceSignal: AbortSignal | undefined;
      const cancel = () => aborter.abort();
      try {
        await this.writes;
        aborter.signal.throwIfAborted();
        this.checkRepairSource(material);
        const snapshot = await this.platform.read(this.config, 'update');
        sourceSignal = snapshot.signal;
        sourceSignal?.addEventListener('abort', cancel, { once: true });
        sourceSignal?.throwIfAborted();
        this.checkRepairSource(material);
        const context =
          snapshot.context && typeof snapshot.context === 'object'
            ? ({ ...snapshot.context } as Record<string, unknown>)
            : {};
        // The repair uses the captured world exactly once, not a later world copy from context.
        delete context.world;
        const proposal = await this.request(
          'update',
          {
            job: 'update',
            stage: 'repair',
            now: material.registration.now,
            state: workingState(material.registration.state, true),
            context,
            world: material.world ?? null,
            failed: { raw: material.raw, errors: material.errors },
            schema: z.toJSONSchema(ProposalSchema.omit({ id: true, until: true }), { io: 'input' }),
          },
          ProposalSchema,
          aborter.signal,
          status,
          (value) => {
            this.checkRepairSource(material);
            this.proposedState('update', snapshot, value);
          },
          snapshot.prompts,
          (value) =>
            value && typeof value === 'object' && !Array.isArray(value)
              ? { ...value, id, until: material.registration.now }
              : value,
        );
        aborter.signal.throwIfAborted();
        this.checkRepairSource(material);
        const preview = this.proposedState('update', snapshot, proposal);
        this.review = {
          registration: material.registration,
          proposal,
          preview,
          evidence: material.evidence,
          evidenceKey: material.evidenceKey,
          repair: material,
        };
        this.repairStatus = { ...this.repairStatus, status: 'available' };
        status.state = 'success';
        status.message = '修复已通过验证，等待审阅与接收';
        const { chatId, messageId, swipeId, now, nonce } = material.registration;
        this.setProposalState({
          status: 'pending',
          origin: 'repair',
          source: { chatId, messageId, swipeId, now, nonce },
          proposal,
          preview,
          evidence: material.evidence,
        });
        return true;
      } catch (error) {
        status.state = aborter.signal.aborted ? 'cancelled' : 'failed';
        status.message = redactApiError(error, this.config.apis);
        if (this.repairMaterial === material) {
          this.repairStatus = { ...this.repairStatus, status: 'failed', error: status.message };
          this.repairSourceFailed(error);
        }
        return false;
      } finally {
        sourceSignal?.removeEventListener('abort', cancel);
        this.aborters.delete(id);
        status.finished = Date.now();
        this.repairAborter = null;
        this.notify();
      }
    })().finally(() => {
      this.repairing = null;
    });
    return this.repairing;
  }
  accept(): Promise<boolean> {
    if (this.accepting) {
      return this.accepting;
    }
    if (!this.review || !['pending', 'overwritten'].includes(this.reception.status)) {
      return Promise.resolve(false);
    }
    const review = this.review;
    const retry = this.reception.status === 'overwritten';
    const verify = () => {
      if (this.review !== review) {
        throw new ProposalBlocked('request_expired');
      }
      if (review.repair) {
        this.checkRepairSource(review.repair);
        const preview = this.proposedState(
          'update',
          {
            identity: '',
            messageId: review.registration.messageId,
            day: review.registration.now,
            turn: 0,
            state: review.registration.state,
            context: {},
          },
          review.proposal,
        );
        if (!sameData(preview, review.preview)) {
          throw new ProposalBlocked('preview_changed');
        }
        return;
      }
      const source = this.integration.readSource(review.registration.messageId);
      if ('status' in source) {
        throw new ProposalBlocked(source.reason);
      }
      const registered = retry
        ? this.integration.retry(review.registration.nonce)
        : this.integration.lookup(review.registration.nonce);
      if (!registered) {
        throw new ProposalBlocked('preview_changed');
      }
      const candidate = this.proposalCandidate(registered);
      if (candidate.evidenceKey !== review.evidenceKey || !sameData(candidate.preview, review.preview)) {
        throw new ProposalBlocked('preview_changed');
      }
    };
    this.accepting = (async () => {
      try {
        verify();
        const snapshot = await this.platform.read(this.config);
        verify();
        const committed = await this.commitUpdate(review.proposal, snapshot, snapshot.signal, verify);
        if (!review.repair && this.integration.current()?.nonce !== review.registration.nonce) {
          throw new ProposalBlocked('request_expired');
        }
        if (!review.repair) {
          this.integration.consume(review.registration.nonce);
        }
        this.repairMaterial = null;
        this.repairStatus = null;
        this.storeRepair();
        this.acceptedCheckpoint = review.registration.state.receipts.includes(review.proposal.id)
          ? null
          : {
              source: {
                chatId: review.registration.chatId,
                messageId: review.registration.messageId,
                swipeId: review.registration.swipeId,
              },
              proposalId: review.proposal.id,
              before: worldFingerprint(review.registration.state),
            };
        this.rollback = null;
        if (this.coordination.status === 'proposal_wait') {
          this.setCoordination({ ...this.coordination, status: 'idle' });
        }
        this.state = committed.state;
        // Integration ticks run once a second: watch for an overwrite for about two seconds.
        this.overwriteTicks = 2;
        this.setProposalState({ ...this.reception, status: 'accepted', reason: undefined });
        this.proposalPeriods?.abort();
        const periods = new AbortController();
        this.proposalPeriods = periods;
        for (const period of committed.periods) {
          void this.run('generate', period.candidate, period.work, {
            signal: periods.signal,
            receipt: review.proposal.id,
          });
        }
        return true;
      } catch (error) {
        if (this.review !== review) {
          return false;
        }
        if (review.repair) {
          this.repairSourceFailed(error);
        }
        const reason = error instanceof ProposalBlocked ? error.reason : 'save_failed';
        if (retry && ['mvu_busy', 'workflow_unknown', 'waiting_workflow'].includes(reason)) {
          this.setProposalState({ ...this.reception, status: 'overwritten', reason });
        } else {
          this.blockProposal(reason, error instanceof ProposalBlocked ? error.detail : undefined);
        }
        return false;
      }
    })().finally(() => {
      this.accepting = null;
    });
    return this.accepting;
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
      if (result && (result.skipped || !result.extractedTags?.['国策提案']?.trim())) {
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
    const yieldToProposal = () => {
      const registration = this.integration.current();
      const valid = registration && this.integration.lookup(registration.nonce);
      if (
        valid ||
        (this.repairMaterial && this.repairStatus?.status !== 'expired') ||
        this.yieldedSource === floor
      ) {
        this.yieldedSource = floor;
        const { content: _content, ...identity } = source;
        this.setCoordination({ status: 'proposal_wait', source: identity, reason: 'nonce' });
        this.refreshProposal();
        return true;
      }
      return false;
    };
    if (yieldToProposal()) {
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
      if (yieldToProposal()) {
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
    await this.runTask('update', undefined, undefined, undefined, 'scheduled');
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
  async run(
    kind: JobKind,
    candidate?: Candidate,
    periodWork?: PeriodWork,
    externalPeriod?: { signal: AbortSignal; receipt: string },
  ): Promise<void> {
    if (kind === 'update') {
      this.invalidateRepair('update_started');
      this.coordinationEpoch++;
      this.finishPredictionWait(false, 'manual');
      this.yieldedSource = '';
      this.setCoordination({ ...this.coordination, status: 'idle', reason: 'manual' });
    }
    await this.runTask(kind, candidate, periodWork, externalPeriod, 'manual');
  }
  private async runTask(
    kind: JobKind,
    candidate?: Candidate,
    periodWork?: PeriodWork,
    externalPeriod?: { signal: AbortSignal; receipt: string },
    mode: 'manual' | 'scheduled' = 'manual',
  ): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (
      kind === 'update' &&
      mode === 'scheduled' &&
      this.repairMaterial &&
      this.repairStatus?.status !== 'expired'
    ) {
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
    const access = kind === 'update' ? this.integration.beginUpdate(mode) : undefined;
    if (access && access.status !== 'acquired') {
      if (access.status === 'waiting') {
        this.yieldedSource = this.waitFloor;
        this.setCoordination({ ...this.coordination, status: 'proposal_wait', reason: 'nonce' });
        this.refreshProposal();
      }
      return;
    }
    if (kind === 'update' && mode === 'scheduled') {
      this.setCoordination({ ...this.coordination, status: 'running' });
    }
    const releaseUpdate = () => {
      if (access?.status === 'acquired') {
        this.integration.endUpdate(access.token);
      }
    };
    const id = requestId('job');
    const aborter = new AbortController();
    const cancelPeriod = () => aborter.abort();
    externalPeriod?.signal.addEventListener('abort', cancelPeriod, { once: true });
    if (externalPeriod?.signal.aborted) {
      aborter.abort();
    }
    aborter.signal.addEventListener('abort', releaseUpdate, { once: true });
    const status: JobStatus = {
      id,
      kind,
      state: 'queued',
      message: '准备任务',
      time: new Date().toLocaleTimeString(),
      ...(candidate ? { label: candidate.name, candidate } : {}),
      ...(periodWork ? { periodWork, label: `${candidate?.name} · 换期` } : {}),
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
      if (externalPeriod && !snapshot.state.receipts.includes(externalPeriod.receipt)) {
        throw new Error('外部提案的保存记录已失效');
      }
      sourceSignal = snapshot.signal;
      sourceSignal?.addEventListener('abort', cancelSource, { once: true });
      if (sourceSignal?.aborted) {
        aborter.abort();
      }
      aborter.signal.throwIfAborted();
      if (periodWork) {
        checkTransition(snapshot.state, periodWork.transition);
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
              instructions:
                '生成下一期与旧期摘要。tree.nodes 只输出新节点，承接节点由程序原样保留；新节点可引用 anchor 作必要前置，不相关议程可独立推进。节点与互斥组使用 prefix。不得生成 historical 或改变既有能力、数值、事实及事件。保留仍有效的 longTerm 的 id 与原文，修订理由写 analysis。summary 只叙述已发生事实与旧期终止原因，不把新计划当成果。总数含 anchor，以 limits 为篇幅目标，不凑数。',
            },
            PeriodReplySchema,
            (value) => {
              transitionPeriod(snapshot.state, periodWork.transition, value);
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
              taskData(snapshot, kind === 'reshape'),
              kind === 'identify' ? CandidatesSchema : ProposalSchema,
              (value) => {
                this.proposedState(kind, snapshot, value, candidate);
              },
            );
      aborter.signal.throwIfAborted();
      // Apply to current data in save order, without comparing it to the request input.
      let next: State;
      if (kind === 'update') {
        const committed = await this.commitUpdate(ProposalSchema.parse(result), snapshot, aborter.signal);
        next = committed.state;
        periods.push(...committed.periods);
      } else {
        next = await this.writeState((current) => {
          if (externalPeriod && !current.state.receipts.includes(externalPeriod.receipt)) {
            throw new Error('外部提案的保存记录已失效');
          }
          const state = periodWork
            ? transitionPeriod(current.state, periodWork.transition, PeriodReplySchema.parse(result))
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
      status.message = kind === 'identify' ? '候选国家已就绪，请勾选启用' : '验证通过，已保存至本楼';
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
      if (kind === 'update' && mode === 'scheduled' && this.coordination.status === 'running') {
        this.setCoordination({ ...this.coordination, status: 'idle' });
      }
      externalPeriod?.signal.removeEventListener('abort', cancelPeriod);
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
    if ((payload as { stage?: string }).stage === 'repair') {
      // Always use the repair task, even if the update task was customized or disabled.
      const task = {
        id: 'task',
        kind: 'task' as const,
        name: '修复任务指示',
        role: 'system' as const,
        content: REPAIR_TASK,
      };
      if (chain.some((item) => item.kind === 'task')) {
        chain = chain.map((item) => (item.kind === 'task' ? task : item));
      } else {
        chain = [task, ...chain];
      }
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
            if (error instanceof InputSizeError || error instanceof ProposalBlocked) {
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
                      ? error.message.slice(0, 1000)
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
  private proposedState(kind: JobKind, snapshot: Snapshot, result: unknown, candidate?: Candidate): State {
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
    const next = applyProposal(snapshot.state, proposal, kind === 'reshape');
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
