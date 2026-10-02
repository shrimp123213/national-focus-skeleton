import { z } from 'zod';
import { HISTORY_PREFIX, isHistoricalEvidence, installCountry, removeCountry } from './engine';
import { layoutTree } from './layout';
import { CountrySchema, StateSchema, TreeSchema, type Country, type FocusNode, type State } from './model';
import { assertCapabilityOrder, assertMutexChoices, assertReachable } from './reachability';
import { repairReply } from './repair';

/**
 * Tree files: export a country's definition (and, for reports, its progress and events);
 * import a definition written by hand, by a submod or by another chat.
 */
export const TREE_FILE_KIND = 'national-focus-tree';
type Tree = z.output<typeof TreeSchema>;
const StatusSchema = CountrySchema.pick({
  period: true,
  enabled: true,
  control: true,
  skipDelegate: true,
  calibration: true,
  cursor: true,
  current: true,
  stability: true,
  warSupport: true,
  progress: true,
  locks: true,
  capabilities: true,
  commitments: true,
  facts: true,
}).partial();
export type TreeImport = { tree: Tree; status?: z.output<typeof StatusSchema>; eventCount: number };

/** Definition of a country as a tree file entry; x/y are omitted because import lays out again. */
export function countryTree(country: Country): Record<string, unknown> {
  const completedAnchor =
    country.progress[country.period.anchor]?.status === 'completed' ? country.period.anchor : '';
  const inheritedProducts = new Set(
    (country.nodes[completedAnchor]?.effects ?? []).flatMap((effect) =>
      effect.kind === 'capability' ? [effect.key] : [],
    ),
  );
  const produced = new Set(
    Object.values(country.nodes).flatMap((node) =>
      node.effects.flatMap((effect) => (effect.kind === 'capability' ? [effect.key] : [])),
    ),
  );
  return {
    id: country.id,
    name: country.name,
    description: country.description,
    stability: country.stability,
    warSupport: country.warSupport,
    evidence: country.evidence,
    ...(country.keywords ? { keywords: country.keywords } : {}),
    analysis: country.analysis,
    periodTitle: country.periodTitle,
    agenda: country.agenda,
    longTerm: country.longTerm,
    autoPeriod: country.autoPeriod,
    branches: country.branches,
    ...(country.relations ? { relations: country.relations } : {}),
    // Base capabilities only: the ones no focus in this tree produces.
    capabilities: Object.values(country.capabilities).filter(
      (capability) => !produced.has(capability.id) || inheritedProducts.has(capability.id),
    ),
    historical: Object.entries(country.progress)
      .filter(
        ([id, progress]) =>
          progress.status === 'completed' &&
          (isHistoricalEvidence(progress.evidence) || id === completedAnchor),
      )
      .map(([node, progress]) => ({
        node,
        evidence: isHistoricalEvidence(progress.evidence)
          ? progress.evidence.slice(HISTORY_PREFIX.length)
          : progress.evidence || '前期已完成的承接国策',
      })),
    nodes: Object.values(country.nodes).map(({ x: _x, y: _y, ...node }) => node),
  };
}

export function exportTrees(state: State, ids?: string[]): string {
  const countries = Object.values(state.countries).filter((country) => !ids || ids.includes(country.id));
  if (!countries.length) {
    throw new Error('没有可导出的国策树');
  }
  return JSON.stringify(
    {
      kind: TREE_FILE_KIND,
      version: 1,
      exportedAt: new Date().toISOString(),
      day: state.day,
      settings: { size: state.settings.size, pace: state.settings.pace },
      countries: countries.map((country) => ({
        tree: countryTree(country),
        status: {
          period: country.period,
          enabled: country.enabled,
          control: country.control,
          skipDelegate: country.skipDelegate,
          calibration: country.calibration,
          cursor: country.cursor,
          current: country.current,
          stability: country.stability,
          warSupport: country.warSupport,
          progress: country.progress,
          locks: country.locks,
          capabilities: country.capabilities,
          commitments: country.commitments,
          facts: country.facts,
        },
        // For reports only; events are not imported.
        events: Object.values(state.events).filter((event) => event.countries.includes(country.id)),
      })),
    },
    null,
    2,
  );
}

function issuesText(error: z.ZodError, nodes: unknown[] = []): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const [head, index, ...rest] = issue.path;
      const node =
        head === 'nodes' && typeof index === 'number' ? (nodes[index] as { id?: unknown }) : undefined;
      const where =
        node && typeof node.id === 'string'
          ? `国策 ${node.id}（nodes.${String(index)}）${rest.length ? `的 ${rest.map(String).join('.')}` : ''}`
          : issue.path.map(String).join('.') || '（根）';
      return `${where}：${issue.message}`;
    })
    .join('\n');
}

/** Fill the fields a hand-written tree may leave out; required story text stays required. */
function withDefaults(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('国策树必须是 JSON 对象');
  }
  const repaired = repairReply(raw) as Record<string, unknown>;
  const nodes = Array.isArray(repaired.nodes) ? repaired.nodes : [];
  return {
    description: repaired.name,
    stability: 50,
    warSupport: 50,
    evidence: '导入的国策树',
    analysis: '',
    branches: [],
    capabilities: [],
    historical: [],
    ...repaired,
    nodes: nodes.map((value) => {
      const node = { ...(value as Record<string, unknown>) };
      delete node.x;
      delete node.y;
      return {
        icon: 'crown',
        reason: '导入的国策',
        durationReason: '依导入设置',
        ...node,
      };
    }),
  };
}

/** Validate one tree definition as playable, without the size or topology rules of AI generation. */
export function parseTree(raw: unknown): Tree {
  const input = withDefaults(raw);
  const nodes = input.nodes as Record<string, unknown>[];
  const laid = (() => {
    try {
      return layoutTree(nodes as unknown as FocusNode[]);
    } catch (error) {
      throw new Error(
        `国策树「${String(input.name ?? input.id ?? '')}」：${error instanceof Error ? error.message : error}`,
      );
    }
  })();
  const result = TreeSchema.safeParse({ ...input, nodes: laid });
  if (!result.success) {
    throw new Error(
      `国策树「${String(input.name ?? input.id ?? '')}」格式有误：\n${issuesText(result.error, nodes)}`,
    );
  }
  const tree = result.data;
  try {
    const ids = new Set(tree.nodes.map((node) => node.id));
    for (const item of tree.historical) {
      if (!ids.has(item.node)) {
        throw new Error(`historical 引用不存在的国策：${item.node}`);
      }
    }
    for (const branch of tree.branches) {
      if (!tree.nodes.some((node) => node.branch === branch.name)) {
        throw new Error(`分支「${branch.name}」没有任何国策`);
      }
    }
    for (const relation of tree.relations ?? []) {
      if (!ids.has(relation.from) || !ids.has(relation.to)) {
        throw new Error(`关系 ${relation.from} → ${relation.to} 引用不存在的国策`);
      }
    }
    for (const node of tree.nodes) {
      if (node.impact === 'pivotal' && !node.news) {
        throw new Error(`重要国策 ${node.id} 缺少 news（headline、body、option）`);
      }
    }
    assertMutexChoices(tree.nodes);
    assertReachable(tree.nodes);
    assertCapabilityOrder(
      tree.nodes,
      tree.capabilities.filter((capability) => capability.active).map((capability) => capability.id),
      tree.historical.map((item) => item.node),
    );
  } catch (error) {
    throw new Error(`国策树「${tree.name}」无法游玩：${error instanceof Error ? error.message : error}`);
  }
  return tree;
}

/** Accept a tree file, an export entry, a bare tree or a list of trees. */
export function parseTreeFile(raw: unknown): TreeImport[] {
  if (Array.isArray((raw as { tasks?: unknown })?.tasks)) {
    throw new Error('这是工作流助手的预设文件，不是国策树文件。');
  }
  if ((raw as { kind?: unknown })?.kind === 'national-focus-task-presets') {
    throw new Error('这是任务预设文件，请到「设置 → 任务 → 任务预设」导入。');
  }
  const list: unknown[] =
    (raw as { kind?: unknown })?.kind === TREE_FILE_KIND
      ? ((raw as { countries?: unknown[] }).countries ?? [])
      : Array.isArray(raw)
        ? raw
        : [raw];
  if (!list.length) {
    throw new Error('文件中没有国策树');
  }
  const entries = list.map((item) => {
    const entry = item as { tree?: unknown; status?: unknown; events?: unknown };
    const tree = parseTree(entry && typeof entry === 'object' && 'tree' in entry ? entry.tree : item);
    let status: TreeImport['status'];
    if (entry && typeof entry === 'object' && entry.status !== undefined) {
      const parsed = StatusSchema.safeParse(entry.status);
      if (!parsed.success) {
        throw new Error(`国策树「${tree.name}」的进度资料有误：\n${issuesText(parsed.error)}`);
      }
      status = parsed.data;
    }
    return { tree, status, eventCount: Array.isArray(entry?.events) ? entry.events.length : 0 };
  });
  const ids = entries.map((entry) => entry.tree.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) {
    throw new Error(`文件中有两棵 id 相同的国策树：${duplicate}`);
  }
  return entries;
}

/**
 * Install imported trees on the current floor. With progress, the country keeps its progress but
 * is recalibrated from the current story day, as when a country is enabled again.
 */
export function importTrees(
  input: State,
  entries: TreeImport[],
  options: { withProgress: boolean; replace: boolean },
): State {
  let state = input;
  for (const entry of entries) {
    const id = entry.tree.id;
    if (state.countries[id]) {
      if (!options.replace) {
        throw new Error(`国家 ${id}（${state.countries[id].name}）已存在；勾选「取代同 id 的国家」才能导入`);
      }
      state = removeCountry(state, id);
    }
    state = installCountry(state, { ...entry.tree, autoPeriod: entry.tree.autoPeriod ?? false }, state.day);
    if (options.withProgress && entry.status) {
      state = structuredClone(state);
      const country = state.countries[id];
      const { progress, cursor: _cursor, calibration: _calibration, current, ...rest } = entry.status;
      Object.assign(country, rest);
      for (const [nodeId, value] of Object.entries(progress ?? {})) {
        if (country.nodes[nodeId]) {
          country.progress[nodeId] = value;
        }
      }
      country.current = current && country.nodes[current] ? current : '';
      country.calibration = true;
      country.cursor = state.day;
      state = StateSchema.parse(state);
    }
  }
  return state;
}

/** A small, valid tree that shows every field a hand-written tree or submod needs. */
export function treeTemplate(): string {
  const node = (
    id: string,
    name: string,
    branch: string,
    prerequisites: string[][],
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    name,
    branch,
    description: `${name}：写出具体行动、受益者与受损者。`,
    reason: '设定依据或设计理由',
    icon: 'crown',
    days: 35,
    durationReason: '工期理由',
    prerequisites,
    requirements: [],
    sustain: [],
    outcomes: [],
    investments: ['投入的人力或物资'],
    effects: [],
    mutex: null,
    ...extra,
  });
  const route = (id: string) => ({
    group: 'reform_path',
    route: id,
    lock: 'complete',
    reason: '两种改革方向只能择一',
  });
  return JSON.stringify(
    {
      kind: TREE_FILE_KIND,
      version: 1,
      countries: [
        {
          tree: {
            id: 'example_realm',
            name: '范例王国',
            description: '示范国策树的所有栏位；复制后改写即可。',
            stability: 55,
            warSupport: 40,
            evidence: '玩家自定义',
            analysis: '核心矛盾：王权与地方贵族。',
            branches: [
              {
                id: 'crown',
                name: '王权与贵族',
                purpose: '决定权力归属',
                supporters: '王室与城市',
                opposition: '地方贵族',
                tradeoff: '效率与稳定',
                destination: '新的权力平衡',
              },
            ],
            capabilities: [{ id: 'royal_guard', name: '王室近卫', active: true, reason: '开局即有' }],
            historical: [],
            nodes: [
              node('census', '全国户籍普查', '王权与贵族', [], {
                effects: [
                  { id: 'gain', kind: 'capability', key: 'census_data', name: '户籍资料', active: true },
                ],
              }),
              node('royal_tax', '王室直辖税', '王权与贵族', [['census']], {
                mutex: route('centralize'),
                requirements: [{ kind: 'capability', id: 'census_data', label: '需要户籍资料' }],
                effects: [{ id: 'stab', kind: 'stability', value: -5 }],
              }),
              node('noble_charter', '贵族特许状', '王权与贵族', [['census']], {
                mutex: route('charter'),
                effects: [{ id: 'stab', kind: 'stability', value: 5 }],
              }),
              node('new_order', '新秩序', '王权与贵族', [['royal_tax', 'noble_charter']], {
                icon: 'diplomacy',
                days: 60,
                outcomes: [{ kind: 'fact', id: 'estates_agree', label: '三级会议同意' }],
                // A turning point: completing it publishes this news (a single option).
                impact: 'pivotal',
                news: {
                  headline: '范例王国召开三级会议，宣布新秩序',
                  body: '邻国使节连夜回报：王国的权力格局已经改写。',
                  option: { label: '新的时代开始了', text: '' },
                },
              }),
            ],
          },
        },
      ],
    },
    null,
    2,
  );
}
