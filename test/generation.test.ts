import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProposal, blockers, createState, installCountry, startFocus } from '../src/engine';
import { layoutTree } from '../src/layout';

import { normalizeGenerated, workingState } from '../src/generation';
import { demoTree } from '../src/demo-tree';

test('136 节点示范的三条宪制路线均能到达共同终点与危机终点', () => {
  for (const route of ['central', 'vassal', 'charter']) {
    let state = installCountry(createState(100), demoTree(), 100);
    assert.equal(Object.keys(state.countries.augustium.nodes).length, 136);
    for (let turn = 0; turn < 136; turn++) {
      const country = state.countries.augustium;
      const node = Object.values(country.nodes).find(
        (n) =>
          country.progress[n.id].status === 'idle' &&
          !blockers(country, n).length &&
          (!n.mutex || n.mutex.group !== 'constitution' || n.mutex.route === route),
      );
      if (!node) {
        break;
      }
      state = startFocus(state, country.id, node.id);
      state = applyProposal(state, {
        id: `step_${turn}`,
        until: state.day + node.days,
        reason: '测试供给指定成果',
        steps: [
          {
            at: state.day,
            events: [],
            selections: [],
            facts: node.outcomes.flatMap((r) =>
              r.kind === 'fact'
                ? [{ country: country.id, id: r.id, value: true, evidence: '测试实际成果', origin: 'story' }]
                : [],
            ),
          },
        ],
      });
    }
    assert.equal(state.countries.augustium.locks.constitution.route, route);
    assert.equal(state.countries.augustium.progress.focus_0_23.status, 'completed');
    assert.equal(state.countries.augustium.progress.focus_7_15.status, 'completed');
    const prompt = JSON.stringify(workingState(state));
    assert.ok(prompt.length < JSON.stringify(state).length * 0.6);
    assert.ok(!prompt.includes('durationReason'));
    assert.equal(state.countries.augustium.nodes.focus_0_0.description, demoTree().nodes[0].description);
  }
});

test('300 个节点自动布局不重叠，跨分支前置位于子节点上方；循环会被拒绝', () => {
  const nodes = Array.from({ length: 300 }, (_, i) => ({
    id: `n${i}`,
    branch: `b${Math.floor(i / 30)}`,
    prerequisites: i ? [[`n${i - 1}`]] : [],
  }));
  const result = layoutTree(nodes);
  assert.equal(new Set(result.map((n) => `${n.x},${n.y}`)).size, 300);
  assert.ok(result.slice(1).every((n, i) => n.y > result[i].y));
  assert.throws(
    () =>
      layoutTree([
        { id: 'a', branch: 'a', prerequisites: [['b']] },
        { id: 'b', branch: 'b', prerequisites: [['a']] },
      ]),
    /循环/,
  );
});

test('布局依前置位置排序，同中心节点保留原顺序，跨分支不改动输入', () => {
  const nodes = [
    { id: 'left', branch: 'main', prerequisites: [] },
    { id: 'right', branch: 'main', prerequisites: [] },
    { id: 'to_right', branch: 'main', prerequisites: [['right']] },
    { id: 'to_left', branch: 'main', prerequisites: [['left']] },
    { id: 'also_left', branch: 'main', prerequisites: [['left']] },
    { id: 'cross', branch: 'other', prerequisites: [['to_left', 'to_right']] },
  ];
  const before = structuredClone(nodes);
  assert.deepEqual(
    layoutTree(nodes).map(({ id, x, y }) => ({ id, x, y })),
    [
      { id: 'left', x: 0, y: 0 },
      { id: 'right', x: 1, y: 0 },
      { id: 'to_right', x: 2, y: 1 },
      { id: 'to_left', x: 0, y: 1 },
      { id: 'also_left', x: 1, y: 1 },
      { id: 'cross', x: 4, y: 2 },
    ],
  );
  assert.deepEqual(nodes, before);
});

test('互斥组至少两条路线；路线起点是没有同路线前置的国策', async () => {
  const { assertMutexChoices, mutexRoutes } = await import('../src/reachability');
  const m = (route: string) => ({ group: 'g', route, lock: 'complete' as const, reason: 'r' });
  const nodes = [
    { id: 'root', prerequisites: [], mutex: null },
    { id: 'a1', prerequisites: [['root']], mutex: m('a') },
    { id: 'a2', prerequisites: [['a1']], mutex: m('a') },
    { id: 'b1', prerequisites: [['root']], mutex: m('b') },
  ];
  const routes = mutexRoutes(nodes).get('g')!;
  assert.deepEqual(
    routes.get('a')!.heads.map((n) => n.id),
    ['a1'],
  );
  assert.deepEqual(
    routes.get('a')!.members.map((n) => n.id),
    ['a1', 'a2'],
  );
  assertMutexChoices(nodes);
  assert.throws(() => assertMutexChoices(nodes.slice(0, 3)), /互斥组 g 只有一条路线/);
});

test('骨架修正操作以 id 定位，坏操作略过并回报', async () => {
  const { applyPatch } = await import('../src/skeleton-patch');
  const root = {
    nodes: [
      { id: 'a', impact: 'pivotal', provides: [] },
      { id: 'b', impact: 'normal' },
    ],
    capabilityCatalog: [],
  };
  const { result, applied, errors } = applyPatch(root, [
    { op: 'replace', path: '/nodes/a/impact', value: 'normal' },
    { op: 'insert', path: '/nodes/b/provides/-', value: 'cap_x' },
    { op: 'insert', path: '/capabilityCatalog/-', value: { key: 'cap_x', name: 'X' } },
    { op: 'remove', path: '/nodes/zzz' },
    { op: 'replace', path: '/nodes/b/impact' },
  ]);
  assert.equal(applied, 3);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /找不到「zzz」/);
  assert.match(errors[1], /缺少 value/);
  const tree = result as typeof root & { nodes: { provides?: string[] }[] };
  assert.equal(tree.nodes[0].impact, 'normal');
  assert.deepEqual(tree.nodes[1].provides, ['cap_x']);
  assert.equal(root.nodes[0].impact, 'pivotal');
});

test('生成指示使用分期与内容深度，不要求结构配额', async () => {
  const { DEFAULT_TASK } = await import('../src/prompts');
  assert.match(DEFAULT_TASK.generate, /10–16/);
  assert.match(DEFAULT_TASK.generate, /没有配额/);
  assert.match(DEFAULT_TASK.generate, /stage=period/);
  assert.match(DEFAULT_TASK.update, /transitions/);
});

test('生成时略过 historical 中不在 nodes 的国策（模型把建国往事写成历史承接），保留有效的承接', () => {
  const node = (id: string) => ({ id, name: id, effects: [], requirements: [], sustain: [], outcomes: [] });
  const tree = normalizeGenerated({
    capabilities: [],
    historical: [
      { node: 'h_foundation_charter', evidence: '世界书：建国' },
      { node: 'old_roads', evidence: '设定：道路已存在' },
    ],
    nodes: [node('old_roads'), node('new_port')],
  });
  assert.deepEqual(
    tree.historical.map((item) => item.node),
    ['old_roads'],
  );
  // Installing a tree that still names a missing focus reports which one and how to fix it.
  const raw = demoTree();
  assert.throws(
    () =>
      installCountry(
        createState(100),
        { ...raw, historical: [{ node: 'h_missing', evidence: '建国' }] },
        100,
      ),
    /historical 引用的「h_missing」不在 nodes 中/,
  );
});
