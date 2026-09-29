import { createState, installCountry } from './engine';
import { layoutTree } from './layout';
import { EventSchema, StateSchema, type FocusNode, type State } from './model';
import fixtures from './demo-period-data';

export type Scenario = keyof typeof fixtures;
const countryId = 'augustium';
type FixtureNode = {
  id: string;
  title: string;
  icon: string;
  requires: string[][];
  description: string;
  effect: string;
  mutex?: string;
  condition?: string;
};
const icons: Record<string, FocusNode['icon']> = {
  scroll: 'science',
  ship: 'trade',
  shield: 'army',
  scale: 'diplomacy',
  grain: 'industry',
  cross: 'diplomacy',
  star: 'crown',
};

function branchFor(id: string): string {
  if (['A03', 'A04', 'A08', 'A09', 'B07', 'B10', 'C03', 'C07', 'C10'].includes(id)) {
    return '糧運與民生';
  }
  if (
    [
      'A05',
      'A06',
      'A07',
      'A10',
      'A11',
      'B03',
      'B04',
      'B05',
      'B06',
      'B08',
      'B09',
      'C02',
      'C05',
      'C06',
      'C09',
    ].includes(id)
  ) {
    return '對外安排';
  }
  return '國家議程';
}

function makeNodes(rows: FixtureNode[]): FocusNode[] {
  return layoutTree(
    rows.map((raw): FocusNode => {
      const other = raw.mutex ?? '';
      const group = other ? [raw.id, other].sort().join('_') : '';
      return {
        id: raw.id,
        name: raw.title,
        branch: branchFor(raw.id),
        description: raw.description,
        reason: '分期 UI 樣品的虛構劇情，非世界書既有事實。',
        icon: icons[raw.icon],
        x: 0,
        y: 0,
        days: raw.id === 'A04' ? 30 : 21,
        durationReason: '樣品用協商與行政工期；正式生成仍依世界情境決定。',
        prerequisites: raw.requires,
        requirements: [],
        sustain: [],
        outcomes: raw.condition ? [{ kind: 'fact', id: `outcome_${raw.id}`, label: raw.condition }] : [],
        investments: ['協商、行政與執行人力'],
        effects: [
          { id: 'policy', kind: 'capability', key: `policy_${raw.id}`, name: raw.effect, active: true },
        ],
        mutex: other ? { group, route: raw.id, lock: 'start', reason: '採取不同的國家政策安排' } : null,
        impact: 'normal',
        execution: 'once',
        news: null,
      };
    }),
  );
}

function treeDefinition(rows: FixtureNode[], name: string) {
  const nodes = makeNodes(rows);
  return {
    id: countryId,
    name: '奧古斯提姆帝國',
    description: name,
    stability: 68,
    warSupport: 42,
    evidence: '分期 UI 樣品',
    analysis: '以最新議程承接國家發展。',
    relations: [],
    capabilities: [],
    historical: [],
    nodes,
    branches: [...new Set(nodes.map((n) => n.branch))].map((branch, index) => ({
      id: `agenda_${index}`,
      name: branch,
      purpose: `本期的${branch}安排`,
      supporters: '相關行政部門與利益群體',
      opposition: '資源分配及權責爭議',
      tradeoff: '政策收益伴隨新的責任與成本',
      destination: '建立當期可執行的安排',
    })),
  };
}

export function makeSampleState(scenario: Scenario): State {
  const sample = fixtures[scenario];
  const definition = treeDefinition(sample.first, '北境的帳，帝國的糧');
  const completed = sample.first.filter((n) => n.status === 'done');
  let state = installCountry(
    createState(100),
    {
      ...definition,
      historical: completed.map((n) => ({ node: n.id, evidence: '樣品已發生的政策成果' })),
      capabilities: completed.map((n) => ({
        id: `policy_${n.id}`,
        name: n.effect,
        active: true,
        reason: '樣品既有成果',
      })),
    },
    100,
  );
  const country = state.countries[countryId];
  country.periodTitle = '北境的帳，帝國的糧';
  country.agenda = '處理北境信用爭議，同時保障民生糧運。';
  country.period.started = 70;
  completed.forEach((row, index) => {
    country.progress[row.id].completed = 80 + index;
  });
  for (const row of sample.first) {
    if (row.status === 'active') {
      country.current = row.id;
      country.progress[row.id] = {
        ...country.progress[row.id],
        status: 'active',
        days: 18,
        started: 82,
        investments: ['已投入港務協調人力'],
        evidence: '港口與糧倉名冊已核定，內陸配額協調中。',
      };
    }
  }
  const event = sample.events[0];
  state.events[event.id] = EventSchema.parse({
    id: event.id,
    at: 100,
    countries: [countryId],
    title: event.title,
    description: event.description,
    current: event.description,
    evidence: '樣品事件紀錄',
    origin: 'story',
    public: true,
    changes: [],
    scope: 'front',
    importance: 'major',
    status: 'ongoing',
    settle: '依實際局勢確認運作成果',
    steps: event.steps.map((text, i) => ({ text, state: i === 0 ? 'done' : i === 1 ? 'active' : 'pending' })),
    timeline: [{ at: 100, text: event.description }],
    source: { kind: 'update', country: countryId, node: scenario === 'crisis' ? 'A04' : 'A05' },
  });
  state = StateSchema.parse(state);
  return state;
}

import { periodAnchor, PeriodReplySchema, transitionPeriod } from './periods';
export function advancePeriodSample(input: State, scenario: Scenario): State {
  const state = structuredClone(input);
  const country = state.countries[countryId];
  if (!country) {
    throw new Error('請先載入分期示範');
  }
  const sample = fixtures[scenario];
  const event = state.events[sample.events[0].id];
  if (event) {
    event.current = sample.events[1].description;
    event.timeline.push({ at: state.day, text: event.current });
  }
  if (!country.autoPeriod || !country.enabled || country.period.number > 1) {
    return state;
  }
  const anchor = periodAnchor(country);
  const expected = scenario === 'crisis' ? 'A04' : 'A12';
  if (anchor !== expected) {
    throw new Error('已改變示範路線，請重新載入分期示範');
  }
  const definition = treeDefinition(sample.second, '下一期');
  const prefix = `p${country.period.number + 1}_`;
  const nodes = definition.nodes
    .filter((n) => n.id !== anchor)
    .map(({ x, y, ...n }) => ({
      ...n,
      id: prefix + n.id,
      prerequisites: n.prerequisites.map((group) => group.map((id) => (id === anchor ? id : prefix + id))),
      mutex: n.mutex ? { ...n.mutex, group: prefix + n.mutex.group } : null,
    }));
  return transitionPeriod(
    state,
    {
      country: countryId,
      cause: scenario === 'crisis' ? 'incompatible' : 'completed',
      reason: '離線示範：局勢或主要議程已改變',
      invalidateActive: false,
    },
    PeriodReplySchema.parse({
      summary: sample.summary,
      tree: {
        ...definition,
        nodes,
        periodTitle: scenario === 'crisis' ? '災厄越過國境' : '秩序之後的遠見',
        agenda: scenario === 'crisis' ? '跨國協作應對災害' : '鞏固新秩序與對外關係',
      },
    }),
  );
}
