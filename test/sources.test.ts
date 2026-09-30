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

test('边界规则使用最后一组、支援开标签前缀、先提取后排除，未命中保留原文', () => {
  const rules = ContextRulesSchema.parse({
    contextExtractRules: [{ start: '<content', end: '</content>' }],
    contextExcludeRules: [{ start: '<secret', end: '</secret>' }],
  });
  const text =
    '<content>前段</content><think>大量思考</think><content name="正文">后段<secret>排除</secret></content><UpdateVariable>大型变量</UpdateVariable>';
  assert.deepEqual(extractContext(text, rules), {
    text: '<content name="正文">后段</content>',
    missed: false,
  });
  assert.equal(extractContext('<CONTENT>大小写</CONTENT>', rules).text, '<CONTENT>大小写</CONTENT>');
  assert.deepEqual(extractContext('没有标签', rules), { text: '没有标签', missed: true });
  assert.equal(
    excludeContext('<think>第一段</think>A<think>第二段</think>', [{ start: '<think', end: '</think>' }]),
    '<think>第一段</think>A',
  );
  const prefix = ContextRulesSchema.parse({ contextExtractRules: [{ start: '<tp', end: '</tp>' }] });
  assert.equal(extractContext('<tpx>不是 tp</tp>', prefix).missed, true);
  assert.equal(extractContext('<tp="正文">内容</tp>', prefix).text, '<tp="正文">内容</tp>');
});

test('上下文只取最近 N 则 AI，N 包含当前楼且 0 仍取当前楼', async () => {
  const config = defaultConfig();
  const messages = [
    { message_id: 1, role: 'assistant', message: '旧 AI' },
    { message_id: 2, role: 'user', message: '不自动送出的使用者全文' },
    { message_id: 3, role: 'assistant', message: '中 AI' },
    { message_id: 4, role: 'system', message: '系统' },
    { message_id: 5, role: 'assistant', message: '最新 AI' },
    { message_id: 6, role: 'assistant', message: '未来分支' },
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

test('绿灯按整理后文字触发、常驻内容可递回；排除禁止向外触发及空关键字', () => {
  const entries = [
    entry(1, '常驻', '矿业'),
    entry(2, '矿业工会', '航运', ['矿业']),
    entry(3, '港口', '终点', ['航运']),
    entry(4, '无关', '巨大资料', ['不存在']),
    entry(5, '无关键字', '不应纳入', []),
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

test('大型不相关世界书与未选 MVU 不进请求；全不选保持空集合，停用条目可明确选取', async () => {
  const config = defaultConfig();
  config.sources.memoryRecallRecentCount = 0;
  config.sources.context.contextExtractRules = [{ start: '<content', end: '</content>' }];
  const entries = [
    entry(1, '帝国', '有效国情', ['帝国']),
    entry(2, '无关地区', 'X'.repeat(700000), ['无关词']),
    entry(3, 'MVU规则', 'Y'.repeat(700000)),
    { ...entry(4, '停用设定', '明确指定'), enabled: false },
  ];
  const input = {
    config,
    job: 'generate' as const,
    messages: [
      {
        message_id: 1,
        role: 'assistant',
        message: `<think>${'Z'.repeat(700000)}</think><content>帝国治理</content>`,
      },
    ],
    currentId: 1,
    entries,
    memoryEntries: [],
    variables: { 世界: { 冗长历史: 'V'.repeat(700000) } },
    renderEntry: async (text: string) => text,
  };
  let result = await buildSourceContext(input);
  assert.ok(result.report.characters < 300);
  assert.ok(String(result.context.worldbook).includes('有效国情'));
  assert.deepEqual(result.context.variables, {});
  config.sources.worldbook.enabledEntries['本局'] = [];
  assert.equal(String((await buildSourceContext(input)).context.worldbook), '');
  config.sources.worldbook.enabledEntries['本局'] = [4];
  result = await buildSourceContext(input);
  assert.ok(String(result.context.worldbook).includes('明确指定'));
  assert.ok(!String(result.context.worldbook).includes('有效国情'));
});

test('AM 回溯取最近 N 条并按时间排列，包裹不占 N 且 0 关闭', async () => {
  const config = defaultConfig();
  config.sources.memoryRecallRecentCount = 2;
  const rows = [
    entry(1, 'TavernDB-ACU-CustomExport-纪要-1', '最旧', ['AM0001']),
    entry(2, 'TavernDB-ACU-CustomExport-纪要-2', '较新', ['AM0002']),
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
  assert.equal(result.context.memory, '<memory>\n\n较新\n\n最新\n\n</memory>');
  assert.equal(String(result.context.worldbook), '');
  config.sources.memoryRecallRecentCount = 0;
  assert.equal((await buildSourceContext(input)).context.memory, undefined);
});

test('表格来源保留国家状态资料，排除主角专用内容且不以其触发其他条目', async () => {
  const config = defaultConfig();
  const entries = [
    entry(
      1,
      'TavernDB-ACU-ReadableDataTable',
      '# 主角信息表\r\n\r\n角色秘密\r\n# 国家表\r\n\r\n| 国家 |\r\n| --- |\r\n| 帝国 |',
    ),
    entry(
      2,
      'TavernDB-ACU-CustomExport-国家状态-1',
      '# 国家状态\n\n| 稳定度 |\n| --- |\n| 72 |\n\n不用重复送出的尾注',
    ),
    entry(3, '角色秘史', '不应被主角表触发', ['角色秘密']),
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
  assert.match(String(result.context.worldbook), /帝国/);
  assert.match(String(result.context.worldbook), /72/);
  assert.doesNotMatch(String(result.context.worldbook), /角色秘密|尾注|不应被主角表触发/);
  assert.equal(result.report.entries[0].status, '已送入');
});

test('任务自订来源存在即生效；旧版开关关闭时保存的自订在载入时移除', () => {
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

test('旧版来源迁移保留指定书和条目、时间路径，缩小预设历史及世界变量', () => {
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
