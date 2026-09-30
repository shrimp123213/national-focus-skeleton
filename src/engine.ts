import {
  Country,
  Effect,
  FocusNode,
  Requirement,
  State,
  TreeSchema,
  StateSchema,
  ProposalSchema,
  EventSchema,
} from './model';

export const HISTORY_PREFIX = '历史承接：';
/** Old saves used the traditional prefix; it is data, not a translated UI label. */
export function isHistoricalEvidence(evidence: string): boolean {
  return evidence.startsWith(HISTORY_PREFIX) || evidence.startsWith('歷史承接：');
}

function requireThat(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
export function createState(day: number): State {
  return StateSchema.parse({
    version: 1,
    revision: 0,
    day,
    settings: { fog: false, observing: [], size: 'standard', pace: 'standard' },
    countries: {},
    events: {},
    receipts: [],
    schedules: {},
  });
}
export function validateGraph(nodes: Record<string, FocusNode>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    requireThat(nodes[id], `不存在的前置国策：${id}`);
    requireThat(!visiting.has(id), '国策前置形成循环');
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const parent of nodes[id].prerequisites.flat()) {
      visit(parent);
    }
    visiting.delete(id);
    visited.add(id);
  }
  const coordinates = new Set<string>();
  for (const node of Object.values(nodes)) {
    visit(node.id);
    const position = `${node.x},${node.y}`;
    requireThat(!coordinates.has(position), `国策布局重叠：${node.name}`);
    coordinates.add(position);
    requireThat(new Set(node.effects.map((e) => e.id)).size === node.effects.length, '效果 ID 重复');
  }
}
export function installCountry(input: State, raw: unknown, day: number): State {
  const tree = TreeSchema.parse(raw);
  requireThat(!input.countries[tree.id], '国家已存在，请使用重新启用或局部改树');
  requireThat(new Set(tree.nodes.map((n) => n.id)).size === tree.nodes.length, '国策 ID 重复');
  const state = structuredClone(input);
  const nodes = Object.fromEntries(tree.nodes.map((n) => [n.id, n]));
  validateGraph(nodes);
  const { historical, capabilities, ...definition } = tree;
  const country: Country = {
    ...definition,
    nodes,
    enabled: true,
    control: 'player',
    skipDelegate: false,
    calibration: false,
    treeRevision: 0,
    cursor: day,
    current: '',
    autoPeriod: tree.autoPeriod ?? true,
    period: { number: 1, started: day, anchor: '', history: [] },
    locks: {},
    facts: {},
    commitments: {},
    capabilities: Object.fromEntries(capabilities.map((c) => [c.id, c])),
    progress: {},
  };
  for (const node of tree.nodes) {
    country.progress[node.id] = {
      status: 'idle',
      days: 0,
      started: null,
      completed: null,
      evidence: '',
      investments: [],
      applied: [],
      public: false,
    };
  }
  for (const item of historical) {
    requireThat(nodes[item.node], '历史承接引用不存在的国策');
    const node = nodes[item.node];
    country.progress[item.node] = {
      status: 'completed',
      days: node.days,
      started: null,
      completed: day,
      evidence: `${HISTORY_PREFIX}${item.evidence}`,
      investments: [],
      applied: node.effects.map((e) => e.id),
      public: true,
    };
    lockRoute(country, node);
  }
  state.countries[tree.id] = country;
  // A newly enabled country has its own baseline; older countries still need catch-up.
  state.revision++;
  return state;
}
export function conditionMet(country: Country, requirement: Requirement): boolean {
  switch (requirement.kind) {
    case 'fact':
      return (country.facts[requirement.id]?.value === true) !== (requirement.negate === true);
    case 'capability':
      return (country.capabilities[requirement.id]?.active === true) !== (requirement.negate === true);
    case 'stability':
      return country.stability >= requirement.minimum;
    case 'warSupport':
      return country.warSupport >= requirement.minimum;
  }
}
export function blockers(country: Country, node: FocusNode): string[] {
  const reasons: string[] = [];
  if (!country.enabled || country.calibration) {
    reasons.push(country.calibration ? '等待重新启用校准' : '此国尚未启用');
  }
  if (country.progress[node.id]?.status === 'completed') {
    reasons.push('此国策已完成');
  }
  if (country.progress[node.id]?.status === 'terminated') {
    reasons.push('此国策已终止');
  }
  for (const group of node.prerequisites) {
    if (!group.some((id) => country.progress[id]?.status === 'completed')) {
      reasons.push(`前置：${group.map((id) => country.nodes[id].name).join(' 或 ')}`);
    }
  }
  if (
    node.mutex &&
    country.locks[node.mutex.group] &&
    country.locks[node.mutex.group].route !== node.mutex.route
  ) {
    reasons.push(`路线已锁定：${country.locks[node.mutex.group].reason}`);
  }
  for (const requirement of node.requirements) {
    if (!conditionMet(country, requirement)) {
      reasons.push(requirement.label);
    }
  }
  return reasons;
}
function lockRoute(country: Country, node: FocusNode): void {
  if (node.mutex) {
    const existing = country.locks[node.mutex.group];
    requireThat(!existing || existing.route === node.mutex.route, '互斥路线冲突');
    country.locks[node.mutex.group] = { route: node.mutex.route, reason: node.mutex.reason };
  }
}
function select(country: Country, nodeId: string): void {
  requireThat(!country.current, '请先暂停目前的主国策');
  const node = country.nodes[nodeId];
  requireThat(node, '国策不存在');
  const reasons = blockers(country, node);
  requireThat(reasons.length === 0, reasons.join('；'));
  const progress = country.progress[nodeId];
  country.current = nodeId;
  progress.status = 'active';
  if (progress.started === null) {
    progress.started = country.cursor;
    progress.investments = [...node.investments];
  }
  if (node.mutex?.lock === 'start') {
    lockRoute(country, node);
  }
}
export function startFocus(input: State, countryId: string, nodeId: string): State {
  const state = structuredClone(input);
  const country = state.countries[countryId];
  requireThat(country, '国家不存在');
  requireThat(country.control === 'player', '请先切换为玩家选策');
  select(country, nodeId);
  state.revision++;
  return state;
}
export function pauseFocus(input: State, countryId: string): State {
  const state = structuredClone(input);
  const country = state.countries[countryId];
  requireThat(country?.current, '没有进行中的国策');
  requireThat(country.control === 'player', '请先切换为玩家选策');
  country.progress[country.current].status = 'paused';
  country.current = '';
  state.revision++;
  return state;
}
/** Apply one effect; a conditional effect whose `when` does not hold is skipped (returns false). */
function effect(country: Country, change: Effect, reason: string): boolean {
  if (!(change.when ?? []).every((r) => conditionMet(country, r))) {
    return false;
  }
  switch (change.kind) {
    case 'stability':
    case 'warSupport':
      country[change.kind] = Math.max(0, Math.min(100, country[change.kind] + change.value));
      break;
    case 'capability':
      country.capabilities[change.key] = { id: change.key, name: change.name, active: change.active, reason };
      break;
    case 'commitment':
      country.commitments[change.key] = change.name;
      break;
  }
  return true;
}
type Completion = { country: string; node: string; at: number };
function settle(country: Country, at: number, completed?: Completion[]): void {
  if (!country.current) {
    return;
  }
  const node = country.nodes[country.current];
  const progress = country.progress[node.id];
  if (!node.sustain.every((r) => conditionMet(country, r))) {
    progress.status = 'waiting';
    progress.evidence = '持续条件未满足';
    return;
  }
  if (progress.days < node.days) {
    progress.status = 'active';
    return;
  }
  if (!node.outcomes.every((r) => conditionMet(country, r))) {
    progress.status = 'waiting';
    progress.evidence = '工期已达标，等待实际成果';
    return;
  }
  lockRoute(country, node);
  // Conditions of conditional effects are read before any effect of this focus applies, so the
  // order of effects inside one focus never changes the result.
  const due = node.effects.filter(
    (item) => !progress.applied.includes(item.id) && (item.when ?? []).every((r) => conditionMet(country, r)),
  );
  for (const item of due) {
    effect(country, { ...item, when: [] }, `国策完成：${node.name}`);
    progress.applied.push(item.id);
  }
  progress.status = 'completed';
  progress.completed = at;
  progress.evidence = '有效工期与成果条件均已满足';
  country.current = '';
  completed?.push({ country: country.id, node: node.id, at });
}
function advance(country: Country, at: number, completed?: Completion[]): void {
  requireThat(at >= country.cursor, '故事时间不可倒退');
  if (country.current) {
    const node = country.nodes[country.current];
    const progress = country.progress[node.id];
    if (node.sustain.every((r) => conditionMet(country, r))) {
      const remaining = Math.max(0, node.days - progress.days);
      const elapsed = at - country.cursor;
      const finishAt = country.cursor + remaining;
      progress.days = Math.min(node.days, progress.days + elapsed);
      // Later facts cannot be used to finish an earlier focus.
      settle(country, elapsed >= remaining ? finishAt : at, completed);
    }
  }
  country.cursor = at;
}
/** Placeholder the script appends to an AI floor that published news; a regex renders it. */
export const NEWS_TAG = '<国策快讯/>';
/** Event the news card emits (Tavern Helper event bus) to open the script's news window. */
export const NEWS_EVENT = 'national-focus:open-news';
export const NEWS_TAG_PATTERN = /<国策快讯\s*\/>/g;
/** Remove the tag exactly as appended (two newlines plus tag), then any stray copy of it. */
export function stripNewsTag(text: string): string {
  return text.replace(/\n\n<国策快讯\s*\/>/g, '').replace(NEWS_TAG_PATTERN, '');
}

/**
 * Mark unpublished news as shown on this AI floor. Returns the ids the player may see here, so
 * the caller only adds the news tag when there is something to show.
 */
export function stampNews(state: State, messageId: number): string[] {
  const fresh: string[] = [];
  for (const event of Object.values(state.events)) {
    if (event.shownAt === null) {
      event.shownAt = messageId;
      fresh.push(event.id);
    }
    // Progress of a running story is marked separately: it shows in the newspaper's serials
    // without becoming a headline.
    if (event.touchedAt === null) {
      event.touchedAt = messageId;
    }
  }
  return fresh;
}

/** Countries whose unpublished news the player may read: the ones the player steers or is in. */
export function newsVisible(event: State['events'][string], insiders: readonly string[]): boolean {
  return event.public || event.countries.some((id) => insiders.includes(id));
}

/**
 * News published on one AI floor that the player may see there: public news, and unpublished
 * news of the countries the player steers or is in (`insiders`, saved with the floor).
 */
export function floorNews(
  state: State,
  messageId: number,
  insiders: readonly string[] = playerCountries(state),
): State['events'][string][] {
  return Object.values(state.events)
    .filter((event) => event.shownAt === messageId && newsVisible(event, insiders))
    .sort((a, b) => importanceRank(b) - importanceRank(a) || a.at - b.at);
}
/** Enabled countries the player steers. */
export function playerCountries(state: State): string[] {
  return Object.values(state.countries)
    .filter((country) => country.enabled && country.control === 'player')
    .map((country) => country.id);
}
const importanceRank = (event: State['events'][string]) =>
  ({ world: 3, major: 2, minor: 1 })[event.importance] + (event.scope === 'front' ? 0.5 : 0);

type StoryEvent = State['events'][string];
/** The latest story day an event changed: its start, or its last progress update. */
export function eventUpdatedAt(event: StoryEvent): number {
  return Math.max(event.at, ...event.timeline.map((entry) => entry.at));
}
/**
 * One line for the story model: how the event began and, when it has progressed since, the latest
 * progress, so a lifted embargo is not told as still in force. `when` renders a story day.
 */
export function eventText(event: StoryEvent, when: (day: number) => string): string {
  const first = event.description.split(/(?<=[。！？])/)[0];
  const latest = event.timeline.length ? event.timeline.reduce((a, b) => (b.at >= a.at ? b : a)) : undefined;
  const state = latest
    ? event.status === 'resolved'
      ? `，${resultNames[event.result ?? 'ended']}`
      : '，仍在发展'
    : event.status === 'ongoing'
      ? '，仍在发展'
      : '';
  const now = event.current ? `现况：${event.current}` : '';
  const body = latest
    ? `起因：${first}最新进展（${when(latest.at)}）：${latest.text}${now && event.status === 'ongoing' ? now : ''}`
    : `${first}${now}`;
  return `${event.headline || event.title}：${body}（始于${when(event.at)}${state}${event.public ? '' : '，未公开'}）`;
}
export const resultNames = {
  achieved: '已达成',
  abandoned: '已终止',
  failed: '已失败',
  ended: '已结束',
} as const;

/** Recent major events as plain text for the story model; unpublished ones are marked. */
export function newsDigest(state: State, limit = 5, days = 30): string {
  const lines = Object.values(state.events)
    .filter(
      (event) =>
        eventUpdatedAt(event) >= state.day - days &&
        (event.importance !== 'minor' || event.scope === 'front' || event.source.kind === 'focus'),
    )
    .sort((a, b) => eventUpdatedAt(b) - eventUpdatedAt(a))
    .slice(0, limit)
    .map((event) => {
      const names = event.countries.map((id) => state.countries[id]?.name ?? id).join('、');
      const scope = event.importance === 'world' ? '世界' : event.scope === 'front' ? '身边' : '各国';
      return `- 〔${scope}〕${eventText(event, (day) => `故事日 ${Math.floor(day)}`)}（${names}）`;
    });
  return lines.length
    ? `【近期国际大事】（供正文自然承接；标示「未公开」的只有当事方与知情者知道）\n${lines.join('\n')}\n呈现方式：可透过公告、报纸、传闻、商旅或 NPC 对话自然带出，不必一次全部写入；不得替玩家行动，也不得改变已写出的正文。`
    : '';
}

export const eventLimits = { front: 3, back: 5, resolvedKept: 60 } as const;

/** Stable, schema-valid id for the news of a turning-point focus. */
export function focusEventId(country: string, node: string): string {
  const id = `focus_${country}_${node}`;
  if (id.length <= 80) {
    return id;
  }
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `focus_${hash.toString(36)}_${node.slice(0, 50)}`;
}

/** The event that carries out a focus, made by the script or linked by an update (at most one). */
export function focusEvent(state: State, country: string, node: string): StoryEvent | undefined {
  return (
    state.events[focusEventId(country, node)] ??
    Object.values(state.events).find(
      (event) => event.source.country === country && event.source.node === node,
    )
  );
}

/**
 * A completed important focus becomes a news event; a focus carried out over time (`ongoing`)
 * opens its execution event. An important ongoing focus has one event for both, so the work is
 * never tracked or settled twice. Effects were already applied by the focus itself.
 */
function publishCompletions(state: State, completed: Completion[]): void {
  for (const item of completed) {
    const country = state.countries[item.country];
    const node = country.nodes[item.node];
    const id = focusEventId(item.country, item.node);
    const ongoing = node.execution === 'ongoing';
    if ((node.impact !== 'pivotal' && !ongoing) || focusEvent(state, item.country, item.node)) {
      continue;
    }
    const pivotal = node.impact === 'pivotal';
    const news = node.news ?? {
      headline: pivotal ? `${country.name}完成「${node.name}」` : `${country.name}开始执行「${node.name}」`,
      body: node.description,
      option: { label: '知道了', text: '' },
    };
    state.events[id] = EventSchema.parse({
      id,
      at: item.at,
      countries: [item.country],
      title: node.name,
      description: pivotal ? news.body : node.description,
      evidence: `国策完成：${node.name}`,
      origin: 'story',
      public: country.progress[item.node].public,
      changes: [],
      scope: country.control === 'player' ? 'front' : 'back',
      importance: pivotal ? 'major' : 'minor',
      headline: news.headline,
      status: ongoing ? 'ongoing' : 'resolved',
      ...(ongoing ? { settle: `「${node.name}」的工作全部完成，或正式终止` } : {}),
      option: news.option,
      timeline: [{ at: item.at, text: pivotal ? news.body : `国策完成，开始执行：${node.name}` }],
      source: { kind: 'focus', country: item.country, node: item.node },
      touchedAt: null,
    });
  }
}

/** Running stories that count toward the limits; events carrying out a focus do not. */
function runningCounts(state: State): Map<string, number> {
  const running = new Map<string, number>();
  for (const event of Object.values(state.events)) {
    if (event.status !== 'ongoing' || event.source.node) {
      continue;
    }
    for (const country of event.countries) {
      const key = `${country}\0${event.scope}`;
      running.set(key, (running.get(key) ?? 0) + 1);
    }
  }
  return running;
}

/**
 * Keep the number of running stories readable, and drop the oldest finished news. The limits only
 * stop new stories: a story still in motion is never ended to make room.
 */
function enforceEventLimits(state: State, before: Map<string, number>): void {
  for (const [key, count] of runningCounts(state)) {
    const [country, scope] = key.split('\0') as [string, 'front' | 'back'];
    requireThat(
      count <= eventLimits[scope] || count <= (before.get(key) ?? 0),
      `${state.countries[country]?.name ?? country}进行中的${scope === 'front' ? '前台' : '后台'}事件已有 ${count} 件，上限 ${eventLimits[scope]} 件；请把新进展并入既有事件（eventUpdates），或不要新增。不要为了腾出名额结束仍在进行的事件`,
    );
  }
  const resolved = Object.values(state.events)
    .filter((event) => event.status === 'resolved')
    .sort((a, b) => b.at - a.at);
  for (const event of resolved.slice(eventLimits.resolvedKept)) {
    delete state.events[event.id];
  }
}

/** Apply event effects for one country; checked like the effects of a new event. */
function applyChanges(
  state: State,
  event: StoryEvent,
  changes: StoryEvent['changes'],
  at: number,
  reason: string,
): void {
  requireThat(new Set(changes.map((c) => c.country)).size === changes.length, '事件同一国家变更重复');
  for (const change of changes) {
    requireThat(event.countries.includes(change.country), '事件变更对象不在参与国家中');
    const country = state.countries[change.country];
    requireThat(country?.enabled, '事件效果引用未启用国家');
    requireThat(country.cursor <= at, '不能修改国家开始追踪前的事件');
    requireThat(new Set(change.effects.map((e) => e.id)).size === change.effects.length, '事件效果 ID 重复');
    for (const item of change.effects) {
      effect(country, item, reason);
    }
  }
}

export function applyProposal(input: State, raw: unknown, allowEdits = false): State {
  const proposal = ProposalSchema.parse(raw);
  if (input.receipts.includes(proposal.id)) {
    return input;
  }
  requireThat(proposal.until >= input.day, '故事时间不可倒退');
  const state = structuredClone(input);
  const completed: Completion[] = [];
  const runningBefore = runningCounts(input);
  let previous = input.day;
  for (const step of proposal.steps) {
    requireThat(step.at >= previous && step.at <= proposal.until, '事件未按故事时间排序');
    for (const country of Object.values(state.countries)) {
      if (country.enabled && !country.calibration && country.cursor <= step.at) {
        advance(country, step.at, completed);
      }
    }
    for (const fact of step.facts) {
      const country = state.countries[fact.country];
      requireThat(country?.enabled, '事实引用未启用国家');
      requireThat(country.cursor <= step.at, '不能修改国家开始追踪前的事实');
      country.facts[fact.id] = { value: fact.value, evidence: fact.evidence };
    }
    for (const raw of step.events) {
      requireThat(raw.at === step.at, '事件时间与步骤不一致');
      // Models write world events only; focus news and publishing floors belong to the script.
      const { focus, ...rest } = raw;
      const event: StoryEvent = {
        ...rest,
        source: focus ? { kind: 'update', country: focus.country, node: focus.node } : { kind: 'update' },
        shownAt: null,
        touchedAt: null,
        timeline: raw.timeline.length ? raw.timeline : [{ at: raw.at, text: raw.description }],
      };
      if (state.events[event.id]) {
        const known = state.events[event.id];
        requireThat(
          known.title === event.title && known.at === event.at && known.description === event.description,
          `事件 ID ${event.id} 已存在；推进既有事件请用 eventUpdates`,
        );
        continue;
      }
      if (focus) {
        const country = state.countries[focus.country];
        requireThat(country?.nodes[focus.node], `事件 ${event.id} 承接的国策 ${focus.node} 不存在`);
        requireThat(event.countries.includes(focus.country), `事件 ${event.id} 承接的国策不属于参与国家`);
        requireThat(
          ['active', 'waiting', 'paused', 'completed'].includes(country.progress[focus.node]?.status),
          `事件 ${event.id} 承接的国策 ${country.nodes[focus.node].name} 尚未开始`,
        );
        const existing = focusEvent(state, focus.country, focus.node);
        requireThat(
          !existing,
          `国策 ${country.nodes[focus.node].name} 已有执行事件 ${existing?.id}；请用 eventUpdates 推进它，不要另建`,
        );
      }
      applyChanges(state, event, event.changes, step.at, event.description);
      state.events[event.id] = event;
    }
    for (const update of step.eventUpdates) {
      const event = state.events[update.id];
      requireThat(event, `要推进的事件 ${update.id} 不存在`);
      requireThat(event.status === 'ongoing', `事件 ${update.id} 已结束，不能再推进`);
      requireThat(step.at >= event.at, `事件 ${update.id} 的推进不能早于事件本身`);
      requireThat(
        !update.result || update.status !== 'ongoing',
        `事件 ${update.id} 填了 result 表示已结束，status 不能是 ongoing`,
      );
      if (update.changes?.length) {
        applyChanges(state, event, update.changes, step.at, update.text);
        // Keep what the story gained, so the record shows every effect it produced.
        for (const change of update.changes) {
          const known = event.changes.find((c) => c.country === change.country);
          if (known) {
            known.effects.push(...change.effects.filter((e) => !known.effects.some((k) => k.id === e.id)));
          } else {
            event.changes.push(structuredClone(change));
          }
        }
      }
      event.timeline.push({ at: step.at, text: update.text });
      event.status = update.result ? 'resolved' : (update.status ?? event.status);
      if (update.result) {
        event.result = update.result;
      }
      if (update.headline) {
        event.headline = update.headline;
      }
      if (update.public !== undefined) {
        event.public = update.public;
      }
      if (update.current !== undefined) {
        event.current = update.current;
      }
      if (update.steps) {
        event.steps = update.steps;
      }
      event.touchedAt = null;
      // Ordinary progress stays in the serials; only reported progress and the end of an important
      // story become news again.
      if (update.report || (event.status === 'resolved' && event.importance !== 'minor')) {
        event.shownAt = null;
      }
    }
    for (const country of Object.values(state.countries)) {
      if (country.enabled && !country.calibration && country.cursor <= step.at) {
        settle(country, step.at, completed);
      }
    }
    for (const choice of step.selections) {
      const country = state.countries[choice.country];
      requireThat(country?.enabled && !country.calibration, '选策国家不可用');
      requireThat(country.cursor === step.at, '选策不能早于国家开始追踪时间');
      requireThat(
        country.control === 'ai' || (country.skipDelegate && proposal.until > input.day),
        '此国未授权 AI 代选',
      );
      select(country, choice.node);
      country.progress[choice.node].evidence = choice.reason;
    }
    for (const publication of step.publications) {
      const country = state.countries[publication.country];
      requireThat(
        country?.enabled && country.progress[publication.node]?.status === 'completed',
        '只能公开已完成且已启用国家的国策',
      );
      country.progress[publication.node].public = true;
      country.progress[publication.node].evidence += `；公开依据：${publication.evidence}`;
      const news = state.events[focusEventId(publication.country, publication.node)];
      if (news) {
        news.public = true;
      }
    }
    previous = step.at;
  }
  for (const country of Object.values(state.countries)) {
    if (country.enabled && !country.calibration) {
      advance(country, proposal.until, completed);
    }
  }
  publishCompletions(state, completed);
  enforceEventLimits(state, runningBefore);
  for (const id of proposal.calibrations) {
    const country = state.countries[id];
    requireThat(country?.enabled && country.calibration, '校准对象不符合条件');
    country.calibration = false;
    country.cursor = proposal.until;
  }
  requireThat(allowEdits || proposal.edits.length === 0, '只有重大改树任务可修改国策树');
  for (const edit of proposal.edits) {
    const country = state.countries[edit.country];
    requireThat(country?.enabled, '改树国家不存在或已停用');
    requireThat(new Set(edit.nodes.map((n) => n.id)).size === edit.nodes.length, '改树节点 ID 重复');
    for (const id of new Set([...edit.remove, ...edit.nodes.map((n) => n.id)])) {
      requireThat(
        !country.progress[id] || country.progress[id].status === 'idle',
        '不可改写已开始或已完成国策',
      );
    }
    for (const id of edit.remove) {
      requireThat(country.nodes[id], '移除国策不存在');
      delete country.nodes[id];
      delete country.progress[id];
    }
    for (const node of edit.nodes) {
      country.nodes[node.id] = node;
      country.progress[node.id] = {
        status: 'idle',
        days: 0,
        started: null,
        completed: null,
        evidence: edit.reason,
        investments: [],
        applied: [],
        public: false,
      };
    }
    requireThat(Object.keys(country.nodes).length <= 300, '单国国策超过 300 节点');
    validateGraph(country.nodes);
    pruneRelations(country, new Set(edit.nodes.map((n) => n.id)));
    country.treeRevision++;
  }
  state.day = proposal.until;
  state.receipts.push(proposal.id);
  state.revision++;
  return state;
}
/** Marks a relation whose focus was rewritten; its rules were checked against the old focus. */
export const STALE_RELATION = '改树后未重新验证：这条关系涉及的国策已改写，上面的规则说明可能已不成立';
/**
 * After a reshape, drop relations to removed focuses and flag relations to rewritten ones, so the
 * tree stays consistent (and its own export can be imported again).
 */
function pruneRelations(country: Country, rewritten: Set<string>): void {
  if (!country.relations) {
    return;
  }
  country.relations = country.relations
    .filter((r) => country.nodes[r.from] && country.nodes[r.to])
    .map((r) =>
      (rewritten.has(r.from) || rewritten.has(r.to)) && !r.via.includes(STALE_RELATION)
        ? { ...r, via: [...r.via, STALE_RELATION] }
        : r,
    );
}
export function changeCountry(
  input: State,
  id: string,
  patch: Partial<Pick<Country, 'enabled' | 'control' | 'skipDelegate' | 'autoPeriod'>>,
): State {
  const state = structuredClone(input);
  const country = state.countries[id];
  requireThat(country, '国家不存在');
  if (patch.enabled === true && !country.enabled) {
    country.calibration = true;
    country.cursor = state.day;
  }
  Object.assign(country, patch);
  state.revision++;
  return StateSchema.parse(state);
}
/**
 * Delete a country's tree, progress and private state. Events it shared with other countries
 * stay for them; events that involved only this country are removed.
 */
export function removeCountry(input: State, id: string): State {
  const state = structuredClone(input);
  requireThat(state.countries[id], '国家不存在');
  delete state.countries[id];
  for (const [eventId, event] of Object.entries(state.events)) {
    event.countries = event.countries.filter((country) => country !== id);
    event.changes = event.changes.filter((change) => change.country !== id);
    if (!event.countries.length) {
      delete state.events[eventId];
    }
  }
  state.settings.observing = state.settings.observing.filter((country) => country !== id);
  state.revision++;
  return StateSchema.parse(state);
}
