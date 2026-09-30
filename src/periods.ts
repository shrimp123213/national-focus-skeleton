import { z } from 'zod';
import { normalizeBranchReferences } from './branch-references';
import { installCountry, validateGraph } from './engine';
import { GeneratedTreeSchema, validateTopology } from './generation';
import { layoutTree } from './layout';
import { sizeLimits, StateSchema, TreeSchema, type Country, type Proposal, type State } from './model';
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

export function checkTransition(state: State, transition: Transition): void {
  const country = state.countries[transition.country];
  if (!country?.enabled || !country.autoPeriod || country.calibration) {
    throw new Error('此国未启用自动换期，或尚待校准');
  }
  if (transition.invalidateActive && transition.cause !== 'incompatible') {
    throw new Error('只有局势不适配可停止承接进行中国策');
  }
}

/** Replace just the policy tree. Events and all already-applied results belong to the live state. */
export function transitionPeriod(input: State, transition: Transition, reply: PeriodReply): State {
  checkTransition(input, transition);
  const old = input.countries[transition.country];
  const anchor = periodAnchor(old, transition.invalidateActive);
  const number = old.period.number + 1;
  const prefix = `p${number}_`;
  const generated = normalizeBranchReferences(reply.tree);
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
    return node;
  });
  if (
    new Set(generated.branches.map((b) => b.id)).size !== generated.branches.length ||
    new Set(generated.branches.map((b) => b.name)).size !== generated.branches.length ||
    nodes.some((n) => !generated.branches.some((b) => b.name === n.branch))
  ) {
    throw new Error('新期分支不可重复，节点必须属于已定义分支');
  }
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
    nodes: layoutTree(nodes),
    capabilities: Object.values(old.capabilities),
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
