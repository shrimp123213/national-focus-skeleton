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
  blockers,
  dueFocuses,
  focusEventId,
  type UpdateReport,
} from '../src/engine';

const tree = (): z.input<typeof TreeSchema> => ({
  id: 'empire',
  name: '示范帝国',
  description: '测试国家',
  stability: 60,
  warSupport: 40,
  evidence: '既有剧情',
  capabilities: [],
  historical: [],
  nodes: [
    {
      id: 'roads',
      name: '修筑道路',
      branch: '建设',
      description: '连接各省',
      reason: '提高通行能力',
      icon: 'industry',
      x: 0,
      y: 0,
      days: 10,
      durationReason: '短期整修',
      prerequisites: [],
      requirements: [],
      sustain: [],
      outcomes: [{ kind: 'fact', id: 'survey', label: '勘测完成' }],
      investments: ['已投入工班'],
      effects: [{ id: 'order', kind: 'stability', value: 5 }],
      mutex: null,
    },
    {
      id: 'trade',
      name: '商路协定',
      branch: '建设',
      description: '通商',
      reason: '交流',
      icon: 'trade',
      x: 0,
      y: 1,
      days: 5,
      durationReason: '会谈',
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

test('时间达标仍等待成果；同一提案重送不重发效果，暂停保留投入', () => {
  let state = installCountry(createState(0), tree(), 0);
  state = startFocus(state, 'empire', 'roads');
  state = applyProposal(state, { id: 'p1', until: 12, reason: '时间前进', steps: [] });
  assert.equal(state.countries.empire.progress.roads.status, 'waiting');
  assert.equal(state.countries.empire.stability, 60);
  state = pauseFocus(state, 'empire');
  assert.deepEqual(state.countries.empire.progress.roads.investments, ['已投入工班']);
  state = startFocus(state, 'empire', 'roads');
  const proposal = {
    id: 'p2',
    until: 12,
    reason: '完成勘测',
    steps: [
      {
        at: 12,
        facts: [
          {
            country: 'empire',
            id: 'survey',
            value: true,
            evidence: '本楼正文：测绘员回报完成',
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

test('前置有循环或同格重叠时拒收整棵树', () => {
  const cyclic = tree();
  cyclic.nodes[0].prerequisites = [['trade']];
  assert.throws(() => installCountry(createState(0), cyclic, 0), /循环/);
  const overlapping = tree();
  overlapping.nodes[1].y = 0;
  assert.throws(() => installCountry(createState(0), overlapping, 0), /重叠/);
});

test('单国不能同时启动两项国策，切换控制也不取消当前国策', () => {
  let state = installCountry(createState(0), tree(), 0);
  state = startFocus(state, 'empire', 'roads');
  assert.throws(() => startFocus(state, 'empire', 'trade'), /先暂停/);
  state = changeCountry(state, 'empire', { control: 'ai' });
  assert.equal(state.countries.empire.current, 'roads');
});

test('没有跳时代选授权时拒绝 AI 帮手动国选策', () => {
  const state = installCountry(createState(0), tree(), 0);
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'unauthorized',
        until: 10,
        reason: '推进',
        steps: [
          {
            at: 0,
            facts: [],
            events: [],
            selections: [{ country: 'empire', node: 'roads', reason: 'AI 选择' }],
          },
        ],
      }),
    /未授权/,
  );
  assert.equal(state.countries.empire.current, '');
});

test('AI 选策失败时，错误写出国家、国策、时点与当时可选的国策', () => {
  const state = changeCountry(installCountry(createState(0), tree(), 0), 'empire', { control: 'ai' });
  const step = (at: number, node: string) => ({
    at,
    facts: [],
    events: [],
    selections: [{ country: 'empire', node, reason: 'AI 选择' }],
  });
  assert.throws(
    () => applyProposal(state, { id: 'blocked', until: 10, reason: '推进', steps: [step(0, 'trade')] }),
    /示范帝国（empire）在 故事日 0（at=0）选 trade：前置：修筑道路。此时可选：roads/,
  );
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'busy',
        until: 10,
        reason: '推进',
        steps: [step(0, 'roads'), step(5, 'trade')],
      }),
    /在 故事日 5（at=5）选 trade：此时主国策「修筑道路」（roads）仍在进行或等待成果/,
  );
});

test('传入略过清单时，被略过的选策不会让引用它的事件与公开退回', () => {
  const state = changeCountry(installCountry(createState(0), tree(), 0), 'empire', { control: 'ai' });
  const report: UpdateReport = { skipped: [], expired: [] };
  const next = applyProposal(
    state,
    {
      id: 'skip',
      until: 10,
      reason: '推进',
      steps: [
        {
          at: 0,
          facts: [],
          events: [],
          selections: [{ country: 'empire', node: 'trade', reason: 'AI 选择' }],
        },
        {
          at: 5,
          facts: [],
          selections: [],
          publications: [{ country: 'empire', node: 'trade', evidence: '公开' }],
          events: [
            {
              id: 'linked',
              at: 5,
              countries: ['empire'],
              title: '通商',
              description: '商路开张',
              evidence: '依据',
              origin: 'background',
              public: true,
              changes: [],
              scope: 'back',
              importance: 'minor',
              headline: '',
              status: 'ongoing',
              settle: '',
              option: { label: '知道了', text: '' },
              timeline: [],
              focus: { country: 'empire', node: 'trade' },
            },
          ],
        },
      ],
    },
    false,
    report,
  );
  assert.deepEqual(
    report.skipped.map(({ country, node, at }) => [country, node, at]),
    [['empire', 'trade', 0]],
  );
  assert.match(report.skipped[0].reason, /前置：修筑道路/);
  assert.equal(next.countries.empire.current, '');
  assert.equal(next.countries.empire.progress.trade.public, false);
  assert.deepEqual(next.events.linked.source, { kind: 'update' });
});

/** The sample country as an AI nation, with a free focus to pick after a failure. */
const aiCountry = (edit: (nodes: ReturnType<typeof tree>['nodes']) => void = () => {}) => {
  const base = tree();
  base.nodes.push({ ...base.nodes[1], id: 'ports', name: '开港', x: 2, y: 0, prerequisites: [] });
  edit(base.nodes);
  return changeCountry(installCountry(createState(0), base, 0), 'empire', { control: 'ai' });
};
const start = (node: string) => ({
  at: 0,
  facts: [],
  events: [],
  selections: [{ country: 'empire', node, reason: 'AI 选择' }],
});
const verdict = (at: number, node = 'roads', selections: object[] = []) => ({
  at,
  facts: [],
  selections,
  completions: [{ country: 'empire', node, mode: 'failed', event: 'failure', reason: '谈判破裂' }],
  events: [
    {
      id: 'failure',
      at,
      countries: ['empire'],
      title: '修路失败',
      description: '勘测队无功而返',
      evidence: '依据',
      origin: 'background',
      public: true,
      changes: [],
      scope: 'back',
      importance: 'minor',
      headline: '',
      status: 'resolved',
      settle: '',
      option: { label: '知道了', text: '' },
      timeline: [],
    },
  ],
});

test('裁决失败：国策终止、不给效果，同一步可选下一项，靠它当前置的国策走不通', () => {
  const next = applyProposal(aiCountry(), {
    id: 'fail',
    until: 12,
    reason: '推进',
    steps: [start('roads'), verdict(12, 'roads', [{ country: 'empire', node: 'ports', reason: '改走海路' }])],
  });
  const empire = next.countries.empire;
  assert.equal(empire.progress.roads.status, 'terminated');
  assert.equal(empire.progress.roads.by?.mode, 'failed');
  assert.match(empire.progress.roads.evidence, /失败：谈判破裂/);
  assert.equal(empire.stability, 60);
  assert.equal(empire.current, 'ports');
  assert.match(blockers(empire, empire.nodes.trade).join(), /前置：修筑道路/);
});

test('裁决失败只用于目前的主国策，玩家国也可以判失败', () => {
  const player = startFocus(installCountry(createState(0), tree(), 0), 'empire', 'roads');
  const failed = applyProposal(player, { id: 'p', until: 12, reason: '推进', steps: [verdict(12)] });
  assert.equal(failed.countries.empire.progress.roads.status, 'terminated');
  assert.equal(failed.countries.empire.current, '');
  assert.throws(
    () => applyProposal(aiCountry(), { id: 'q', until: 12, reason: '推进', steps: [verdict(12, 'ports')] }),
    /主国策不是「开港」/,
  );
});

test('裁决失败时，开始时锁定的路线重新开放，同路线还有进展时不开放', () => {
  const mutex = (route: string) => ({ group: 'way', route, lock: 'start' as const, reason: '只能择一' });
  const routed = aiCountry((nodes) => {
    nodes[0].mutex = mutex('land');
    nodes[2].mutex = mutex('sea');
  });
  const locked = applyProposal(routed, { id: 'a', until: 0, reason: '推进', steps: [start('roads')] });
  assert.equal(locked.countries.empire.locks.way.route, 'land');
  const failed = applyProposal(locked, { id: 'b', until: 12, reason: '推进', steps: [verdict(12)] });
  assert.equal(failed.countries.empire.locks.way, undefined);
  assert.deepEqual(blockers(failed.countries.empire, failed.countries.empire.nodes.ports), []);
  const kept = structuredClone(locked);
  kept.countries.empire.nodes.trade.mutex = mutex('land');
  kept.countries.empire.progress.trade.status = 'completed';
  const held = applyProposal(kept, { id: 'c', until: 12, reason: '推进', steps: [verdict(12)] });
  assert.equal(held.countries.empire.locks.way.route, 'land');
});

test('到期未裁决满 7 日判失败；本次才选的国策不算，不传报告时不判', () => {
  const report = (): UpdateReport => ({ skipped: [], expired: [] });
  const first = report();
  const late = applyProposal(
    aiCountry(),
    { id: 'pick', until: 30, reason: '推进', steps: [start('roads')] },
    false,
    first,
  );
  assert.deepEqual(first.expired, []);
  assert.equal(late.countries.empire.progress.roads.status, 'waiting');
  assert.equal(late.countries.empire.progress.roads.due, 10);
  const expired = report();
  const failed = applyProposal(late, { id: 'over', until: 31, reason: '推进', steps: [] }, false, expired);
  assert.deepEqual(expired.expired, [{ country: 'empire', node: 'roads' }]);
  assert.equal(failed.countries.empire.progress.roads.status, 'terminated');
  assert.equal(failed.countries.empire.current, '');
  assert.equal(failed.countries.empire.stability, 60);

  const picked = applyProposal(aiCountry(), { id: 'p2', until: 0, reason: '推进', steps: [start('roads')] });
  const six = report();
  const waiting = applyProposal(picked, { id: 'six', until: 16, reason: '推进', steps: [] }, false, six);
  assert.deepEqual(six.expired, []);
  assert.equal(dueFocuses(waiting, 16)[0].due, 10);
  const seven = report();
  applyProposal(waiting, { id: 'seven', until: 17, reason: '推进', steps: [] }, false, seven);
  assert.equal(seven.expired.length, 1);
  const strict = applyProposal(waiting, { id: 'strict', until: 90, reason: '推进', steps: [] });
  assert.equal(strict.countries.empire.progress.roads.status, 'waiting');
});

test('改版前已在等待的存档，从下一次更新起算 7 日', () => {
  const picked = applyProposal(aiCountry(), { id: 'p', until: 0, reason: '推进', steps: [start('roads')] });
  const old = applyProposal(picked, { id: 'old', until: 40, reason: '推进', steps: [] });
  delete old.countries.empire.progress.roads.due;
  const report: UpdateReport = { skipped: [], expired: [] };
  const next = applyProposal(old, { id: 'next', until: 46, reason: '推进', steps: [] }, false, report);
  assert.deepEqual(report.expired, []);
  assert.equal(next.countries.empire.progress.roads.due, 40);
});

const fresh = (): UpdateReport => ({ skipped: [], expired: [] });
const opened = focusEventId('empire', 'roads');
const moved = (at: number, update: object) => ({
  at,
  facts: [],
  events: [],
  selections: [],
  eventUpdates: [{ id: opened, ...update }],
});

test('还缺成果的国策开始时发事件，一般国策不发；完成时事件结束', () => {
  const report = fresh();
  const started = applyProposal(
    aiCountry(),
    { id: 'a', until: 1, reason: '推进', steps: [start('roads')] },
    false,
    report,
  );
  const event = started.events[opened];
  assert.equal(event.status, 'ongoing');
  assert.equal(event.scope, 'back');
  assert.deepEqual(event.source, { kind: 'focus', country: 'empire', node: 'roads' });
  assert.equal(event.current, '尚需：勘测完成');
  assert.deepEqual(event.steps, [{ text: '勘测完成', state: 'active', when: '故事日 10' }]);
  const done = applyProposal(
    started,
    {
      id: 'b',
      until: 12,
      reason: '推进',
      steps: [
        {
          at: 10,
          events: [],
          selections: [{ country: 'empire', node: 'ports', reason: '接续' }],
          facts: [{ country: 'empire', id: 'survey', value: true, evidence: '勘测队回报', origin: 'story' }],
        },
      ],
    },
    false,
    report,
  );
  assert.equal(done.countries.empire.progress.roads.status, 'completed');
  assert.equal(done.events[opened].status, 'resolved');
  assert.equal(done.events[opened].result, 'achieved');
  assert.equal(done.countries.empire.current, 'ports');
  assert.equal(done.events[focusEventId('empire', 'ports')], undefined);
});

test('不传报告时不发事件', () => {
  const next = applyProposal(aiCountry(), { id: 'a', until: 1, reason: '推进', steps: [start('roads')] });
  assert.deepEqual(next.events, {});
});

test('玩家国相同：已在进行的国策补发事件，漏判满 7 日判失败并结束事件', () => {
  const player = startFocus(installCountry(createState(0), tree(), 0), 'empire', 'roads');
  const report = fresh();
  const next = applyProposal(player, { id: 'a', until: 17, reason: '推进', steps: [] }, false, report);
  assert.deepEqual(report.expired, [{ country: 'empire', node: 'roads' }]);
  assert.equal(next.countries.empire.progress.roads.status, 'terminated');
  const event = next.events[opened];
  assert.equal(event.at, 0);
  assert.equal(event.scope, 'back');
  assert.equal(event.status, 'resolved');
  assert.equal(event.result, 'failed');
  assert.match(event.timeline.at(-1)!.text, /仍未裁决/);
  assert.match(event.current!, /仍未裁决/);
  assert.equal(event.steps?.[0].state, 'pending');
});

test('结束国策事件就是裁决：达成写入成果，其他结局终止国策', () => {
  const started = applyProposal(
    aiCountry(),
    { id: 'a', until: 1, reason: '推进', steps: [start('roads')] },
    false,
    fresh(),
  );
  const won = applyProposal(
    started,
    {
      id: 'w',
      until: 12,
      reason: '裁决',
      steps: [moved(10, { text: '勘测队带回图纸', result: 'achieved' })],
    },
    false,
    fresh(),
  );
  assert.deepEqual(won.countries.empire.facts.survey, { value: true, evidence: '勘测队带回图纸' });
  assert.equal(won.countries.empire.progress.roads.status, 'completed');
  assert.equal(won.countries.empire.stability, 65);
  for (const result of ['failed', 'abandoned']) {
    const lost = applyProposal(
      started,
      { id: result, until: 12, reason: '裁决', steps: [moved(10, { text: '勘测队失踪', result })] },
      false,
      fresh(),
    );
    assert.equal(lost.countries.empire.progress.roads.status, 'terminated');
    assert.equal(lost.countries.empire.progress.roads.by?.mode, 'failed');
    assert.equal(lost.countries.empire.stability, 60);
    assert.equal(lost.countries.empire.current, '');
    assert.equal(lost.events[opened].current, '勘测队失踪');
    assert.equal(lost.events[opened].steps?.[0].state, 'pending');
  }
  const progress = applyProposal(
    started,
    { id: 'p', until: 5, reason: '进展', steps: [moved(5, { text: '勘测队出发' })] },
    false,
    fresh(),
  );
  assert.equal(progress.countries.empire.progress.roads.status, 'active');
  assert.equal(progress.events[opened].status, 'ongoing');
});

test('模型另建连到国策的事件时，取代尚未推进的开场事件；已推进时退回', () => {
  const linked = (id: string) => ({
    ...verdict(5).events[0],
    id,
    status: 'ongoing',
    focus: { country: 'empire', node: 'roads' },
    at: 5,
  });
  const started = applyProposal(
    aiCountry(),
    { id: 'a', until: 1, reason: '推进', steps: [start('roads')] },
    false,
    fresh(),
  );
  const step = (id: string) => ({ at: 5, facts: [], selections: [], events: [linked(id)] });
  const replaced = applyProposal(
    started,
    { id: 'b', until: 5, reason: '推进', steps: [step('own')] },
    false,
    fresh(),
  );
  assert.equal(replaced.events[opened], undefined);
  assert.equal(replaced.events.own.source.node, 'roads');
  const advanced = applyProposal(
    started,
    { id: 'c', until: 3, reason: '进展', steps: [moved(3, { text: '勘测队出发' })] },
    false,
    fresh(),
  );
  assert.throws(
    () =>
      applyProposal(advanced, { id: 'd', until: 5, reason: '推进', steps: [step('own')] }, false, fresh()),
    /已有执行事件/,
  );
});

test('重要国策由开场事件发新闻；持续执行的国策完成后事件继续', () => {
  const news = { headline: '道路贯通', body: '七省相连', option: { label: '好', text: '' } };
  const finish = (edit: (node: ReturnType<typeof tree>['nodes'][number]) => void) => {
    const started = applyProposal(
      aiCountry((nodes) => edit(nodes[0])),
      { id: 'a', until: 1, reason: '推进', steps: [start('roads')] },
      false,
      fresh(),
    );
    const fact = { country: 'empire', id: 'survey', value: true, evidence: '回报', origin: 'story' };
    return applyProposal(
      started,
      { id: 'b', until: 12, reason: '推进', steps: [{ at: 10, events: [], selections: [], facts: [fact] }] },
      false,
      fresh(),
    ).events;
  };
  const pivotal = finish((node) => Object.assign(node, { impact: 'pivotal', news }));
  assert.equal(Object.keys(pivotal).length, 1);
  assert.equal(pivotal[opened].headline, '道路贯通');
  assert.equal(pivotal[opened].importance, 'major');
  assert.equal(pivotal[opened].status, 'resolved');
  const running = finish((node) => Object.assign(node, { execution: 'ongoing' }));
  assert.equal(running[opened].status, 'ongoing');
});

test('跳时不能把晚到的勘查成果用于提早完成，后续国策从实际选策时开始', () => {
  let state = installCountry(createState(0), tree(), 0);
  state = changeCountry(state, 'empire', { skipDelegate: true });
  state = startFocus(state, 'empire', 'roads');
  state = applyProposal(state, {
    id: 'catchup',
    until: 25,
    reason: '跳时',
    steps: [
      {
        at: 20,
        facts: [
          { country: 'empire', id: 'survey', value: true, evidence: '第20日才勘查完成', origin: 'story' },
        ],
        events: [],
        selections: [{ country: 'empire', node: 'trade', reason: '道路成果达成后谈判' }],
      },
    ],
  });
  assert.equal(state.countries.empire.progress.roads.completed, 20);
  assert.equal(state.countries.empire.progress.trade.started, 20);
  assert.equal(state.countries.empire.progress.trade.completed, 25);
});

test('停用期间不累积工期，重新启用必须先校准', () => {
  let state = installCountry(createState(0), tree(), 0);
  state = startFocus(state, 'empire', 'roads');
  state = changeCountry(state, 'empire', { enabled: false });
  state = applyProposal(state, { id: 'off', until: 100, reason: '停用', steps: [] });
  state = changeCountry(state, 'empire', { enabled: true });
  state = applyProposal(state, {
    id: 'calibrate',
    until: 110,
    reason: '承接现况',
    steps: [],
    calibrations: ['empire'],
  });
  assert.equal(state.countries.empire.progress.roads.days, 0);
  state = applyProposal(state, { id: 'on', until: 112, reason: '追踪恢复', steps: [] });
  assert.equal(state.countries.empire.progress.roads.days, 2);
});

test('完成历史与成果有效性分离；修复不再给稳定度奖励', () => {
  const source = tree();
  source.nodes[0].outcomes = [];
  source.nodes[0].effects.push({ id: 'cap', kind: 'capability', key: 'road', name: '公路', active: true });
  let state = startFocus(installCountry(createState(0), source, 0), 'empire', 'roads');
  state = applyProposal(state, { id: 'complete', until: 10, reason: '完成', steps: [] });
  state = applyProposal(state, {
    id: 'destroy',
    until: 11,
    reason: '损坏',
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
            description: '道路中断',
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

test('跨国事件任一变更无效则整笔拒绝，不留下单方条约', () => {
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
                title: '条约',
                description: '双方同意',
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
    /未启用/,
  );
  assert.equal(state.countries.empire.stability, 60);
  assert.deepEqual(state.events, {});
});

test('重大改树不能改写已开始的国策', () => {
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
          edits: [{ country: 'empire', remove: ['roads'], nodes: [], reason: '不应允许' }],
        },
        true,
      ),
    /不可改写/,
  );
});

test('选择具有不可撤回承诺的路线后，暂停不能选互斥路线', () => {
  const source = tree();
  source.nodes[0].mutex = {
    group: 'politics',
    route: 'central',
    lock: 'start',
    reason: '已签署不可撤回承诺',
  };
  source.nodes[1].mutex = { group: 'politics', route: 'local', lock: 'complete', reason: '地方协约' };
  source.nodes[1].prerequisites = [];
  let state = startFocus(installCountry(createState(0), source, 0), 'empire', 'roads');
  state = pauseFocus(state, 'empire');
  assert.throws(() => startFocus(state, 'empire', 'trade'), /路线已锁定/);
});

test('晚加入的国家不截断原有国家的跳时事件区间', () => {
  let state = startFocus(installCountry(createState(0), tree(), 0), 'empire', 'roads');
  const source = tree();
  source.id = 'newCountry';
  state = installCountry(state, source, 20);
  assert.equal(state.day, 0);
  state = applyProposal(state, {
    id: 'existing',
    until: 20,
    reason: '原有国家补算',
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

test('正文资料呈现实际状态：AI 国推进中的国策与未公开的完成国策都会出现，未公开的加上标示', async () => {
  const { promptView } = await import('../src/prompt-view');
  const source = tree();
  source.nodes[0].outcomes = [];
  let state = startFocus(installCountry(createState(0), source, 0), 'empire', 'roads');
  state = changeCountry(state, 'empire', { control: 'ai' });
  state = applyProposal(state, {
    id: 'finish',
    until: 10,
    reason: '竣工但未公开',
    steps: [
      {
        at: 10,
        facts: [],
        events: [],
        selections: [{ country: 'empire', node: 'trade', reason: '启动秘密谈判' }],
      },
    ],
  });
  let text = promptView(state).countries.empire.text;
  assert.match(text, /推进中：[^\n]*（第/);
  assert.match(text, /近期完成：\n- [^\n]*（今日，未公开）/);
  state = applyProposal(state, {
    id: 'publish',
    until: 10,
    reason: '公开竣工',
    steps: [
      {
        at: 10,
        facts: [],
        events: [],
        selections: [],
        publications: [{ country: 'empire', node: 'roads', evidence: '公开通车典礼' }],
      },
    ],
  });
  text = promptView(state).countries.empire.text;
  assert.match(text, /近期完成：\n- [^\n]*（今日）：/);
  // The secret talks that started afterwards are still marked.
  assert.match(text, /推进中：[^\n]*（第 [^\n]*，未公开）/);
});

test('「必须没有」的条件与条件式效果：依完成当下的状态判定，只判定一次', () => {
  const node = (id: string, y: number, extra: Record<string, unknown>) => ({
    id,
    name: id,
    branch: '制度',
    description: `${id} 描述`,
    reason: '测试',
    icon: 'crown' as const,
    x: 0,
    y,
    days: 5,
    durationReason: '测试',
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
          when: [{ kind: 'capability', id: 'pledge', label: '承诺：地方分成' }],
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
            { id: 'pledge', kind: 'capability', key: 'pledge', name: '承诺：地方分成', active: true },
          ],
        }),
        node('audit', 1, {
          requirements: [{ kind: 'capability', id: 'pledge', label: '没有「承诺：地方分成」', negate: true }],
        }),
        academy('academy_early', 2),
        academy('academy_late', 3),
      ],
    },
    0,
  );
  const advance = (until: number) =>
    (state = applyProposal(state, { id: `p${until}`, until, reason: '时间前进', steps: [] }));
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
  assert.throws(() => startFocus(state, 'empire', 'audit'), /没有「承诺：地方分成」/);
  state = startFocus(state, 'empire', 'academy_late');
  advance(15);
  country = state.countries.empire;
  assert.deepEqual(country.progress.academy_late.applied, ['officials', 'order']);
  assert.equal(country.capabilities.officials.active, true);
});

test('改树删除国策时移除失效的关系、改写国策时标示关系待验证；汇出后可以再汇入', async () => {
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
          change: '道路让商路更快',
          via: ['「修筑道路」是「商路协定」的前置'],
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
        reason: '改树',
        steps: [],
        edits: [{ country: 'empire', remove, nodes, reason: '重大改树' }],
      },
      true,
    );
  state = edit('r1', [], [{ ...trade, description: '改写后的商路' }]);
  assert.deepEqual(state.countries.empire.relations![0].via.at(-1), STALE_RELATION);
  state = edit('r2', ['trade'], []);
  assert.deepEqual(state.countries.empire.relations, []);
  const parsed = parseTreeFile(JSON.parse(exportTrees(state)));
  assert.equal(parsed[0].tree.id, 'empire');
});

test('历史承接的国策带有标记，详情页据此不宣称条件式效果已生效', () => {
  let state = installCountry(
    createState(0),
    {
      ...tree(),
      historical: [{ node: 'roads', evidence: '设定：道路已存在' }],
    },
    0,
  );
  assert.ok(state.countries.empire.progress.roads.evidence.startsWith('历史承接：'));
});
