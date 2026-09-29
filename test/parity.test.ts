import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { ConfigSchema, defaultConfig, EventSchema, PromptItemSchema } from '../src/model';
import { DATA_TOKEN, DEFAULT_GUIDE, DEFAULT_TASK, migratePrompts, normalizePrompts } from '../src/prompts';
import {
  applyTaskPreset,
  deleteTaskPreset,
  exportTaskPresets,
  importTaskPresets,
  saveTaskPreset,
} from '../src/task-presets';
import {
  buildSourceContext,
  cleanLatestUser,
  extractContext,
  formatSummaryIndex,
  replacePlaceholders,
  scanWorldbook,
  type SourceInput,
} from '../src/sources';
import { extractApiResult, parseJsonReply, structuredApi } from '../src/api-config';
import {
  extractSecrets,
  mergeSecrets,
  MemorySecretStore,
  splitAuthHeaders,
  stripSecrets,
} from '../src/secrets';
import { RoutePool, routeLimits } from '../src/route-pool';
import { TavernPlatform, type TavernApi } from '../src/tavern';
import { FocusController } from '../src/workflow';
import { DemoPlatform } from '../src/demo';
import type { PromptMessage, SourceEntry } from '../src/platform';

const entry = (uid: number, name: string, content: string, keys?: string[], book = '本局'): SourceEntry => ({
  book,
  uid,
  name,
  content,
  enabled: true,
  strategy: { type: keys ? 'selective' : 'constant', keys: keys ?? [] },
});
function input(overrides: Partial<SourceInput> = {}): SourceInput {
  const config = defaultConfig();
  config.sources.memoryRecallRecentCount = 0;
  return {
    config,
    job: 'update',
    messages: [{ message_id: 2, role: 'assistant', message: '帝國議會召開' }],
    currentId: 2,
    entries: [],
    memoryEntries: [],
    characterEntries: [],
    variables: {},
    renderEntry: async (text) => text,
    ...overrides,
  };
}

test('遞迴掃描：第 0 層只看正文，遵守 delay_until、prevent_incoming 與 prevent_outgoing', () => {
  const rows = [
    entry(1, '議會', '提到港口與鐵路', ['議會']),
    entry(2, '港口', '港口資料', ['港口']),
    { ...entry(3, '鐵路', '不可被遞迴觸發', ['鐵路']), recursion: { prevent_incoming: true } },
    { ...entry(4, '延後常駐', '第二層才加入', undefined), recursion: { delay_until: 2 } },
    entry(5, '只在正文', '正文命中', ['帝國']),
  ];
  assert.deepEqual(
    scanWorldbook(rows, '帝國議會').map((row) => row.uid),
    [1, 2, 4, 5],
  );
  // The same entry that prevents incoming recursion still matches chat text at depth 0.
  assert.ok(scanWorldbook(rows, '鐵路').some((row) => row.uid === 3));
  rows[0].recursion = { prevent_outgoing: true };
  assert.ok(!scanWorldbook(rows, '議會').some((row) => row.uid === 2));
});

test('邊界規則：開標籤前綴不匹配斜線後或更長的標籤名', () => {
  const rules = {
    contextTurnCount: 3,
    contextExtractRules: [{ start: '<tp', end: '</tp>' }],
    contextExcludeRules: [],
  };
  assert.equal(extractContext('<tp:note>冒號延續</tp>', rules).text, '<tp:note>冒號延續</tp>');
  assert.equal(extractContext('<tpx>否</tp>', rules).missed, true);
});

test('$1 只送條目正文、不帶條目名稱，並依位置、深度、順序與原始序排列', async () => {
  const rows: SourceEntry[] = [
    { ...entry(1, '後段', 'C'), position: { type: 'at_depth', depth: 1, order: 1 } },
    { ...entry(2, '前段', 'A'), position: { type: 'before_character_definition', depth: 0, order: 5 } },
    { ...entry(3, '深層', 'B'), position: { type: 'at_depth', depth: 4, order: 9 } },
  ];
  const result = await buildSourceContext(input({ entries: rows }));
  assert.equal(result.context.worldbook, 'A\n\nB\n\nC');
  assert.doesNotMatch(String(result.context.worldbook), /前段|後段|深層/);
});

test('$8 只取當前 AI 前一樓的使用者輸入，優先取輸入標籤並移除預設警告', async () => {
  assert.equal(
    cleanLatestUser('前言<本轮输入>第一次</本轮输入>\n<用户输入 id="x">最後輸入</用户输入>(⚠️: 預設提醒)'),
    '最後輸入',
  );
  assert.equal(cleanLatestUser('我要前往港口\n以上是用户的本轮输入\n後續模板'), '我要前往港口');
  const config = defaultConfig();
  config.sources.includeLatestUser = true;
  const base = input({ config });
  base.messages = [
    { message_id: 1, role: 'user', message: '不相鄰的舊輸入' },
    { message_id: 2, role: 'assistant', message: '正文' },
    { message_id: 3, role: 'assistant', message: '續寫' },
  ];
  base.currentId = 3;
  assert.equal((await buildSourceContext(base)).context.user, undefined);
  base.messages[1] = { message_id: 2, role: 'user', message: '<input>相鄰輸入</input>' };
  assert.equal((await buildSourceContext(base)).context.user, '相鄰輸入');
});

test('資料庫表格可選擇依工作流助手一律納入，否則仍受全不選限制', async () => {
  const table = {
    ...entry(1, 'TavernDB-ACU-CustomExport-国家状态-1', '# 國家\n\n| 國 |\n| --- |\n| 帝國 |'),
    enabled: false,
  };
  const base = input({ entries: [table, entry(2, '一般', '一般條目')] });
  base.config.sources.worldbook.enabledEntries = { 本局: [] };
  assert.equal((await buildSourceContext(base)).context.worldbook, '');
  base.config.sources.autoIncludeTables = true;
  const result = await buildSourceContext(base);
  assert.equal(result.context.worldbook, '| 國 |\n| --- |\n| 帝國 |');
  assert.equal(result.report.entries[1].status, '未勾選');
});

test('$2／$5／$U／$C 預設不送，開啟後依來源規則組裝', async () => {
  const character: SourceEntry[] = [
    entry(1, 'WorkflowHelper-國家關係', '托管關係', ['議會'], '角色書'),
    { ...entry(2, 'WorkflowHelper-停用', '不送', undefined, '角色書'), enabled: false },
    entry(3, 'TavernDB-ACU-CustomExport-主角信息-1', '主角是帝國外交官', undefined, '角色書'),
  ];
  const memory = [entry(9, 'TavernDB-ACU-CustomExport-纪要索引', '- AM0001 帝國成立')];
  const base = input({
    characterEntries: character,
    memoryEntries: memory,
    persona: '玩家設定',
    character: '{{char}} 的描述',
    renderEntry: async (text) => text.replaceAll('{{char}}', '命定之詩').replaceAll('{{user}}', '玩家'),
  });
  let result = await buildSourceContext(base);
  for (const key of ['managedWorldbook', 'summaryIndex', 'persona', 'character']) {
    assert.equal(result.context[key], undefined);
  }
  Object.assign(base.config.sources, {
    managedEntries: true,
    summaryIndex: true,
    persona: true,
    characterDescription: true,
  });
  result = await buildSourceContext(base);
  assert.equal(result.context.managedWorldbook, '托管關係');
  assert.equal(result.context.summaryIndex, '- AM0001 帝國成立');
  assert.equal(
    result.context.persona,
    '<玩家初始设定>\n玩家設定\n</玩家初始设定>\n<玩家最新数据>\n主角是帝國外交官\n</玩家最新数据>',
  );
  assert.equal(result.context.character, '命定之詩 的描述');
  base.memoryEntries = [];
  base.tables = {
    sheet: {
      name: '纪要表',
      content: [
        ['', '概要', '编码索引'],
        ['', '帝國成立', 'AM0001'],
      ],
    },
  };
  assert.match(String((await buildSourceContext(base)).context.summaryIndex), /帝國成立 \| 编码索引: AM0001/);
  assert.equal(formatSummaryIndex(null), '');
});

test('提示詞串的佔位符只替換一次，並把該來源移出 JSON', async () => {
  const config = defaultConfig();
  config.sources.memoryRecallRecentCount = 0;
  const custom = (fields: object) =>
    PromptItemSchema.parse({ id: `c${Math.random()}`, kind: 'custom', ...fields });
  config.jobs.update.prompts = normalizePrompts([
    custom({ name: '世界', role: 'system', content: '世界資料：$1\n正文：$7' }),
    ...config.jobs.update.prompts,
    custom({ name: '預填', role: 'assistant', content: '{' }),
    custom({ name: '停用', enabled: false, content: '$C' }),
  ]);
  const result = await buildSourceContext(
    input({ config, entries: [entry(1, '條目', '含有 $7 字樣的條目')] }),
  );
  assert.equal(result.context.worldbook, undefined);
  assert.equal(result.context.history, undefined);
  assert.deepEqual(result.context.segmentSources, ['worldbook', 'history']);
  assert.deepEqual(
    result.prompts.map((p) => [p.kind, p.role]),
    [
      ['custom', 'system'],
      ['guide', 'system'],
      ['task', 'system'],
      ['data', 'user'],
      ['custom', 'assistant'],
    ],
  );
  assert.equal(
    result.prompts[0].content,
    '世界資料：\n<worldbook_context>\n含有 $7 字樣的條目\n</worldbook_context>\n\n正文：帝國議會召開',
  );
  assert.equal(result.prompts[1].content, DEFAULT_GUIDE);
  assert.equal(result.prompts[2].content, DEFAULT_TASK.update);
  // The data item stays raw until the workflow inserts the JSON.
  assert.ok(result.prompts[3].content.includes(DATA_TOKEN));
  assert.equal(replacePlaceholders('$U$1$9', { $1: '$U' }), '$U$9');
  assert.ok(result.report.characters >= result.prompts[0].content.length);
});

test('舊版提示詞段與補充提示詞遷移成提示詞串，內建段各一且資料段必定啟用', () => {
  const legacy = JSON.parse(JSON.stringify(defaultConfig()));
  delete legacy.jobs.update.prompts;
  Object.assign(legacy.jobs.update, {
    prompt: '多寫外交',
    segments: [
      { name: '越獄', role: 'system', content: 'A', placement: 'before' },
      { name: '預填', role: 'assistant', content: '{', placement: 'after', enabled: false },
    ],
  });
  const migrated = ConfigSchema.parse(legacy);
  assert.deepEqual(
    migrated.jobs.update.prompts.map((p) => [p.kind, p.name, p.enabled]),
    [
      ['custom', '越獄', true],
      ['guide', '系統規則', true],
      ['custom', '玩家補充任務指示', true],
      ['task', '任務指示', true],
      ['data', '任務資料', true],
      ['custom', '預填', false],
    ],
  );
  assert.equal(migrated.jobs.update.prompts[2].content, '多寫外交');
  assert.deepEqual(
    migratePrompts({}).map((p) => p.kind),
    ['guide', 'task', 'data'],
  );
  const fixed = normalizePrompts([
    PromptItemSchema.parse({ id: 'x', kind: 'data', enabled: false }),
    PromptItemSchema.parse({ id: 'y', kind: 'data' }),
    PromptItemSchema.parse({ id: 'z', kind: 'custom', content: 'c' }),
  ]);
  assert.deepEqual(
    fixed.map((p) => [p.kind, p.id, p.enabled]),
    [
      ['guide', 'guide', true],
      ['task', 'task', true],
      ['data', 'data', true],
      ['custom', 'z', true],
    ],
  );
});

test('金鑰與授權標頭拆出設定，重載時合併；其他標頭保留原本格式', () => {
  const config = defaultConfig();
  Object.assign(config.apis[0], {
    apiKey: 'sk-test',
    requestHeaders: 'X-Trace: 1\nAuthorization: Bearer header-secret',
  });
  assert.deepEqual(splitAuthHeaders(config.apis[0].requestHeaders), {
    publicHeaders: 'X-Trace: 1',
    authHeaders: 'Authorization: Bearer header-secret',
  });
  const stripped = stripSecrets(config);
  assert.ok(!JSON.stringify(stripped).includes('secret'));
  assert.ok(!JSON.stringify(stripped).includes('sk-test'));
  const merged = mergeSecrets(stripped, extractSecrets(config));
  assert.equal(merged.apis[0].apiKey, 'sk-test');
  assert.equal(merged.apis[0].requestHeaders, 'Authorization: Bearer header-secret\nX-Trace: 1');
});

function tavern(extensionSettings: Record<string, unknown> | undefined, storage = new Map<string, string>()) {
  let saves = 0;
  const api = {
    SillyTavern: {
      getCurrentChatId: () => 'chat',
      getContext: () => ({ extensionSettings, saveSettingsDebounced: () => saves++ }),
    },
    getLastMessageId: () => 1,
    getChatMessages: () => [],
    eventOn: () => ({ stop() {} }),
    tavern_events: {},
    generateRaw: async () => '{}',
    stopGenerationById: () => true,
    getGlobalWorldbookNames: () => [],
    getCharWorldbookNames: () => ({ primary: null, additional: [] }),
    getWorldbook: async () => [],
    injectPrompts: () => ({ uninject() {} }),
    uninjectPrompts() {},
  } as unknown as TavernApi;
  const local: Storage = {
    get length() {
      return storage.size;
    },
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => void storage.set(key, value),
    removeItem: (key) => void storage.delete(key),
    clear: () => storage.clear(),
    key: (index) => [...storage.keys()][index] ?? null,
  };
  return { platform: new TavernPlatform(api, local), storage, saves: () => saves, api };
}

test('酒館平台把金鑰存入擴充設定，不留在 localStorage；舊版 localStorage 金鑰自動搬移', () => {
  const settings: Record<string, unknown> = {};
  const env = tavern(settings);
  try {
    const config = defaultConfig();
    Object.assign(config.apis[0], { apiKey: 'sk-live', requestHeaders: 'X-Api-Key: header-secret' });
    env.platform.saveConfig(config);
    assert.ok(
      ![...env.storage.values()].some(
        (value) => value.includes('sk-live') || value.includes('header-secret'),
      ),
    );
    assert.match(JSON.stringify(settings), /sk-live/);
    assert.ok(env.saves() > 0);
    assert.equal(env.platform.loadConfig().apis[0].apiKey, 'sk-live');
    assert.equal(env.platform.secretLocation(), 'tavern');
    // Another browser: empty localStorage, same Tavern account settings.
    const other = tavern(settings);
    assert.equal(other.platform.loadConfig().apis[0].apiKey, 'sk-live');
    other.platform.dispose();
  } finally {
    env.platform.dispose();
  }
  const legacy = defaultConfig();
  legacy.apis[0].apiKey = 'sk-legacy';
  const storage = new Map([['national-focus.config.v1', JSON.stringify(legacy)]]);
  const settings2: Record<string, unknown> = {};
  const migrated = tavern(settings2, storage);
  try {
    assert.equal(migrated.platform.loadConfig().apis[0].apiKey, 'sk-legacy');
    assert.ok(!storage.get('national-focus-skeleton.config.v1')!.includes('sk-legacy'));
    assert.match(JSON.stringify(settings2), /sk-legacy/);
  } finally {
    migrated.platform.dispose();
  }
  const fallback = tavern(undefined);
  try {
    const config = defaultConfig();
    config.apis[0].apiKey = 'sk-local';
    fallback.platform.saveConfig(config);
    assert.equal(fallback.platform.loadConfig().apis[0].apiKey, 'sk-local');
    assert.equal(fallback.platform.secretLocation(), 'local');
  } finally {
    fallback.platform.dispose();
  }
});

test('Chat Completion 失敗時，基本參數回退 generateRaw，進階參數明確報錯；推理內容分開保存', async () => {
  const env = tavern({});
  const messages: PromptMessage[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '{' },
  ];
  let raw: Record<string, unknown> | undefined;
  (env.api as { generateRaw: TavernApi['generateRaw'] }).generateRaw = async (config) => {
    raw = config;
    return '{"fallback":true}';
  };
  const context: { ChatCompletionService: { processRequest: () => Promise<unknown> } } = {
    ChatCompletionService: { processRequest: async () => Promise.reject(new Error('502')) },
  };
  env.api.SillyTavern.getContext = () => context;
  const api = { ...defaultConfig().apis[0], url: 'https://example.invalid/v1', model: 'm' };
  try {
    assert.deepEqual(await env.platform.generate(messages, api, '', new AbortController().signal), {
      content: '{"fallback":true}',
    });
    assert.deepEqual(raw?.ordered_prompts, messages);
    await assert.rejects(
      env.platform.generate(messages, structuredApi(api), '', new AbortController().signal),
      /不能回退/,
    );
    context.ChatCompletionService.processRequest = async () => ({
      choices: [{ message: { content: '{"ok":1}', reasoning_content: '思考' } }],
    });
    assert.deepEqual(await env.platform.generate(messages, api, '', new AbortController().signal), {
      content: '{"ok":1}',
      reasoning: '思考',
    });
    // Streaming: the request asks for stream, the generator's cumulative text becomes the reply.
    let sent: Record<string, unknown> | undefined;
    (
      context.ChatCompletionService as { processRequest: (data: Record<string, unknown>) => Promise<unknown> }
    ).processRequest = async (data) => {
      sent = data;
      return async function* () {
        yield { text: '{"ok"', state: { reasoning: '想' } };
        yield { text: '{"ok":2}', state: { reasoning: '想好了' } };
      };
    };
    assert.deepEqual(
      await env.platform.generate(messages, { ...api, stream: true }, '', new AbortController().signal),
      { content: '{"ok":2}', reasoning: '想好了' },
    );
    assert.equal(sent?.stream, true);
    // generateRaw path streams too, and still returns the final text.
    await env.platform.generate(
      messages,
      { ...defaultConfig().apis[0], stream: true },
      '',
      new AbortController().signal,
    );
    assert.equal(raw?.should_stream, true);
  } finally {
    env.platform.dispose();
  }
});

test('條目巨集依助手巨集開關與樓層深度處理，EJS 失敗時保留原文', async () => {
  const env = tavern({ tavern_helper: { macro: { enabled: false } } });
  const calls: string[] = [];
  Object.assign(env.api, {
    substitudeMacros: (text: string) => {
      calls.push(`sub:${text}`);
      return text.replace('{{char}}', '角色');
    },
    formatAsTavernRegexedString: (
      text: string,
      source: string,
      _mode: string,
      options: { depth: number },
    ) => {
      calls.push(`fmt:${source}:${options.depth}`);
      return text.replace('{{char}}', '格式化角色');
    },
    EjsTemplate: {
      prepareContext: async () => ({}),
      evalTemplate: async () => {
        throw new Error('bad template');
      },
    },
  });
  try {
    const render = (
      env.platform as unknown as { renderer(id: number): (t: string, s?: string) => Promise<string> }
    ).renderer(0);
    assert.equal(await render('{{char}}<% x %>'), '角色<% x %>');
    assert.ok(calls.every((call) => call.startsWith('sub:')));
    (
      env.api.SillyTavern.getContext as () => { extensionSettings: Record<string, unknown> }
    )().extensionSettings.tavern_helper = {
      macro: { enabled: true },
    };
    calls.length = 0;
    const render2 = (
      env.platform as unknown as { renderer(id: number): (t: string, s?: string) => Promise<string> }
    ).renderer(0);
    assert.equal(await render2('{{char}}', 'slash_command'), '格式化角色');
    assert.deepEqual(calls, ['fmt:slash_command:1', 'fmt:slash_command:1']);
  } finally {
    env.platform.dispose();
  }
});

test('寬鬆 JSON：移除代碼圍欄、思考標籤與前後文字，截斷回應仍明確失敗', () => {
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('<think>{"a":0}</think>說明 {不是JSON} 最終：{"a":{"b":"}"}} 完'), {
    a: { b: '}' },
  });
  assert.throws(() => parseJsonReply('{"nodes":['));
  assert.deepEqual(extractApiResult({ content: 'x', reasoning: 'x' }), { content: 'x' });
  assert.deepEqual(extractApiResult({ text: ' y ' }), { content: 'y' });
});

test('嚴格 JSON 只補缺少的參數，且不套用到沒有明確 URL 的連線', () => {
  const api = {
    ...defaultConfig().apis[0],
    url: 'https://example.invalid/v1',
    model: 'm',
    bodyParams: 'seed: 1',
  };
  const next = structuredApi(api);
  assert.deepEqual(parse(next.bodyParams), { seed: 1, response_format: { type: 'json_object' } });
  assert.equal(next.customPromptPostProcessing, 'strict');
  assert.equal(next.excludeBodyParams, 'top_p, reasoning_effort');
  assert.equal(
    structuredApi({ ...api, bodyParams: 'response_format:\n  type: text' }).bodyParams,
    'response_format:\n  type: text',
  );
  const inherited = defaultConfig().apis[0];
  assert.deepEqual(structuredApi(inherited), inherited);
});

test('路由並發：主要連線滿載時分流到備援，釋放後喚醒等待者，取消時移出佇列', async () => {
  const pool = new RoutePool(routeLimits(['主', '備'], 1, [1]));
  assert.equal(await pool.acquire(['主', '備']), '主');
  assert.equal(await pool.acquire(['主', '備']), '備');
  const waiting = pool.acquire(['主', '備']);
  const cancel = new AbortController();
  const cancelled = pool.acquire(['主'], cancel.signal);
  cancel.abort();
  await assert.rejects(cancelled);
  pool.release('備');
  assert.equal(await waiting, '備');
  assert.equal(pool.count('主'), 1);
  assert.deepEqual(
    [...routeLimits(['a', 'b', 'c'], 0, [2]).entries()],
    [
      ['a', 0],
      ['b', 2],
      ['c', 0],
    ],
  );
});

test('任務請求依提示詞串排列訊息，資料段的 {{data}} 換成 JSON，執行紀錄保存提示詞、回應與推理', async () => {
  class Recording extends DemoPlatform {
    sent: PromptMessage[][] = [];
    override async generate(messages: PromptMessage[]) {
      this.sent.push(messages);
      return { content: '{"countries":[]}', reasoning: '推理' };
    }
  }
  const platform = new Recording();
  const controller = new FocusController(platform);
  const config = structuredClone(controller.config);
  const custom = (fields: object) =>
    PromptItemSchema.parse({ id: `c${Math.random()}`, kind: 'custom', ...fields });
  config.runLog = true;
  config.jobs.identify.prompts = normalizePrompts([
    custom({ name: '前置', content: '前置段' }),
    ...config.jobs.identify.prompts.map((p) => (p.kind === 'task' ? { ...p, enabled: false } : p)),
    custom({ name: '預填', role: 'assistant', content: '{' }),
  ]);
  controller.saveSettings(config);
  await controller.run('identify');
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  assert.deepEqual(
    platform.sent[0].map((m) => m.role),
    ['system', 'system', 'user', 'assistant'],
  );
  assert.equal(platform.sent[0][0].content, '前置段');
  const data = platform.sent[0][2].content;
  assert.ok(!data.includes(DATA_TOKEN));
  assert.equal(JSON.parse(data.slice(data.indexOf('{'))).job, 'identify');
  assert.equal(controller.logs[0].reasoning, '推理');
  assert.equal(controller.logs[0].route, controller.jobs[0].route);

  // Without the token the JSON is appended; preview builds the same chain without calling the API.
  const edited = structuredClone(controller.config);
  edited.jobs.identify.prompts = edited.jobs.identify.prompts.map((p) =>
    p.kind === 'data' ? { ...p, content: '資料如下' } : p,
  );
  const preview = await controller.preview('identify', edited);
  assert.equal(platform.sent.length, 1);
  assert.match(preview.find((m) => m.role === 'user')!.content, /^資料如下\n\{"job":"identify"/);
  assert.equal(controller.config.jobs.identify.prompts.find((p) => p.kind === 'data')!.content, '');
  const generate = await controller.preview('generate');
  assert.match(generate.at(-1)!.content, /"limits":\{"min":/);
  assert.match(generate.at(-1)!.content, /"stage":"generate"/);
  controller.saveSettings({ ...controller.config, runLog: false });
  assert.deepEqual(controller.logs, []);
  controller.dispose();
});

test('任務預設保存、套用、匯出與匯入，不含 API 路由', () => {
  let config = defaultConfig();
  config.jobs.update.api = '主力';
  config.jobs.update.retries = 3;
  config.jobs.update.prompts = config.jobs.update.prompts.map((p) =>
    p.kind === 'task' ? { ...p, content: '自訂局勢更新指示' } : p,
  );
  config.sources.memoryRecallRecentCount = 7;
  config.jobs.generate.segmentMax = 40;
  config.jobs.generate.recommendedModel = 'deepseek-chat';
  config.jobs.update.strictJson = true;
  config = saveTaskPreset(config, '外交向');
  assert.equal(config.activeTaskPreset, '外交向');
  const preset = config.taskPresets[0];
  assert.equal((preset.jobs.update as Record<string, unknown>).api, undefined);
  const text = exportTaskPresets(config);
  assert.ok(!text.includes('主力'));

  let other = defaultConfig();
  other.jobs.update.api = '備用';
  const imported = importTaskPresets(other, JSON.parse(text));
  assert.deepEqual(imported.names, ['外交向']);
  other = applyTaskPreset(imported.config, '外交向');
  assert.equal(other.jobs.update.api, '備用');
  assert.equal(other.jobs.update.retries, 3);
  assert.equal(other.jobs.update.prompts.find((p) => p.kind === 'task')!.content, '自訂局勢更新指示');
  assert.equal(other.sources.memoryRecallRecentCount, 7);
  assert.equal(other.jobs.generate.segmentMax, 40);
  assert.equal(other.jobs.generate.recommendedModel, 'deepseek-chat');
  // The retired task-level strict JSON switch is not part of presets any more.
  assert.equal(other.jobs.update.strictJson, false);
  assert.ok(!text.includes('strictJson'));
  assert.equal(ConfigSchema.parse(other).taskPresets.length, 1);
  assert.throws(() => saveTaskPreset(other, '  '), /名稱/);
  assert.throws(
    () => importTaskPresets(other, { name: '世界后台引擎', tasks: [{ promptGroups: [] }] }),
    /工作流助手的預設檔/,
  );
  assert.throws(
    () =>
      importTaskPresets(other, { kind: 'national-focus-task-presets', version: 1, presets: [{ name: 'x' }] }),
    /任務預設檔內容有誤：presets\.0\.jobs/,
  );
  assert.throws(() => importTaskPresets(other, { foo: 1 }), /這不是國策任務預設檔/);
  other = deleteTaskPreset(other, '外交向');
  assert.equal(other.activeTaskPreset, '');
  assert.throws(() => exportTaskPresets(other), /沒有/);
});

test('記憶體金鑰儲存供離線頁使用', () => {
  const store = new MemorySecretStore();
  store.save({ version: 1, byPreset: { a: { apiKey: 'k' } } });
  assert.deepEqual(store.load(), { version: 1, byPreset: { a: { apiKey: 'k' } } });
});

test('生成常見誤用在本機修正：outcomes 重複自身產出、被需要卻漏列的歷史能力', async () => {
  const { normalizeGenerated } = await import('../src/generation');
  const effect = (key: string) => ({
    id: `e_${key}`,
    kind: 'capability' as const,
    key,
    name: key,
    active: true,
  });
  const cap = (id: string) => ({ kind: 'capability' as const, id, label: id });
  const node = (id: string, gives: string, needs: string[] = [], outcomes: string[] = []) => ({
    id,
    name: id,
    effects: [effect(gives)],
    requirements: needs.map(cap),
    sustain: [],
    outcomes: outcomes.map(cap),
  });
  const tree = normalizeGenerated({
    capabilities: [] as { id: string; name: string; active: boolean; reason: string }[],
    historical: [{ node: 'old' }, { node: 'ruin' }],
    nodes: [
      node('old', 'province', [], ['province']),
      node('ruin', 'bridge'),
      node('next', 'reform', ['province'], ['reform']),
      node('cycle', 'self', ['self']),
    ],
  });
  assert.deepEqual(
    tree.capabilities.map((c) => c.id),
    ['province'],
  );
  assert.deepEqual(tree.nodes.find((n) => n.id === 'next')!.outcomes, []);
  assert.deepEqual(tree.nodes.find((n) => n.id === 'next')!.requirements, [cap('province')]);
  assert.deepEqual(tree.nodes.find((n) => n.id === 'cycle')!.requirements, []);
});

test('驗證失敗的重試會把本機驗證原因回饋給模型，並顯示在任務狀態', async () => {
  class Retrying extends DemoPlatform {
    prompts: string[] = [];
    override async generate(messages: PromptMessage[]) {
      const data = messages.find((m) => m.role === 'user')!.content;
      this.prompts.push(data.slice(data.indexOf('{')));
      const day = (await this.read()).day;
      return {
        content: JSON.stringify({
          id: `p${this.prompts.length}`,
          until: this.prompts.length === 1 ? day + 50 : day,
          reason: 'r',
          steps: [],
        }),
      };
    }
  }
  const platform = new Retrying();
  const controller = new FocusController(platform);
  controller.config.jobs.update.retries = 1;
  await controller.run('update');
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  assert.equal(platform.prompts.length, 2);
  assert.equal(JSON.parse(platform.prompts[0]).correction, '');
  assert.match(JSON.parse(platform.prompts[1]).correction, /本機驗證：更新終點必須等於來源故事時間/);
  controller.dispose();
});

test('模型把前置寫成物件、平鋪陣列或 any 群組時在本機修正；不明的 API 錯誤附上常見原因', async () => {
  const { repairReply } = await import('../src/repair');
  const { explainOpaqueError } = await import('../src/tavern');
  const fixed = repairReply({
    id: 'c',
    nodes: [
      { id: 'a', prerequisites: [] },
      { id: 'b', prerequisites: [[{ id: 'a' }]], requirements: null },
      { id: 'd', prerequisites: ['a', 'b'], mutex: {} },
      { id: 'e', prerequisites: [{ any: [{ node: 'a' }, 'b'] }, 'd'] },
      { id: 'f' },
    ],
    edits: [{ country: 'c', nodes: [{ id: 'g', prerequisites: 'a' }] }],
  }) as { nodes: Record<string, unknown>[]; edits: { nodes: Record<string, unknown>[] }[] };
  assert.deepEqual(
    fixed.nodes.map((n) => n.prerequisites),
    [[], [['a']], [['a'], ['b']], [['a', 'b'], ['d']], []],
  );
  assert.deepEqual(fixed.nodes[1].requirements, []);
  assert.equal(fixed.nodes[2].mutex, null);
  assert.equal(fixed.nodes[4].mutex, null);
  assert.deepEqual(fixed.edits[0].nodes[0].prerequisites, [['a']]);
  assert.match(explainOpaqueError('Error: <none>'), /沒有提供原因/);
  assert.equal(explainOpaqueError('429 rate limited'), '429 rate limited');
});

test('刪除國策樹：移除國家與只涉及它的事件，共同事件保留給其他國家，國家回到候選清單', async () => {
  const { removeCountry } = await import('../src/engine');
  const platform = new DemoPlatform();
  const controller = new FocusController(platform);
  await controller.refresh();
  const state = controller.state!;
  const [first, second] = Object.keys(state.countries);
  const base = {
    at: state.day,
    title: '事件',
    description: '描述',
    evidence: '依據',
    origin: 'story' as const,
    public: true,
  };
  state.events.only = EventSchema.parse({ ...base, id: 'only', countries: [first], changes: [] });
  state.events.shared = EventSchema.parse({
    ...base,
    id: 'shared',
    countries: [first, second],
    changes: [
      { country: first, effects: [] },
      { country: second, effects: [] },
    ],
  });
  state.settings.observing = [first];
  const next = removeCountry(state, first);
  assert.equal(next.countries[first], undefined);
  assert.equal(next.events.only, undefined);
  assert.deepEqual(next.events.shared.countries, [second]);
  assert.deepEqual(
    next.events.shared.changes.map((c) => c.country),
    [second],
  );
  assert.deepEqual(next.settings.observing, []);
  assert.throws(() => removeCountry(next, first), /國家不存在/);

  const name = state.countries[first].name;
  await controller.removeCountry(first);
  assert.equal(controller.state!.countries[first], undefined);
  assert.ok(controller.candidates.some((c) => c.id === first && c.name === name));
  controller.dispose();
});
