import { z } from 'zod';
import { installCountry, removeCountry } from './engine';
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

const HISTORY = '歷史承接：';

/** Definition of a country as a tree file entry; x/y are omitted because import lays out again. */
export function countryTree(country: Country): Record<string, unknown> {
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
    branches: country.branches,
    ...(country.relations ? { relations: country.relations } : {}),
    // Base capabilities only: the ones no focus in this tree produces.
    capabilities: Object.values(country.capabilities).filter((capability) => !produced.has(capability.id)),
    historical: Object.entries(country.progress)
      .filter(([, progress]) => progress.status === 'completed' && progress.evidence.startsWith(HISTORY))
      .map(([node, progress]) => ({ node, evidence: progress.evidence.slice(HISTORY.length) })),
    nodes: Object.values(country.nodes).map(({ x: _x, y: _y, ...node }) => node),
  };
}

export function exportTrees(state: State, ids?: string[]): string {
  const countries = Object.values(state.countries).filter((country) => !ids || ids.includes(country.id));
  if (!countries.length) {
    throw new Error('沒有可匯出的國策樹');
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
          ? `國策 ${node.id}（nodes.${String(index)}）${rest.length ? `的 ${rest.map(String).join('.')}` : ''}`
          : issue.path.map(String).join('.') || '（根）';
      return `${where}：${issue.message}`;
    })
    .join('\n');
}

/** Fill the fields a hand-written tree may leave out; required story text stays required. */
function withDefaults(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('國策樹必須是 JSON 物件');
  }
  const repaired = repairReply(raw) as Record<string, unknown>;
  const nodes = Array.isArray(repaired.nodes) ? repaired.nodes : [];
  return {
    description: repaired.name,
    stability: 50,
    warSupport: 50,
    evidence: '匯入的國策樹',
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
        reason: '匯入的國策',
        durationReason: '依匯入設定',
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
        `國策樹「${String(input.name ?? input.id ?? '')}」：${error instanceof Error ? error.message : error}`,
      );
    }
  })();
  const result = TreeSchema.safeParse({ ...input, nodes: laid });
  if (!result.success) {
    throw new Error(
      `國策樹「${String(input.name ?? input.id ?? '')}」格式有誤：\n${issuesText(result.error, nodes)}`,
    );
  }
  const tree = result.data;
  try {
    const ids = new Set(tree.nodes.map((node) => node.id));
    for (const item of tree.historical) {
      if (!ids.has(item.node)) {
        throw new Error(`historical 引用不存在的國策：${item.node}`);
      }
    }
    for (const branch of tree.branches) {
      if (!tree.nodes.some((node) => node.branch === branch.name)) {
        throw new Error(`分支「${branch.name}」沒有任何國策`);
      }
    }
    for (const relation of tree.relations ?? []) {
      if (!ids.has(relation.from) || !ids.has(relation.to)) {
        throw new Error(`關係 ${relation.from} → ${relation.to} 引用不存在的國策`);
      }
    }
    for (const node of tree.nodes) {
      if (node.impact === 'pivotal' && !node.news) {
        throw new Error(`重要國策 ${node.id} 缺少 news（headline、body、option）`);
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
    throw new Error(`國策樹「${tree.name}」無法遊玩：${error instanceof Error ? error.message : error}`);
  }
  return tree;
}

/** Accept a tree file, an export entry, a bare tree or a list of trees. */
export function parseTreeFile(raw: unknown): TreeImport[] {
  if (Array.isArray((raw as { tasks?: unknown })?.tasks)) {
    throw new Error('這是工作流助手的預設檔，不是國策樹檔案。');
  }
  if ((raw as { kind?: unknown })?.kind === 'national-focus-task-presets') {
    throw new Error('這是任務預設檔，請到「設定 → 任務 → 任務預設」匯入。');
  }
  const list: unknown[] =
    (raw as { kind?: unknown })?.kind === TREE_FILE_KIND
      ? ((raw as { countries?: unknown[] }).countries ?? [])
      : Array.isArray(raw)
        ? raw
        : [raw];
  if (!list.length) {
    throw new Error('檔案中沒有國策樹');
  }
  const entries = list.map((item) => {
    const entry = item as { tree?: unknown; status?: unknown; events?: unknown };
    const tree = parseTree(entry && typeof entry === 'object' && 'tree' in entry ? entry.tree : item);
    let status: TreeImport['status'];
    if (entry && typeof entry === 'object' && entry.status !== undefined) {
      const parsed = StatusSchema.safeParse(entry.status);
      if (!parsed.success) {
        throw new Error(`國策樹「${tree.name}」的進度資料有誤：\n${issuesText(parsed.error)}`);
      }
      status = parsed.data;
    }
    return { tree, status, eventCount: Array.isArray(entry?.events) ? entry.events.length : 0 };
  });
  const ids = entries.map((entry) => entry.tree.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) {
    throw new Error(`檔案中有兩棵 id 相同的國策樹：${duplicate}`);
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
        throw new Error(`國家 ${id}（${state.countries[id].name}）已存在；勾選「取代同 id 的國家」才能匯入`);
      }
      state = removeCountry(state, id);
    }
    state = installCountry(state, entry.tree, state.day);
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
    description: `${name}：寫出具體行動、受益者與受損者。`,
    reason: '設定依據或設計理由',
    icon: 'crown',
    days: 35,
    durationReason: '工期理由',
    prerequisites,
    requirements: [],
    sustain: [],
    outcomes: [],
    investments: ['投入的人力或物資'],
    effects: [],
    mutex: null,
    ...extra,
  });
  const route = (id: string) => ({
    group: 'reform_path',
    route: id,
    lock: 'complete',
    reason: '兩種改革方向只能擇一',
  });
  return JSON.stringify(
    {
      kind: TREE_FILE_KIND,
      version: 1,
      countries: [
        {
          tree: {
            id: 'example_realm',
            name: '範例王國',
            description: '示範國策樹的所有欄位；複製後改寫即可。',
            stability: 55,
            warSupport: 40,
            evidence: '玩家自訂',
            analysis: '核心矛盾：王權與地方貴族。',
            branches: [
              {
                id: 'crown',
                name: '王權與貴族',
                purpose: '決定權力歸屬',
                supporters: '王室與城市',
                opposition: '地方貴族',
                tradeoff: '效率與穩定',
                destination: '新的權力平衡',
              },
            ],
            capabilities: [{ id: 'royal_guard', name: '王室近衛', active: true, reason: '開局即有' }],
            historical: [],
            nodes: [
              node('census', '全國戶籍普查', '王權與貴族', [], {
                effects: [
                  { id: 'gain', kind: 'capability', key: 'census_data', name: '戶籍資料', active: true },
                ],
              }),
              node('royal_tax', '王室直轄稅', '王權與貴族', [['census']], {
                mutex: route('centralize'),
                requirements: [{ kind: 'capability', id: 'census_data', label: '需要戶籍資料' }],
                effects: [{ id: 'stab', kind: 'stability', value: -5 }],
              }),
              node('noble_charter', '貴族特許狀', '王權與貴族', [['census']], {
                mutex: route('charter'),
                effects: [{ id: 'stab', kind: 'stability', value: 5 }],
              }),
              node('new_order', '新秩序', '王權與貴族', [['royal_tax', 'noble_charter']], {
                icon: 'diplomacy',
                days: 60,
                outcomes: [{ kind: 'fact', id: 'estates_agree', label: '三級會議同意' }],
                // A turning point: completing it publishes this news (a single option).
                impact: 'pivotal',
                news: {
                  headline: '範例王國召開三級會議，宣布新秩序',
                  body: '鄰國使節連夜回報：王國的權力格局已經改寫。',
                  option: { label: '新的時代開始了', text: '' },
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
