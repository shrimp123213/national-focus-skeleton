/**
 * Skeleton-first generation (v0.12.x skeleton edition, handoff doc sections 28–32).
 *
 * 1. One skeleton request lays out every focus with its structure and rules only: prerequisites,
 *    mutex routes and lock time, turning points, capabilities provided or revoked, stat changes,
 *    conditions (including "must not have"), conditional outcomes, the core branch and the
 *    relations between focuses. All structural checks run here, where a retry is cheap.
 * 2. Fill requests write the text of a batch of skeleton focuses (any branches). The structure
 *    always comes from the skeleton; a fill reply cannot change it.
 * 3. Fill replies are accepted per focus: good focuses are kept, and only missing or rejected IDs
 *    are asked again, with the reasons.
 * 4. The merged tree passes the same final checks as every other tree.
 */
import { z } from 'zod';
import {
  BranchSchema,
  Id,
  TreeSchema,
  RelationSchema,
  relationKindNames,
  sizeLimits,
  type Candidate,
  type Effect,
  type FocusNode,
  type Relation,
  type Requirement,
  type State,
} from './model';
import { layoutTree } from './layout';
import { assertCapabilityOrder, reachableBefore } from './reachability';
import { repairSkeleton } from './repair';
import { applyPatch, PatchReplySchema, schemaIssues } from './skeleton-patch';
import type { Snapshot } from './platform';
import {
  assertTurningPoints,
  brevityOf,
  crossLinkMinimumOf,
  segmentCap,
  topologyMinimumOf,
  validateTopology,
  validateTree,
  type GeneratedTree,
  type GenerationRequest,
} from './generation';

const Text = z.string().min(1).max(8000);
/**
 * The core branch must change the choices of at least this many other branches (distinct
 * branches, not relation count; handoff doc section 32). Fewer when the tree has few branches.
 */
export const coreReach = (branches: number) => (branches <= 3 ? 1 : 2);
/** Text budget per focus in fill requests (the same as the segmented budget before). */
export const fillText = { description: 120, reason: 60, durationReason: 40 } as const;
/** Rounds that ask again only for missing or rejected focuses. */
export const refillRounds = 2;

/**
 * While a check section runs under `collect`, failed checks are recorded instead of thrown, so one
 * validation pass can report every problem it finds (handoff doc section 36).
 */
let sink: string[] | null = null;
function requireThat(value: unknown, reason: string): asserts value {
  if (!value) {
    if (sink) {
      sink.push(reason);
      return;
    }
    throw new Error(reason);
  }
}
/** Run one check section, recording its problems; returns whether it found none. */
function collect(issues: string[], section: () => void): boolean {
  const before = issues.length;
  const previous = sink;
  sink = issues;
  try {
    section();
  } catch (error) {
    // A later crash after a recorded problem is a consequence of it; report the cause only.
    if (issues.length === before) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  } finally {
    sink = previous;
  }
  return issues.length === before;
}
export const maxReportedIssues = 20;
/** One message for the model and the player: numbered problems, capped. */
export function formatIssues(issues: string[]): string {
  const unique = [...new Set(issues)];
  const shown = unique.slice(0, maxReportedIssues).map((issue, i) => `${i + 1}. ${issue}`);
  return unique.length > maxReportedIssues
    ? [...shown, `另有 ${unique.length - maxReportedIssues} 个问题`].join('\n')
    : shown.join('\n');
}

const Negate = z.boolean().optional().describe('true＝必须「没有」；省略为 false');
const ConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('capability'), id: Id, negate: Negate }).strict(),
  z.object({ kind: z.literal('fact'), id: Id, negate: Negate }).strict(),
  z.object({ kind: z.enum(['stability', 'warSupport']), minimum: z.number().min(0).max(100) }).strict(),
]);
type Condition = z.output<typeof ConditionSchema>;
const Stat = z.number().int().min(-30).max(30).default(0);
const Stats = z
  .object({ stability: Stat, warSupport: Stat })
  .strict()
  .default({ stability: 0, warSupport: 0 });
/** An outcome that applies only when its conditions hold at completion (法工式配套、俄罗斯式情境). */
const ConditionalSchema = z
  .object({
    when: z.array(ConditionSchema).min(1),
    provides: z.array(Id).default([]),
    revokes: z.array(Id).default([]),
    stats: Stats,
  })
  .strict();
type Conditional = z.output<typeof ConditionalSchema>;

export const SkeletonNodeSchema = z
  .object({
    id: Id,
    name: Text,
    branch: Text,
    gist: Text.describe('40 字内：核心行动与预期成果'),
    prerequisites: z
      .array(z.array(Id).min(1))
      .max(100)
      .describe('AND of OR groups：[[a,b],[c]] 表示完成 a 或 b，且完成 c'),
    mutex: z
      .object({
        group: Id,
        route: Id,
        lock: z.enum(['complete', 'start']).describe('start＝开始时就锁定路线；complete＝完成时锁定'),
      })
      .strict()
      .nullable(),
    impact: z.enum(['normal', 'pivotal']),
    action: z
      .string()
      .nullable()
      .default(null)
      .describe('pivotal 必填：新闻要报导的国家行动；normal 为 null'),
    execution: z
      .enum(['once', 'ongoing'])
      .optional()
      .describe('ongoing＝完成后仍需持续执行（工程、长期改革）；省略为一次完成'),
    provides: z.array(Id).default([]).describe('完成时产生的能力 key（capabilityCatalog 或初始能力）'),
    revokes: z.array(Id).default([]).describe('完成时撤销的能力 key：制衡其他路线'),
    stats: Stats.describe('完成时稳定度／战争支持度的增减'),
    conditional: z
      .array(ConditionalSchema)
      .max(4)
      .default([])
      .describe('条件式成果：完成时 when 全部成立才生效，例如依已选路线或当前局势给不同成果'),
    requirements: z.array(ConditionSchema).default([]).describe('开始前必须成立'),
    sustain: z.array(ConditionSchema).default([]).describe('推进期间必须持续成立'),
    outcomes: z.array(ConditionSchema).default([]).describe('工期满后、完成前必须由剧情取得的外部成果'),
  })
  .strict();
export type SkeletonNode = z.output<typeof SkeletonNodeSchema>;

export const SkeletonSchema = TreeSchema.pick({
  id: true,
  name: true,
  description: true,
  stability: true,
  warSupport: true,
  evidence: true,
  capabilities: true,
})
  .extend({
    analysis: z.string().min(1),
    keywords: z
      .array(z.string().min(1).max(24))
      .max(8)
      .default([])
      .describe('正文中指称本国的词：简称、首都、统治者、代表地名；不放通用词'),
    branches: z.array(BranchSchema).min(3).max(16),
    choices: z
      .array(
        z
          .object({
            group: Id,
            routes: z
              .array(z.object({ id: Id, name: Text, supporters: Text }).strict())
              .min(2)
              .max(4),
            reason: Text,
          })
          .strict(),
      )
      .min(1)
      .max(12)
      .describe('互斥路线；同一组的路线可以分布在不同分支'),
    capabilityCatalog: z
      .array(z.object({ key: Id, name: Text }).strict())
      .default([])
      .describe('国策会产生或撤销的能力；初始能力列在 capabilities'),
    facts: z
      .array(z.object({ id: Id, label: Text }).strict())
      .default([])
      .describe('跨国策共用的剧情事实；fact 条件只能引用这里的 id'),
    historical: z.array(z.object({ node: Id, evidence: Text }).strict()).default([]),
    relations: z
      .array(RelationSchema.omit({ via: true }))
      .max(40)
      .default([])
      .describe('国策之间的关系：选了 from 之后，to 的选项、收益、代价或时机如何改变；必须由实际规则实现'),
    nodes: z.array(SkeletonNodeSchema).min(1).max(300),
  })
  .strict();
export type Skeleton = z.output<typeof SkeletonSchema>;

export const FillNodeSchema = z
  .object({
    id: Id,
    description: Text,
    reason: Text,
    icon: z.enum(['crown', 'industry', 'army', 'trade', 'science', 'diplomacy']),
    days: z.number().positive().max(36500),
    durationReason: Text,
    investments: z.array(Text).min(1).max(4).describe('投入的人力、物资或机构，简短名词'),
    commitments: z
      .array(z.object({ key: Id, name: Text }).strict())
      .default([])
      .describe('完成时立下的承诺（只影响本国策）'),
    mutexReason: z.string().nullable().default(null).describe('有 mutex 时必填：玩家看到的锁定理由'),
    news: z
      .object({
        headline: Text.describe('像报纸头条，报导骨架的 action'),
        body: Text.describe('世界如何反应'),
        option: z.object({ label: Text, text: z.string().default('') }).strict(),
      })
      .strict()
      .nullable()
      .default(null)
      .describe('pivotal 必填；normal 为 null'),
  })
  .strict();
export type FillNode = z.output<typeof FillNodeSchema>;
/** Parsed loosely so one bad focus does not reject the whole batch. */
const FillReplySchema = z.object({ nodes: z.array(z.unknown()).max(300) });
const FillShownSchema = z.object({ nodes: z.array(FillNodeSchema) });

export type SkeletonProgress = {
  skeleton?: Skeleton;
  /** A skeleton reply that still has problems; correction rounds continue from it on a rerun. */
  draft?: unknown;
  filled: Record<string, FillNode>;
};
/** Correction rounds (JSON Patch) before a skeleton with problems fails the task. */
export const skeletonFixRounds = 3;
/** Any JSON object: the skeleton is parsed and checked after local repairs and corrections. */
const LooseSkeletonSchema = z.record(z.string(), z.unknown());

function capabilityNames(skeleton: Pick<Skeleton, 'capabilities' | 'capabilityCatalog'>) {
  return new Map([
    ...skeleton.capabilities.map((c) => [c.id, c.name] as const),
    ...skeleton.capabilityCatalog.map((c) => [c.key, c.name] as const),
  ]);
}

function label(condition: Condition, names: Map<string, string>, facts: Map<string, string>): Requirement {
  const negate = 'negate' in condition && condition.negate === true;
  switch (condition.kind) {
    case 'capability': {
      const name = names.get(condition.id) ?? condition.id;
      return negate
        ? { kind: 'capability', id: condition.id, label: `没有「${name}」`, negate: true }
        : { kind: 'capability', id: condition.id, label: name };
    }
    case 'fact': {
      const text = facts.get(condition.id) ?? condition.id;
      return negate
        ? { kind: 'fact', id: condition.id, label: `尚未：${text}`, negate: true }
        : { kind: 'fact', id: condition.id, label: text };
    }
    case 'stability':
      return { kind: 'stability', minimum: condition.minimum, label: `稳定度 ≥ ${condition.minimum}` };
    case 'warSupport':
      return { kind: 'warSupport', minimum: condition.minimum, label: `战争支持度 ≥ ${condition.minimum}` };
  }
}

/** Effects fixed by the skeleton: capabilities provided or revoked, stat changes, then conditional ones. */
function skeletonEffects(
  node: SkeletonNode,
  names: Map<string, string>,
  facts: Map<string, string>,
): Effect[] {
  return [
    ...outcomeEffects(node, names, ''),
    ...node.conditional.flatMap((item, i) =>
      outcomeEffects(item, names, `if${i}_`).map((effect) => ({
        ...effect,
        when: item.when.map((c) => label(c, names, facts)),
      })),
    ),
  ];
}
function outcomeEffects(
  node: Pick<SkeletonNode, 'provides' | 'revokes' | 'stats'>,
  names: Map<string, string>,
  prefix: string,
): Effect[] {
  return [
    ...node.provides.map(
      (key): Effect => ({
        id: `${prefix}gain_${key}`,
        kind: 'capability',
        key,
        name: names.get(key) ?? key,
        active: true,
      }),
    ),
    ...node.revokes.map(
      (key): Effect => ({
        id: `${prefix}lose_${key}`,
        kind: 'capability',
        key,
        name: names.get(key) ?? key,
        active: false,
      }),
    ),
    ...(['stability', 'warSupport'] as const).flatMap((kind): Effect[] =>
      node.stats[kind] ? [{ id: `${prefix}${kind}`, kind, value: node.stats[kind] }] : [],
    ),
  ];
}

/** A full focus from its skeleton and (optionally) its fill; the placeholder text is for checks only. */
export function buildNode(
  skeleton: Skeleton,
  node: SkeletonNode,
  fill?: FillNode,
): Omit<FocusNode, 'x' | 'y'> {
  const names = capabilityNames(skeleton);
  const facts = new Map(skeleton.facts.map((f) => [f.id, f.label]));
  const commitments: Effect[] = (fill?.commitments ?? []).map((c, i) => ({
    id: `pledge_${i}_${c.key}`,
    kind: 'commitment',
    key: c.key,
    name: c.name,
  }));
  return {
    id: node.id,
    name: node.name,
    branch: node.branch,
    description: fill?.description ?? node.gist,
    reason: fill?.reason ?? node.gist,
    icon: fill?.icon ?? 'crown',
    days: fill?.days ?? 30,
    durationReason: fill?.durationReason ?? node.gist,
    prerequisites: node.prerequisites,
    requirements: node.requirements.map((c) => label(c, names, facts)),
    sustain: node.sustain.map((c) => label(c, names, facts)),
    outcomes: node.outcomes.map((c) => label(c, names, facts)),
    investments: fill?.investments ?? [node.gist],
    effects: [...skeletonEffects(node, names, facts), ...commitments],
    mutex: node.mutex
      ? {
          group: node.mutex.group,
          route: node.mutex.route,
          lock: node.mutex.lock,
          reason: fill?.mutexReason?.trim() || node.gist,
        }
      : null,
    impact: node.impact,
    ...(node.execution === 'ongoing' ? { execution: 'ongoing' as const } : {}),
    news:
      node.impact === 'pivotal'
        ? (fill?.news ?? {
            headline: node.action ?? node.name,
            body: node.gist,
            option: { label: '知道了', text: '' },
          })
        : null,
  };
}

/** Nodes that must be completed before `id` can start, whatever alternatives the player takes. */
function mandatoryAncestors(nodes: SkeletonNode[]): (id: string) => Set<string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const known = memo.get(id);
    if (known) {
      return known;
    }
    if (stack.has(id)) {
      return new Set(); // Cycles are reported by layoutTree.
    }
    stack.add(id);
    const result = new Set<string>();
    for (const group of byId.get(id)?.prerequisites ?? []) {
      const options = group.map((option) => new Set([option, ...visit(option, stack)]));
      for (const candidate of options[0] ?? []) {
        if (options.every((option) => option.has(candidate))) {
          result.add(candidate);
        }
      }
    }
    stack.delete(id);
    memo.set(id, result);
    return result;
  };
  return (id) => visit(id, new Set());
}

/** Mandatory ancestors and route exclusivity, shared by the feasibility checks. */
function routeInfo(nodes: SkeletonNode[]) {
  const ancestors = mandatoryAncestors(nodes);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const routes = (id: string) => {
    const result = new Map<string, string>();
    for (const member of [id, ...ancestors(id)]) {
      const mutex = byId.get(member)?.mutex;
      if (mutex) {
        result.set(mutex.group, mutex.route);
      }
    }
    return result;
  };
  /** Two focuses that can never both be taken: their own or mandatory routes differ in one group. */
  const exclusive = (a: string, b: string) => {
    const left = routes(a);
    return [...routes(b)].some(([group, route]) => left.has(group) && left.get(group) !== route);
  };
  return { ancestors, exclusive, routes };
}

/**
 * A revoked capability must not strand a focus that needs it. Each such focus must be exclusive
 * with the revoker, be a mandatory ancestor of it (so it is done first), or have another provider
 * that always comes after the revoker and so can restore the capability.
 */
export function assertRevocationsSafe(skeleton: Skeleton): void {
  const nodes = skeleton.nodes;
  const { ancestors, exclusive } = routeInfo(nodes);
  const historical = new Set(skeleton.historical.map((h) => h.node));
  for (const revoker of nodes) {
    if (historical.has(revoker.id)) {
      continue;
    }
    // A conditional revocation may happen, so it is checked like an unconditional one.
    for (const key of new Set([...revoker.revokes, ...revoker.conditional.flatMap((c) => c.revokes)])) {
      const before = ancestors(revoker.id);
      // Only a focus that can happen after the revocation restores it: the revoker is its mandatory
      // ancestor. A provider completed earlier cannot be done again.
      const restorers = nodes.filter(
        (n) => n.id !== revoker.id && n.provides.includes(key) && ancestors(n.id).has(revoker.id),
      );
      for (const node of nodes) {
        if (node.id === revoker.id || historical.has(node.id)) {
          continue;
        }
        const needs = [...node.requirements, ...node.sustain, ...node.outcomes].some(
          (c) => c.kind === 'capability' && c.id === key && !c.negate,
        );
        if (!needs || before.has(node.id) || exclusive(node.id, revoker.id)) {
          continue;
        }
        requireThat(
          restorers.some((r) => r.id !== node.id && !exclusive(r.id, node.id)),
          `国策 ${revoker.id} 撤销能力 ${key} 后，需要它的国策 ${node.id} 可能永远无法推进；请让两者互斥、让 ${node.id} 成为 ${revoker.id} 的必经前置，或让一个以 ${revoker.id} 为必经前置的国策重新提供 ${key}`,
        );
      }
    }
  }
}

type Use = { key: string; where: string; negate: boolean };
const stages = [
  ['requirements', '开始条件'],
  ['sustain', '推进条件'],
  ['outcomes', '完成条件'],
] as const;
/** Capability and stat conditions a focus reads, including the `when` of its conditional outcomes. */
function usesOf(node: SkeletonNode): {
  capabilities: Use[];
  stats: { kind: string; minimum: number; where: string }[];
} {
  const capabilities: Use[] = [];
  const stats: { kind: string; minimum: number; where: string }[] = [];
  const read = (conditions: Condition[], where: string) => {
    for (const c of conditions) {
      if (c.kind === 'capability') {
        capabilities.push({ key: c.id, where, negate: c.negate === true });
      } else if (c.kind === 'stability' || c.kind === 'warSupport') {
        stats.push({ kind: c.kind, minimum: c.minimum, where });
      }
    }
  };
  for (const [field, where] of stages) {
    read(node[field], where);
  }
  for (const item of node.conditional) {
    read(item.when, '条件式成果');
  }
  return { capabilities, stats };
}
const statNames: Record<string, string> = { stability: '稳定度', warSupport: '战争支持度' };
/** What a focus changes on completion, conditional outcomes included. */
function changesOf(node: SkeletonNode) {
  const all = [node, ...node.conditional];
  return {
    provides: new Set(all.flatMap((o) => o.provides)),
    revokes: new Set(all.flatMap((o) => o.revokes)),
    stats: (['stability', 'warSupport'] as const).flatMap((kind) =>
      all.filter((o) => o.stats[kind]).map((o) => ({ kind, value: o.stats[kind] })),
    ),
  };
}
type Link = { choice: boolean; kind: 'prerequisite' | 'capability' | 'stat' | 'mutex'; text: string };
/**
 * The rules through which `a` affects `b`. A plain prerequisite is a real link but does not by
 * itself change the other side's choices; conditions, conditional outcomes, stat thresholds and
 * mutex routes do (`choice`).
 */
function linksFrom(a: SkeletonNode, b: SkeletonNode, names: Map<string, string>): Link[] {
  const links: Link[] = [];
  if (b.prerequisites.flat().includes(a.id)) {
    links.push({ choice: false, kind: 'prerequisite', text: `「${a.name}」是「${b.name}」的前置` });
  }
  const changes = changesOf(a);
  const uses = usesOf(b);
  for (const use of uses.capabilities) {
    const name = names.get(use.key) ?? use.key;
    const need = `「${b.name}」的${use.where}${use.negate ? '要求没有' : '需要'}「${name}」`;
    if (changes.provides.has(use.key)) {
      links.push({ choice: true, kind: 'capability', text: `「${a.name}」提供「${name}」→ ${need}` });
    }
    if (changes.revokes.has(use.key)) {
      links.push({ choice: true, kind: 'capability', text: `「${a.name}」撤销「${name}」→ ${need}` });
    }
  }
  for (const stat of changes.stats) {
    for (const use of uses.stats.filter((u) => u.kind === stat.kind)) {
      links.push({
        choice: true,
        kind: 'stat',
        text: `「${a.name}」使${statNames[stat.kind]} ${stat.value > 0 ? '+' : ''}${stat.value} →「${b.name}」的${use.where}要求${statNames[stat.kind]} ≥ ${use.minimum}`,
      });
    }
  }
  return links;
}
function relationLinks(from: SkeletonNode, to: SkeletonNode, names: Map<string, string>): Link[] {
  const links = [...linksFrom(from, to, names), ...linksFrom(to, from, names)];
  if (from.mutex && to.mutex && from.mutex.group === to.mutex.group) {
    links.push({
      choice: true,
      kind: 'mutex',
      text:
        from.mutex.route === to.mutex.route
          ? `「${from.name}」与「${to.name}」同属互斥组 ${from.mutex.group} 的同一路线`
          : `「${from.name}」与「${to.name}」是互斥组 ${from.mutex.group} 的不同路线`,
    });
  }
  return links;
}
/** Relations with the rules that implement them, for validation and for the player. */
export function describeRelations(skeleton: Skeleton): (Relation & { choice: boolean })[] {
  const byId = new Map(skeleton.nodes.map((n) => [n.id, n]));
  const names = capabilityNames(skeleton);
  return skeleton.relations.map((relation) => {
    const from = byId.get(relation.from);
    const to = byId.get(relation.to);
    const links = from && to ? relationLinks(from, to, names) : [];
    return { ...relation, via: links.map((l) => l.text), choice: links.some((l) => l.choice) };
  });
}

/**
 * The core branch must change the choices of other branches; every other branch takes part in
 * some cross-branch relation or says why it can stand alone in this tree (handoff doc section 32).
 */
export function validateRelations(skeleton: Skeleton): void {
  const byId = new Map(skeleton.nodes.map((n) => [n.id, n]));
  for (const relation of skeleton.relations) {
    requireThat(byId.has(relation.from), `关系的 from「${relation.from}」不是骨架中的国策`);
    requireThat(byId.has(relation.to), `关系的 to「${relation.to}」不是骨架中的国策`);
    requireThat(relation.from !== relation.to, `关系 ${relation.from} 不能指向自己`);
  }
  const described = describeRelations(skeleton);
  for (const relation of described) {
    requireThat(
      relation.via.length,
      `关系 ${relation.from} → ${relation.to}（${relationKindNames[relation.kind]}）没有实际规则对应：请用前置、能力条件（含「必须没有」）、条件式成果、数值门槛或互斥实现，或删除这条关系`,
    );
  }
  const cores = skeleton.branches.filter((b) => b.core);
  requireThat(
    cores.length === 1,
    `必须恰好有一支分支标记 core=true（本国最主要的战略问题所在），本次有 ${cores.length} 支`,
  );
  const core = cores[0];
  requireThat(core.coreReason?.trim(), `核心分支「${core.name}」缺少 coreReason`);
  requireThat(!core.independent, `核心分支「${core.name}」不能标记为独立`);
  const branchOf = (id: string) => byId.get(id)!.branch;
  const crossing = described.filter((r) => branchOf(r.from) !== branchOf(r.to));
  const reached = new Set(
    crossing
      .filter((r) => r.choice && [branchOf(r.from), branchOf(r.to)].includes(core.name))
      .map((r) => (branchOf(r.from) === core.name ? branchOf(r.to) : branchOf(r.from))),
  );
  const needed = coreReach(skeleton.branches.length);
  requireThat(
    reached.size >= needed,
    `核心分支「${core.name}」至少要改变 ${needed} 支其他分支的选择（目前 ${reached.size} 支）：用能力条件（含「必须没有」）、条件式成果、数值门槛或互斥建立关系；单纯的前置不算`,
  );
  const names = capabilityNames(skeleton);
  for (const branch of skeleton.branches) {
    if (branch === core) {
      continue;
    }
    const involved = crossing.some((r) => branchOf(r.from) === branch.name || branchOf(r.to) === branch.name);
    if (branch.independent !== undefined) {
      requireThat(branch.independent.trim(), `分支「${branch.name}」的 independent 不可为空白`);
      requireThat(
        !involved,
        `分支「${branch.name}」标记为独立，却参与跨分支关系；请删除 independent，或删除这些关系`,
      );
      // Independence is judged by the rules, not by the relation list: no capability or mutex
      // link with another branch, and no prerequisite across branches except a common starting
      // focus (one with no prerequisites of its own). Stability and war support are national
      // totals every branch touches, so they do not count.
      const own = skeleton.nodes.filter((n) => n.branch === branch.name);
      const others = skeleton.nodes.filter((n) => n.branch !== branch.name);
      const inside = new Set(own.map((n) => n.id));
      for (const [child, parent] of [
        ...own.flatMap((n) => n.prerequisites.flat().map((id) => [n, byId.get(id)!] as const)),
        ...others.flatMap((n) => n.prerequisites.flat().map((id) => [n, byId.get(id)!] as const)),
      ]) {
        const crosses = inside.has(child.id) !== inside.has(parent.id);
        requireThat(
          !crosses || parent.prerequisites.length === 0,
          `分支「${branch.name}」标记为独立，但「${child.name}」以其他分支中后期的「${parent.name}」为前置；独立分支只能和别支共用起点国策（没有前置的国策），请删除 independent 并写成关系，或调整前置`,
        );
      }
      for (const a of own) {
        for (const b of others) {
          const link = relationLinks(a, b, names).find((l) => l.kind === 'capability' || l.kind === 'mutex');
          requireThat(
            !link,
            `分支「${branch.name}」标记为独立，但规则上与分支「${b.branch}」互相影响（${link?.text}）；请删除 independent 并写成关系，或移除这条规则`,
          );
        }
      }
    } else {
      requireThat(
        involved,
        `分支「${branch.name}」没有参与任何跨分支关系；请加入关系，或写 independent 说明它在本树涵盖的时期与议题内为何可以独立推进`,
      );
    }
  }
}

/**
 * Conditions that can never hold are rejected (no full state search, only the certain cases):
 * - the same capability required and required absent by one focus;
 * - "must not have K" when K is surely held before the focus starts and no focus that can come
 *   before it (not after it, not on an excluded route) revokes K;
 * - a condition on a capability that only a conditional outcome grants.
 */
export function assertConditionsFeasible(skeleton: Skeleton): void {
  const nodes = skeleton.nodes;
  const { ancestors, exclusive, routes } = routeInfo(nodes);
  const graph = nodes.map((n) => ({
    id: n.id,
    prerequisites: n.prerequisites,
    mutex: n.mutex ? { ...n.mutex, reason: '' } : null,
  }));
  const initial = new Set(skeleton.capabilities.filter((c) => c.active).map((c) => c.id));
  const plainProviders = new Map<string, string[]>();
  const anyProviders = new Set<string>();
  const revoked = new Map<string, string[]>();
  for (const node of nodes) {
    for (const key of node.provides) {
      plainProviders.set(key, [...(plainProviders.get(key) ?? []), node.id]);
    }
    for (const key of changesOf(node).provides) {
      anyProviders.add(key);
    }
    for (const key of changesOf(node).revokes) {
      revoked.set(key, [...(revoked.get(key) ?? []), node.id]);
    }
  }
  const names = capabilityNames(skeleton);
  for (const node of nodes) {
    // Only one focus advances at a time, so nothing in the tree changes a capability between the
    // start and the completion of this focus: K and "not K" in any two of its stages conflict.
    const wanted = new Map<string, boolean>();
    for (const [field] of stages) {
      for (const c of node[field]) {
        if (c.kind !== 'capability') {
          continue;
        }
        const name = names.get(c.id) ?? c.id;
        const negate = c.negate === true;
        requireThat(
          !wanted.has(c.id) || wanted.get(c.id) === negate,
          `国策 ${node.id} 同时要求有与没有「${name}」，条件互相矛盾`,
        );
        wanted.set(c.id, negate);
      }
    }
    for (const [field, where] of stages) {
      for (const c of node[field]) {
        if (c.kind !== 'capability') {
          continue;
        }
        const name = names.get(c.id) ?? c.id;
        if (c.negate) {
          const surely =
            initial.has(c.id) || (plainProviders.get(c.id) ?? []).some((p) => ancestors(node.id).has(p));
          // A revoker helps only if it can be completed before this focus starts while this focus
          // stays possible: some prerequisite path avoids this focus and every route that excludes it.
          const usable = surely
            ? (revoked.get(c.id) ?? []).filter(
                (r) =>
                  r !== node.id &&
                  !ancestors(r).has(node.id) &&
                  !exclusive(r, node.id) &&
                  reachableBefore(graph, r, node.id, routes(node.id)),
              )
            : [];
          requireThat(
            !surely || usable.length,
            `国策 ${node.id} 的${where}要求没有「${name}」，但它开始前一定已有「${name}」，而且没有能在它之前完成的国策撤销「${name}」`,
          );
        } else {
          requireThat(
            initial.has(c.id) || plainProviders.has(c.id) || !anyProviders.has(c.id),
            `能力「${name}」只由条件式成果提供，不能作为国策 ${node.id} 的${where}；请改为无条件提供，或只在其他条件式成果的 when 中使用`,
          );
        }
      }
    }
  }
}

/**
 * Every structural rule, checked on the skeleton before any focus text is written. Returns all
 * problems found: reference and field problems first (the structure checks need them fixed), then
 * every structure check that can run.
 */
export function skeletonProblems(snapshot: Snapshot, candidate: Candidate, skeleton: Skeleton): string[] {
  const size = snapshot.state.settings.size;
  const [min, max] = sizeLimits[size];
  const [fewest, most] = brevityOf(size).branches;
  const issues: string[] = [];
  const nodes = skeleton.nodes;
  // A short skeleton is completed by inserting focuses, so it never stops the other checks.
  const count =
    nodes.length < min
      ? `骨架须有 ${min}–${max} 个国策，本次有 ${nodes.length} 个：请用 insert /nodes/- 新增至少 ${min - nodes.length} 个国策，接在既有国策之后，优先补在较短的分支`
      : nodes.length > max
        ? `骨架须有 ${min}–${max} 个国策，本次有 ${nodes.length} 个：请用 remove 删除至少 ${nodes.length - max} 个国策，并移除指向它们的前置与关系`
        : '';
  const basic = collect(issues, () => {
    requireThat(skeleton.id === candidate.id, '骨架的国家 id 必须等于 candidate.id');
    requireThat(
      skeleton.branches.length >= fewest && skeleton.branches.length <= most,
      `分支数须为 ${fewest}–${most}，本次有 ${skeleton.branches.length} 支；规模靠分支的深度与互斥路线，而不是更多分支`,
    );
    for (const key of ['id', 'name'] as const) {
      requireThat(
        new Set(skeleton.branches.map((b) => b[key])).size === skeleton.branches.length,
        '分支 id 与 name 不可重复',
      );
    }
    requireThat(new Set(nodes.map((n) => n.id)).size === nodes.length, '国策 id 不可重复');
    const branchNames = new Set(skeleton.branches.map((b) => b.name));
    for (const node of nodes) {
      requireThat(
        branchNames.has(node.branch),
        `国策 ${node.id} 的 branch「${node.branch}」不是任何分支的 name`,
      );
    }
    for (const branch of skeleton.branches) {
      requireThat(
        nodes.some((n) => n.branch === branch.name),
        `分支「${branch.name}」没有任何国策`,
      );
    }
    const names = capabilityNames(skeleton);
    requireThat(
      new Set(skeleton.capabilityCatalog.map((c) => c.key)).size === skeleton.capabilityCatalog.length &&
        new Set(skeleton.capabilities.map((c) => c.id)).size === skeleton.capabilities.length,
      '能力 key 不可重复',
    );
    const facts = new Set(skeleton.facts.map((f) => f.id));
    requireThat(facts.size === skeleton.facts.length, 'facts 的 id 不可重复');
    const declared = new Map(skeleton.choices.map((c) => [c.group, new Set(c.routes.map((r) => r.id))]));
    requireThat(declared.size === skeleton.choices.length, 'choices 的 group 不可重复');
    for (const node of nodes) {
      for (const key of [...changesOf(node).provides, ...changesOf(node).revokes]) {
        requireThat(names.has(key), `国策 ${node.id} 的能力 ${key} 不在 capabilityCatalog 或初始能力中`);
      }
      for (const [i, item] of node.conditional.entries()) {
        requireThat(
          item.provides.length || item.revokes.length || item.stats.stability || item.stats.warSupport,
          `国策 ${node.id} 的第 ${i + 1} 个条件式成果没有任何效果`,
        );
      }
      for (const condition of [
        ...node.requirements,
        ...node.sustain,
        ...node.outcomes,
        ...node.conditional.flatMap((c) => c.when),
      ]) {
        if (condition.kind === 'capability') {
          requireThat(
            names.has(condition.id),
            `国策 ${node.id} 的能力条件 ${condition.id} 不在 capabilityCatalog 或初始能力中`,
          );
          // "Must not have K yet" before establishing K is fine; requiring K itself is circular.
          requireThat(
            condition.negate === true || !node.provides.includes(condition.id),
            `国策 ${node.id} 的条件引用自己提供的能力 ${condition.id}`,
          );
        }
        if (condition.kind === 'fact') {
          requireThat(facts.has(condition.id), `国策 ${node.id} 的 fact 条件 ${condition.id} 不在 facts 中`);
        }
      }
      requireThat(
        (node.impact === 'pivotal') === Boolean(node.action?.trim()),
        node.impact === 'pivotal'
          ? `重要国策 ${node.id} 缺少 action（新闻要报导的国家行动）`
          : `国策 ${node.id} 不是重要国策，action 应为 null`,
      );
      if (node.mutex) {
        requireThat(
          declared.get(node.mutex.group)?.has(node.mutex.route) ?? false,
          `国策 ${node.id} 的 mutex（${node.mutex.group}/${node.mutex.route}）不在 choices 中`,
        );
      }
    }
    for (const choice of skeleton.choices) {
      for (const route of choice.routes) {
        requireThat(
          nodes.some((n) => n.mutex?.group === choice.group && n.mutex.route === route.id),
          `互斥组 ${choice.group} 的路线 ${route.id}（${route.name}）没有任何国策`,
        );
      }
    }
    const ids = new Set(nodes.map((n) => n.id));
    for (const entry of skeleton.historical) {
      requireThat(ids.has(entry.node), `historical 的 ${entry.node} 不是骨架中的国策`);
    }
  });
  if (!basic) {
    return [...new Set([...issues, ...(count ? [count] : [])])];
  }
  const built = nodes.map((node) => buildNode(skeleton, node));
  // Structure: missing references, cycles, forks, joins, cross links, mutex routes, reachability.
  if (collect(issues, () => validateTopology(built, size))) {
    for (const branch of skeleton.branches) {
      collect(issues, () => assertTurningPoints(built, [branch.name]));
    }
    collect(issues, () => forksAndJoins(skeleton, built));
    collect(issues, () => assertConditionsFeasible(skeleton));
    collect(issues, () =>
      assertCapabilityOrder(
        layoutTree(built) as FocusNode[],
        skeleton.capabilities.filter((c) => c.active).map((c) => c.id),
        skeleton.historical.map((h) => h.node),
      ),
    );
    collect(issues, () => assertRevocationsSafe(skeleton));
    collect(issues, () => validateRelations(skeleton));
  }
  return [...new Set([...issues, ...(count ? [count] : [])])];
}

/** Every branch with 5 or more focuses needs one fork and one join inside it. */
function forksAndJoins(skeleton: Skeleton, built: ReturnType<typeof buildNode>[]): void {
  for (const branch of skeleton.branches) {
    const own = built.filter((n) => n.branch === branch.name);
    if (own.length < 5) {
      continue;
    }
    const inside = new Set(own.map((n) => n.id));
    const children = new Map<string, number>();
    for (const node of own) {
      for (const id of new Set(node.prerequisites.flat())) {
        if (inside.has(id)) {
          children.set(id, (children.get(id) ?? 0) + 1);
        }
      }
    }
    requireThat(
      [...children.values()].some((count) => count > 1),
      `分支「${branch.name}」至少需要一处分岔：一个国策同时是两个以上国策的前置`,
    );
    requireThat(
      own.some((n) => n.prerequisites.flat().length > 1),
      `分支「${branch.name}」至少需要一处汇流：一个国策有两个以上前置`,
    );
  }
}

/** Throwing form of skeletonProblems, for callers that need one error. */
export function validateSkeleton(snapshot: Snapshot, candidate: Candidate, skeleton: Skeleton): void {
  const problems = skeletonProblems(snapshot, candidate, skeleton);
  requireThat(!problems.length, `骨架有 ${problems.length} 个问题：\n${formatIssues(problems)}`);
}

export function skeletonPlan(snapshot: Snapshot, candidate: Candidate, previousProblems: string[] = []) {
  const size = snapshot.state.settings.size;
  const [min, max] = sizeLimits[size];
  const budget = brevityOf(size);
  const minimum = topologyMinimumOf(size);
  const data = {
    candidate,
    context: snapshot.context,
    now: snapshot.day,
    size,
    pace: snapshot.state.settings.pace,
    limits: {
      min,
      max,
      branches: `${budget.branches[0]}–${budget.branches[1]}`,
      perBranch: `${budget.perBranch[0]}–${budget.perBranch[1]}`,
      minimumForks: minimum,
      minimumJoins: minimum,
      minimumCrossBranchLinks: crossLinkMinimumOf(size),
      coreMinimumBranches: coreReach(budget.branches[0]),
      gist: 40,
    },
    // A fresh skeleton after patching stalled: what the previous design could not resolve.
    previousProblems,
  };
  const validate = (skeleton: Skeleton) => validateSkeleton(snapshot, candidate, skeleton);
  return {
    data,
    schema: SkeletonSchema,
    validate,
    label: previousProblems.length ? '重新生成骨架' : '生成骨架',
  };
}

/** A raw skeleton reply after local repairs: the parsed skeleton when it fits, and every problem. */
export function checkSkeleton(
  snapshot: Snapshot,
  candidate: Candidate,
  raw: unknown,
): { raw: unknown; skeleton?: Skeleton; problems: string[] } {
  const repaired = repairSkeleton(raw);
  const parsed = SkeletonSchema.safeParse(repaired);
  if (!parsed.success) {
    return { raw: repaired, problems: schemaIssues(parsed.error, repaired) };
  }
  return {
    raw: repaired,
    skeleton: parsed.data,
    problems: skeletonProblems(snapshot, candidate, parsed.data),
  };
}

/** One correction request: the current skeleton, its problems, and room for patch operations. */
export function fixPlan(
  snapshot: Snapshot,
  candidate: Candidate,
  raw: unknown,
  problems: string[],
  round: number,
  skipped: string[],
  attempt = '',
) {
  const base = skeletonPlan(snapshot, candidate).data;
  const data = {
    candidate,
    now: base.now,
    size: base.size,
    limits: base.limits,
    skeleton: raw,
    issues: formatIssues(problems).split('\n'),
    skippedOperations: skipped,
  };
  let outcome: { result: unknown; errors: string[] } = { result: raw, errors: [] };
  const validate = (reply: z.output<typeof PatchReplySchema>) => {
    const applied = applyPatch(raw, reply.patch);
    requireThat(
      !reply.patch.length || applied.applied,
      `没有任何修正操作能套用：${applied.errors.slice(0, 5).join('；')}`,
    );
    outcome = { result: applied.result, errors: applied.errors };
  };
  return {
    data,
    schema: PatchReplySchema,
    validate,
    label: `修正骨架（${attempt}第 ${round}/${skeletonFixRounds} 轮，${problems.length} 个问题）`,
    outcome: () => outcome,
  };
}

/** Skeleton IDs in skeleton order, split into batches of at most `cap`. */
export function fillBatches(ids: string[], cap: number): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += cap) {
    batches.push(ids.slice(i, i + cap));
  }
  return batches;
}

/**
 * One fill request. `accept` keeps every focus that passes and throws only when none does, so a
 * single bad focus never costs the whole batch.
 */
export function fillPlan(
  snapshot: Snapshot,
  candidate: Candidate,
  skeleton: Skeleton,
  batch: string[],
  filled: Record<string, FillNode>,
  title: string,
  previous: Record<string, string> = {},
) {
  const byId = new Map(skeleton.nodes.map((n) => [n.id, n]));
  const names = capabilityNames(skeleton);
  const facts = new Map(skeleton.facts.map((f) => [f.id, f.label]));
  const describe = (c: Condition) => label(c, names, facts);
  const relations = describeRelations(skeleton);
  const data = {
    candidate,
    context: snapshot.context,
    now: snapshot.day,
    size: snapshot.state.settings.size,
    pace: snapshot.state.settings.pace,
    skeleton: {
      analysis: skeleton.analysis,
      capabilities: skeleton.capabilities,
      capabilityCatalog: skeleton.capabilityCatalog,
      facts: skeleton.facts,
      branches: skeleton.branches,
      choices: skeleton.choices,
      relations: relations.map(({ choice: _choice, ...r }) => r),
      nodes: skeleton.nodes.map((n) => ({
        id: n.id,
        name: n.name,
        branch: n.branch,
        gist: n.gist,
        prerequisites: n.prerequisites,
        mutex: n.mutex,
        impact: n.impact,
        ...(n.execution === 'ongoing' ? { execution: n.execution } : {}),
      })),
    },
    batch: batch.map((id) => {
      const node = byId.get(id)!;
      return {
        ...node,
        requirements: node.requirements.map(describe),
        sustain: node.sustain.map(describe),
        outcomes: node.outcomes.map(describe),
        provides: node.provides.map((key) => ({ key, name: names.get(key) })),
        revokes: node.revokes.map((key) => ({ key, name: names.get(key) })),
        conditional: node.conditional.map((item) => ({
          when: item.when.map(describe),
          provides: item.provides.map((key) => ({ key, name: names.get(key) })),
          revokes: item.revokes.map((key) => ({ key, name: names.get(key) })),
          stats: item.stats,
        })),
        relations: relations
          .filter((r) => r.from === id || r.to === id)
          .map((r) => ({
            kind: relationKindNames[r.kind],
            other: byId.get(r.from === id ? r.to : r.from)?.name,
            change: r.change,
            via: r.via,
          })),
        historical: skeleton.historical.find((h) => h.node === id)?.evidence ?? null,
        previousError: previous[id] ?? null,
      };
    }),
    limits: { text: fillText },
  };
  const wanted = new Set(batch);
  let result: { accepted: Record<string, FillNode>; rejected: Record<string, string> } = {
    accepted: {},
    rejected: {},
  };
  const accept = (reply: z.output<typeof FillReplySchema>) => {
    const accepted: Record<string, FillNode> = {};
    const rejected: Record<string, string> = {};
    const descriptions = new Set(Object.values(filled).map((f) => f.description.trim()));
    for (const raw of reply.nodes) {
      const id =
        raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string'
          ? (raw as { id: string }).id
          : '';
      if (!wanted.has(id) || accepted[id]) {
        continue;
      }
      const parsed = FillNodeSchema.safeParse(raw);
      if (!parsed.success) {
        rejected[id] = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || '(root)'}：${issue.message}`)
          .join('；');
        continue;
      }
      const fill = parsed.data;
      const node = byId.get(id)!;
      if (node.impact === 'pivotal' && !fill.news) {
        rejected[id] = '重要国策必须填 news（headline 报导骨架的 action、body、option）';
        continue;
      }
      if (node.mutex && !fill.mutexReason?.trim()) {
        rejected[id] = '有互斥路线的国策必须填 mutexReason';
        continue;
      }
      if (descriptions.has(fill.description.trim())) {
        rejected[id] = 'description 与其他国策完全相同';
        continue;
      }
      descriptions.add(fill.description.trim());
      accepted[id] = node.impact === 'pivotal' ? fill : { ...fill, news: null };
    }
    for (const id of batch) {
      if (!accepted[id] && !rejected[id]) {
        rejected[id] = '回复中没有这个国策';
      }
    }
    requireThat(
      Object.keys(accepted).length > 0,
      `本批没有任何国策通过：${Object.entries(rejected)
        .slice(0, 5)
        .map(([id, reason]) => `${id}（${reason}）`)
        .join('；')}`,
    );
    result = { accepted, rejected };
  };
  return {
    data,
    schema: FillReplySchema,
    shown: FillShownSchema,
    validate: accept,
    label: title,
    result: () => result,
  };
}

/** The complete tree: skeleton structure with fill text, ready for the final checks. */
export function mergeFill(skeleton: Skeleton, filled: Record<string, FillNode>): GeneratedTree {
  return {
    id: skeleton.id,
    name: skeleton.name,
    description: skeleton.description,
    stability: skeleton.stability,
    warSupport: skeleton.warSupport,
    evidence: skeleton.evidence,
    ...(skeleton.keywords.length ? { keywords: skeleton.keywords } : {}),
    periodTitle: skeleton.name,
    agenda: skeleton.analysis,
    longTerm: [],
    analysis: skeleton.analysis,
    capabilities: skeleton.capabilities,
    branches: skeleton.branches,
    relations: describeRelations(skeleton).map(({ choice: _choice, ...r }) => r),
    historical: skeleton.historical,
    nodes: skeleton.nodes.map((node) => buildNode(skeleton, node, filled[node.id])),
  };
}

export async function generateBySkeleton(
  snapshot: Snapshot,
  candidate: Candidate,
  ask: GenerationRequest,
  progress: SkeletonProgress,
  segmentMax: number,
  retries = 0,
): Promise<GeneratedTree> {
  if (!progress.skeleton) {
    // Small slips are repaired locally; the rest is corrected with patches instead of asking for
    // the whole skeleton again (a full rewrite tends to trade one mistake for another).
    let raw = progress.draft;
    if (raw === undefined) {
      const plan = skeletonPlan(snapshot, candidate);
      raw = await ask('skeleton', plan.data, LooseSkeletonSchema, undefined, plan.label, plan.schema);
    }
    // Each task retry buys another block of fix rounds. A block that did not reduce the problems
    // is abandoned for a fresh skeleton told what the stalled one could not resolve.
    const attempts = Math.max(0, Math.floor(retries)) + 1;
    let skipped: string[] = [];
    let attempt = 1;
    let round = 0;
    let atStart = Infinity;
    for (;;) {
      const checked = checkSkeleton(snapshot, candidate, raw);
      raw = checked.raw;
      if (checked.skeleton && !checked.problems.length) {
        progress.skeleton = checked.skeleton;
        progress.draft = undefined;
        break;
      }
      progress.draft = raw;
      if (round === 0) {
        atStart = checked.problems.length;
      }
      if (round === skeletonFixRounds) {
        requireThat(
          attempt < attempts,
          `骨架修正 ${attempts * skeletonFixRounds} 轮（${attempts} 次尝试）后仍有 ${checked.problems.length} 个问题（重跑会从目前的骨架继续修正）：\n${formatIssues(checked.problems)}`,
        );
        attempt++;
        round = 0;
        skipped = [];
        if (checked.problems.length >= atStart) {
          const plan = skeletonPlan(snapshot, candidate, checked.problems);
          raw = await ask('skeleton', plan.data, LooseSkeletonSchema, undefined, plan.label, plan.schema);
        }
        continue;
      }
      round++;
      const label = attempts > 1 ? `第 ${attempt}/${attempts} 次，` : '';
      const fix = fixPlan(snapshot, candidate, raw, checked.problems, round, skipped, label);
      await ask('skeleton-fix', fix.data, fix.schema, fix.validate, fix.label);
      ({ result: raw, errors: skipped } = fix.outcome());
    }
  }
  const skeleton = progress.skeleton;
  const cap = segmentCap(snapshot.state.settings.size as State['settings']['size'], segmentMax);
  const ids = skeleton.nodes.map((n) => n.id);
  const reasons: Record<string, string> = {};
  const run = async (batch: string[], label: string) => {
    const plan = fillPlan(snapshot, candidate, skeleton, batch, progress.filled, label, reasons);
    await ask('fill', plan.data, plan.schema, plan.validate, plan.label, plan.shown);
    const { accepted, rejected } = plan.result();
    Object.assign(progress.filled, accepted);
    for (const id of Object.keys(accepted)) {
      delete reasons[id];
    }
    Object.assign(reasons, rejected);
  };
  const first = fillBatches(
    ids.filter((id) => !progress.filled[id]),
    cap,
  );
  for (const [index, batch] of first.entries()) {
    await run(batch, `填写第 ${index + 1}/${first.length} 批（${batch.length} 项）`);
  }
  for (let round = 1; round <= refillRounds; round++) {
    const missing = ids.filter((id) => !progress.filled[id]);
    if (!missing.length) {
      break;
    }
    for (const batch of fillBatches(missing, cap)) {
      await run(batch, `补填 ${batch.length} 项（第 ${round} 轮）`);
    }
  }
  const missing = ids.filter((id) => !progress.filled[id]);
  requireThat(
    !missing.length,
    `补填 ${refillRounds} 轮后仍有 ${missing.length} 项没有内容：${missing
      .slice(0, 5)
      .map((id) => `${id}（${reasons[id] ?? '未回复'}）`)
      .join('；')}；重跑会沿用骨架与已完成的国策`,
  );
  const tree = mergeFill(skeleton, progress.filled);
  try {
    validateTree(snapshot, candidate, tree);
  } catch (error) {
    // The skeleton passed every structural check; only the written text is redone.
    progress.filled = {};
    throw error;
  }
  return tree;
}
