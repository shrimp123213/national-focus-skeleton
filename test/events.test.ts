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
  name: `國策${id}`,
  branch: '主線',
  description: `${id} 的內容`,
  reason: '測試',
  icon: 'crown',
  x: 0,
  y: 0,
  days: 10,
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
function world() {
  let state = createState(0);
  state = installCountry(
    state,
    {
      id: 'realm',
      name: '王國',
      description: '測試',
      stability: 50,
      warSupport: 50,
      evidence: '測試',
      capabilities: [],
      historical: [],
      nodes: [
        node('march', {
          impact: 'pivotal',
          news: {
            headline: '王國大軍進駐萊茵河谷',
            body: '鄰國震驚。',
            option: { label: '這下有得忙了', text: '' },
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
      name: '對手',
      description: '測試',
      stability: 50,
      warSupport: 50,
      evidence: '測試',
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
  evidence: '依據',
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

test('轉折國策完成時發布新聞事件；效果不重複，公開與否跟隨國策', () => {
  let state = startFocus(world(), 'realm', 'march');
  state = applyProposal(state, { id: 'p1', until: 12, reason: '推進', steps: [] });
  const id = focusEventId('realm', 'march');
  const news = state.events[id];
  assert.equal(news.headline, '王國大軍進駐萊茵河谷');
  assert.equal(news.option.label, '這下有得忙了');
  assert.deepEqual(news.source, { kind: 'focus', country: 'realm', node: 'march' });
  assert.equal(news.at, 10);
  assert.equal(news.scope, 'front');
  assert.equal(news.public, false);
  assert.equal(news.shownAt, null);
  // Publishing the focus later makes the news public.
  state = applyProposal(state, {
    id: 'p2',
    until: 12,
    reason: '公開',
    steps: [step(12, { publications: [{ country: 'realm', node: 'march', evidence: '公告' }] })],
  });
  assert.equal(state.events[id].public, true);
  // A normal focus completes silently.
  state = startFocus(state, 'realm', 'census');
  state = applyProposal(state, { id: 'p3', until: 30, reason: '推進', steps: [] });
  assert.equal(state.events[focusEventId('realm', 'census')], undefined);
  StateSchema.parse(state);
});

test('局勢更新可新增進行中的事件並逐期推進；結束後不能再推進；已存在的 id 需用 eventUpdates', () => {
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
            headline: '邊境集結',
            settle: '任一方撤軍',
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
    reason: '推進',
    steps: [
      step(5, {
        eventUpdates: [
          { id: 'border', text: '對手撤回一半部隊', status: 'resolved', headline: '邊境危機緩和' },
        ],
      }),
    ],
  });
  assert.equal(state.events.border.status, 'resolved');
  assert.equal(state.events.border.headline, '邊境危機緩和');
  assert.equal(state.events.border.timeline.length, 2);
  assert.equal(state.events.border.shownAt, null);
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'u3',
        until: 6,
        reason: 'x',
        steps: [step(6, { eventUpdates: [{ id: 'border', text: '再推進' }] })],
      }),
    /已結束/,
  );
  assert.throws(
    () =>
      applyProposal(state, {
        id: 'u4',
        until: 6,
        reason: 'x',
        steps: [step(6, { eventUpdates: [{ id: 'nothing', text: '推進' }] })],
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

test('每國進行中的後台事件超過上限時整筆拒收；舊事件缺少新欄位仍可讀取', () => {
  const state = world();
  const many = Array.from({ length: 6 }, (_, i) => event(`e${i}`, { status: 'ongoing' }));
  assert.throws(
    () => applyProposal(state, { id: 'x', until: 3, reason: 'x', steps: [step(3, { events: many })] }),
    /後台事件已有 6 件，上限 5 件/,
  );
  const legacy = StateSchema.parse({
    ...state,
    events: {
      old: {
        id: 'old',
        at: 1,
        countries: ['rival'],
        title: '舊事件',
        description: '舊',
        evidence: '舊',
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

test('持續事件的更新：整句取代現況與步驟、成果只套用一次、一般進展不再發新聞、報導或結束才發', () => {
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
            current: '測量隊出發',
            steps: [
              { text: '測量隊進駐', state: 'active' },
              { text: '清冊入庫', state: 'pending' },
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
    name: '四省清冊',
    active: true,
  };
  state = applyProposal(state, {
    id: 'a2',
    until: 5,
    reason: '推進',
    steps: [
      step(5, {
        eventUpdates: [
          {
            id: 'survey',
            text: '四省清冊入庫',
            current: '四省完成，兩地以私兵阻擋',
            steps: [
              { text: '測量隊進駐', state: 'done', when: '2 月' },
              { text: '清冊入庫', state: 'active' },
            ],
            changes: [{ country: 'rival', effects: [cap] }],
          },
        ],
      }),
    ],
  });
  const survey = state.events.survey;
  assert.equal(survey.current, '四省完成，兩地以私兵阻擋');
  assert.equal(survey.steps?.[0].state, 'done');
  assert.equal(state.countries.rival.capabilities.cap_ledger.active, true);
  assert.deepEqual(survey.changes, [{ country: 'rival', effects: [cap] }]);
  // Ordinary progress stays out of the headlines but is marked as progress on the next floor.
  assert.equal(survey.shownAt, 7);
  assert.equal(survey.touchedAt, null);
  // The same proposal committed twice (a retry) changes nothing.
  assert.equal(applyProposal(state, { id: 'a2', until: 5, reason: '推進', steps: [] }), state);
  state = applyProposal(state, {
    id: 'a3',
    until: 6,
    reason: '報導',
    steps: [step(6, { eventUpdates: [{ id: 'survey', text: '內閣動用禁衛軍', report: true }] })],
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
    reason: '結束',
    steps: [step(7, { eventUpdates: [{ id: 'survey', text: '七省清冊入庫', result: 'achieved' }] })],
  });
  assert.equal(state.events.survey.status, 'resolved');
  assert.equal(state.events.survey.result, 'achieved');
  StateSchema.parse(state);
});

test('事件上限只擋新增：已超過上限的舊存檔仍可推進，承接國策的事件不佔名額', () => {
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
    reason: '推進',
    steps: [step(4, { eventUpdates: [{ id: 'e0', text: '進展' }] })],
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

test('一項國策最多一個執行事件；尚未開始的國策不能被承接', () => {
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
    /尚未開始/,
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
    /已有執行事件 work/,
  );
});

test('持續執行的國策完成時自動建立執行事件；重要國策只有一則事件同時是新聞與執行', () => {
  const state = world();
  state.countries.realm.nodes.census.execution = 'ongoing';
  state.countries.realm.nodes.march.execution = 'ongoing';
  let next = startFocus(state, 'realm', 'census');
  next = applyProposal(next, { id: 'd1', until: 10, reason: '推進', steps: [] });
  const work = next.events[focusEventId('realm', 'census')];
  assert.equal(work.status, 'ongoing');
  assert.equal(work.importance, 'minor');
  assert.equal(work.headline, '王國開始執行「國策census」');
  next = startFocus(next, 'realm', 'march');
  next = applyProposal(next, { id: 'd2', until: 20, reason: '推進', steps: [] });
  const march = next.events[focusEventId('realm', 'march')];
  assert.equal(march.status, 'ongoing');
  assert.equal(march.importance, 'major');
  assert.equal(march.headline, '王國大軍進駐萊茵河谷');
  assert.equal(Object.values(next.events).filter((e) => e.source.node === 'march').length, 1);
});

test('未公開的消息只給玩家選策或身在其中的國家看', () => {
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
