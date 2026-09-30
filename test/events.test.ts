import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProposal,
  createState,
  floorNews,
  focusEventId,
  installCountry,
  newsVisible,
  stampNews,
  startFocus,
} from '../src/engine';
import { EventSchema, StateSchema } from '../src/model';

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `国策${id}`,
  branch: '主线',
  description: `${id} 的内容`,
  reason: '测试',
  icon: 'crown',
  x: 0,
  y: 0,
  days: 10,
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
function world() {
  let state = createState(0);
  state = installCountry(
    state,
    {
      id: 'realm',
      name: '王国',
      description: '测试',
      stability: 50,
      warSupport: 50,
      evidence: '测试',
      capabilities: [],
      historical: [],
      nodes: [
        node('march', {
          impact: 'pivotal',
          news: {
            headline: '王国大军进驻莱茵河谷',
            body: '邻国震惊。',
            option: { label: '这下有得忙了', text: '' },
          },
        }),
        node('census', { y: 1 }),
      ],
    },
    0,
  );
  state = installCountry(
    state,
    {
      id: 'rival',
      name: '对手',
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
  state.countries.rival.control = 'ai';
  return state;
}
const event = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  at: 3,
  countries: ['rival'],
  title: `事件${id}`,
  description: '描述',
  evidence: '依据',
  origin: 'background',
  public: true,
  changes: [],
  ...extra,
});
const step = (at: number, extra: Record<string, unknown> = {}) => ({
  at,
  facts: [],
  events: [],
  selections: [],
  ...extra,
});

test('转折国策完成时发布新闻事件；效果不重复，公开与否跟随国策', () => {
  let state = startFocus(world(), 'realm', 'march');
  state = applyProposal(state, { id: 'p1', until: 12, reason: '推进', steps: [] });
  const id = focusEventId('realm', 'march');
  const news = state.events[id];
  assert.equal(news.headline, '王国大军进驻莱茵河谷');
  assert.equal(news.option.label, '这下有得忙了');
  assert.deepEqual(news.source, { kind: 'focus', country: 'realm', node: 'march' });
  assert.equal(news.at, 10);
  assert.equal(news.scope, 'front');
  assert.equal(news.public, false);
  assert.equal(news.shownAt, null);
  // Publishing the focus later makes the news public.
  state = applyProposal(state, {
    id: 'p2',
    until: 12,
    reason: '公开',
    steps: [step(12, { publications: [{ country: 'realm', node: 'march', evidence: '公告' }] })],
  });
  assert.equal(state.events[id].public, true);
  // A normal focus completes silently.
  state = startFocus(state, 'realm', 'census');
  state = applyProposal(state, { id: 'p3', until: 30, reason: '推进', steps: [] });
  assert.equal(state.events[focusEventId('realm', 'census')], undefined);
  StateSchema.parse(state);
});

test('局势更新可新增进行中的事件并逐期推进；结束后不能再推进；已存在的 id 需用 eventUpdates', () => {
  let state = world();
  state = applyProposal(state, {
    id: 'u1',
    until: 3,
    reason: '新增',
    steps: [
      step(3, {
        events: [
          event('border', {
            status: 'ongoing',
            scope: 'back',
            importance: 'major',
            headline: '边境集结',
            settle: '任一方撤军',
          }),
        ],
      }),
    ],
  });
  const border = state.events.border;
  assert.equal(border.status, 'ongoing');
  assert.deepEqual(border.source, { kind: 'update' });
  assert.deepEqual(border.timeline, [{ at: 3, text: '描述' }]);
  state.events.border.shownAt = 7;
  state = applyProposal(state, {
    id: 'u2',
    until: 5,
    reason: '推进',
    steps: [
      step(5, {
        eventUpdates: [
          { id: 'border', text: '对手撤回一半部队', status: 'resolved', headline: '边境危机缓和' },
        ],
      }),
    ],
  });
  assert.equal(state.events.border.status, 'resolved');
  assert.equal(state.events.border.headline, '边境危机缓和');
  assert.equal(state.events.border.timeline.length, 2);
  assert.equal(state.events.border.shownAt, null);
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'u3',
        until: 6,
        reason: 'x',
        steps: [step(6, { eventUpdates: [{ id: 'border', text: '再推进' }] })],
      }),
    /已结束/,
  );
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'u4',
        until: 6,
        reason: 'x',
        steps: [step(6, { eventUpdates: [{ id: 'nothing', text: '推进' }] })],
      }),
    /不存在/,
  );
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'u5',
        until: 6,
        reason: 'x',
        steps: [step(6, { events: [event('border', { at: 6, title: '另一件' })] })],
      }),
    /eventUpdates/,
  );
});

test('每国进行中的后台事件超过上限时整笔拒收；旧事件缺少新栏位仍可读取', () => {
  const state = world();
  const many = Array.from({ length: 6 }, (_, i) => event(`e${i}`, { status: 'ongoing' }));
  assert.throws(
    () => applyProposal(state, { id: 'x', until: 3, reason: 'x', steps: [step(3, { events: many })] }),
    /后台事件已有 6 件，上限 5 件/,
  );
  const legacy = StateSchema.parse({
    ...state,
    events: {
      old: {
        id: 'old',
        at: 1,
        countries: ['rival'],
        title: '旧事件',
        description: '旧',
        evidence: '旧',
        origin: 'story',
        public: true,
        changes: [],
      },
    },
  });
  assert.equal(legacy.events.old.status, 'resolved');
  assert.equal(legacy.events.old.option.label, '知道了');
  assert.equal(legacy.events.old.shownAt, null);
});

test('持续事件的更新：整句取代现况与步骤、成果只套用一次、一般进展不再发新闻、报导或结束才发', () => {
  let state = applyProposal(world(), {
    id: 'a1',
    until: 3,
    reason: '新增',
    steps: [
      step(3, {
        events: [
          event('survey', {
            status: 'ongoing',
            importance: 'major',
            current: '测量队出发',
            steps: [
              { text: '测量队进驻', state: 'active' },
              { text: '清册入库', state: 'pending' },
            ],
          }),
        ],
      }),
    ],
  });
  assert.equal(state.events.survey.touchedAt, null);
  assert.deepEqual(stampNews(state, 7), ['survey']);
  assert.equal(state.events.survey.touchedAt, 7);
  const cap = {
    id: 'cap_ledger',
    kind: 'capability',
    key: 'cap_ledger',
    name: '四省清册',
    active: true,
  };
  state = applyProposal(state, {
    id: 'a2',
    until: 5,
    reason: '推进',
    steps: [
      step(5, {
        eventUpdates: [
          {
            id: 'survey',
            text: '四省清册入库',
            current: '四省完成，两地以私兵阻挡',
            steps: [
              { text: '测量队进驻', state: 'done', when: '2 月' },
              { text: '清册入库', state: 'active' },
            ],
            changes: [{ country: 'rival', effects: [cap] }],
          },
        ],
      }),
    ],
  });
  const survey = state.events.survey;
  assert.equal(survey.current, '四省完成，两地以私兵阻挡');
  assert.equal(survey.steps?.[0].state, 'done');
  assert.equal(state.countries.rival.capabilities.cap_ledger.active, true);
  assert.deepEqual(survey.changes, [{ country: 'rival', effects: [cap] }]);
  // Ordinary progress stays out of the headlines but is marked as progress on the next floor.
  assert.equal(survey.shownAt, 7);
  assert.equal(survey.touchedAt, null);
  // The same proposal committed twice (a retry) changes nothing.
  assert.equal(applyProposal(state, { id: 'a2', until: 5, reason: '推进', steps: [] }), state);
  state = applyProposal(state, {
    id: 'a3',
    until: 6,
    reason: '报导',
    steps: [step(6, { eventUpdates: [{ id: 'survey', text: '内阁动用禁卫军', report: true }] })],
  });
  assert.equal(state.events.survey.shownAt, null);
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'a4',
        until: 7,
        reason: '矛盾',
        steps: [
          step(7, { eventUpdates: [{ id: 'survey', text: '完成', result: 'achieved', status: 'ongoing' }] }),
        ],
      }),
    /result/,
  );
  state = applyProposal(state, {
    id: 'a5',
    until: 7,
    reason: '结束',
    steps: [step(7, { eventUpdates: [{ id: 'survey', text: '七省清册入库', result: 'achieved' }] })],
  });
  assert.equal(state.events.survey.status, 'resolved');
  assert.equal(state.events.survey.result, 'achieved');
  StateSchema.parse(state);
});

test('事件上限只挡新增：已超过上限的旧存档仍可推进，承接国策的事件不占名额', () => {
  const base = world();
  const legacy = structuredClone(base);
  for (let i = 0; i < 6; i++) {
    legacy.events[`e${i}`] = EventSchema.parse({
      ...event(`e${i}`, { status: 'ongoing' }),
    });
  }
  // Six running stories from an older save: progress is fine, a seventh is not.
  let state = applyProposal(legacy, {
    id: 'b1',
    until: 4,
    reason: '推进',
    steps: [step(4, { eventUpdates: [{ id: 'e0', text: '进展' }] })],
  });
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'b2',
        until: 5,
        reason: '新增',
        steps: [step(5, { events: [event('e9', { at: 5, status: 'ongoing' })] })],
      }),
    /已有 7 件，上限 5 件/,
  );
  // An event that carries out a focus does not count.
  state = startFocus(base, 'realm', 'census');
  state.countries.rival.control = 'ai';
  const five = Array.from({ length: 5 }, (_, i) =>
    event(`r${i}`, { countries: ['realm'], status: 'ongoing' }),
  );
  state = applyProposal(state, {
    id: 'b3',
    until: 3,
    reason: '新增',
    steps: [
      step(3, {
        events: [
          ...five,
          event('work', {
            countries: ['realm'],
            status: 'ongoing',
            focus: { country: 'realm', node: 'census' },
          }),
        ],
      }),
    ],
  });
  assert.deepEqual(state.events.work.source, { kind: 'update', country: 'realm', node: 'census' });
});

test('一项国策最多一个执行事件；尚未开始的国策不能被承接', () => {
  const state = world();
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'c1',
        until: 3,
        reason: 'x',
        steps: [
          step(3, {
            events: [event('work', { countries: ['realm'], focus: { country: 'realm', node: 'census' } })],
          }),
        ],
      }),
    /尚未开始/,
  );
  let started = startFocus(state, 'realm', 'census');
  started = applyProposal(started, {
    id: 'c2',
    until: 3,
    reason: 'x',
    steps: [
      step(3, {
        events: [event('work', { countries: ['realm'], focus: { country: 'realm', node: 'census' } })],
      }),
    ],
  });
  assert.throws(
    () =>
      applyProposal(started, {
        id: 'c3',
        until: 4,
        reason: 'x',
        steps: [
          step(4, {
            events: [
              event('work2', { at: 4, countries: ['realm'], focus: { country: 'realm', node: 'census' } }),
            ],
          }),
        ],
      }),
    /已有执行事件 work/,
  );
});

test('持续执行的国策完成时自动建立执行事件；重要国策只有一则事件同时是新闻与执行', () => {
  const state = world();
  state.countries.realm.nodes.census.execution = 'ongoing';
  state.countries.realm.nodes.march.execution = 'ongoing';
  let next = startFocus(state, 'realm', 'census');
  next = applyProposal(next, { id: 'd1', until: 10, reason: '推进', steps: [] });
  const work = next.events[focusEventId('realm', 'census')];
  assert.equal(work.status, 'ongoing');
  assert.equal(work.importance, 'minor');
  assert.equal(work.headline, '王国开始执行「国策census」');
  next = startFocus(next, 'realm', 'march');
  next = applyProposal(next, { id: 'd2', until: 20, reason: '推进', steps: [] });
  const march = next.events[focusEventId('realm', 'march')];
  assert.equal(march.status, 'ongoing');
  assert.equal(march.importance, 'major');
  assert.equal(march.headline, '王国大军进驻莱茵河谷');
  assert.equal(Object.values(next.events).filter((e) => e.source.node === 'march').length, 1);
});

test('未公开的消息只给玩家选策或身在其中的国家看', () => {
  const state = applyProposal(world(), {
    id: 'v1',
    until: 3,
    reason: '新增',
    steps: [step(3, { events: [event('secret', { public: false }), event('open')] })],
  });
  stampNews(state, 9);
  assert.equal(newsVisible(state.events.secret, ['realm']), false);
  assert.equal(newsVisible(state.events.secret, ['rival']), true);
  // Default insiders are the countries the player steers (the realm), so only the public one shows.
  assert.deepEqual(
    floorNews(state, 9).map((e) => e.id),
    ['open'],
  );
  assert.deepEqual(
    floorNews(state, 9, ['realm', 'rival'])
      .map((e) => e.id)
      .sort(),
    ['open', 'secret'],
  );
});
