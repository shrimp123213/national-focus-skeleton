import { z } from 'zod';
import { migrateCountryKeys } from './engine';
import { workingState } from './generation';
import { ProposalSchema, StateSchema, type State } from './model';
import { requestId, storyDay, valueAt } from './platform';

export type IntegrationReason =
  | 'preview'
  | 'invalid_request'
  | 'unsupported'
  | 'disposed'
  | 'mvu_unavailable'
  | 'mvu_busy'
  | 'missing_stat_data'
  | 'missing_state'
  | 'invalid_state'
  | 'invalid_time'
  | 'not_latest'
  | 'not_assistant'
  | 'source_changed'
  | 'read_failed'
  | 'update_busy'
  | 'update_started'
  | 'request_expired';

export type IntegrationUnavailable = { version: 1; status: 'unavailable'; reason: IntegrationReason };
export function unavailable(reason: IntegrationReason): IntegrationUnavailable {
  return { version: 1, status: 'unavailable', reason };
}

/** Raw floor data, read without waiting for TavernPlatform.read's ready timer. */
export type IntegrationInput = {
  chatId: string;
  messageId: number;
  swipeId: number;
  lastMessageId: number;
  role: string;
  extraAnalysis: boolean;
  data: { stat_data?: Record<string, unknown>; 国策?: unknown };
  world?: { taskId: string; rootId: string; fingerprint: string | null };
  timePath: string;
  signal?: AbortSignal;
};
export type IntegrationRead = IntegrationInput | IntegrationUnavailable;
export type IntegrationSource = {
  chatId: string;
  messageId: number;
  swipeId: number;
  timePath: string;
  now: number;
  cursors: Record<string, number>;
  state: State;
};
export type IntegrationRegistration = IntegrationSource & {
  nonce: string;
  requestId: string;
  registeredAt: number;
  world?: IntegrationInput['world'];
};
export type IntegrationOptions = { mode?: 'preview' | 'request'; requestId?: string };
export type IntegrationReady = {
  version: 1;
  status: 'ready';
  nonce: string;
  now: number;
  cursors: Record<string, number>;
  state: object;
  schema: z.core.JSONSchema.JSONSchema;
  history: {
    complete: false;
    since: null;
    countries: Record<
      string,
      {
        progress: State['countries'][string]['progress'];
        periods: State['countries'][string]['period']['history'];
      }
    >;
    events: State['events'];
  };
};
export type IntegrationReply = IntegrationReady | IntegrationUnavailable;
export type IntegrationApi = {
  version: 1;
  prepare(messageId: number, options?: IntegrationOptions): Promise<IntegrationReply>;
  lookup(nonce: string): IntegrationRegistration | null;
};

export function integrationSource(input: IntegrationRead): IntegrationSource | IntegrationUnavailable {
  if ('status' in input) {
    return input;
  }
  if (input.signal?.aborted) {
    return unavailable('source_changed');
  }
  if (input.messageId !== input.lastMessageId) {
    return unavailable('not_latest');
  }
  if (input.role !== 'assistant') {
    return unavailable('not_assistant');
  }
  if (input.extraAnalysis) {
    return unavailable('mvu_busy');
  }
  if (!input.data.stat_data) {
    return unavailable('missing_stat_data');
  }
  let now: number;
  try {
    now = storyDay(valueAt(input.data.stat_data, input.timePath));
  } catch {
    return unavailable('invalid_time');
  }
  const saved = input.data.国策 !== undefined ? input.data.国策 : input.data.stat_data.国策;
  if (saved === undefined) {
    return unavailable('missing_state');
  }
  const parsed = StateSchema.safeParse(saved);
  if (!parsed.success) {
    return unavailable('invalid_state');
  }
  const state = migrateCountryKeys(parsed.data);
  return {
    chatId: input.chatId,
    messageId: input.messageId,
    swipeId: input.swipeId,
    timePath: input.timePath,
    now,
    cursors: Object.fromEntries(
      Object.values(state.countries).map((country) => [country.id, country.cursor]),
    ),
    state,
  };
}

/** Compare floor identity and national data; workflow injection may rewrite the message body. */
export function sameData(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const a = Object.entries(left);
  const b = right as Record<string, unknown>;
  return (
    a.length === Object.keys(b).length &&
    a.every(([key, value]) => Object.hasOwn(b, key) && sameData(value, b[key]))
  );
}

function payload(registration: IntegrationRegistration): IntegrationReady {
  const { state, now, cursors, nonce } = registration;
  const working = workingState(state, true) as {
    instructions?: unknown;
    events: { ongoing: { review?: unknown }[] };
  };
  // The integration preset owns model instructions. Keep this API data-only.
  delete working.instructions;
  for (const event of working.events.ongoing) {
    delete event.review;
  }
  return structuredClone({
    version: 1,
    status: 'ready',
    nonce,
    now,
    cursors,
    state: working,
    schema: z.toJSONSchema(ProposalSchema, { io: 'input' }),
    history: {
      complete: false,
      since: null,
      countries: Object.fromEntries(
        Object.values(state.countries).map((country) => [
          country.id,
          {
            progress: country.progress,
            periods: country.period.history,
          },
        ]),
      ),
      events: state.events,
    },
  });
}

export type UpdateAccess =
  | { status: 'acquired'; token: symbol }
  | { status: 'waiting'; nonce: string }
  | { status: 'unavailable'; reason: 'update_busy' | 'disposed' };

/** One controller owns one registration and one local update, all kept in memory. */
export class FocusIntegration {
  private registration: IntegrationRegistration | null = null;
  private consumed: IntegrationRegistration | null = null;
  private sourceSignal?: AbortSignal;
  private owner: symbol | null = null;
  private epoch = 0;
  private pendingRequest = '';
  private sourceKey = '';
  private seenRequests = new Set<string>();
  private disposed = false;
  private sourceCache: Map<number, IntegrationSource | IntegrationUnavailable> | null = null;

  constructor(
    private readonly read: (messageId: number) => IntegrationRead,
    private readonly changed: (reason?: IntegrationReason) => void = () => {},
  ) {}

  current(): IntegrationRegistration | null {
    return structuredClone(this.registration ?? this.consumed);
  }
  readSource(messageId: number): IntegrationSource | IntegrationUnavailable {
    const cache = this.sourceCache;
    if (!cache) {
      return integrationSource(this.read(messageId));
    }
    if (!cache.has(messageId)) {
      cache.set(messageId, integrationSource(this.read(messageId)));
    }
    return structuredClone(cache.get(messageId)!);
  }
  /** Parse each floor once during one synchronous check; every caller gets its own copy. */
  cached<T>(check: () => T): T {
    if (this.sourceCache) {
      return check();
    }
    this.sourceCache = new Map();
    try {
      return check();
    } finally {
      this.sourceCache = null;
    }
  }
  /** Accepted nonces are hidden from ordinary lookup, but retain a revocable retry checkpoint. */
  consume(nonce: string): void {
    if (this.registration?.nonce === nonce) {
      this.consumed = this.registration;
      this.registration = null;
    }
  }
  retry(nonce: string): IntegrationRegistration | null {
    if (this.consumed?.nonce !== nonce || this.owner || this.disposed) {
      return null;
    }
    return this.validate(this.consumed);
  }

  invalidate(reason: IntegrationReason = 'request_expired'): void {
    this.epoch++;
    this.registration = null;
    this.consumed = null;
    this.sourceSignal = undefined;
    this.pendingRequest = '';
    this.changed(reason);
  }
  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.owner = null;
    this.seenRequests.clear();
  }
  lookup(nonce: string): IntegrationRegistration | null {
    const registered = this.registration;
    if (this.disposed || !registered || registered.nonce !== nonce) {
      return null;
    }
    return this.validate(registered);
  }
  private validate(registered: IntegrationRegistration): IntegrationRegistration | null {
    const source = this.readSource(registered.messageId);
    if ('status' in source && source.reason === 'mvu_busy') {
      return null;
    }
    const {
      nonce: _nonce,
      requestId: _requestId,
      registeredAt: _at,
      world: _world,
      ...expected
    } = registered;
    if (this.sourceSignal?.aborted || 'status' in source || !sameData(source, expected)) {
      this.invalidate();
      return null;
    }
    return structuredClone(registered);
  }
  beginUpdate(mode: 'manual' | 'scheduled'): UpdateAccess {
    if (this.disposed) {
      return { status: 'unavailable', reason: 'disposed' };
    }
    if (this.owner) {
      return { status: 'unavailable', reason: 'update_busy' };
    }
    const registered = this.registration && this.lookup(this.registration.nonce);
    if (mode === 'scheduled' && registered) {
      return { status: 'waiting', nonce: registered.nonce };
    }
    this.invalidate('update_started');
    this.owner = Symbol('focus-update');
    return { status: 'acquired', token: this.owner };
  }
  endUpdate(token: symbol): void {
    if (this.owner === token) {
      this.owner = null;
    }
  }
  async prepare(
    messageId: number,
    options: IntegrationOptions = {},
    writes: Promise<unknown> = Promise.resolve(),
  ): Promise<IntegrationReply> {
    if (this.disposed) {
      return unavailable('disposed');
    }
    if (options.mode !== 'request') {
      return unavailable('preview');
    }
    const id = typeof options.requestId === 'string' ? options.requestId.trim() : '';
    if (!id) {
      return unavailable('invalid_request');
    }
    if (this.owner) {
      return unavailable('update_busy');
    }
    const input = this.read(messageId);
    const signal = 'signal' in input ? input.signal : undefined;
    const initial = integrationSource(input);
    if ('status' in initial) {
      return initial;
    }
    const key = JSON.stringify([initial.chatId, initial.messageId, initial.swipeId]);
    if (key !== this.sourceKey) {
      this.invalidate();
      this.sourceKey = key;
      this.seenRequests.clear();
    }
    const registered = this.registration && this.lookup(this.registration.nonce);
    if (registered?.requestId === id) {
      return payload(registered);
    }
    if (this.pendingRequest !== id) {
      if (this.seenRequests.has(id)) {
        return unavailable('request_expired');
      }
      this.invalidate();
      this.pendingRequest = id;
      this.seenRequests.add(id);
    }
    const epoch = this.epoch;
    // Local mutations may be saving; never register a snapshot read halfway through a save.
    await writes;
    if (this.disposed) {
      return unavailable('disposed');
    }
    if (this.owner) {
      return unavailable('update_busy');
    }
    if (epoch !== this.epoch) {
      return unavailable('request_expired');
    }
    const latestInput = this.read(messageId);
    const current = integrationSource(latestInput);
    if ('status' in current) {
      this.invalidate();
      return current;
    }
    if (signal?.aborted || !sameData(initial, current)) {
      this.invalidate();
      return unavailable('source_changed');
    }
    if (this.registration?.requestId === id) {
      return payload(this.registration);
    }
    const next: IntegrationRegistration = {
      ...current,
      nonce: requestId('focus'),
      requestId: id,
      registeredAt: Date.now(),
      world: 'world' in latestInput ? structuredClone(latestInput.world) : undefined,
    };
    const result = payload(next);
    this.registration = next;
    this.sourceSignal = signal;
    this.pendingRequest = '';
    this.changed();
    return result;
  }
}
