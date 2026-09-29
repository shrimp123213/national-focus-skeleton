import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProposal, changeCountry, createState, installCountry, startFocus } from '../src/engine';
import { EventSchema, NodeSchema, StateSchema, TreeSchema, type State } from '../src/model';
import { PeriodReplySchema, periodAnchor, transitionPeriod } from '../src/periods';
import { exportTrees, importTrees, parseTreeFile } from '../src/tree-io';
import { FocusController } from '../src/workflow';
import { DemoPlatform } from '../src/demo';
import type { PromptMessage, Snapshot } from '../src/platform';
import { workingState } from '../src/generation';

const node = (id: string, prerequisites: string[][] = []) =>
  NodeSchema.parse({
    id,
    name: id,
    branch: '國家議程',
    description: `${id} 的行動`,
    reason: '設定',
    icon: 'crown',
    x: 0,
    y: id === 'old_done' ? 0 : 1,
    days: 30,
    durationReason: '協商',
    prerequisites,
    requirements: [],
    sustain: [],
    outcomes: [],
    investments: ['行政人員'],
    mutex: null,
    effects: [{ id: 'stability', kind: 'stability', value: 5 }],
  });
const branch = {
  id: 'agenda',
  name: '國家議程',
  purpose: '改革',
  supporters: '城市',
  opposition: '領主',
  tradeoff: '權力',
  destination: '新秩序',
};
const tree = TreeSchema.parse({
  id: 'land',
  name: '試驗國',
  description: '試驗',
  evidence: '設定',
  analysis: '本期改革',
  stability: 50,
  warSupport: 30,
  branches: [branch],
  capabilities: [],
  historical: [{ node: 'old_done', evidence: '既有成果' }],
  nodes: [node('old_done'), node('old_active', [['old_done']])],
});
function fixture(): State {
  let state = installCountry(createState(100), tree, 100);
  state = startFocus(state, 'land', 'old_active');
  state = applyProposal(state, { id: 'advance', until: 110, reason: '時間推進', steps: [] });
  state.countries.land.capabilities.keep = { id: 'keep', name: '既有制度', active: true, reason: '既成' };
  state.countries.land.commitments.promise = '保持互通';
  state.countries.land.facts.accepted = { value: true, evidence: '已簽約' };
  state.events.project = EventSchema.parse({
    id: 'project',
    at: 100,
    countries: ['land'],
    title: '施工',
    description: '已開工',
    evidence: '工程紀錄',
    origin: 'background',
    public: true,
    changes: [],
    status: 'ongoing',
    current: '橋墩施工',
    source: { kind: 'focus', country: 'land', node: 'old_active' },
  });
  return state;
}
const transition = {
  country: 'land',
  cause: 'completed' as const,
  reason: '主要制度已確立，轉向落實',
  invalidateActive: false,
};
function reply(prefix = 'p2_', parent = 'old_active') {
  const { x, y, ...newNode } = node(`${prefix}new`, parent ? [[parent]] : []);
  return PeriodReplySchema.parse({
    summary: '本期改革確立新制度，施工仍持續。',
    tree: {
      ...tree,
      periodTitle: '落實新秩序',
      agenda: '鞏固已取得的制度',
      historical: [],
      nodes: [newNode],
    },
  });
}

test('換期承接 active 的 ID、投入、工期與效果帳本；往期只存時間摘要', () => {
  const before = fixture();
  const after = transitionPeriod(before, transition, reply());
  const country = after.countries.land;
  assert.equal(country.period.number, 2);
  assert.equal(country.period.anchor, 'old_active');
  assert.equal(country.current, 'old_active');
  assert.deepEqual(country.progress.old_active, before.countries.land.progress.old_active);
  assert.deepEqual(country.nodes.old_active.prerequisites, []);
  assert.deepEqual(country.capabilities, before.countries.land.capabilities);
  assert.deepEqual(country.commitments, before.countries.land.commitments);
  assert.deepEqual(country.facts, before.countries.land.facts);
  assert.deepEqual(after.receipts, before.receipts);
  assert.deepEqual(Object.keys(country.period.history[0]).sort(), ['end', 'start', 'summary']);
  assert.equal(country.nodes.old_done, undefined);
  assert.equal(after.events.project.source.name, 'old_active');
  const complete = applyProposal(after, { id: 'finish', until: 130, reason: '完成承接工作', steps: [] });
  assert.equal(complete.countries.land.stability, 55);
  assert.equal(complete.countries.land.progress.old_active.status, 'completed');
  assert.deepEqual(
    applyProposal(complete, { id: 'finish', until: 130, reason: '重試', steps: [] }),
    complete,
  );
  assert.equal(before.countries.land.period.number, 1);
});

test('paused、waiting 與失效 active 改承接最新完成；無完成節點則新建起點', () => {
  for (const status of ['paused', 'waiting'] as const) {
    const state = fixture();
    state.countries.land.progress.old_active.status = status;
    assert.equal(periodAnchor(state.countries.land), 'old_done');
    const after = transitionPeriod(state, transition, reply('p2_', 'old_done'));
    assert.equal(after.countries.land.current, '');
    assert.equal(after.countries.land.progress.old_done.status, 'completed');
    assert.equal(after.countries.land.stability, 50);
  }
  const state = fixture();
  const incompatible = { ...transition, cause: 'incompatible' as const, invalidateActive: true };
  const after = transitionPeriod(state, incompatible, reply('p2_', 'old_done'));
  assert.equal(after.countries.land.nodes.old_active, undefined);
  assert.equal(after.events.project.status, 'ongoing');
  state.countries.land.progress.old_done.status = 'idle';
  assert.equal(transitionPeriod(state, incompatible, reply('p2_', '')).countries.land.period.anchor, '');
});

test('跨期事件可繼續結算，事件成果與舊國策不會重發', () => {
  let state = transitionPeriod(
    fixture(),
    { ...transition, cause: 'incompatible', invalidateActive: true },
    reply('p2_', 'old_done'),
  );
  const update = {
    id: 'event_finish',
    until: 110,
    reason: '工程完成',
    steps: [
      {
        at: 110,
        facts: [],
        events: [],
        selections: [],
        eventUpdates: [
          {
            id: 'project',
            text: '橋樑已通車',
            result: 'achieved',
            changes: [{ country: 'land', effects: [{ id: 'bridge', kind: 'stability', value: 3 }] }],
          },
        ],
      },
    ],
  };
  state = applyProposal(state, update);
  assert.equal(state.events.project.status, 'resolved');
  assert.equal(state.countries.land.stability, 53);
  assert.deepEqual(applyProposal(state, update), state);
  const exported = parseTreeFile(JSON.parse(exportTrees(state)));
  assert.equal(
    importTrees(createState(110), exported, { withProgress: true, replace: false }).countries.land.period
      .number,
    2,
  );
});

test('舊規模轉換；AI 樹預設開啟，匯入缺值關閉，作者明示的設定隨檔案攜帶', () => {
  for (const [from, to] of [
    ['small', 'standard'],
    ['epic', 'large'],
  ]) {
    assert.equal(
      StateSchema.parse({ ...fixture(), settings: { ...fixture().settings, size: from } }).settings.size,
      to,
    );
  }
  assert.equal(fixture().countries.land.autoPeriod, true);
  for (const auto of [undefined, true, false]) {
    const entries = parseTreeFile({ ...tree, autoPeriod: auto });
    const state = importTrees(createState(100), entries, { withProgress: false, replace: false });
    assert.equal(state.countries.land.autoPeriod, auto ?? false);
    const restored = importTrees(createState(100), parseTreeFile(JSON.parse(exportTrees(state))), {
      withProgress: false,
      replace: false,
    });
    assert.equal(restored.countries.land.autoPeriod, auto ?? false);
  }
});

test('非法跨期 ID、循環、缺失前置、重複國策與關閉開關拒絕套用', () => {
  for (const corrupt of [
    (r: ReturnType<typeof reply>) => {
      r.tree.nodes[0].id = 'old_done';
    },
    (r: ReturnType<typeof reply>) => {
      r.tree.nodes[0].prerequisites = [['p2_new']];
    },
    (r: ReturnType<typeof reply>) => {
      r.tree.nodes[0].prerequisites = [['missing']];
    },
    (r: ReturnType<typeof reply>) => {
      r.tree.nodes.push(r.tree.nodes[0]);
    },
  ]) {
    const result = reply();
    corrupt(result);
    assert.throws(() => transitionPeriod(fixture(), transition, result));
  }
  assert.throws(
    () => transitionPeriod(changeCountry(fixture(), 'land', { autoPeriod: false }), transition, reply()),
    /自動換期/,
  );
});

class PeriodPlatform extends DemoPlatform {
  data = fixture();
  revisionNumber = 0;
  identity = 'floor';
  story = 'story';
  outputs: ((messages: PromptMessage[]) => Promise<string>)[] = [];
  calls = 0;
  override async read(): Promise<Snapshot> {
    return {
      identity: this.identity,
      messageId: 1,
      day: this.data.day,
      turn: 1,
      state: structuredClone(this.data),
      context: {},
    };
  }
  override async commit(source: Snapshot, state: State) {
    this.data = structuredClone(state);
    this.revisionNumber++;
  }
  override async generate(messages: PromptMessage[]) {
    this.calls++;
    return { content: await this.outputs.shift()!(messages) };
  }
}
const update = { id: 'switch', until: 110, reason: '制度建立', steps: [], transitions: [transition] };
function controllerFor(platform: PeriodPlatform) {
  const controller = new FocusController(platform);
  controller.config.jobs.update.retries = 0;
  controller.config.jobs.generate.retries = 0;
  return controller;
}

test('局勢更新後直接呼叫一次生成；摘要與新樹原子提交，無批准階段', async () => {
  const platform = new PeriodPlatform();
  platform.outputs.push(
    async () => JSON.stringify(update),
    async (messages) => {
      assert.match(JSON.stringify(messages), /p2_/);
      return JSON.stringify(reply());
    },
  );
  const controller = controllerFor(platform);
  await controller.run('update');
  assert.equal(platform.calls, 2);
  assert.equal(platform.data.countries.land.period.number, 2);
  assert.ok(
    controller.jobs.every((j) => j.state === 'success'),
    JSON.stringify(controller.jobs),
  );
  const before = structuredClone(platform.data);
  platform.outputs.push(async () => JSON.stringify(update));
  await controller.run('update');
  assert.equal(platform.calls, 3);
  assert.deepEqual(platform.data.countries.land, before.countries.land);
});

test('新期失敗保留原樹與已提交事件，重試只生成該期', async () => {
  const platform = new PeriodPlatform();
  platform.outputs.push(
    async () => JSON.stringify(update),
    async () => '{invalid',
  );
  const controller = controllerFor(platform);
  await controller.run('update');
  assert.equal(platform.data.countries.land.period.number, 1);
  assert.equal(platform.data.events.project.current, '橋墩施工');
  const failed = controller.jobs[0];
  assert.equal(failed.state, 'failed');
  platform.outputs.push(async () => JSON.stringify(reply()));
  await controller.run('generate', failed.candidate, failed.periodWork);
  assert.equal(platform.data.countries.land.period.number, 2);
  assert.equal(platform.calls, 3);
});

test('生成中事件與世界資料更新不阻擋換期，關閉換期仍遵守功能開關', async () => {
  for (const change of ['event', 'story', 'switch']) {
    const platform = new PeriodPlatform();
    platform.outputs.push(
      async () => JSON.stringify(update),
      async () => {
        if (change === 'event') {
          platform.data.events.project.current = '橋墩完工';
        }
        if (change === 'story') {
          platform.story = 'new story';
        }
        if (change === 'switch') {
          platform.data.countries.land.autoPeriod = false;
        }
        platform.revisionNumber++;
        return JSON.stringify(reply());
      },
    );
    const controller = controllerFor(platform);
    await controller.run('update');
    assert.equal(platform.data.countries.land.period.number, change === 'switch' ? 1 : 2, change);
    assert.equal(
      controller.jobs[0].state,
      change === 'switch' ? 'failed' : 'success',
      controller.jobs[0].message,
    );
    if (change === 'event') {
      assert.equal(platform.data.events.project.current, '橋墩完工');
    }
  }
});

test('關閉換期忽略 AI 的替樹要求，仍接受局勢與事件更新', async () => {
  const platform = new PeriodPlatform();
  platform.data.countries.land.autoPeriod = false;
  platform.outputs.push(async () =>
    JSON.stringify({
      ...update,
      steps: [
        {
          at: 110,
          facts: [],
          events: [],
          selections: [],
          eventUpdates: [{ id: 'project', text: '照常施工', current: '已完成橋墩' }],
        },
      ],
    }),
  );
  const controller = controllerFor(platform);
  await controller.run('update');
  assert.equal(platform.calls, 1);
  assert.equal(platform.data.countries.land.period.number, 1);
  assert.equal(platform.data.events.project.current, '已完成橋墩');
});

test('背景只帶最近三期摘要，不帶完整歷史樹', () => {
  const state = fixture();
  state.countries.land.period.history = Array.from({ length: 12 }, (_, i) => ({
    start: i,
    end: i + 1,
    summary: `summary-${i}`,
  }));
  const prompt = JSON.stringify(workingState(state));
  assert.ok(prompt.includes('summary-11'));
  assert.ok(!prompt.includes('summary-8'));
});

test('正式離線示範使用相同換期引擎，支援兩種承接及關閉換期', async () => {
  for (const completed of [false, true]) {
    const demo = new DemoPlatform();
    await demo.periodSample(completed);
    const before = await demo.read();
    await demo.nextPeriod();
    const after = await demo.read();
    const anchor = completed ? 'A12' : 'A04';
    assert.equal(after.state.countries.augustium.period.anchor, anchor);
    assert.deepEqual(
      after.state.countries.augustium.progress[anchor],
      before.state.countries.augustium.progress[anchor],
    );
    assert.ok(Object.keys(after.state.countries.augustium.nodes).length <= 16);
    if (completed) {
      const imported = importTrees(createState(100), parseTreeFile(JSON.parse(exportTrees(after.state))), {
        withProgress: false,
        replace: false,
      });
      assert.equal(imported.countries.augustium.progress.A12.status, 'completed');
      assert.equal(imported.countries.augustium.capabilities.policy_A12.active, true);
    }
    await demo.periodSample(completed);
    const snapshot = await demo.read();
    await demo.commit(snapshot, changeCountry(snapshot.state, 'augustium', { autoPeriod: false }));
    await demo.nextPeriod();
    assert.equal((await demo.read()).state.countries.augustium.period.number, 1);
  }
});

test('取消換期只丟棄新生成結果，保留已提交的局勢和原樹', async () => {
  const platform = new PeriodPlatform();
  platform.outputs.push(
    async () => JSON.stringify(update),
    () => new Promise(() => {}),
  );
  const controller = controllerFor(platform);
  const work = controller.run('update');
  for (let i = 0; i < 100 && platform.calls < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(platform.calls, 2);
  controller.cancelAll();
  await work;
  assert.equal(controller.jobs[0].state, 'cancelled');
  assert.equal(platform.data.countries.land.period.number, 1);
  assert.ok(platform.data.receipts.includes('switch'));
  assert.equal(platform.data.events.project.status, 'ongoing');
});
