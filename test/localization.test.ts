import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, installCountry, isHistoricalEvidence } from '../src/engine';
import { demoTree } from '../src/demo-tree';
import { bookEntries, promptView, reconcileBook, type WorldbookEntryLike } from '../src/prompt-view';
import { countryTree, importTrees, parseTreeFile } from '../src/tree-io';
import { builtinItem, normalizePrompts, promptText } from '../src/prompts';
import { repairSkeleton } from '../src/repair';
import { entryExclusion } from '../src/sources';

test('旧繁体世界书条目原位改名、去重并保留玩家设置，后续同步不重复写入', () => {
  const state = installCountry(createState(0), demoTree(), 0);
  const wanted = bookEntries(promptView(state));
  const current = reconcileBook([], wanted)!;
  const oldNames: Record<string, string> = {
    '国策档案-世界概况': '國策檔案-世界概況',
    '国策档案-国家动态-包裹-上': '國策檔案-國家動態-包裹-上',
    '国策档案-国家-augustium': '國策檔案-國家-augustium',
    '国策档案-国家动态-包裹-下': '國策檔案-國家動態-包裹-下',
  };
  const old = current.map((entry, i) => ({
    ...entry,
    uid: i + 10,
    name: oldNames[entry.name],
    content: entry.content.replaceAll('国策动态', '國策動態'),
    enabled: false,
    position: { type: 'at_depth', depth: 8, order: i },
    strategy: { ...entry.strategy, keys: [...entry.strategy.keys, '玩家關鍵字'] },
  }));
  const other: WorldbookEntryLike = {
    name: '玩家條目',
    content: '原文',
    strategy: { type: 'constant', keys: [] },
  };
  const result = reconcileBook([...old, other, current[0]], wanted)!;
  assert.equal(result.length, wanted.length + 1);
  assert.equal(result.at(-1), other);
  for (let i = 0; i < wanted.length; i++) {
    assert.equal(result[i].name, wanted[i].name);
    assert.equal(result[i].content, wanted[i].content);
    assert.equal(result[i].uid, old[i].uid);
    assert.equal(result[i].enabled, false);
    assert.deepEqual(result[i].position, old[i].position);
    assert.ok(result[i].strategy.keys.includes('玩家關鍵字'));
  }
  assert.equal(reconcileBook(result, wanted), null);
  assert.deepEqual(reconcileBook(result, []), [other]);
});

test('繁体历史承接标记仍可识别，导出再导入不丢失完成状态或重发效果', () => {
  const state = installCountry(createState(0), demoTree(), 0);
  const country = state.countries.augustium;
  const id = Object.keys(country.nodes)[0];
  Object.assign(country.progress[id], {
    status: 'completed',
    evidence: '歷史承接：世界書記載',
    completed: 0,
  });
  assert.equal(isHistoricalEvidence(country.progress[id].evidence), true);
  const definition = countryTree(country);
  assert.ok(
    (definition.historical as { node: string; evidence: string }[]).some(
      (item) => item.node === id && item.evidence === '世界書記載',
    ),
  );
  const restored = importTrees(createState(0), parseTreeFile(definition), {
    withProgress: false,
    replace: false,
  });
  const next = restored.countries.augustium;
  assert.equal(next.progress[id].status, 'completed');
  assert.equal(next.progress[id].evidence, '历史承接：世界書記載');
  assert.equal(next.stability, country.stability);
  assert.equal(next.warSupport, country.warSupport);
});

test('内置提示词名称迁移为简体，用户改写的名称和正文保持原样', () => {
  const items = normalizePrompts([
    { ...builtinItem('guide'), name: '系統規則' },
    { ...builtinItem('task'), name: '我自訂的任務', content: '維持我的內容' },
    { ...builtinItem('data'), name: '任務資料' },
  ]);
  assert.deepEqual(
    items.map((item) => item.name),
    ['系统规则', '我自訂的任務', '任务资料'],
  );
  assert.match(promptText(items[0], 'generate'), /你是命定之诗国策系统/);
  assert.equal(promptText(items[1], 'generate'), '維持我的內容');
});

test('旧繁体关系类型与来源排除词仍能识别', () => {
  const aliases = ['利益交換', '機會成本', '情境差異', '延後兌現'];
  const output = repairSkeleton({
    relations: aliases.map((kind) => ({ from: 'a', to: 'b', kind, change: '原文' })),
  }) as { relations: { kind: string }[] };
  assert.deepEqual(
    output.relations.map((item) => item.kind),
    ['exchange', 'opportunity', 'context', 'deferred'],
  );
  for (const word of ['規則', '思維鏈', '變量', '狀態', '檢定', '判斷', '敘事', '文風']) {
    assert.notEqual(entryExclusion({ name: `角色${word}` }), '');
  }
});

test('国策档案自己的世界书条目不进入任务的剧情世界书（任务资料已含国策状态）', () => {
  for (const name of ['国策档案-世界概况', '国策档案-国家-奥古斯提姆帝国', '國策檔案-世界概況']) {
    assert.match(entryExclusion({ name }), /国策档案自身条目/);
  }
  assert.equal(entryExclusion({ name: '国策设定' }), '');
});
