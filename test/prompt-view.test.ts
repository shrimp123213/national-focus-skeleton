import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, installCountry } from '../src/engine';
import { demoTree } from '../src/demo-tree';
import {
  bookEntries,
  bookPrefix,
  promptText,
  promptView,
  reconcileBook,
  type WorldbookEntryLike,
} from '../src/prompt-view';

function world() {
  let state = installCountry(createState(0), { ...demoTree(), keywords: ['狮鹫王座', '七省'] }, 0);
  state = installCountry(state, demoTree('coast', '苍海同盟'), 0);
  state.day = 40;
  const empire = state.countries.augustium;
  const [done, doing] = Object.keys(empire.nodes);
  Object.assign(empire.progress[done], {
    status: 'completed',
    started: 0,
    completed: 30,
    days: 30,
    public: true,
  });
  Object.assign(empire.progress[doing], { status: 'active', started: 30, days: 10, public: true });
  empire.current = doing;
  empire.capabilities.cap_test = { id: 'cap_test', name: '省际驿站', active: true, reason: done };
  empire.commitments.oath = '承诺：保障地方分成';
  return { state, done: empire.nodes[done], doing: empire.nodes[doing] };
}

test('正文资料带出目前与近期完成国策的描述、制度与承诺，关键字触发该国详情', () => {
  const { state, done, doing } = world();
  const view = promptView(state);
  assert.match(view.overview, /奥古斯提姆帝国：稳定度 \d+／战争支持度 \d+｜推进中：/);
  assert.match(view.overview, new RegExp(`最近完成：${done.name}（10 天前）`));
  const empire = view.countries.augustium;
  assert.deepEqual(empire.keys, ['奥古斯提姆帝国', '狮鹫王座', '七省']);
  assert.match(empire.text, new RegExp(`推进中：${doing.name}（第 10／${doing.days} 天）`));
  assert.ok(empire.text.includes(done.description.slice(0, 20)));
  assert.match(empire.text, /现行制度与成果：[^\n]*省际驿站/);
  assert.match(empire.text, /承诺：承诺：保障地方分成/);
  assert.match(promptText(view), /<国策动态>[\s\S]*【苍海同盟】[\s\S]*<\/国策动态>/);
});

test('AI 国的推进中国策、制度与未公开完成的国策都照实呈现，未公开的加上标示', () => {
  const { state, done, doing } = world();
  state.countries.augustium.control = 'ai';
  state.countries.augustium.progress[done.id].public = false;
  const view = promptView(state);
  assert.match(
    view.overview,
    new RegExp(`推进中：${doing.name}[^\\n]*最近完成：${done.name}（10 天前，未公开）`),
  );
  assert.ok(view.countries.augustium.text.includes('省际驿站'));
  assert.match(view.countries.augustium.text, new RegExp(`- ${done.name}（10 天前，未公开）`));
});

test('聊天世界书条目：蓝灯概况与包裹、每国详情预设蓝灯（可改绿灯）；只在内容改变时改写，保留玩家调整的位置与关键字', () => {
  const { state } = world();
  const wanted = bookEntries(promptView(state));
  assert.deepEqual(
    wanted.map((entry) => [entry.name, entry.constant, entry.order]),
    [
      [`${bookPrefix}世界概况`, true, 99990],
      [`${bookPrefix}国家动态-包裹-上`, true, 99991],
      [`${bookPrefix}国家-augustium`, true, 99992],
      [`${bookPrefix}国家-coast`, true, 99992],
      [`${bookPrefix}国家动态-包裹-下`, true, 99993],
    ],
  );
  assert.equal(wanted[2].content, "<%- getvar('国策.prompt.countries.augustium.text', { defaults: '' }) %>");
  assert.equal(bookEntries(promptView(state), false)[2].constant, false);
  const other: WorldbookEntryLike = {
    name: '玩家的条目',
    strategy: { type: 'constant', keys: [] },
    content: '保留',
  };
  const created = reconcileBook([other], wanted)!;
  assert.equal(created.length, 6);
  assert.equal(created[0], other);
  assert.equal(reconcileBook(created, wanted), null);
  // The player moved an entry, disabled another and added a key: an update keeps all of it.
  const edited = created.map((entry) =>
    entry.name === `${bookPrefix}国家-augustium`
      ? {
          ...entry,
          enabled: false,
          position: { type: 'at_depth', depth: 2, order: 5 },
          strategy: { ...entry.strategy, keys: [...entry.strategy.keys, '狮鹫'] },
        }
      : entry,
  );
  assert.equal(reconcileBook(edited, wanted), null);
  const next = structuredClone(state);
  next.countries.augustium.keywords = ['帝都'];
  delete next.countries.coast;
  const updated = reconcileBook(edited, bookEntries(promptView(next)))!;
  const empire = updated.find((entry) => entry.name === `${bookPrefix}国家-augustium`)!;
  assert.equal(empire.enabled, false);
  assert.deepEqual(empire.position, { type: 'at_depth', depth: 2, order: 5 });
  assert.deepEqual(empire.strategy.keys, ['奥古斯提姆帝国', '狮鹫王座', '七省', '狮鹫', '帝都']);
  assert.ok(!updated.some((entry) => entry.name === `${bookPrefix}国家-coast`));
  // No countries and no news: every entry this script made is removed.
  assert.deepEqual(reconcileBook(updated, bookEntries(promptView(createState(0)))), [other]);
});

test('持续事件以最新进展呈现：已解除的禁运不写成仍有效，今日的更新算近期消息', async () => {
  const { EventSchema } = await import('../src/model');
  const { state } = world();
  state.day = 100;
  state.events.embargo = EventSchema.parse({
    id: 'embargo',
    at: 10,
    countries: ['augustium'],
    title: '港口禁运',
    headline: '帝国港口实施禁运',
    description: '港口实施禁运。',
    evidence: '正文',
    origin: 'story',
    public: true,
    changes: [],
    importance: 'major',
    status: 'resolved',
    timeline: [{ at: 100, text: '协议生效，禁运已解除。' }],
  });
  const view = promptView(state);
  assert.match(
    view.countries.augustium.text,
    /帝国港口实施禁运：起因：港口实施禁运。最新进展（今日）：协议生效，禁运已解除。（始于90 天前，已结束）/,
  );
  assert.match(
    view.overview,
    /近期国际大事[\s\S]*最新进展（故事日 100）：协议生效，禁运已解除。（始于故事日 10，已结束）/,
  );
});

test('推进中的未公开国策在概况与详情都标示未公开，公开的不标示', () => {
  const { state, doing } = world();
  let view = promptView(state);
  assert.doesNotMatch(view.overview, new RegExp(`${doing.name}（[^）]*未公开`));
  state.countries.augustium.progress[doing.id].public = false;
  view = promptView(state);
  assert.match(view.overview, new RegExp(`推进中：${doing.name}（第 10／${doing.days} 天，未公开）`));
  assert.match(
    view.countries.augustium.text,
    new RegExp(`推进中：${doing.name}（第 10／${doing.days} 天，未公开）`),
  );
});

test('国家详情：历史完整但精简（全部完成国策依分支列名、全部现行制度、已选路线），重要国策与近期附描述，进行中事件列出完整脉络', async () => {
  const { EventSchema } = await import('../src/model');
  const state = installCountry(createState(0), demoTree(), 0);
  state.day = 200;
  const empire = state.countries.augustium;
  const ids = ['focus_0_0', 'focus_0_1', 'focus_0_2', 'focus_0_3', 'focus_0_4', 'focus_0_5', 'focus_0_7'];
  ids.forEach((id, i) => {
    Object.assign(empire.progress[id], {
      status: 'completed',
      started: i * 10,
      completed: i * 10 + 5,
      public: true,
    });
  });
  empire.nodes.focus_0_0.impact = 'pivotal';
  empire.locks.constitution = { route: 'central', reason: '选定宪制方向' };
  for (let i = 0; i < 14; i++) {
    empire.capabilities[`cap_${i}`] = { id: `cap_${i}`, name: `制度${i}`, active: true, reason: '测试' };
  }
  state.events.siege = EventSchema.parse({
    id: 'siege',
    at: 20,
    countries: ['augustium'],
    title: '边境对峙',
    description: '两国在边境集结。',
    evidence: '正文',
    origin: 'background',
    public: true,
    changes: [],
    status: 'ongoing',
    timeline: [
      { at: 50, text: '双方外交冻结。' },
      { at: 90, text: '爆发小规模冲突。' },
      { at: 180, text: '民间和平呼声渐起。' },
    ],
  });
  const text = promptView(state).countries.augustium.text;
  const names = ids.map((id) => empire.nodes[id].name);
  // Every completed focus by name, oldest first.
  assert.match(
    text,
    new RegExp(`已完成国策（共 11 项，依分支、由早到晚）：\\n- 王冠与七省：${names.join('、')}\\n`),
  );
  // Details: the 4 most recent plus the older turning point.
  const detailed = text.split('重要与近期完成：')[1].split('已完成国策')[0];
  assert.ok(detailed.includes(`${names[0]}（195 天前，重要国策）`));
  assert.ok(!detailed.includes(`${names[1]}（`));
  assert.ok(detailed.includes(`${names[6]}（`));
  assert.match(text, /已选定路线：王冠与七省：王冠的直辖官路线/);
  assert.match(text, /现行制度与成果：[^\n]*制度0[^\n]*制度13/);
  assert.match(
    text,
    /- 边境对峙（始于180 天前，仍在发展）：两国在边境集结。\n {2}- 150 天前：双方外交冻结。\n {2}- 110 天前：爆发小规模冲突。\n {2}- 20 天前：民间和平呼声渐起。/,
  );
});

test('持续事件在正文资料中带现况、步骤与最近 3 则进展，更早的只计数', async () => {
  const { EventSchema } = await import('../src/model');
  const { state } = world();
  state.day = 100;
  state.events.survey = EventSchema.parse({
    id: 'survey',
    at: 10,
    countries: ['augustium'],
    title: '七省清丈进程',
    description: '强制清丈令颁布后，测量队出发。',
    evidence: '国策',
    origin: 'story',
    public: false,
    changes: [],
    status: 'ongoing',
    current: '四省清册入库，两地以私兵阻挡',
    steps: [
      { text: '测量队进驻', state: 'done', when: '2 月' },
      { text: '金谷城清丈', state: 'active' },
      { text: '秋季议定是否动兵', state: 'planned' },
    ],
    timeline: [10, 30, 50, 70, 90].map((at) => ({ at, text: `第 ${at} 天进展` })),
  });
  const text = promptView(state).countries.augustium.text;
  assert.match(text, /现况：四省清册入库，两地以私兵阻挡/);
  assert.match(
    text,
    /步骤（1／3）：测量队进驻［已完成，2 月］；金谷城清丈［进行中］；秋季议定是否动兵［预定］/,
  );
  assert.match(text, /更早 2 则进展从略/);
  assert.doesNotMatch(text, /第 30 天进展/);
  assert.match(text, /第 90 天进展/);
});

test('正文资料的各国动向标示故事时间而非日数：有来源时间用原文，否则还原成日期', async () => {
  const { storyDay } = await import('../src/platform');
  const state = installCountry(createState(storyDay('复兴纪元490年-10月-15日-星期三-14:25')), demoTree(), 0);
  state.day = storyDay('复兴纪元490年-10月-15日-星期三-14:25');
  assert.match(promptView(state).overview, /【各国动向】（490年10月15日 14:25）/);
  assert.match(
    promptView(state, true, '复兴纪元490年-10月-15日-星期三-14:25').overview,
    /【各国动向】（复兴纪元490年-10月-15日-星期三-14:25）/,
  );
  assert.doesNotMatch(promptView(state).overview, /故事日 \d{5,}/);
  state.countries.augustium.longTerm = [
    { id: 'a', text: '恢复关税管辖权。' },
    { id: 'b', text: '建造横渡巨舰。' },
  ];
  assert.match(promptView(state).countries.augustium.text, /长期方向：恢复关税管辖权；建造横渡巨舰\n/);
});
