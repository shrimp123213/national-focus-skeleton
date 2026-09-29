import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { TreeSchema } from '../src/model';
import {
  createState,
  installCountry,
  startFocus,
  applyProposal,
  pauseFocus,
  changeCountry,
} from '../src/engine';

const tree = (): z.input<typeof TreeSchema> => ({
  id: 'empire',
  name: '示範帝國',
  description: '測試國家',
  stability: 60,
  warSupport: 40,
  evidence: '既有劇情',
  capabilities: [],
  historical: [],
  nodes: [
    {
      id: 'roads',
      name: '修築道路',
      branch: '建設',
      description: '連接各省',
      reason: '提高通行能力',
      icon: 'industry',
      x: 0,
      y: 0,
      days: 10,
      durationReason: '短期整修',
      prerequisites: [],
      requirements: [],
      sustain: [],
      outcomes: [{ kind: 'fact', id: 'survey', label: '勘測完成' }],
      investments: ['已投入工班'],
      effects: [{ id: 'order', kind: 'stability', value: 5 }],
      mutex: null,
    },
    {
      id: 'trade',
      name: '商路協定',
      branch: '建設',
      description: '通商',
      reason: '交流',
      icon: 'trade',
      x: 0,
      y: 1,
      days: 5,
      durationReason: '會談',
      prerequisites: [['roads']],
      requirements: [],
      sustain: [],
      outcomes: [],
      investments: [],
      effects: [],
      mutex: null,
    },
  ],
});

test('時間達標仍等待成果；同一提案重送不重發效果，暫停保留投入', () => {
  let state = installCountry(createState(0), tree(), 0);
  state = startFocus(state, 'empire', 'roads');
  state = applyProposal(state, { id: 'p1', until: 12, reason: '時間前進', steps: [] });
  assert.equal(state.countries.empire.progress.roads.status, 'waiting');
  assert.equal(state.countries.empire.stability, 60);
  state = pauseFocus(state, 'empire');
  assert.deepEqual(state.countries.empire.progress.roads.investments, ['已投入工班']);
  state = startFocus(state, 'empire', 'roads');
  const proposal = {
    id: 'p2',
    until: 12,
    reason: '完成勘測',
    steps: [
      {
        at: 12,
        facts: [
          {
            country: 'empire',
            id: 'survey',
            value: true,
            evidence: '本樓正文：測繪員回報完成',
            origin: 'story',
          },
        ],
        events: [],
        selections: [],
      },
    ],
  };
  state = applyProposal(state, proposal);
  assert.equal(state.countries.empire.stability, 65);
  assert.equal(state.countries.empire.progress.roads.status, 'completed');
  assert.deepEqual(applyProposal(state, proposal), state);
});

test('前置有循環或同格重疊時拒收整棵樹', () => {
  const cyclic = tree();
  cyclic.nodes[0].prerequisites = [['trade']];
  assert.throws(() => installCountry(createState(0), cyclic, 0), /循環/);
  const overlapping = tree();
  overlapping.nodes[1].y = 0;
  assert.throws(() => installCountry(createState(0), overlapping, 0), /重疊/);
});

test('單國不能同時啟動兩項國策，切換控制也不取消當前國策', () => {
  let state = installCountry(createState(0), tree(), 0);
  state = startFocus(state, 'empire', 'roads');
  assert.throws(() => startFocus(state, 'empire', 'trade'), /先暫停/);
  state = changeCountry(state, 'empire', { control: 'ai' });
  assert.equal(state.countries.empire.current, 'roads');
});

test('沒有跳時代選授權時拒绝 AI 幫手動國選策', () => {
  const state = installCountry(createState(0), tree(), 0);
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'unauthorized',
        until: 10,
        reason: '推進',
        steps: [
          {
            at: 0,
            facts: [],
            events: [],
            selections: [{ country: 'empire', node: 'roads', reason: 'AI 選擇' }],
          },
        ],
      }),
    /未授權/,
  );
  assert.equal(state.countries.empire.current, '');
});

test('跳時不能把晚到的勘查成果用於提早完成，後續國策從實際選策時開始', () => {
  let state = installCountry(createState(0), tree(), 0);
  state = changeCountry(state, 'empire', { skipDelegate: true });
  state = startFocus(state, 'empire', 'roads');
  state = applyProposal(state, {
    id: 'catchup',
    until: 25,
    reason: '跳時',
    steps: [
      {
        at: 20,
        facts: [
          { country: 'empire', id: 'survey', value: true, evidence: '第20日才勘查完成', origin: 'story' },
        ],
        events: [],
        selections: [{ country: 'empire', node: 'trade', reason: '道路成果達成後談判' }],
      },
    ],
  });
  assert.equal(state.countries.empire.progress.roads.completed, 20);
  assert.equal(state.countries.empire.progress.trade.started, 20);
  assert.equal(state.countries.empire.progress.trade.completed, 25);
});

test('停用期間不累積工期，重新啟用必須先校準', () => {
  let state = installCountry(createState(0), tree(), 0);
  state = startFocus(state, 'empire', 'roads');
  state = changeCountry(state, 'empire', { enabled: false });
  state = applyProposal(state, { id: 'off', until: 100, reason: '停用', steps: [] });
  state = changeCountry(state, 'empire', { enabled: true });
  state = applyProposal(state, {
    id: 'calibrate',
    until: 110,
    reason: '承接現況',
    steps: [],
    calibrations: ['empire'],
  });
  assert.equal(state.countries.empire.progress.roads.days, 0);
  state = applyProposal(state, { id: 'on', until: 112, reason: '追蹤恢復', steps: [] });
  assert.equal(state.countries.empire.progress.roads.days, 2);
});

test('完成歷史與成果有效性分離；修復不再給穩定度獎勵', () => {
  const source = tree();
  source.nodes[0].outcomes = [];
  source.nodes[0].effects.push({ id: 'cap', kind: 'capability', key: 'road', name: '公路', active: true });
  let state = startFocus(installCountry(createState(0), source, 0), 'empire', 'roads');
  state = applyProposal(state, { id: 'complete', until: 10, reason: '完成', steps: [] });
  state = applyProposal(state, {
    id: 'destroy',
    until: 11,
    reason: '損壞',
    steps: [
      {
        at: 11,
        facts: [],
        selections: [],
        events: [
          {
            id: 'bridge',
            at: 11,
            countries: ['empire'],
            title: '洪水',
            description: '道路中斷',
            evidence: '正文洪水',
            origin: 'story',
            public: true,
            changes: [
              {
                country: 'empire',
                effects: [{ id: 'damage', kind: 'capability', key: 'road', name: '公路', active: false }],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(state.countries.empire.progress.roads.status, 'completed');
  assert.equal(state.countries.empire.capabilities.road.active, false);
  assert.equal(state.countries.empire.stability, 65);
});

test('跨國事件任一變更無效則整筆拒絕，不留下單方條約', () => {
  const state = installCountry(createState(0), tree(), 0);
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'treaty',
        until: 1,
        reason: '外交',
        steps: [
          {
            at: 1,
            facts: [],
            selections: [],
            events: [
              {
                id: 'bad',
                at: 1,
                countries: ['empire', 'missing'],
                title: '條約',
                description: '雙方同意',
                evidence: '背景外交',
                origin: 'background',
                public: true,
                changes: [
                  { country: 'empire', effects: [{ id: 'gain', kind: 'stability', value: 10 }] },
                  { country: 'missing', effects: [] },
                ],
              },
            ],
          },
        ],
      }),
    /未啟用/,
  );
  assert.equal(state.countries.empire.stability, 60);
  assert.deepEqual(state.events, {});
});

test('重大改樹不能改寫已開始的國策', () => {
  const state = startFocus(installCountry(createState(0), tree(), 0), 'empire', 'roads');
  assert.throws(
    () =>
      applyProposal(
        state,
        {
          id: 'edit',
          until: 0,
          reason: '更改',
          steps: [],
          edits: [{ country: 'empire', remove: ['roads'], nodes: [], reason: '不應允許' }],
        },
        true,
      ),
    /不可改寫/,
  );
});

test('選擇具有不可撤回承諾的路線後，暫停不能選互斥路線', () => {
  const source = tree();
  source.nodes[0].mutex = {
    group: 'politics',
    route: 'central',
    lock: 'start',
    reason: '已簽署不可撤回承諾',
  };
  source.nodes[1].mutex = { group: 'politics', route: 'local', lock: 'complete', reason: '地方協約' };
  source.nodes[1].prerequisites = [];
  let state = startFocus(installCountry(createState(0), source, 0), 'empire', 'roads');
  state = pauseFocus(state, 'empire');
  assert.throws(() => startFocus(state, 'empire', 'trade'), /路線已鎖定/);
});

test('晚加入的國家不截斷原有國家的跳時事件區間', () => {
  let state = startFocus(installCountry(createState(0), tree(), 0), 'empire', 'roads');
  const source = tree();
  source.id = 'newCountry';
  state = installCountry(state, source, 20);
  assert.equal(state.day, 0);
  state = applyProposal(state, {
    id: 'existing',
    until: 20,
    reason: '原有國家補算',
    steps: [
      {
        at: 10,
        facts: [
          { country: 'empire', id: 'survey', value: true, evidence: '第10日勘查完成', origin: 'story' },
        ],
        events: [],
        selections: [],
      },
    ],
  });
  assert.equal(state.countries.empire.progress.roads.completed, 10);
  assert.equal(state.countries.newCountry.cursor, 20);
});

test('正文資料呈現實際狀態：AI 國推進中的國策與未公開的完成國策都會出現，未公開的加上標示', async () => {
  const { promptView } = await import('../src/prompt-view');
  const source = tree();
  source.nodes[0].outcomes = [];
  let state = startFocus(installCountry(createState(0), source, 0), 'empire', 'roads');
  state = changeCountry(state, 'empire', { control: 'ai' });
  state = applyProposal(state, {
    id: 'finish',
    until: 10,
    reason: '竣工但未公開',
    steps: [
      {
        at: 10,
        facts: [],
        events: [],
        selections: [{ country: 'empire', node: 'trade', reason: '啟動秘密談判' }],
      },
    ],
  });
  let text = promptView(state).countries.empire.text;
  assert.match(text, /推進中：[^\n]*（第/);
  assert.match(text, /近期完成：\n- [^\n]*（今日，未公開）/);
  state = applyProposal(state, {
    id: 'publish',
    until: 10,
    reason: '公開竣工',
    steps: [
      {
        at: 10,
        facts: [],
        events: [],
        selections: [],
        publications: [{ country: 'empire', node: 'roads', evidence: '公開通車典禮' }],
      },
    ],
  });
  text = promptView(state).countries.empire.text;
  assert.match(text, /近期完成：\n- [^\n]*（今日）：/);
  // The secret talks that started afterwards are still marked.
  assert.match(text, /推進中：[^\n]*（第 [^\n]*，未公開）/);
});

test('「必須沒有」的條件與條件式效果：依完成當下的狀態判定，只判定一次', () => {
  const node = (id: string, y: number, extra: Record<string, unknown>) => ({
    id,
    name: id,
    branch: '制度',
    description: `${id} 描述`,
    reason: '測試',
    icon: 'crown' as const,
    x: 0,
    y,
    days: 5,
    durationReason: '測試',
    prerequisites: [],
    requirements: [],
    sustain: [],
    outcomes: [],
    investments: [],
    effects: [],
    mutex: null,
    ...extra,
  });
  const academy = (id: string, y: number) =>
    node(id, y, {
      effects: [
        {
          id: 'officials',
          kind: 'capability',
          key: 'officials',
          name: '跨省官僚',
          active: true,
          when: [{ kind: 'capability', id: 'pledge', label: '承諾：地方分成' }],
        },
        { id: 'order', kind: 'stability', value: 1 },
      ],
    });
  let state = installCountry(
    createState(0),
    {
      ...tree(),
      nodes: [
        node('pledge_local', 0, {
          effects: [
            { id: 'pledge', kind: 'capability', key: 'pledge', name: '承諾：地方分成', active: true },
          ],
        }),
        node('audit', 1, {
          requirements: [{ kind: 'capability', id: 'pledge', label: '沒有「承諾：地方分成」', negate: true }],
        }),
        academy('academy_early', 2),
        academy('academy_late', 3),
      ],
    },
    0,
  );
  const advance = (until: number) =>
    (state = applyProposal(state, { id: `p${until}`, until, reason: '時間前進', steps: [] }));
  // Before the pledge: the conditional capability is skipped, the plain effect applies.
  state = startFocus(state, 'empire', 'academy_early');
  advance(5);
  let country = state.countries.empire;
  assert.equal(country.progress.academy_early.status, 'completed');
  assert.deepEqual(country.progress.academy_early.applied, ['order']);
  assert.equal(country.capabilities.officials, undefined);
  // "Must not have" holds before the pledge.
  state = startFocus(state, 'empire', 'audit');
  state = pauseFocus(state, 'empire');
  state = startFocus(state, 'empire', 'pledge_local');
  advance(10);
  // After the pledge the audit cannot be resumed, and the late academy gets the capability.
  assert.throws(() => startFocus(state, 'empire', 'audit'), /沒有「承諾：地方分成」/);
  state = startFocus(state, 'empire', 'academy_late');
  advance(15);
  country = state.countries.empire;
  assert.deepEqual(country.progress.academy_late.applied, ['officials', 'order']);
  assert.equal(country.capabilities.officials.active, true);
});

test('改樹刪除國策時移除失效的關係、改寫國策時標示關係待驗證；匯出後可以再匯入', async () => {
  const { exportTrees, parseTreeFile } = await import('../src/tree-io');
  const { STALE_RELATION } = await import('../src/engine');
  const base = tree();
  let state = installCountry(
    createState(0),
    {
      ...base,
      relations: [
        {
          from: 'roads',
          to: 'trade',
          kind: 'synergy',
          change: '道路讓商路更快',
          via: ['「修築道路」是「商路協定」的前置'],
        },
      ],
    },
    0,
  );
  const trade = state.countries.empire.nodes.trade;
  const edit = (id: string, remove: string[], nodes: unknown[]) =>
    applyProposal(
      state,
      {
        id,
        until: 0,
        reason: '改樹',
        steps: [],
        edits: [{ country: 'empire', remove, nodes, reason: '重大改樹' }],
      },
      true,
    );
  state = edit('r1', [], [{ ...trade, description: '改寫後的商路' }]);
  assert.deepEqual(state.countries.empire.relations![0].via.at(-1), STALE_RELATION);
  state = edit('r2', ['trade'], []);
  assert.deepEqual(state.countries.empire.relations, []);
  const parsed = parseTreeFile(JSON.parse(exportTrees(state)));
  assert.equal(parsed[0].tree.id, 'empire');
});

test('歷史承接的國策帶有標記，詳情頁據此不宣稱條件式效果已生效', () => {
  let state = installCountry(
    createState(0),
    {
      ...tree(),
      historical: [{ node: 'roads', evidence: '設定：道路已存在' }],
    },
    0,
  );
  assert.ok(state.countries.empire.progress.roads.evidence.startsWith('歷史承接：'));
});
