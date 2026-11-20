import { z } from 'zod';
import { normalizeBranchReferences } from './branch-references';
import { installCountry, validateGraph } from './engine';
import { GeneratedPoliticsSchema, GeneratedTreeSchema, normalizeCore, validateTopology } from './generation';
import { coreBranch, layoutTree } from './layout';
import {
  sizeLimits,
  StateSchema,
  TreeSchema,
  type Country,
  type Politics,
  type Proposal,
  type State,
} from './model';
import { assignColors, validateFactionRules, validateGeneratedPolitics } from './politics';
import { assertCapabilityOrder } from './reachability';

export type Transition = Proposal['transitions'][number];
export const PeriodReplySchema = z
  .object({
    summary: z.string().min(1).max(1200),
    tree: GeneratedTreeSchema.extend({
      periodTitle: z.string().min(1).max(80),
      agenda: z.string().min(1).max(800),
    }),
  })
  .strict();
export type PeriodReply = z.output<typeof PeriodReplySchema>;
/** The reply that adds politics to an existing country. Null politics means fewer than 2 factions. */
export const PoliticsReplySchema = z
  .object({ reason: z.string().min(1).max(400), politics: GeneratedPoliticsSchema.nullable() })
  .strict();

/** Only a still-active focus is carried; paused and waiting focuses do not take precedence. */
export function periodAnchor(country: Country, invalidateActive = false): string {
  if (!invalidateActive && country.progress[country.current]?.status === 'active') {
    return country.current;
  }
  return (
    Object.entries(country.progress)
      .filter(([, progress]) => progress.status === 'completed')
      .sort((a, b) => (b[1].completed ?? -1) - (a[1].completed ?? -1))[0]?.[0] ?? ''
  );
}

/**
 * Rules for a change of government (spec 五): the country has factions, and the new ruling faction
 * exists, has support and does not rule yet. Other causes pass.
 */
export function checkGovernment(state: State, transition: Transition): void {
  if (transition.cause !== 'government') {
    return;
  }
  const country = state.countries[transition.country];
  const politics = country?.politics;
  if (!politics) {
    throw new Error(`${country?.name ?? transition.country}没有派系，不能提出执政更替（cause=government）`);
  }
  const faction = politics.factions.find((item) => item.id === transition.ruling);
  if (!faction) {
    throw new Error(
      `执政更替的新执政派系 ${transition.ruling} 不存在：ruling 须照抄 state 中${country.name}的派系 id`,
    );
  }
  if (faction.support <= 0) {
    throw new Error(`新执政派系「${faction.name}」的支持度为 0，不能执政`);
  }
  if (faction.id === politics.ruling) {
    throw new Error(`「${faction.name}」已是${country.name}的执政派系：同一派系内换人不算执政更替`);
  }
}

/**
 * `approved` marks a pending change of government that the player approved. The autoPeriod switch
 * does not apply to it.
 */
export function checkTransition(state: State, transition: Transition, approved = false): void {
  const country = state.countries[transition.country];
  if (approved && country?.calibration) {
    throw new Error('此国尚待校准：新一期要依校准后的现况生成，请先完成「更新局势」再换期');
  }
  if (!country?.enabled || (!country.autoPeriod && !approved) || country.calibration) {
    throw new Error('此国未启用自动换期，或尚待校准');
  }
  if (transition.invalidateActive && !['incompatible', 'government'].includes(transition.cause)) {
    throw new Error('只有局势不适配或执政更替可停止承接进行中国策');
  }
  // The approval holds only while the same change is still pending.
  if (
    approved &&
    (transition.cause !== 'government' || country.politics?.pending?.ruling !== transition.ruling)
  ) {
    throw new Error('这项执政更替已不在待决中：已换期、已放弃或已被新的更替取代');
  }
  checkGovernment(state, transition);
}

/** Drop a pending change of government; the ruling faction stays (spec 五「待决」). */
export function dismissPending(input: State, id: string): State {
  if (!input.countries[id]?.politics?.pending) {
    throw new Error('此国没有待决的执政更替');
  }
  const state = structuredClone(input);
  delete state.countries[id].politics!.pending;
  state.revision++;
  return StateSchema.parse(state);
}

/**
 * Give politics to a country that has none. The factions get colour slots as on install. The tree,
 * the progress and the capabilities stay the same.
 */
export function addPolitics(input: State, id: string, politics: Politics): State {
  const country = input.countries[id];
  if (!country) {
    throw new Error('国家不存在');
  }
  if (country.politics) {
    throw new Error('此国已有政局');
  }
  validateGeneratedPolitics(politics);
  const added = structuredClone(politics);
  added.factions = assignColors(added.factions);
  const state = structuredClone(input);
  state.countries[id].politics = added;
  state.revision++;
  return StateSchema.parse(state);
}

/** Commitments of a former government stay; their text says so once (spec 五). */
const FORMER_GOVERNMENT = '前政府：';

/** Replace just the policy tree. Events and all already-applied results belong to the live state. */
export function transitionPeriod(
  input: State,
  transition: Transition,
  reply: PeriodReply,
  approved = false,
): State {
  checkTransition(input, transition, approved);
  const old = input.countries[transition.country];
  const government = transition.cause === 'government';
  const anchor = periodAnchor(old, transition.invalidateActive);
  const number = old.period.number + 1;
  const prefix = `p${number}_`;
  const generated = normalizeCore(normalizeBranchReferences(reply.tree));
  if (generated.id !== old.id) {
    throw new Error('下一期国家 ID 不一致');
  }
  if (generated.historical.length) {
    throw new Error('新一期不得生成已完成国策；承接节点由程式保留');
  }
  if (generated.nodes.length + Number(Boolean(anchor)) > sizeLimits[input.settings.size][1]) {
    throw new Error('新一期超过所选规模上限（包含承接节点）');
  }
  const oldGroups = new Set(Object.values(old.nodes).flatMap((n) => (n.mutex ? [n.mutex.group] : [])));
  const nodes = generated.nodes.map((node) => {
    if (!node.id.startsWith(prefix) || old.nodes[node.id]) {
      throw new Error(`新国策 ID 必须使用 ${prefix} 前缀，且不可重用旧 ID`);
    }
    if (node.mutex && (!node.mutex.group.startsWith(prefix) || oldGroups.has(node.mutex.group))) {
      throw new Error(`新互斥组必须使用 ${prefix} 前缀`);
    }
    if (node.impact === 'pivotal' && !node.news) {
      throw new Error(`重要国策 ${node.id} 缺少新闻`);
    }
    if (government && anchor && node.prerequisites.flat().includes(anchor)) {
      throw new Error(`新国策 ${node.id} 不可以 anchor（${anchor}）为前置：政权已更替，前期国策只作历史保留`);
    }
    return node;
  });
  if (
    new Set(generated.branches.map((b) => b.id)).size !== generated.branches.length ||
    new Set(generated.branches.map((b) => b.name)).size !== generated.branches.length ||
    nodes.some((n) => !generated.branches.some((b) => b.name === n.branch))
  ) {
    throw new Error('新期分支不可重复，节点必须属于已定义分支');
  }
  // A country with politics keeps its own; one without may get them in this reply (spec 六).
  if (old.politics && generated.politics) {
    throw new Error('此国已有派系：新一期不要输出 politics，照抄 state 中的派系 id 与成员 id');
  }
  if (generated.politics) {
    validateGeneratedPolitics(generated.politics);
  }
  let politics = old.politics ?? generated.politics;
  if (government) {
    // The new government takes office with the new tree, and the pending change ends.
    const { pending: _pending, ...rest } = old.politics!;
    politics = { ...rest, ruling: transition.ruling! };
  }
  // New focuses only: the carried focus may name a faction that has dissolved since.
  validateFactionRules(nodes, politics, nodes);
  if (anchor) {
    // The old routes are no longer choices. Preserve work/effects, not obsolete graph edges.
    nodes.unshift({ ...old.nodes[anchor], prerequisites: [], mutex: null });
  }
  const branches = [...generated.branches];
  if (anchor && !branches.some((b) => b.name === old.nodes[anchor].branch)) {
    const branch = old.branches.find((b) => b.name === old.nodes[anchor].branch);
    if (branch) {
      branches.unshift({ ...branch, core: false });
    }
  }
  if (new Set(branches.map((b) => b.id)).size !== branches.length) {
    throw new Error('新分支 ID 与承接分支冲突');
  }
  validateTopology(nodes, input.settings.size);
  const tree = TreeSchema.parse({
    ...generated,
    branches,
    nodes: layoutTree(nodes, coreBranch({ branches })),
    capabilities: Object.values(old.capabilities),
    // The install checks these politics; the country stores them below only when they are new.
    politics,
  });
  assertCapabilityOrder(
    tree.nodes,
    Object.values(old.capabilities)
      .filter((c) => c.active)
      .map((c) => c.id),
    anchor && old.progress[anchor].status === 'completed' ? [anchor] : [],
  );
  const ids = new Set(tree.nodes.map((n) => n.id));
  if (tree.relations?.some((r) => !ids.has(r.from) || !ids.has(r.to))) {
    throw new Error('新期关系引用不存在的节点');
  }
  const base = structuredClone(input);
  delete base.countries[old.id];
  const installed = installCountry(base, tree, input.day).countries[old.id];
  const state = structuredClone(input);
  state.countries[old.id] = {
    ...old,
    // New politics, with the colour slots the install assigned, take effect with the new tree.
    ...(generated.politics || government ? { politics: installed.politics } : {}),
    ...(government
      ? {
          commitments: Object.fromEntries(
            Object.entries(old.commitments).map(([id, text]) => [
              id,
              text.startsWith(FORMER_GOVERNMENT) ? text : `${FORMER_GOVERNMENT}${text}`,
            ]),
          ),
        }
      : {}),
    periodTitle: tree.periodTitle,
    agenda: tree.agenda,
    longTerm: tree.longTerm,
    analysis: tree.analysis,
    branches: tree.branches,
    relations: tree.relations,
    nodes: installed.nodes,
    progress: installed.progress,
    current: anchor && old.progress[anchor].status === 'active' ? anchor : '',
    // Old route groups belong to the removed graph; their actual results remain in national state.
    locks: {},
    treeRevision: old.treeRevision + 1,
    period: {
      number,
      started: input.day,
      anchor,
      history: [
        ...old.period.history,
        {
          start:
            old.period.started ??
            Math.min(
              old.cursor,
              ...Object.values(old.progress).flatMap((p) =>
                [p.started, p.completed].filter((day): day is number => day !== null),
              ),
            ),
          end: input.day,
          summary: reply.summary,
        },
      ],
    },
  };
  if (anchor) {
    state.countries[old.id].progress[anchor] = structuredClone(old.progress[anchor]);
  }
  for (const event of Object.values(state.events)) {
    if (event.source.country === old.id && event.source.node && !event.source.name) {
      event.source.name = old.nodes[event.source.node]?.name ?? event.source.node;
    }
  }
  validateGraph(state.countries[old.id].nodes);
  state.revision++;
  return StateSchema.parse(state);
}
