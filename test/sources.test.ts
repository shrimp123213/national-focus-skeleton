import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextRulesSchema, defaultConfig, SourcesSchema } from '../src/model';
import {
  buildSourceContext,
  effectiveSources,
  excludeContext,
  extractContext,
  scanWorldbook,
} from '../src/sources';
import type { SourceEntry } from '../src/platform';

const entry = (uid: number, name: string, content: string, keys?: string[]): SourceEntry => ({
  book: '本局',
  uid,
  name,
  content,
  enabled: true,
  strategy: { type: keys ? 'selective' : 'constant', keys: keys ?? [] },
});

test('邊界規則使用最後一組、支援開標籤前綴、先提取後排除，未命中保留原文', () => {
  const rules = ContextRulesSchema.parse({
    contextExtractRules: [{ start: '<content', end: '</content>' }],
    contextExcludeRules: [{ start: '<secret', end: '</secret>' }],
  });
  const text =
    '<content>前段</content><think>大量思考</think><content name="正文">後段<secret>排除</secret></content><UpdateVariable>大型變量</UpdateVariable>';
  assert.deepEqual(extractContext(text, rules), {
    text: '<content name="正文">後段</content>',
    missed: false,
  });
  assert.equal(extractContext('<CONTENT>大小寫</CONTENT>', rules).text, '<CONTENT>大小寫</CONTENT>');
  assert.deepEqual(extractContext('沒有標籤', rules), { text: '沒有標籤', missed: true });
  assert.equal(
    excludeContext('<think>第一段</think>A<think>第二段</think>', [{ start: '<think', end: '</think>' }]),
    '<think>第一段</think>A',
  );
  const prefix = ContextRulesSchema.parse({ contextExtractRules: [{ start: '<tp', end: '</tp>' }] });
  assert.equal(extractContext('<tpx>不是 tp</tp>', prefix).missed, true);
  assert.equal(extractContext('<tp="正文">內容</tp>', prefix).text, '<tp="正文">內容</tp>');
});

test('上下文只取最近 N 則 AI，N 包含當前樓且 0 仍取當前樓', async () => {
  const config = defaultConfig();
  const messages = [
    { message_id: 1, role: 'assistant', message: '舊 AI' },
    { message_id: 2, role: 'user', message: '不自動送出的使用者全文' },
    { message_id: 3, role: 'assistant', message: '中 AI' },
    { message_id: 4, role: 'system', message: '系統' },
    { message_id: 5, role: 'assistant', message: '最新 AI' },
    { message_id: 6, role: 'assistant', message: '未來分支' },
  ];
  const input = {
    config,
    job: 'update' as const,
    messages,
    currentId: 5,
    entries: [],
    memoryEntries: [],
    variables: {},
    renderEntry: async (text: string) => text,
  };
  config.sources.context.contextTurnCount = 2;
  assert.deepEqual(
    ((await buildSourceContext(input)).context.history as { content: string }[]).map((row) => row.content),
    ['中 AI', '最新 AI'],
  );
  config.sources.context.contextTurnCount = 0;
  assert.deepEqual(
    ((await buildSourceContext(input)).context.history as { content: string }[]).map((row) => row.content),
    ['最新 AI'],
  );
});

test('綠燈按整理後文字觸發、常駐內容可遞迴；排除禁止向外觸發及空關鍵字', () => {
  const entries = [
    entry(1, '常駐', '礦業'),
    entry(2, '礦業工會', '航運', ['礦業']),
    entry(3, '港口', '終點', ['航運']),
    entry(4, '無關', '巨大資料', ['不存在']),
    entry(5, '無關鍵字', '不應納入', []),
  ];
  assert.deepEqual(
    scanWorldbook(entries, '').map((row) => row.uid),
    [1, 2, 3],
  );
  entries[0].recursion = { prevent_outgoing: true };
  assert.deepEqual(
    scanWorldbook(entries, '').map((row) => row.uid),
    [1],
  );
});

test('大型不相關世界書與未選 MVU 不進請求；全不選保持空集合，停用條目可明確選取', async () => {
  const config = defaultConfig();
  config.sources.memoryRecallRecentCount = 0;
  config.sources.context.contextExtractRules = [{ start: '<content', end: '</content>' }];
  const entries = [
    entry(1, '帝國', '有效國情', ['帝國']),
    entry(2, '無關地區', 'X'.repeat(700000), ['無關詞']),
    entry(3, 'MVU规则', 'Y'.repeat(700000)),
    { ...entry(4, '停用設定', '明確指定'), enabled: false },
  ];
  const input = {
    config,
    job: 'generate' as const,
    messages: [
      {
        message_id: 1,
        role: 'assistant',
        message: `<think>${'Z'.repeat(700000)}</think><content>帝國治理</content>`,
      },
    ],
    currentId: 1,
    entries,
    memoryEntries: [],
    variables: { 世界: { 冗長歷史: 'V'.repeat(700000) } },
    renderEntry: async (text: string) => text,
  };
  let result = await buildSourceContext(input);
  assert.ok(result.report.characters < 300);
  assert.ok(String(result.context.worldbook).includes('有效國情'));
  assert.deepEqual(result.context.variables, {});
  config.sources.worldbook.enabledEntries['本局'] = [];
  assert.equal(String((await buildSourceContext(input)).context.worldbook), '');
  config.sources.worldbook.enabledEntries['本局'] = [4];
  result = await buildSourceContext(input);
  assert.ok(String(result.context.worldbook).includes('明確指定'));
  assert.ok(!String(result.context.worldbook).includes('有效國情'));
});

test('AM 回溯取最近 N 條並按時間排列，包裹不占 N 且 0 關閉', async () => {
  const config = defaultConfig();
  config.sources.memoryRecallRecentCount = 2;
  const rows = [
    entry(1, 'TavernDB-ACU-CustomExport-纪要-1', '最舊', ['AM0001']),
    entry(2, 'TavernDB-ACU-CustomExport-纪要-2', '較新', ['AM0002']),
    entry(3, 'TavernDB-ACU-CustomExport-纪要-3', '最新', ['AM0003']),
    entry(4, 'TavernDB-ACU-CustomExport-纪要-包裹-上', '<memory>'),
    entry(5, 'TavernDB-ACU-CustomExport-纪要-包裹-下', '</memory>'),
  ];
  const input = {
    config,
    job: 'update' as const,
    messages: [],
    currentId: 1,
    entries: rows,
    memoryEntries: rows,
    variables: {},
    renderEntry: async (text: string) => text,
  };
  const result = await buildSourceContext(input);
  assert.equal(result.context.memory, '<memory>\n\n較新\n\n最新\n\n</memory>');
  assert.equal(String(result.context.worldbook), '');
  config.sources.memoryRecallRecentCount = 0;
  assert.equal((await buildSourceContext(input)).context.memory, undefined);
});

test('表格來源保留國家狀態資料，排除主角專用內容且不以其觸發其他條目', async () => {
  const config = defaultConfig();
  const entries = [
    entry(
      1,
      'TavernDB-ACU-ReadableDataTable',
      '# 主角信息表\r\n\r\n角色秘密\r\n# 國家表\r\n\r\n| 國家 |\r\n| --- |\r\n| 帝國 |',
    ),
    entry(
      2,
      'TavernDB-ACU-CustomExport-国家状态-1',
      '# 国家状态\n\n| 穩定度 |\n| --- |\n| 72 |\n\n不用重複送出的尾註',
    ),
    entry(3, '角色秘史', '不應被主角表觸發', ['角色秘密']),
  ];
  const result = await buildSourceContext({
    config,
    job: 'update',
    messages: [],
    currentId: 1,
    entries,
    memoryEntries: [],
    variables: {},
    renderEntry: async (text) => text,
  });
  assert.match(String(result.context.worldbook), /帝國/);
  assert.match(String(result.context.worldbook), /72/);
  assert.doesNotMatch(String(result.context.worldbook), /角色秘密|尾註|不應被主角表觸發/);
  assert.equal(result.report.entries[0].status, '已送入');
});

test('任務自訂來源存在即生效；舊版開關關閉時保存的自訂在載入時移除', () => {
  const config = defaultConfig();
  config.sources.overrides.generate = {
    context: ContextRulesSchema.parse({ contextTurnCount: 1 }),
    worldbook: { source: 'manual', manualSelection: ['生成专用'], enabledEntries: {} },
  };
  assert.equal(effectiveSources(config.sources, 'generate').context.contextTurnCount, 1);
  assert.deepEqual(effectiveSources(config.sources, 'generate').worldbook.manualSelection, ['生成专用']);
  assert.equal(effectiveSources(config.sources, 'update').context.contextTurnCount, 3);
  // v0.13.2 and older: an override saved while its switch was off never applied, so it is dropped.
  const old = SourcesSchema.parse({
    ...structuredClone(config.sources),
    taskContextOverridesEnabled: false,
    taskWorldbookOverridesEnabled: true,
  });
  assert.equal(old.overrides.generate?.context, undefined);
  assert.deepEqual(old.overrides.generate?.worldbook?.manualSelection, ['生成专用']);
  assert.equal(effectiveSources(old, 'generate').context.contextTurnCount, 3);
  const none = SourcesSchema.parse({
    ...structuredClone(config.sources),
    taskContextOverridesEnabled: false,
    taskWorldbookOverridesEnabled: false,
  });
  assert.equal(none.overrides.generate, undefined);
  assert.equal(none.taskContextOverridesEnabled, true);
});

test('舊版來源遷移保留指定書和條目、時間路徑，縮小預設歷史及世界變量', () => {
  const sources = SourcesSchema.parse({
    history: 12,
    worldbooks: ['A', 'B'],
    entries: ['A:3'],
    variables: ['世界'],
    timePath: '世界.时间',
    extra: '保留',
  });
  assert.equal(sources.context.contextTurnCount, 3);
  assert.deepEqual(sources.variables, []);
  assert.deepEqual(sources.worldbook.enabledEntries, { A: [3], B: [] });
  assert.equal(sources.timePath, '世界.时间');
  assert.equal(sources.extra, '保留');
  assert.deepEqual(SourcesSchema.parse(sources), sources);
});
