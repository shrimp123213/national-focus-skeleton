import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyProposal, createState, focusEventId, installCountry, startFocus } from '../src/engine';
import { StateSchema, type State } from '../src/model';
import { promptView } from '../src/prompt-view';

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `国策${id}`,
  branch: '主线',
  description: `${id} 的内容`,
  reason: '测试',
  icon: 'crown',
  x: 0,
  y: 0,
  days: 14,
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
const mutex = (route: string) => ({ group: 'way', route, lock: 'start', reason: '和战只能择一' });
function world(): State {
  let state = createState(0);
  state = installCountry(
    state,
    {
      id: '王国',
      name: '王国',
      description: '测试',
      stability: 50,
      warSupport: 50,
      evidence: '测试',
      capabilities: [],
      historical: [],
      nodes: [
        node('open', { effects: [{ id: 'e_open', kind: 'stability', value: 5 }] }),
        node('peace', { prerequisites: [['open']], mutex: mutex('peace') }),
        node('war', { prerequisites: [['open']], mutex: mutex('war') }),
        node('decap', {
          prerequisites: [['war']],
          mutex: mutex('war'),
          effects: [{ id: 'e_decap', kind: 'warSupport', value: 6 }],
        }),
        node('guard', {
          prerequisites: [['open']],
          impact: 'pivotal',
          news: { headline: '禁军易主', body: '王室收回兵权。', option: { label: '知道了', text: '' } },
          effects: [
            { id: 'e_guard', kind: 'capability', key: 'royal_guard', name: '王室禁军', active: true },
          ],
        }),
        node('levy', { execution: 'ongoing', impact: 'pivotal' }),
      ].map((item, i) => ({ ...item, x: i * 2 })),
    },
    0,
  );
  state = installCountry(
    state,
    {
      id: '邻国',
      name: '邻国',
      description: '测试',
      stability: 50,
      warSupport: 50,
      evidence: '测试',
      capabilities: [],
      historical: [],
      nodes: [node('wait')],
    },
    0,
  );
  return state;
}
const cause = (id: string, countries = ['王国'], at = 5) => ({
  id,
  at,
  countries,
  title: `事件${id}`,
  description: '正文中发生的事',
  evidence: '正文',
  origin: 'story',
  public: true,
  changes: [],
});
const step = (at: number, extra: Record<string, unknown> = {}) => ({
  at,
  facts: [],
  events: [],
  selections: [],
  ...extra,
});
const done = (node: string, mode: 'achieved' | 'bypassed', event: string) => ({
  country: '王国',
  node,
  mode,
  event,
  reason: '正文：这件事已经做成',
});

test('事件达成：不检查前置与工期，套用效果，导致完成的事件就是新闻', () => {
  const state = applyProposal(world(), {
    id: 'u1',
    until: 5,
    reason: '政变',
    steps: [step(5, { events: [cause('coup')], completions: [done('guard', 'achieved', 'coup')] })],
  });
  const country = state.countries['王国'];
  const progress = country.progress.guard;
  assert.equal(progress.status, 'completed');
  assert.equal(progress.completed, 5);
  assert.equal(progress.started, null);
  assert.deepEqual(progress.by, {
    event: 'coup',
    title: '事件coup',
    mode: 'achieved',
    reason: '正文：这件事已经做成',
  });
  assert.equal(country.capabilities.royal_guard.active, true);
  assert.deepEqual(progress.applied, ['e_guard']);
  // The important focus does not publish its own news: the coup is the news.
  assert.equal(state.events[focusEventId('王国', 'guard')], undefined);
  assert.equal(Object.keys(state.events).length, 1);
  // The story sees how it was done; the next task sees it too.
  assert.match(promptView(state).countries['王国'].text, /国策guard（今日，重要国策，由「事件coup」达成）/);
  StateSchema.parse(state);
});

test('事件达成进行中的主国策会结束它；一件既有事件可同时完成多项国策', () => {
  let state = applyProposal(world(), {
    id: 'u0',
    until: 2,
    reason: '开场',
    steps: [step(2, { events: [cause('plot', ['王国'], 2)] })],
  });
  state = startFocus(state, '王国', 'open');
  state = applyProposal(state, {
    id: 'u1',
    until: 5,
    reason: '密谋成功',
    steps: [step(5, { completions: [done('open', 'achieved', 'plot'), done('guard', 'achieved', 'plot')] })],
  });
  const country = state.countries['王国'];
  assert.equal(country.current, '');
  assert.equal(country.progress.open.status, 'completed');
  assert.equal(country.progress.open.days, 3);
  assert.equal(country.stability, 55);
  assert.equal(country.progress.guard.status, 'completed');
});

test('事件达成尚未选定的互斥路线会锁定路线；已放弃的路线退回', () => {
  const state = applyProposal(world(), {
    id: 'u1',
    until: 5,
    reason: '开战',
    steps: [step(5, { events: [cause('raid')], completions: [done('war', 'achieved', 'raid')] })],
  });
  assert.equal(state.countries['王国'].locks.way.route, 'war');
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'u2',
        until: 6,
        reason: '和谈',
        steps: [
          step(6, {
            events: [cause('talks', ['王国'], 6)],
            completions: [done('peace', 'achieved', 'talks')],
          }),
        ],
      }),
    /已放弃的互斥路线.*transitions/,
  );
});

test('略过：不套用效果，只用于没有互斥或本国已走上的路线，不替本国选路线', () => {
  const unchosen = {
    id: 'u1',
    until: 5,
    reason: '敌酋暴毙',
    steps: [
      step(5, {
        events: [cause('death', ['王国', '邻国'])],
        completions: [done('decap', 'bypassed', 'death')],
      }),
    ],
  };
  assert.throws(() => applyProposal(world(), unchosen), /尚未选定或已放弃的互斥路线/);
  let state = startFocus(world(), '王国', 'open');
  state = applyProposal(state, { id: 'u0', until: 14, reason: '推进', steps: [] });
  state = startFocus(state, '王国', 'war');
  state = applyProposal(state, {
    ...unchosen,
    until: 16,
    steps: [{ ...unchosen.steps[0], at: 16, events: [cause('death', ['王国', '邻国'], 16)] }],
  });
  const country = state.countries['王国'];
  assert.equal(country.progress.decap.status, 'completed');
  assert.equal(country.progress.decap.by?.mode, 'bypassed');
  assert.deepEqual(country.progress.decap.applied, []);
  assert.equal(country.warSupport, 50);
  // The current focus on the same route keeps running.
  assert.equal(country.current, 'war');
});

test('事件完成国策的引用都要存在且一致', () => {
  const attempt = (events: unknown[], completions: unknown[]) => () =>
    applyProposal(world(), { id: 'u1', until: 5, reason: '测试', steps: [step(5, { events, completions })] });
  assert.throws(attempt([], [done('guard', 'achieved', 'ghost')]), /引用的事件 ghost 不存在/);
  assert.throws(attempt([cause('far', ['邻国'])], [done('guard', 'achieved', 'far')]), /参与国家不含王国/);
  assert.throws(
    attempt([cause('coup')], [done('guard', 'achieved', 'coup'), done('guard', 'bypassed', 'coup')]),
    /已完成，不能再由事件完成/,
  );
  assert.throws(attempt([cause('coup')], [done('nothing', 'achieved', 'coup')]), /国策 nothing 不存在/);
});

test('事件完成持续执行的国策：建立执行事件但不重复发布新闻；事件可同时承接它', () => {
  let state = applyProposal(world(), {
    id: 'u1',
    until: 5,
    reason: '征召',
    steps: [step(5, { events: [cause('call')], completions: [done('levy', 'achieved', 'call')] })],
  });
  const execution = state.events[focusEventId('王国', 'levy')];
  assert.equal(execution.status, 'ongoing');
  assert.equal(execution.importance, 'minor');
  assert.equal(execution.headline, '王国开始执行「国策levy」');
  // The cause event may carry out the focus it completes; then no execution event is added.
  state = applyProposal(world(), {
    id: 'u2',
    until: 5,
    reason: '征召',
    steps: [
      step(5, {
        events: [{ ...cause('call'), status: 'ongoing', focus: { country: '王国', node: 'levy' } }],
        completions: [done('levy', 'achieved', 'call')],
      }),
    ],
  });
  assert.deepEqual(Object.keys(state.events), ['call']);
  assert.equal(state.events.call.source.node, 'levy');
});
