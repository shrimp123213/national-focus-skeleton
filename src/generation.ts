import { installCountry } from './engine';
import { assertReachable, assertCapabilityOrder, assertMutexChoices } from './reachability';
import { z } from 'zod';
import {
  BranchSchema,
  NodeSchema,
  TreeSchema,
  sizeLimits,
  type Candidate,
  type FocusNode,
  type State,
} from './model';
import { layoutTree } from './layout';
import type { Snapshot } from './platform';
import { generateBySkeleton, type SkeletonProgress } from './skeleton';

export const GeneratedTreeSchema = TreeSchema.extend({
  analysis: z.string().min(1),
  branches: z.array(BranchSchema).min(1).max(16),
  nodes: z
    .array(NodeSchema.omit({ x: true, y: true }))
    .min(1)
    .max(300),
});
/** Periods follow their agendas; graph shapes have no quotas. */
const topologyMinimums = { small: 0, standard: 0, large: 0, epic: 0 } as const;
const crossLinkMinimums = { small: 0, standard: 0, large: 0, epic: 0 } as const;
const standardBudget = {
  description: 300,
  reason: 120,
  duration: 60,
  branches: [1, 4],
  perBranch: [2, 8],
} as const;
const largeBudget = { ...standardBudget, branches: [1, 6], perBranch: [2, 10] } as const;
const brevity = { small: standardBudget, standard: standardBudget, large: largeBudget, epic: largeBudget };
/**
 * Focuses per fill request. The maximum comes from the generate task (`segmentMax`; before
 * v0.13.3 from its API preset), 0 = no limit, that is one batch for the whole skeleton.
 */
export const segmentMin = 3;
export const defaultSegmentMax = 25;
/** The focus cap per segment for this size: 0 means the whole size maximum. */
export function segmentCap(size: State['settings']['size'], segmentMax: number): number {
  const top = sizeLimits[size][1];
  return segmentMax <= 0 ? top : Math.min(top, Math.max(segmentMin + 2, Math.round(segmentMax)));
}
const span = ([low, high]: readonly [number, number]) => `${low}–${high}`;
/**
 * Trees above this size do not fit one reply with any common model (tested up to ~60 nodes).
 * They are generated skeleton-first (skeleton.ts), then validated as a whole.
 */
export function isSegmented(size: State['settings']['size']): boolean {
  return sizeLimits[size][1] > 40;
}

/**
 * Models often repeat a node's own product under outcomes, or require it before starting.
 * When nothing else can supply that capability the condition can never be met, so drop it
 * locally instead of spending another full request. Outcomes naming the node's own product
 * are always dropped: the product belongs in effects.
 */
export function dropSelfConditions<
  T extends Pick<FocusNode, 'id' | 'effects' | 'requirements' | 'sustain' | 'outcomes'>,
>(nodes: T[], initial: string[] = []): { nodes: T[]; removed: number } {
  const providers = new Map<string, Set<string>>();
  for (const node of nodes) {
    for (const effect of node.effects) {
      if (effect.kind === 'capability' && effect.active) {
        providers.set(effect.key, (providers.get(effect.key) ?? new Set()).add(node.id));
      }
    }
  }
  const available = new Set(initial);
  let removed = 0;
  const result = nodes.map((node) => {
    const own = (id: string) => providers.get(id)?.has(node.id) ?? false;
    const elsewhere = (id: string) =>
      available.has(id) || [...(providers.get(id) ?? [])].some((p) => p !== node.id);
    const keep = (rules: FocusNode['requirements'], outcome: boolean) =>
      rules.filter((rule) => {
        const drop =
          rule.kind === 'capability' && !rule.negate && own(rule.id) && (outcome || !elsewhere(rule.id));
        removed += drop ? 1 : 0;
        return !drop;
      });
    return {
      ...node,
      requirements: keep(node.requirements, false),
      sustain: keep(node.sustain, false),
      outcomes: keep(node.outcomes, true),
    };
  });
  return { nodes: result, removed };
}

/** Important focuses carry news, but a branch does not need to contain one. */
export function assertTurningPoints(
  nodes: Pick<FocusNode, 'id' | 'branch' | 'impact' | 'news'>[],
  branches: string[],
): void {
  for (const node of nodes) {
    requireThat(
      node.impact !== 'pivotal' || node.news,
      `重要國策 ${node.id} 缺少 news（headline、body、option）`,
    );
  }
}

export type GenerationRequest = <S extends z.ZodType>(
  stage: string,
  data: object,
  schema: S,
  validate?: (value: z.output<S>) => void,
  label?: string,
  /** Schema shown to the model when the parsed schema is deliberately looser (fill replies). */
  shown?: z.ZodType,
) => Promise<z.output<S>>;

function requireThat(value: unknown, reason: string): asserts value {
  if (!value) {
    throw new Error(reason);
  }
}
export const brevityOf = (size: State['settings']['size']) => brevity[size];
export const topologyMinimumOf = (size: State['settings']['size']) => topologyMinimums[size];
export const crossLinkMinimumOf = (size: State['settings']['size']) => crossLinkMinimums[size];
export function validateTopology(
  nodes: Pick<FocusNode, 'id' | 'branch' | 'prerequisites' | 'mutex'>[],
  size: State['settings']['size'],
): void {
  layoutTree(nodes); // Reject missing references, duplicate IDs and cycles before inspecting edges.
  assertMutexChoices(nodes);
  assertReachable(nodes);
}

/**
 * Local repairs for common, unambiguous model slips; the result still passes every check:
 * - a capability produced only by a historical node, not listed in capabilities, yet required
 *   by a later node, is treated as still active: otherwise the tree could never be valid. An
 *   unlisted capability nobody needs keeps meaning "lost" and is not re-issued;
 * - self-referencing conditions are dropped (see dropSelfConditions).
 */
export function normalizeGenerated<
  T extends {
    capabilities: { id: string; name: string; active: boolean; reason: string }[];
    historical: { node: string }[];
    nodes: Pick<FocusNode, 'id' | 'name' | 'effects' | 'requirements' | 'sustain' | 'outcomes'>[];
  },
>(tree: T): T {
  const capabilities = [...tree.capabilities];
  const historical = new Set(tree.historical.map((h) => h.node));
  const needed = new Set<string>();
  const livingProviders = new Set<string>();
  for (const node of tree.nodes) {
    if (historical.has(node.id)) {
      continue;
    }
    for (const rule of [...node.requirements, ...node.sustain, ...node.outcomes]) {
      if (rule.kind === 'capability' && !rule.negate) {
        needed.add(rule.id);
      }
    }
    for (const effect of node.effects) {
      if (effect.kind === 'capability' && effect.active) {
        livingProviders.add(effect.key);
      }
    }
  }
  for (const node of tree.nodes) {
    if (!historical.has(node.id)) {
      continue;
    }
    for (const effect of node.effects) {
      if (
        effect.kind === 'capability' &&
        effect.active &&
        needed.has(effect.key) &&
        !livingProviders.has(effect.key) &&
        !capabilities.some((c) => c.id === effect.key)
      ) {
        capabilities.push({
          id: effect.key,
          name: effect.name,
          active: true,
          reason: `既成國策「${node.name}」的成果`,
        });
      }
    }
  }
  const initial = capabilities.filter((c) => c.active).map((c) => c.id);
  return { ...tree, capabilities, nodes: dropSelfConditions(tree.nodes, initial).nodes };
}
/** Data, schema and local checks for one country's single generation request. */
export function generationPlan(snapshot: Snapshot, candidate: Candidate) {
  const size = snapshot.state.settings.size;
  const [min, max] = sizeLimits[size];
  const minimumConnections = topologyMinimums[size];
  const budget = brevity[size];
  const data = {
    candidate,
    context: snapshot.context,
    now: snapshot.day,
    size,
    pace: snapshot.state.settings.pace,
    limits: {
      min,
      max,
      branches: span(budget.branches),
      perBranch: span(budget.perBranch),
      minimumForks: minimumConnections,
      minimumJoins: minimumConnections,
      minimumCrossBranchLinks: crossLinkMinimums[size],
      text: { description: budget.description, reason: budget.reason, durationReason: budget.duration },
    },
  };
  const validate = (reply: z.output<typeof GeneratedTreeSchema>) => validateTree(snapshot, candidate, reply);
  return { data, schema: GeneratedTreeSchema, validate };
}

/** Every check the final commit runs, applied to a complete (possibly merged) tree. */
export function validateTree(
  snapshot: Snapshot,
  candidate: Candidate,
  reply: z.output<typeof GeneratedTreeSchema>,
  /** Supplement rounds check everything but the lower count; the next round adds the rest. */
  options: { allowShort?: boolean } = {},
): void {
  const size = snapshot.state.settings.size;
  const [min, max] = sizeLimits[size];
  {
    const raw = normalizeGenerated(reply);
    requireThat(raw.id === candidate.id, '生成的國家 ID 與選取國家不一致');
    requireThat(
      raw.nodes.length >= 1 && raw.nodes.length <= max,
      raw.nodes.length < min
        ? `生成規模須為 ${min}–${max} 節點，本次只有 ${raw.nodes.length} 項。請依建議分支數與每支項數補足，並精簡每個節點的文字，讓整棵樹能在一次回應內輸出完畢`
        : `生成規模須為 ${min}–${max} 節點，本次有 ${raw.nodes.length} 項，請合併或刪減`,
    );
    for (const key of ['id', 'name'] as const) {
      requireThat(
        new Set(raw.branches.map((b) => b[key])).size === raw.branches.length,
        '分支 ID 與名稱不可重複',
      );
    }
    requireThat(
      raw.nodes.every((n) => raw.branches.some((b) => b.name === n.branch)) &&
        raw.branches.every((b) => raw.nodes.some((n) => n.branch === b.name)),
      '節點分支須存在，每個分支須有國策',
    );
    assertTurningPoints(
      raw.nodes,
      raw.branches.map((b) => b.name),
    );
    validateTopology(raw.nodes, size);
    const tree = TreeSchema.parse({ ...raw, nodes: layoutTree(raw.nodes) });
    if (
      tree.relations?.some(
        (relation) =>
          !tree.nodes.some((n) => n.id === relation.from) || !tree.nodes.some((n) => n.id === relation.to),
      )
    ) {
      throw new Error('關係引用不存在的國策');
    }
    requireThat(
      new Set(tree.nodes.map((n) => n.description.trim())).size === tree.nodes.length,
      '國策描述完全重複',
    );
    assertCapabilityOrder(
      tree.nodes,
      tree.capabilities.filter((c) => c.active).map((c) => c.id),
      tree.historical.map((h) => h.node),
    );
    // Exercise the same graph/history checks as the final commit before retrying an invalid response.
    installCountry(snapshot.state, tree, snapshot.day);
  }
}

export type GeneratedTree = z.output<typeof GeneratedTreeSchema>;

export async function generateCountry(
  snapshot: Snapshot,
  candidate: Candidate,
  ask: GenerationRequest,
  progress: SkeletonProgress = { filled: {} },
  segmentMax = defaultSegmentMax,
  retries = 0,
) {
  const raw: GeneratedTree = !isSegmented(snapshot.state.settings.size)
    ? await (async () => {
        const plan = generationPlan(snapshot, candidate);
        return ask('generate', plan.data, plan.schema, plan.validate, '單次生成完整國策樹');
      })()
    : await generateBySkeleton(snapshot, candidate, ask, progress, segmentMax, retries);
  const normalized = normalizeGenerated(raw);
  return TreeSchema.parse({ ...normalized, nodes: layoutTree(normalized.nodes) });
}
/** Story days without progress after which an ongoing event is flagged for review. */
export const staleEventDays = 120;
/** Keep executable rules for time skips, omit large descriptive text and receipt history. */
export function workingState(state: State, fullDefinitions = false): object {
  return {
    day: state.day,
    countries: Object.values(state.countries)
      .filter((c) => c.enabled)
      .map((c) => ({
        id: c.id,
        name: c.name,
        control: c.control,
        skipDelegate: c.skipDelegate,
        cursor: c.cursor,
        calibration: c.calibration,
        current: c.current,
        stability: c.stability,
        warSupport: c.warSupport,
        locks: c.locks,
        facts: c.facts,
        capabilities: c.capabilities,
        commitments: c.commitments,
        period: {
          number: c.period.number,
          title: c.periodTitle,
          agenda: c.agenda || c.analysis,
          auto: c.autoPeriod,
          history: c.period.history.slice(-3),
        },
        longTerm: c.longTerm,
        nodes: Object.values(c.nodes).map((n) =>
          fullDefinitions
            ? n
            : c.progress[n.id].status === 'completed'
              ? { id: n.id, name: n.name, branch: n.branch }
              : {
                  id: n.id,
                  name: n.name,
                  branch: n.branch,
                  description: n.description,
                  days: n.days,
                  prerequisites: n.prerequisites,
                  mutex: n.mutex,
                  requirements: n.requirements,
                  sustain: n.sustain,
                  outcomes: n.outcomes,
                  effects: n.effects,
                  ...(n.execution === 'ongoing' ? { execution: n.execution } : {}),
                },
        ),
        progress: Object.fromEntries(
          Object.entries(c.progress)
            .filter(([, p]) => p.status !== 'idle')
            .map(([id, p]) => [
              id,
              {
                status: p.status,
                days: p.days,
                started: p.started,
                completed: p.completed,
                public: p.public,
              },
            ]),
        ),
      })),
    events: {
      // Running stories to advance with eventUpdates, then the latest finished news for context.
      ongoing: Object.values(state.events)
        .filter((event) => event.status === 'ongoing')
        .map((event) => {
          const updated = Math.max(event.at, ...event.timeline.map((t) => t.at));
          return {
            id: event.id,
            title: event.title,
            headline: event.headline,
            countries: event.countries,
            scope: event.scope,
            importance: event.importance,
            public: event.public,
            settle: event.settle,
            ...(event.source.node
              ? { focus: { country: event.source.country, node: event.source.node, name: event.source.name } }
              : {}),
            ...(event.current ? { current: event.current } : {}),
            ...(event.steps ? { steps: event.steps } : {}),
            timeline: event.timeline.slice(-3),
            ...(state.day - updated >= staleEventDays
              ? {
                  review: `已 ${Math.floor(state.day - updated)} 天沒有進展：依實際情況推進、結束或說明為何仍停滯`,
                }
              : {}),
          };
        }),
      recent: Object.values(state.events)
        .filter((event) => event.status === 'resolved')
        .sort((a, b) => b.at - a.at)
        .slice(0, 12)
        .map((event) => ({
          id: event.id,
          at: event.at,
          title: event.title,
          countries: event.countries,
          scope: event.scope,
          importance: event.importance,
          public: event.public,
        })),
    },
    instructions:
      '未列 progress 的節點均 idle。保留所有節點的可執行條件以支援長跳時；未列國家均停用，禁止更新。',
  };
}
