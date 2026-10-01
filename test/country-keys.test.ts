import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoState } from '../src/demo';
import { applyProposal, countryKey, focusEventId, migrateCountryKeys } from '../src/engine';
import { CountryId, EventSchema, type State } from '../src/model';
import { bookEntries, promptView, reconcileBook, type WorldbookEntryLike } from '../src/prompt-view';
import { candidateKeys } from '../src/workflow';

/** A demo save from before name keys, with a focus news event and a shared event. */
function legacySave(): State {
  const state = demoState();
  state.countries.augustium.progress.focus_0_0.public = false;
  const newsId = focusEventId('augustium', 'focus_0_0');
  state.events[newsId] = EventSchema.parse({
    id: newsId,
    at: 100,
    countries: ['augustium'],
    title: '旧国策新闻',
    description: '完成',
    evidence: '国策完成',
    origin: 'story',
    public: false,
    changes: [],
    source: { kind: 'focus', country: 'augustium', node: 'focus_0_0' },
  });
  state.events.border = EventSchema.parse({
    id: 'border',
    at: 110,
    countries: ['augustium', 'north'],
    title: '边境摩擦',
    description: '双方增兵',
    evidence: '正文',
    origin: 'background',
    public: true,
    changes: [{ country: 'north', effects: [{ id: 'tension', kind: 'warSupport', value: 5 }] }],
  });
  state.settings.observing = ['coast'];
  return state;
}

test('国家 ID 可用世界书国名，但不可含变量路径会断开的字符', () => {
  for (const ok of ['瓦伦蒂亚公国', '圣·艾尔文王国', 'augustium', '北境-联邦']) {
    assert.ok(CountryId.safeParse(ok).success, ok);
  }
  for (const bad of ['某.国', '某 国', "某'国", '[某国]', '', '__proto__']) {
    assert.ok(!CountryId.safeParse(bad).success, bad);
  }
  assert.equal(countryKey(' 瓦伦蒂亚公国（北境） '), '瓦伦蒂亚公国北境');
  assert.equal(countryKey('……'), null);
});

test('旧存档的英文国家 ID 换成国名，所有引用一起改，重复读取结果相同', () => {
  const legacy = legacySave();
  const state = migrateCountryKeys(legacy);
  assert.deepEqual(Object.keys(state.countries), ['奥古斯提姆帝国', '北境联邦', '苍海同盟']);
  assert.equal(state.countries.奥古斯提姆帝国.id, '奥古斯提姆帝国');
  assert.deepEqual(state.events.border.countries, ['奥古斯提姆帝国', '北境联邦']);
  assert.equal(state.events.border.changes[0].country, '北境联邦');
  const news = state.events[focusEventId('augustium', 'focus_0_0')];
  assert.equal(news.source.country, '奥古斯提姆帝国');
  assert.deepEqual(state.settings.observing, ['苍海同盟']);
  assert.equal(state.revision, legacy.revision);
  assert.equal(migrateCountryKeys(state), state);
  assert.deepEqual(migrateCountryKeys(legacySave()), state);
});

test('国名已被其他国家占用或无法作 ID 时保留原 ID', () => {
  const legacy = demoState();
  legacy.countries.coast.name = '北境联邦';
  legacy.countries.north.name = '「」';
  const state = migrateCountryKeys(legacy);
  assert.deepEqual(Object.keys(state.countries).sort(), ['north', '北境联邦', '奥古斯提姆帝国'].sort());
});

test('迁移后旧国策新闻仍可由公开步骤找到', () => {
  const state = migrateCountryKeys(legacySave());
  const next = applyProposal(state, {
    id: 'publish_old_news',
    until: state.day,
    reason: '公开',
    steps: [
      {
        at: state.day,
        facts: [],
        events: [],
        selections: [],
        publications: [{ country: '奥古斯提姆帝国', node: 'focus_0_0', evidence: '诏书' }],
        eventUpdates: [],
      },
    ],
  });
  assert.equal(next.events[focusEventId('augustium', 'focus_0_0')].public, true);
});

test('辨识出的候选国家以国名作 ID，已有国家与重复者略过', () => {
  const state = migrateCountryKeys(demoState());
  const candidates = candidateKeys(
    [
      { id: 'valentia', name: '瓦伦蒂亚公国', description: '公国', evidence: '世界书' },
      { id: 'north_league', name: '北境联邦', description: '已有', evidence: '世界书' },
      { id: 'valentia2', name: '瓦伦蒂亚公国', description: '重复', evidence: '世界书' },
      { id: 'odd', name: '……', description: '无法作 ID', evidence: '世界书' },
    ],
    state,
  );
  assert.deepEqual(
    candidates.map((c) => c.id),
    ['瓦伦蒂亚公国', 'odd'],
  );
});

test('国家条目改名时移动原条目，保留玩家的位置与启用状态', () => {
  const legacy = legacySave();
  const toEntry = (entry: ReturnType<typeof bookEntries>[number]): WorldbookEntryLike => ({
    name: entry.name,
    enabled: true,
    strategy: { type: entry.constant ? 'constant' : 'selective', keys: entry.keys },
    position: { type: 'at_depth', depth: 2, order: entry.order },
    content: entry.content,
  });
  const existing = bookEntries(promptView(legacy)).map(toEntry);
  const old = existing.find((entry) => entry.name === '国策档案-国家-north')!;
  old.enabled = false;
  old.strategy.keys.push('北境');
  const result = reconcileBook(existing, bookEntries(promptView(migrateCountryKeys(legacy))))!;
  const names = result.map((entry) => entry.name);
  assert.ok(!names.some((name) => /国家-(augustium|north|coast)$/.test(name)));
  const moved = result.find((entry) => entry.name === '国策档案-国家-北境联邦')!;
  assert.equal(moved.enabled, false);
  assert.deepEqual(moved.position, { type: 'at_depth', depth: 2, order: old.position!.order });
  assert.ok(moved.strategy.keys.includes('北境'));
  assert.match(moved.content, /countries\.北境联邦\.text/);
  assert.equal(names.length, new Set(names).size);
});
