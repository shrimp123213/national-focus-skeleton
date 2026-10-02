import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoPlatform } from '../src/demo';
import { FocusController } from '../src/workflow';
import { exportTrees, importTrees, parseTreeFile, treeTemplate } from '../src/tree-io';
import { createState } from '../src/engine';

async function demoState() {
  const controller = new FocusController(new DemoPlatform());
  await controller.refresh();
  const state = controller.state!;
  controller.dispose();
  return state;
}

test('国策树汇出后可原样汇入；连同进度时保留进度并从目前故事日校准', async () => {
  const state = await demoState();
  const [id] = Object.keys(state.countries);
  const country = state.countries[id];
  const file = JSON.parse(exportTrees(state, [id]));
  assert.equal(file.kind, 'national-focus-tree');
  assert.equal(file.countries.length, 1);
  assert.equal(file.countries[0].tree.nodes[0].x, undefined);
  const entries = parseTreeFile(file);
  assert.equal(entries[0].tree.nodes.length, Object.keys(country.nodes).length);
  assert.ok(entries[0].status);

  assert.throws(() => importTrees(state, entries, { withProgress: false, replace: false }), /已存在/);
  const fresh = importTrees(state, entries, { withProgress: false, replace: true });
  assert.equal(fresh.countries[id].current, '');
  assert.ok(
    Object.values(fresh.countries[id].progress).every(
      (p) => p.status === 'idle' || p.evidence.startsWith('历史承接'),
    ),
  );

  const restored = importTrees(state, entries, { withProgress: true, replace: true });
  assert.equal(restored.countries[id].current, country.current);
  assert.deepEqual(restored.countries[id].progress, country.progress);
  assert.equal(restored.countries[id].calibration, true);
  assert.equal(restored.countries[id].cursor, state.day);

  const other = importTrees(createState(10), entries, { withProgress: false, replace: false });
  assert.equal(Object.keys(other.countries[id].nodes).length, Object.keys(country.nodes).length);
});

test('手写国策树：省略座标与选填栏位、前置写成物件也能汇入；范本本身可汇入', () => {
  const tree = {
    id: 'handmade',
    name: '手写国',
    nodes: [
      { id: 'a', name: '起点', branch: '主线', description: '开始', days: 30, prerequisites: [] },
      {
        id: 'b',
        name: '甲路',
        branch: '主线',
        description: '甲',
        days: 30,
        prerequisites: [[{ id: 'a' }]],
        mutex: { group: 'g', route: 'x', lock: 'complete', reason: '择一' },
      },
      {
        id: 'c',
        name: '乙路',
        branch: '主线',
        description: '乙',
        days: 30,
        prerequisites: ['a'],
        mutex: { group: 'g', route: 'y', lock: 'complete', reason: '择一' },
      },
    ],
  };
  const [entry] = parseTreeFile(tree);
  assert.equal(entry.tree.stability, 50);
  assert.deepEqual(entry.tree.nodes[1].prerequisites, [['a']]);
  assert.equal(entry.tree.nodes[0].icon, 'crown');
  const state = importTrees(createState(0), [entry], { withProgress: false, replace: false });
  assert.equal(Object.keys(state.countries.handmade.nodes).length, 3);

  const template = parseTreeFile(JSON.parse(treeTemplate()));
  assert.equal(template[0].tree.id, 'example_realm');
  importTrees(createState(0), template, { withProgress: false, replace: false });
});

test('汇入错误会指出国策与栏位；其他格式的档案给出明确说明', () => {
  const base = { id: 'bad', name: '坏国' };
  assert.throws(
    () =>
      parseTreeFile({
        ...base,
        nodes: [
          { id: 'a', name: 'A', branch: '主线', description: 'x', days: 30, prerequisites: [['missing']] },
        ],
      }),
    /不存在的前置国策：missing/,
  );
  assert.throws(
    () =>
      parseTreeFile({
        ...base,
        nodes: [{ id: 'a', name: 'A', branch: '主线', description: 'x', prerequisites: [] }],
      }),
    /国策 a（nodes\.0）的 days/,
  );
  assert.throws(
    () =>
      parseTreeFile({
        ...base,
        nodes: [
          {
            id: 'a',
            name: 'A',
            branch: '主线',
            description: 'x',
            days: 5,
            prerequisites: [],
            mutex: { group: 'g', route: 'x', lock: 'complete', reason: 'r' },
          },
        ],
      }),
    /只有一条路线/,
  );
  assert.throws(() => parseTreeFile({ name: '世界后台引擎', tasks: [] }), /工作流助手的预设文件/);
  assert.throws(() => parseTreeFile({ kind: 'national-focus-task-presets' }), /任务预设文件/);
});

test('重要国策缺少新闻时不能汇入；范本含一个重要国策', () => {
  const [template] = parseTreeFile(JSON.parse(treeTemplate()));
  assert.equal(template.tree.nodes.find((node) => node.id === 'new_order')?.impact, 'pivotal');
  assert.throws(
    () =>
      parseTreeFile({
        id: 'bad',
        name: '坏国',
        nodes: [
          {
            id: 'a',
            name: 'A',
            branch: '主线',
            description: 'x',
            days: 5,
            prerequisites: [],
            impact: 'pivotal',
          },
        ],
      }),
    /重要国策 a 缺少 news/,
  );
});
