import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TavernPlatform, type TavernApi } from '../src/tavern';
import { ConfigSchema, defaultConfig } from '../src/model';
import { demoState } from '../src/demo';
import { storyDay } from '../src/platform';
import { applyDeepSeek } from '../src/api-config';
import { parse } from 'yaml';

const prompt = [
  { role: 'system' as const, content: 'system' },
  { role: 'user' as const, content: 'prompt' },
];

test('模型清單使用指定端點與金鑰，去重排序且不觸發生成', async () => {
  const env = environment();
  let requests = 0;
  try {
    const api = { ...defaultConfig().apis[0], url: 'https://example.invalid/v1', apiKey: 'test-key' };
    env.api.getModelList = async (input) => {
      assert.deepEqual(input, { apiurl: api.url, key: 'test-key' });
      return ['z-model', '', 'a-model', 'z-model'];
    };
    env.api.generateRaw = async () => {
      requests++;
      return '{}';
    };
    assert.deepEqual(await env.platform.models(api), ['a-model', 'z-model']);
    assert.equal(requests, 0);
    env.api.getModelList = async () => {
      throw new Error('bad credential test-key');
    };
    await assert.rejects(env.platform.models(api), (error: Error) => !error.message.includes('test-key'));
  } finally {
    env.platform.dispose();
  }
});

test('進階連線透過酒館服務送出全部設定，保留取消信號且不改動 MVU', async () => {
  const env = environment();
  const request = new AbortController();
  try {
    const api = applyDeepSeek(
      {
        ...defaultConfig().apis[0],
        url: 'https://example.invalid/v1',
        model: 'deepseek-chat',
        apiKey: 'test-key',
        requestHeaders: 'X-Test: secret-header',
      },
      true,
      false,
    );
    const before = structuredClone(env.getData());
    env.api.generateRaw = async () => {
      assert.fail('不得回退丟失進階設定');
    };
    env.api.SillyTavern.getContext = () => ({
      ChatCompletionService: {
        async processRequest(data, options, extract, signal) {
          assert.deepEqual(options, {});
          assert.equal(extract, true);
          assert.equal(signal, request.signal);
          assert.equal(data.temperature, 0.85);
          assert.equal(data.custom_prompt_post_processing, 'strict');
          assert.deepEqual(parse(String(data.custom_include_headers)), {
            'X-Test': 'secret-header',
            Authorization: 'Bearer test-key',
          });
          assert.deepEqual(parse(String(data.custom_include_body)), {
            thinking: { type: 'disabled' },
            response_format: { type: 'json_object' },
          });
          return { content: '{"ok":true}', reasoning: 'not JSON output' };
        },
      },
    });
    assert.deepEqual(await env.platform.generate(prompt, api, api.apiKey, request.signal), {
      content: '{"ok":true}',
      reasoning: 'not JSON output',
    });
    assert.deepEqual(env.getData(), before);
    request.abort();
    await assert.rejects(env.platform.generate(prompt, api, api.apiKey, request.signal), /abort/i);
    delete env.api.SillyTavern.getContext;
    await assert.rejects(
      env.platform.generate(prompt, api, api.apiKey, new AbortController().signal),
      /ChatCompletionService/,
    );
  } finally {
    env.platform.dispose();
  }
});

test('API 預設與金鑰保存可重載，且完全不寫入樓層變量', () => {
  const env = environment();
  try {
    const before = structuredClone(env.getData());
    const config = defaultConfig();
    Object.assign(config.apis[0], { apiKey: 'persisted-test-key', temperature: 0.85 });
    config.apiBindings['chat-a'] = config.apis[0].name;
    env.platform.saveConfig(config);
    assert.deepEqual(env.platform.loadConfig(), config);
    assert.deepEqual(env.getData(), before);
  } finally {
    env.platform.dispose();
  }
});

test('從世界時間讀取復興紀元格式並保存最外層國策，保留原時間文字', async () => {
  const env = environment();
  try {
    const time = '复兴纪元490年-10月-15日-星期三-14:25';
    env.getData().stat_data.世界.时间 = time;
    const snapshot = await env.platform.read(defaultConfig());
    assert.equal(snapshot.day, storyDay('490-10-15 14:25'));
    await env.platform.commit(snapshot, snapshot.state);
    assert.equal(env.getData().国策.day, snapshot.day);
    assert.equal(env.getData().stat_data.世界.时间, time);
  } finally {
    env.platform.dispose();
  }
});

test('預設六萬輸出 Token 會送給目前酒館連線，且不覆寫來源與模型', async () => {
  const env = environment();
  let sent: Record<string, any> | undefined;
  env.api.generateRaw = async (config) => {
    sent = config;
    return '{}';
  };
  try {
    const config = defaultConfig();
    assert.equal(config.apis[0].maxTokens, 60000);
    await env.platform.generate(prompt, config.apis[0], '', new AbortController().signal);
    assert.equal(sent?.custom_api.max_tokens, 60000);
    assert.equal(sent?.custom_api.source, undefined);
    assert.equal(sent?.custom_api.model, undefined);
    assert.equal(sent?.custom_api.temperature, 0.85);
    assert.equal(sent?.should_stream, false);
    assert.equal(sent?.max_chat_history, 0);
    assert.deepEqual(sent?.overrides.chat_history, { with_depth_entries: false, prompts: [] });
    assert.equal(sent?.overrides.world_info_before, '');
    assert.equal(sent?.overrides.world_info_after, '');
    assert.deepEqual(sent?.ordered_prompts, [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'prompt' },
    ]);
  } finally {
    env.platform.dispose();
  }
});

test('自訂 API 送出設定的輸出上限，既有手動設定不因預設改動而被覆蓋', async () => {
  const env = environment();
  let sent: Record<string, any> | undefined;
  env.api.generateRaw = async (config) => {
    sent = config;
    return '{}';
  };
  try {
    const config = defaultConfig();
    Object.assign(config.apis[0], { url: 'https://example.invalid/v1', model: 'example', maxTokens: 32000 });
    env.platform.saveConfig(config);
    const api = env.platform.loadConfig().apis[0];
    assert.equal(api.maxTokens, 32000);
    await env.platform.generate(prompt, api, 'test-secret', new AbortController().signal);
    assert.equal(sent?.custom_api.max_tokens, 32000);
    assert.equal(sent?.custom_api.source, 'openai');
    assert.equal(sent?.custom_api.model, 'example');
    assert.ok(!JSON.stringify(sent?.ordered_prompts).includes('test-secret'));
  } finally {
    env.platform.dispose();
  }
});

test('來源只讀角色或明確手選世界書，預覽使用傳入草稿且手選空白不回退', async () => {
  const env = environment();
  const loaded: string[] = [];
  try {
    env.api.getGlobalWorldbookNames = () => {
      throw new Error('不可自動讀取全域世界書');
    };
    env.api.getCharWorldbookNames = () => ({ primary: '角色書', additional: ['附加書', '角色書'] });
    env.api.getWorldbookNames = () => ['角色書', '附加書', '手選書', '全域書'];
    env.api.getWorldbook = async (book) => {
      loaded.push(book);
      return [
        { uid: 1, name: '地理', enabled: true, content: book, strategy: { type: 'constant', keys: [] } },
      ];
    };
    const config = defaultConfig();
    config.sources.memoryRecallRecentCount = 0;
    await env.platform.read(config);
    assert.deepEqual(loaded, []);
    const character = await env.platform.read(config, 'identify');
    assert.deepEqual(loaded, ['角色書', '附加書']);
    assert.match(JSON.stringify(character.context), /角色書/);
    assert.doesNotMatch(JSON.stringify(character.context), /全域書/);
    loaded.length = 0;
    config.sources.worldbook = { source: 'manual', manualSelection: [], enabledEntries: {} };
    const empty = await env.platform.read(config, 'identify');
    assert.deepEqual(loaded, []);
    assert.equal((empty.context as { worldbook: string }).worldbook, '');
    config.sources.worldbook.manualSelection = ['手選書'];
    const manual = await env.platform.read(config, 'identify');
    assert.deepEqual(loaded, ['手選書']);
    assert.match(JSON.stringify(manual.context), /手選書/);
    assert.equal(env.platform.loadConfig().sources.worldbook.source, 'character');
    assert.ok(manual.sourceReport);
    assert.equal(manual.sourceReport.characters, JSON.stringify(manual.context).length);
  } finally {
    env.platform.dispose();
  }
});

test('只渲染已選且觸發的世界書巨集，來源報告計算展開後內容', async () => {
  const env = environment();
  const rendered: string[] = [];
  try {
    env.api.getCharWorldbookNames = () => ({ primary: '角色書', additional: [] });
    env.api.getWorldbook = async () => [
      { uid: 1, name: '地理', enabled: true, content: '{{land}}', strategy: { type: 'constant', keys: [] } },
      {
        uid: 2,
        name: '無關',
        enabled: true,
        content: '{{huge}}',
        strategy: { type: 'selective', keys: ['未出現的關鍵字'] },
      },
    ];
    env.api.substitudeMacros = (text) => {
      rendered.push(text);
      return text.replace('{{land}}', '帝國位於大陸中央');
    };
    const config = defaultConfig();
    config.sources.memoryRecallRecentCount = 0;
    const snapshot = await env.platform.read(config, 'generate');
    assert.match(JSON.stringify(snapshot.context), /帝國位於大陸中央/);
    assert.ok(!rendered.includes('{{huge}}'));
    assert.equal(snapshot.sourceReport?.entries[0].characters, '帝國位於大陸中央'.length);
    assert.equal(snapshot.sourceReport?.characters, JSON.stringify(snapshot.context).length);
  } finally {
    env.platform.dispose();
  }
});

function environment() {
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  let data: any = {
    stat_data: { 世界: { 时间: 100 }, 角色: { 金幣: 50 } },
    schema: {
      type: 'object',
      properties: { 世界: { type: 'object', extensible: false } },
      extensible: false,
    },
    initialized_lorebooks: { world: ['initial'] },
  };
  let id = 'chat-a';
  let messageId = 3;
  let swipe = 0;
  let text = '正文';
  const storage = new Map<string, string>();
  const api: TavernApi = {
    Mvu: {
      events: {
        VARIABLE_UPDATE_STARTED: 'mvu-start',
        VARIABLE_UPDATE_ENDED: 'mvu-end',
        BEFORE_MESSAGE_UPDATE: 'mvu-write',
      },
      isDuringExtraAnalysis: () => false,
      getMvuData: () => structuredClone(data),
      replaceMvuData: async (next) => {
        data = structuredClone(next);
      },
    },
    SillyTavern: { getCurrentChatId: () => id },
    getLastMessageId: () => messageId,
    getChatMessages: () => [
      {
        message_id: messageId,
        role: 'assistant',
        swipe_id: swipe,
        swipes: [text, '另一正文'],
        message: text,
      },
    ],
    eventOn: (event, callback) => {
      listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      return { stop() {} };
    },
    tavern_events: {
      GENERATION_STARTED: 'generation-start',
      GENERATION_ENDED: 'generation-end',
      MESSAGE_RECEIVED: 'received',
      CHAT_CHANGED: 'chat',
      MESSAGE_SWIPED: 'swipe',
      MESSAGE_DELETED: 'deleted',
      MESSAGE_EDITED: 'edited',
    },
    generateRaw: async () => '{}',
    stopGenerationById: () => true,
    getGlobalWorldbookNames: () => [],
    getCharWorldbookNames: () => ({ primary: null, additional: [] }),
    getWorldbook: async () => [],
    injectPrompts: () => ({ uninject() {} }),
    uninjectPrompts() {},
    setChatMessages: async ([message]) => {
      text = message.message ?? text;
    },
  };
  const localStorage: Storage = {
    get length() {
      return storage.size;
    },
    getItem: (k) => storage.get(k) ?? null,
    setItem: (k, v) => {
      storage.set(k, v);
    },
    removeItem: (k) => {
      storage.delete(k);
    },
    clear: () => storage.clear(),
    key: (index) => [...storage.keys()][index] ?? null,
  };
  const platform = new TavernPlatform(api, localStorage);
  return {
    platform,
    api,
    getData: () => data,
    changeExternal: () => {
      data.stat_data.角色.金幣 = 70;
    },
    edit: () => {
      text = '編輯後的正文';
    },
    text: () => text,
    next: () => {
      messageId++;
    },
    swipe: () => {
      swipe++;
    },
    chat: () => {
      id = 'chat-b';
    },
    emit: (event: string, ...args: any[]) => {
      for (const callback of listeners.get(event) ?? []) {
        callback(...args);
      }
    },
  };
}
test('國策保存完成才通知報紙，保存失敗不通知', async () => {
  const env = environment();
  const notifications: unknown[][] = [];
  env.api.eventEmit = (event, ...args) => {
    notifications.push([event, ...args]);
  };
  try {
    const snapshot = await env.platform.read(defaultConfig());
    const replace = env.api.Mvu!.replaceMvuData;
    let finish!: () => void;
    const saved = new Promise<void>((resolve) => {
      finish = resolve;
    });
    env.api.Mvu!.replaceMvuData = async (data, options) => {
      await saved;
      await replace(data, options);
    };
    const committing = env.platform.commit(snapshot, snapshot.state);
    assert.equal(notifications.length, 0);
    finish();
    await committing;
    assert.deepEqual(notifications, [['national-focus:news-saved', 3]]);
    env.api.Mvu!.replaceMvuData = async () => {
      throw new Error('存檔失敗');
    };
    await assert.rejects(env.platform.commit(snapshot, snapshot.state), /存檔失敗/);
    assert.equal(notifications.length, 1);
  } finally {
    env.platform.dispose();
  }
});

test('國策寫入樓層最外層，保留完整 stat_data、初始化資料與既有 schema', async () => {
  const env = environment();
  try {
    const before = structuredClone(env.getData());
    const snapshot = await env.platform.read(defaultConfig());
    await env.platform.commit(snapshot, snapshot.state);
    assert.deepEqual(env.getData().stat_data, before.stat_data);
    assert.deepEqual(env.getData().initialized_lorebooks, { world: ['initial'] });
    assert.deepEqual(env.getData().schema, before.schema);
    assert.equal(env.getData().国策.version, 1);
    const { prompt, ...stored } = env.getData().国策;
    assert.deepEqual((await env.platform.read(defaultConfig())).state, stored);
    assert.deepEqual(prompt, { overview: '', countries: {} });
  } finally {
    env.platform.dispose();
  }
});
for (const change of ['generation-start', 'swipe', 'chat', 'deleted'] as const) {
  test(`生命週期事件 ${change} 取消舊任務，遲到結果不回寫`, async () => {
    const env = environment();
    try {
      const snapshot = await env.platform.read(defaultConfig());
      env.emit(change);
      await assert.rejects(env.platform.commit(snapshot, snapshot.state), /abort/i);
      assert.equal(env.getData().国策, undefined);
      assert.equal(env.getData().stat_data.国策, undefined);
    } finally {
      env.platform.dispose();
    }
  });
}

test('舊版完整樹與進度可讀取，成功保存才移到最外層且不改寫其他變量', async () => {
  const env = environment();
  try {
    const legacy = demoState();
    env.getData().stat_data.国策 = legacy;
    env.getData().schema = '沒有用別管這個';
    env.getData()._post_process_inject_var_baseline = { original: true };
    const before = structuredClone(env.getData());
    const snapshot = await env.platform.read(defaultConfig());
    assert.deepEqual(snapshot.state, legacy);
    assert.deepEqual(env.getData(), before);
    await env.platform.commit(snapshot, snapshot.state);
    const { basis, prompt: _prompt, ...saved } = env.getData().国策;
    assert.deepEqual(saved, legacy);
    assert.equal(basis, undefined);
    delete before.stat_data.国策;
    const { 国策, ...remaining } = env.getData();
    assert.deepEqual(remaining, before);
  } finally {
    env.platform.dispose();
  }
});

test('兩位置同時有資料時以最外層為準，無效最外層資料明確報錯', async () => {
  const env = environment();
  try {
    const root = demoState();
    env.getData().国策 = root;
    env.getData().stat_data.国策 = { ...root, day: 90 };
    const snapshot = await env.platform.read(defaultConfig());
    assert.deepEqual(snapshot.state, root);
    await env.platform.commit(snapshot, snapshot.state);
    assert.equal(env.getData().stat_data.国策, undefined);
    env.getData().国策 = null;
    await assert.rejects(env.platform.read(defaultConfig()));
  } finally {
    env.platform.dispose();
  }
});

test('保存不比較國策或世界變量指紋，保留其他變量的最新值', async () => {
  const env = environment();
  try {
    env.getData().国策 = demoState();
    const snapshot = await env.platform.read(defaultConfig());
    env.getData().国策.day++;
    env.changeExternal();
    env.edit();
    await env.platform.commit(snapshot, snapshot.state);
    assert.equal(env.getData().国策.day, snapshot.state.day);
    assert.equal(env.getData().stat_data.角色.金幣, 70);
  } finally {
    env.platform.dispose();
  }
});

for (const legacy of [false, true]) {
  test(`一般 MVU 更新保留${legacy ? '舊版' : '最外層'}國策且允許世界變量更新`, () => {
    const env = environment();
    try {
      const state = demoState();
      const before = structuredClone(env.getData());
      if (legacy) {
        before.stat_data.国策 = state;
      } else {
        before.国策 = state;
      }
      const after = structuredClone(env.getData());
      after.stat_data.世界.时间 = 120;
      after.stat_data.国策 = { unwanted: true };
      after.国策 = { unwanted: true };
      const schema = structuredClone(after.schema);
      env.emit('mvu-end', after, before);
      assert.deepEqual(after.国策, state);
      assert.notEqual(after.国策, state);
      assert.equal(after.stat_data.国策, undefined);
      assert.equal(after.stat_data.世界.时间, 120);
      assert.deepEqual(after.schema, schema);
    } finally {
      env.platform.dispose();
    }
  });
}
test('收到正文而一般 MVU 尚未寫入時，不啟動背景任務；兩者完成後只觸發一次', async () => {
  const env = environment();
  let count = 0;
  env.platform.onReady(() => {
    count++;
  });
  try {
    env.emit('generation-start');
    env.emit('received');
    env.emit('generation-end');
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(count, 0);
    await assert.rejects(env.platform.read(defaultConfig()), /等待本樓/);
    env.emit('mvu-write', { message_content: '正文' });
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(count, 1);
    env.emit('received');
    env.emit('generation-end');
    env.emit('mvu-write', { message_content: env.text() });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(count, 1, '同樓層重複完成事件不得重新啟動');
    await env.platform.read(defaultConfig());
  } finally {
    env.platform.dispose();
  }
});
test('新正文一開始就取消舊任務，即使新樓尚未插入', async () => {
  const env = environment();
  try {
    const snapshot = await env.platform.read(defaultConfig());
    env.emit('generation-start');
    await assert.rejects(env.platform.commit(snapshot, snapshot.state), /abort/i);
  } finally {
    env.platform.dispose();
  }
});

test('舊存檔的正文依據不再驗證，編輯後可繼續讀取', async () => {
  const env = environment();
  try {
    const snapshot = await env.platform.read(defaultConfig());
    await env.platform.commit(snapshot, snapshot.state);
    env.getData().国策.basis = { messageId: 3, hash: 'legacy-hash' };
    env.edit();
    env.emit('edited');
    const current = await env.platform.read(defaultConfig());
    assert.deepEqual(current.state, snapshot.state);
    await env.platform.commit(current, current.state);
    assert.equal(env.getData().国策.basis, undefined);
  } finally {
    env.platform.dispose();
  }
});

test('同次來源讀取共用一份聊天記錄，提交不讀取或雜湊歷史正文', async () => {
  const env = environment();
  const messages = [
    { message_id: 0, role: 'user', message: '起點', swipe_id: 0, swipes: ['起點'] },
    { message_id: 1, role: 'assistant', message: '第一樓', swipe_id: 0, swipes: ['第一樓'] },
    { message_id: 2, role: 'user', message: '繼續', swipe_id: 0, swipes: ['繼續'] },
    { message_id: 3, role: 'assistant', message: '第二樓', swipe_id: 0, swipes: ['第二樓'] },
  ];
  const ranges: (string | number)[] = [];
  env.api.getChatMessages = (range) => {
    if (range === -1) {
      return structuredClone(messages.slice(-1));
    }
    ranges.push(range);
    if (typeof range === 'number') {
      return structuredClone(messages.filter((message) => message.message_id === range));
    }
    const end = Number(String(range).split('-').at(-1));
    return structuredClone(messages.filter((message) => message.message_id <= end));
  };
  try {
    const config = defaultConfig();
    const first = await env.platform.read(config);
    await env.platform.commit(first, first.state);
    ranges.length = 0;
    const saved = await env.platform.read(config, 'update');
    assert.deepEqual(ranges, ['0-3']);
    assert.equal(saved.turn, 2);
    assert.equal(Object.hasOwn(saved, 'historyHash'), false);
    assert.match(JSON.stringify(saved.context), /第二樓/);

    // A later floor can continue even when older story text was edited.
    env.next();
    env.next();
    messages.push(
      { message_id: 4, role: 'user', message: '再繼續', swipe_id: 0, swipes: ['再繼續'] },
      { message_id: 5, role: 'assistant', message: '第三樓', swipe_id: 0, swipes: ['第三樓'] },
    );
    ranges.length = 0;
    const next = await env.platform.read(config, 'update');
    assert.deepEqual(ranges, ['0-5']);
    assert.equal(next.turn, 3);
    ranges.length = 0;
    messages[1].message = '舊樓已被靜默編輯';
    await env.platform.commit(next, next.state);
    assert.ok(!ranges.some((range) => typeof range === 'string' && range.startsWith('0-')));
    await env.platform.read(config, 'update');
  } finally {
    env.platform.dispose();
  }
});

test('quiet 背景生成不會被當成新的正文或封鎖手動讀取', async () => {
  const env = environment();
  try {
    env.emit('generation-start', 'quiet', {}, false);
    env.emit('received', 3, 'quiet');
    env.emit('generation-end', 3);
    const snapshot = await env.platform.read(defaultConfig());
    assert.equal(snapshot.day, 100);
  } finally {
    env.platform.dispose();
  }
});

test('提交新新聞時標記所在樓層並在正文末尾加標籤；標籤不算正文編輯，也不重複加入', async () => {
  const { EventSchema } = await import('../src/model');
  const env = environment();
  try {
    const snapshot = await env.platform.read(defaultConfig());
    const state = structuredClone(snapshot.state);
    state.events.news = EventSchema.parse({
      id: 'news',
      at: state.day,
      countries: ['x'],
      title: '邊境集結',
      description: '兩國軍隊在邊境集結。',
      evidence: '正文',
      origin: 'story',
      public: true,
      changes: [],
      importance: 'major',
    });
    await env.platform.commit(snapshot, state);
    assert.equal(env.getData().国策.events.news.shownAt, 3);
    assert.equal(env.text(), '正文\n\n<国策快讯/>');
    const again = await env.platform.read(defaultConfig());
    assert.equal(Object.hasOwn(again.state, 'basis'), false);
    await env.platform.commit(again, again.state);
    assert.equal(env.text(), '正文\n\n<国策快讯/>');
    let injected = '';
    env.api.injectPrompts = (prompts) => {
      injected = String(prompts[0].content);
      return { uninject() {} };
    };
    env.api.uninjectPrompts = () => {
      injected = '';
    };
    env.platform.inject(again.state);
    assert.match(injected, /【近期國際大事】[\s\S]*邊境集結/);
    env.platform.inject(again.state, false);
    assert.doesNotMatch(injected, /近期國際大事/);
    const floor = await env.platform.readNews(3);
    assert.deepEqual(
      floor?.events.map((event) => event.id),
      ['news'],
    );
    const opened: number[] = [];
    const stop = env.platform.onNewsRequest((id) => opened.push(id));
    env.emit('national-focus:open-news', 3);
    env.emit('national-focus:open-news', 'bad');
    stop();
    assert.deepEqual(opened, [3]);
  } finally {
    env.platform.dispose();
  }
});

test('有提示詞模板擴展時，國策以角色主世界書條目讀取樓層變量；舊樓層與注入模式改用注入', async () => {
  const env = environment();
  let book: any[] = [];
  let created = 0;
  let writes = 0;
  let injected = '';
  Object.assign(env.api, {
    EjsTemplate: {},
    getChatWorldbookName: () => 'unused-chat-book',
    getCharWorldbookNames: () => ({ primary: 'chat-book', additional: [] }),
    getOrCreateChatWorldbook: async () => {
      created++;
      return 'chat-book';
    },
    getWorldbook: async () => structuredClone(book),
    updateWorldbookWith: async (_name: string, updater: (entries: any[]) => any[]) => {
      writes++;
      book = updater(structuredClone(book));
    },
    injectPrompts: (prompts: { content: string }[]) => {
      injected = prompts[0].content;
      return { uninject() {} };
    },
    uninjectPrompts: () => {
      injected = '';
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  try {
    // No countries yet: no chat worldbook is created.
    const empty = await env.platform.read(defaultConfig());
    env.platform.inject(empty.state);
    await settle();
    assert.equal(created, 0);
    // A floor saved before v0.12.6 has no 国策.prompt: inject now, and prepare the entries.
    const state = { ...demoState(), day: empty.state.day };
    env.getData().国策 = state;
    const old = await env.platform.read(defaultConfig());
    env.platform.inject(old.state);
    await settle();
    assert.match(injected, /各國動向[\s\S]*<國策動態>/);
    assert.ok(book.some((entry) => entry.name === '國策檔案-世界概況'));
    assert.ok(book.some((entry) => entry.name.startsWith('國策檔案-國家-')));
    // After a save the floor carries its own view: the entries render it and nothing is injected.
    await env.platform.commit(old, old.state);
    assert.match(env.getData().国策.prompt.overview, /各國動向/);
    const saved = await env.platform.read(defaultConfig());
    const before = writes;
    env.platform.inject(saved.state);
    await settle();
    assert.equal(injected, '');
    assert.equal(writes, before, 'unchanged entries are not rewritten');
    // Injection mode removes this script's entries and injects instead.
    const config = { ...defaultConfig(), promptMode: 'inject' as const };
    const again = await env.platform.read(config);
    env.platform.inject(again.state);
    await settle();
    assert.match(injected, /各國動向/);
    assert.ok(!book.some((entry) => entry.name.startsWith('國策檔案-')));
  } finally {
    env.platform.dispose();
  }
});

function bookEnvironment() {
  const env = environment();
  const books = new Map<string, any[]>([
    ['book-chat-a', []],
    ['book-chat-b', []],
  ]);
  const state = { failNext: 0, warnings: [] as string[], injected: '', gate: null as Promise<void> | null };
  let chat = () => env.api.SillyTavern.getCurrentChatId();
  Object.assign(env.api, {
    EjsTemplate: {},
    getChatWorldbookName: () => 'separate-chat-book',
    getCharWorldbookNames: () => ({
      primary: books.has(`book-${chat()}`) ? `book-${chat()}` : null,
      additional: [],
    }),
    getOrCreateChatWorldbook: async () => {
      const name = `book-${chat()}`;
      if (!books.has(name)) {
        books.set(name, []);
      }
      return name;
    },
    getWorldbook: async (name: string) => {
      await state.gate;
      return structuredClone(books.get(name) ?? []);
    },
    updateWorldbookWith: async (name: string, updater: (entries: any[]) => any[]) => {
      if (state.failNext > 0) {
        state.failNext--;
        throw new Error('寫入失敗');
      }
      books.set(name, updater(structuredClone(books.get(name) ?? [])));
    },
    injectPrompts: (prompts: { content: string }[]) => {
      state.injected = prompts[0].content;
      return { uninject() {} };
    },
    uninjectPrompts: () => {
      state.injected = '';
    },
    toastr: { warning: (message: string) => state.warnings.push(message) },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const countries = (name: string) =>
    (books.get(name) ?? []).filter((e) => e.name.startsWith('國策檔案-國家-')).map((e) => e.name);
  return { env, books, state, settle, countries };
}

test('無角色主世界書時不使用聊天、附加或全域書；設定主書後寫入並清理本次追蹤的前一目標', async () => {
  const { env, books, state, settle } = bookEnvironment();
  let creations = 0;
  let primary: string | null = null;
  const unrelated = { name: '原有設定', content: '保留', strategy: { type: 'constant', keys: [] } };
  books.set('chat-only', [unrelated]);
  books.set('additional-only', [unrelated]);
  Object.assign(env.api, {
    getCharWorldbookNames: () => ({ primary, additional: ['additional-only'] }),
    getChatWorldbookName: () => 'chat-only',
    getGlobalWorldbookNames: () => ['chat-only'],
    getOrCreateChatWorldbook: async () => {
      creations++;
      return 'unexpected';
    },
  });
  try {
    const empty = await env.platform.read(defaultConfig());
    env.getData().国策 = { ...demoState(), day: empty.day };
    const initial = await env.platform.read(defaultConfig());
    await env.platform.commit(initial, initial.state);
    env.platform.inject((await env.platform.read(defaultConfig())).state);
    await settle();
    assert.equal(creations, 0);
    assert.match(state.injected, /各國動向/);
    assert.match(state.warnings[0], /當前角色尚未設定主世界書/);
    assert.deepEqual(books.get('chat-only'), [unrelated]);
    assert.deepEqual(books.get('additional-only'), [unrelated]);
    books.set('primary-a', [unrelated]);
    books.set('primary-b', []);
    primary = 'primary-a';
    env.platform.inject((await env.platform.read(defaultConfig())).state);
    await settle();
    assert.equal(state.injected, '');
    assert.ok(books.get('primary-a')!.some((e) => e.name === '國策檔案-世界概況'));
    primary = 'primary-b';
    env.platform.inject((await env.platform.read(defaultConfig())).state);
    await settle();
    assert.deepEqual(books.get('primary-a'), [unrelated]);
    assert.ok(books.get('primary-b')!.some((e) => e.name === '國策檔案-世界概況'));
    assert.equal(creations, 0);
  } finally {
    env.platform.dispose();
  }
});

test('舊手動世界書設定被忽略，只寫角色主書且保留其他書', async () => {
  const { env, books, state, settle } = bookEnvironment();
  try {
    books.set('old-manual', []);
    const config = ConfigSchema.parse({ ...defaultConfig(), promptBookName: 'old-manual' });
    assert.equal(Object.hasOwn(config, 'promptBookName'), false);
    const empty = await env.platform.read(config);
    env.getData().国策 = { ...demoState(), day: empty.day };
    const initial = await env.platform.read(config);
    await env.platform.commit(initial, initial.state);
    env.platform.inject((await env.platform.read(config)).state);
    await settle();
    assert.ok(books.get('book-chat-a')!.some((e) => e.name === '國策檔案-世界概況'));
    assert.deepEqual(books.get('old-manual'), []);
    assert.equal(state.injected, '');
    assert.equal(state.warnings.length, 0);
  } finally {
    env.platform.dispose();
  }
});

test('角色主世界書同步失敗時保留直接注入並提示一次；之後成功才交給條目，不重複送出', async () => {
  const { env, books, state, settle } = bookEnvironment();
  try {
    const empty = await env.platform.read(defaultConfig());
    env.getData().国策 = { ...demoState(), day: empty.state.day };
    const old = await env.platform.read(defaultConfig());
    await env.platform.commit(old, old.state);
    const saved = await env.platform.read(defaultConfig());
    books.set('book-chat-a', []);
    state.failNext = 2;
    env.platform.inject(saved.state);
    await settle();
    assert.match(state.injected, /各國動向/, 'the story still gets the data');
    assert.equal(state.warnings.length, 1);
    env.platform.inject(saved.state);
    await settle();
    assert.match(state.injected, /各國動向/);
    assert.equal(state.warnings.length, 1, 'one warning per failure streak');
    env.platform.inject(saved.state);
    await settle();
    assert.equal(state.injected, '', 'handed over to the worldbook after a successful sync');
    assert.ok(books.get('book-chat-a')!.some((e) => e.name === '國策檔案-世界概況'));
  } finally {
    env.platform.dispose();
  }
});

test('世界書工作綁定來源聊天與樓層：切換聊天或排入較新的工作後，舊工作不寫入', async () => {
  const { env, books, state, settle, countries } = bookEnvironment();
  try {
    const empty = await env.platform.read(defaultConfig());
    env.getData().国策 = { ...demoState(), day: empty.state.day };
    const a = await env.platform.read(defaultConfig());
    // Switch before the job starts.
    env.platform.inject(a.state);
    env.chat();
    env.emit('chat');
    await settle();
    assert.deepEqual(books.get('book-chat-b'), []);
    // Switch while the job waits on the worldbook read: nothing is written to either chat.
    books.set('book-chat-a', []);
    books.set('book-chat-b', []);
    let open!: () => void;
    state.gate = new Promise((resolve) => (open = resolve));
    env.platform.inject(a.state);
    await settle();
    env.emit('chat');
    open();
    await settle();
    assert.deepEqual(countries('book-chat-b'), []);
    state.gate = null;
    // Same chat: only the newest of two queued jobs writes.
    const fewer = structuredClone(a.state);
    delete fewer.countries[Object.keys(fewer.countries)[0]];
    env.platform.inject(a.state);
    env.platform.inject(fewer);
    await settle();
    assert.deepEqual(
      countries('book-chat-b'),
      Object.keys(fewer.countries).map((id) => `國策檔案-國家-${id}`),
    );
  } finally {
    env.platform.dispose();
  }
});

test('每個完成的 AI 樓層在背景任務之前寫入快訊條資料：新聞更新時間逐樓承接、所在國家算內部，並加上標籤', async () => {
  const { createState, installCountry } = await import('../src/engine');
  const env = environment();
  let state = installCountry(
    createState(0),
    {
      id: 'augustium',
      name: '奧古斯提姆帝國',
      description: '帝國',
      stability: 50,
      warSupport: 50,
      evidence: '測試',
      capabilities: [],
      historical: [],
      nodes: [
        {
          id: 'a',
          name: '國策',
          branch: '主線',
          description: '內容',
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
        },
      ],
    },
    0,
  );
  state.countries.augustium.control = 'ai';
  const floors: Record<number, any> = {
    1: {
      stat_data: {
        世界: { 时间: '491年6月18日', 地点: '西大陆-某处' },
        新闻: { 快讯: { 军事: '旧', 经济: '旧' } },
      },
      国策: { ...state, 快讯: { updated: { '快讯/军事': '491年6月18日', '快讯/经济': '491年6月1日' } } },
    },
    3: {
      stat_data: {
        世界: { 时间: '491年6月20日 10:12', 地点: '西大陆-中部-奥古斯提姆帝国-艾瑟嘉德' },
        新闻: { 快讯: { 军事: '新', 经济: '旧' } },
      },
      国策: structuredClone(state),
    },
  };
  env.api.Mvu!.getMvuData = ({ message_id }) => structuredClone(floors[message_id]);
  env.api.Mvu!.replaceMvuData = async (next, { message_id }) => {
    floors[message_id] = structuredClone(next);
  };
  const current = env.api.getChatMessages;
  env.api.getChatMessages = (range, options) =>
    range === 1
      ? [{ message_id: 1, role: 'assistant', swipe_id: 0, swipes: ['上一樓'], message: '上一樓' }]
      : typeof range === 'number'
        ? current(range, options)
        : [
            { message_id: 1, role: 'assistant', swipe_id: 0, swipes: ['上一樓'], message: '上一樓' },
            ...current(-1),
          ];
  let seen: unknown;
  env.platform.onReady(() => {
    seen = structuredClone(floors[3].国策.快讯);
  });
  try {
    env.emit('generation-start');
    env.emit('received');
    env.emit('generation-end');
    env.emit('mvu-write', { message_content: '正文' });
    await new Promise((resolve) => setTimeout(resolve, 450));
    const bar = floors[3].国策.快讯;
    assert.deepEqual(seen, bar);
    assert.deepEqual(bar.changed, ['快讯/军事']);
    assert.deepEqual(bar.updated, { '快讯/军事': '491年6月20日 10:12', '快讯/经济': '491年6月1日' });
    assert.deepEqual(bar.insiders, ['augustium']);
    assert.equal(bar.time, '491年6月20日 10:12');
    assert.equal(env.text(), '正文\n\n<国策快讯/>');
    // The card's own news is only read.
    assert.deepEqual(floors[3].stat_data.新闻, { 快讯: { 军事: '新', 经济: '旧' } });
    // A later commit keeps the bar and follows the new state for who the player may hear from.
    const snapshot = await env.platform.read(defaultConfig());
    const next = structuredClone(snapshot.state);
    next.countries.augustium.control = 'player';
    await env.platform.commit(snapshot, next);
    assert.deepEqual(floors[3].国策.快讯.changed, ['快讯/军事']);
    assert.deepEqual(floors[3].国策.快讯.insiders, ['augustium']);
    const previousFloor = structuredClone(floors[1]);
    const policy = structuredClone(floors[3].国策.countries);
    let extraReady = 0;
    env.platform.onReady(() => {
      extraReady++;
    });
    floors[3].stat_data.新闻.快讯.经济 = '本樓稍後更新';
    floors[3].stat_data.世界.时间 = '491年6月20日 12:00';
    const notifications: unknown[][] = [];
    env.api.eventEmit = (event, ...args) => {
      notifications.push([event, ...args]);
      assert.equal(floors[3].国策.快讯.time, '491年6月20日 12:00');
    };
    env.emit('national-focus:refresh-news', 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(floors[3].国策.快讯.changed, ['快讯/军事', '快讯/经济']);
    assert.equal(floors[3].国策.快讯.updated['快讯/经济'], '491年6月20日 12:00');
    assert.equal(floors[3].国策.快讯.timePath, '世界.时间');
    assert.deepEqual(floors[3].国策.countries, policy);
    assert.deepEqual(floors[1], previousFloor);
    assert.equal(extraReady, 0, '刷新報紙不得重新啟動國策工作');
    assert.deepEqual(notifications, [['national-focus:news-saved', 3]]);
  } finally {
    env.platform.dispose();
  }
});

test('沒有國策資料的樓層不寫快訊條，也不加標籤', async () => {
  const env = environment();
  try {
    env.emit('generation-start');
    env.emit('received');
    env.emit('generation-end');
    env.emit('mvu-write', { message_content: '正文' });
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(env.getData().国策, undefined);
    assert.equal(env.text(), '正文');
  } finally {
    env.platform.dispose();
  }
});
