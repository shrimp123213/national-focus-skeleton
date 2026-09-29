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
  let state = installCountry(createState(0), { ...demoTree(), keywords: ['獅鷲王座', '七省'] }, 0);
  state = installCountry(state, demoTree('coast', '蒼海同盟'), 0);
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
  empire.capabilities.cap_test = { id: 'cap_test', name: '省際驛站', active: true, reason: done };
  empire.commitments.oath = '承諾：保障地方分成';
  return { state, done: empire.nodes[done], doing: empire.nodes[doing] };
}

test('正文資料帶出目前與近期完成國策的描述、制度與承諾，關鍵字觸發該國詳情', () => {
  const { state, done, doing } = world();
  const view = promptView(state);
  assert.match(view.overview, /奧古斯提姆帝國：穩定度 \d+／戰爭支持度 \d+｜推進中：/);
  assert.match(view.overview, new RegExp(`最近完成：${done.name}（10 天前）`));
  const empire = view.countries.augustium;
  assert.deepEqual(empire.keys, ['奧古斯提姆帝國', '獅鷲王座', '七省']);
  assert.match(empire.text, new RegExp(`推進中：${doing.name}（第 10／${doing.days} 天）`));
  assert.ok(empire.text.includes(done.description.slice(0, 20)));
  assert.match(empire.text, /現行制度與成果：[^\n]*省際驛站/);
  assert.match(empire.text, /承諾：承諾：保障地方分成/);
  assert.match(promptText(view), /<國策動態>[\s\S]*【蒼海同盟】[\s\S]*<\/國策動態>/);
});

test('AI 國的推進中國策、制度與未公開完成的國策都照實呈現，未公開的加上標示', () => {
  const { state, done, doing } = world();
  state.countries.augustium.control = 'ai';
  state.countries.augustium.progress[done.id].public = false;
  const view = promptView(state);
  assert.match(
    view.overview,
    new RegExp(`推進中：${doing.name}[^\\n]*最近完成：${done.name}（10 天前，未公開）`),
  );
  assert.ok(view.countries.augustium.text.includes('省際驛站'));
  assert.match(view.countries.augustium.text, new RegExp(`- ${done.name}（10 天前，未公開）`));
});

test('聊天世界書條目：藍燈概況與包裹、每國詳情預設藍燈（可改綠燈）；只在內容改變時改寫，保留玩家調整的位置與關鍵字', () => {
  const { state } = world();
  const wanted = bookEntries(promptView(state));
  assert.deepEqual(
    wanted.map((entry) => [entry.name, entry.constant, entry.order]),
    [
      [`${bookPrefix}世界概況`, true, 99990],
      [`${bookPrefix}國家動態-包裹-上`, true, 99991],
      [`${bookPrefix}國家-augustium`, true, 99992],
      [`${bookPrefix}國家-coast`, true, 99992],
      [`${bookPrefix}國家動態-包裹-下`, true, 99993],
    ],
  );
  assert.equal(wanted[2].content, "<%- getvar('国策.prompt.countries.augustium.text', { defaults: '' }) %>");
  assert.equal(bookEntries(promptView(state), false)[2].constant, false);
  const other: WorldbookEntryLike = {
    name: '玩家的條目',
    strategy: { type: 'constant', keys: [] },
    content: '保留',
  };
  const created = reconcileBook([other], wanted)!;
  assert.equal(created.length, 6);
  assert.equal(created[0], other);
  assert.equal(reconcileBook(created, wanted), null);
  // The player moved an entry, disabled another and added a key: an update keeps all of it.
  const edited = created.map((entry) =>
    entry.name === `${bookPrefix}國家-augustium`
      ? {
          ...entry,
          enabled: false,
          position: { type: 'at_depth', depth: 2, order: 5 },
          strategy: { ...entry.strategy, keys: [...entry.strategy.keys, '獅鷲'] },
        }
      : entry,
  );
  assert.equal(reconcileBook(edited, wanted), null);
  const next = structuredClone(state);
  next.countries.augustium.keywords = ['帝都'];
  delete next.countries.coast;
  const updated = reconcileBook(edited, bookEntries(promptView(next)))!;
  const empire = updated.find((entry) => entry.name === `${bookPrefix}國家-augustium`)!;
  assert.equal(empire.enabled, false);
  assert.deepEqual(empire.position, { type: 'at_depth', depth: 2, order: 5 });
  assert.deepEqual(empire.strategy.keys, ['奧古斯提姆帝國', '獅鷲王座', '七省', '獅鷲', '帝都']);
  assert.ok(!updated.some((entry) => entry.name === `${bookPrefix}國家-coast`));
  // No countries and no news: every entry this script made is removed.
  assert.deepEqual(reconcileBook(updated, bookEntries(promptView(createState(0)))), [other]);
});

test('持續事件以最新進展呈現：已解除的禁運不寫成仍有效，今日的更新算近期消息', async () => {
  const { EventSchema } = await import('../src/model');
  const { state } = world();
  state.day = 100;
  state.events.embargo = EventSchema.parse({
    id: 'embargo',
    at: 10,
    countries: ['augustium'],
    title: '港口禁運',
    headline: '帝國港口實施禁運',
    description: '港口實施禁運。',
    evidence: '正文',
    origin: 'story',
    public: true,
    changes: [],
    importance: 'major',
    status: 'resolved',
    timeline: [{ at: 100, text: '協議生效，禁運已解除。' }],
  });
  const view = promptView(state);
  assert.match(
    view.countries.augustium.text,
    /帝國港口實施禁運：起因：港口實施禁運。最新進展（今日）：協議生效，禁運已解除。（始於90 天前，已結束）/,
  );
  assert.match(
    view.overview,
    /近期國際大事[\s\S]*最新進展（故事日 100）：協議生效，禁運已解除。（始於故事日 10，已結束）/,
  );
});

test('推進中的未公開國策在概況與詳情都標示未公開，公開的不標示', () => {
  const { state, doing } = world();
  let view = promptView(state);
  assert.doesNotMatch(view.overview, new RegExp(`${doing.name}（[^）]*未公開`));
  state.countries.augustium.progress[doing.id].public = false;
  view = promptView(state);
  assert.match(view.overview, new RegExp(`推進中：${doing.name}（第 10／${doing.days} 天，未公開）`));
  assert.match(
    view.countries.augustium.text,
    new RegExp(`推進中：${doing.name}（第 10／${doing.days} 天，未公開）`),
  );
});

test('國家詳情：歷史完整但精簡（全部完成國策依分支列名、全部現行制度、已選路線），重要國策與近期附描述，進行中事件列出完整脈絡', async () => {
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
  empire.locks.constitution = { route: 'central', reason: '選定憲制方向' };
  for (let i = 0; i < 14; i++) {
    empire.capabilities[`cap_${i}`] = { id: `cap_${i}`, name: `制度${i}`, active: true, reason: '測試' };
  }
  state.events.siege = EventSchema.parse({
    id: 'siege',
    at: 20,
    countries: ['augustium'],
    title: '邊境對峙',
    description: '兩國在邊境集結。',
    evidence: '正文',
    origin: 'background',
    public: true,
    changes: [],
    status: 'ongoing',
    timeline: [
      { at: 50, text: '雙方外交凍結。' },
      { at: 90, text: '爆發小規模衝突。' },
      { at: 180, text: '民間和平呼聲漸起。' },
    ],
  });
  const text = promptView(state).countries.augustium.text;
  const names = ids.map((id) => empire.nodes[id].name);
  // Every completed focus by name, oldest first.
  assert.match(
    text,
    new RegExp(`已完成國策（共 11 項，依分支、由早到晚）：\\n- 王冠與七省：${names.join('、')}\\n`),
  );
  // Details: the 4 most recent plus the older turning point.
  const detailed = text.split('重要與近期完成：')[1].split('已完成國策')[0];
  assert.ok(detailed.includes(`${names[0]}（195 天前，重要國策）`));
  assert.ok(!detailed.includes(`${names[1]}（`));
  assert.ok(detailed.includes(`${names[6]}（`));
  assert.match(text, /已選定路線：王冠與七省：王冠的直轄官路線/);
  assert.match(text, /現行制度與成果：[^\n]*制度0[^\n]*制度13/);
  assert.match(
    text,
    /- 邊境對峙（始於180 天前，仍在發展）：兩國在邊境集結。\n {2}- 150 天前：雙方外交凍結。\n {2}- 110 天前：爆發小規模衝突。\n {2}- 20 天前：民間和平呼聲漸起。/,
  );
});

test('持續事件在正文資料中帶現況、步驟與最近 3 則進展，更早的只計數', async () => {
  const { EventSchema } = await import('../src/model');
  const { state } = world();
  state.day = 100;
  state.events.survey = EventSchema.parse({
    id: 'survey',
    at: 10,
    countries: ['augustium'],
    title: '七省清丈進程',
    description: '強制清丈令頒布後，測量隊出發。',
    evidence: '國策',
    origin: 'story',
    public: false,
    changes: [],
    status: 'ongoing',
    current: '四省清冊入庫，兩地以私兵阻擋',
    steps: [
      { text: '測量隊進駐', state: 'done', when: '2 月' },
      { text: '金谷城清丈', state: 'active' },
      { text: '秋季議定是否動兵', state: 'planned' },
    ],
    timeline: [10, 30, 50, 70, 90].map((at) => ({ at, text: `第 ${at} 天進展` })),
  });
  const text = promptView(state).countries.augustium.text;
  assert.match(text, /現況：四省清冊入庫，兩地以私兵阻擋/);
  assert.match(
    text,
    /步驟（1／3）：測量隊進駐［已完成，2 月］；金谷城清丈［進行中］；秋季議定是否動兵［預定］/,
  );
  assert.match(text, /更早 2 則進展從略/);
  assert.doesNotMatch(text, /第 30 天進展/);
  assert.match(text, /第 90 天進展/);
});
