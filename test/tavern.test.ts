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

test('模型清单使用指定端点与金钥，去重排序且不触发生成', async () => {
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

test('进阶连线透过酒馆服务送出全部设定，保留取消信号且不改动 MVU', async () => {
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
      assert.fail('不得回退丢失进阶设定');
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

test('API 预设与金钥保存可重载，且完全不写入楼层变量', () => {
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

test('从世界时间读取复兴纪元格式并保存最外层国策，保留原时间文字', async () => {
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

test('预设六万输出 Token 会送给目前酒馆连线，且不覆写来源与模型', async () => {
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

test('自订 API 送出设定的输出上限，既有手动设定不因预设改动而被覆盖', async () => {
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

test('来源只读角色或明确手选世界书，预览使用传入草稿且手选空白不回退', async () => {
  const env = environment();
  const loaded: string[] = [];
  try {
    env.api.getGlobalWorldbookNames = () => {
      throw new Error('不可自动读取全域世界书');
    };
    env.api.getCharWorldbookNames = () => ({ primary: '角色书', additional: ['附加书', '角色书'] });
    env.api.getWorldbookNames = () => ['角色书', '附加书', '手选书', '全域书'];
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
    assert.deepEqual(loaded, ['角色书', '附加书']);
    assert.match(JSON.stringify(character.context), /角色书/);
    assert.doesNotMatch(JSON.stringify(character.context), /全域书/);
    loaded.length = 0;
    config.sources.worldbook = { source: 'manual', manualSelection: [], enabledEntries: {} };
    const empty = await env.platform.read(config, 'identify');
    assert.deepEqual(loaded, []);
    assert.equal((empty.context as { worldbook: string }).worldbook, '');
    config.sources.worldbook.manualSelection = ['手选书'];
    const manual = await env.platform.read(config, 'identify');
    assert.deepEqual(loaded, ['手选书']);
    assert.match(JSON.stringify(manual.context), /手选书/);
    assert.equal(env.platform.loadConfig().sources.worldbook.source, 'character');
    assert.ok(manual.sourceReport);
    assert.equal(manual.sourceReport.characters, JSON.stringify(manual.context).length);
  } finally {
    env.platform.dispose();
  }
});

test('只渲染已选且触发的世界书巨集，来源报告计算展开后内容', async () => {
  const env = environment();
  const rendered: string[] = [];
  try {
    env.api.getCharWorldbookNames = () => ({ primary: '角色书', additional: [] });
    env.api.getWorldbook = async () => [
      { uid: 1, name: '地理', enabled: true, content: '{{land}}', strategy: { type: 'constant', keys: [] } },
      {
        uid: 2,
        name: '无关',
        enabled: true,
        content: '{{huge}}',
        strategy: { type: 'selective', keys: ['未出现的关键字'] },
      },
    ];
    env.api.substitudeMacros = (text) => {
      rendered.push(text);
      return text.replace('{{land}}', '帝国位于大陆中央');
    };
    const config = defaultConfig();
    config.sources.memoryRecallRecentCount = 0;
    const snapshot = await env.platform.read(config, 'generate');
    assert.match(JSON.stringify(snapshot.context), /帝国位于大陆中央/);
    assert.ok(!rendered.includes('{{huge}}'));
    assert.equal(snapshot.sourceReport?.entries[0].characters, '帝国位于大陆中央'.length);
    assert.equal(snapshot.sourceReport?.characters, JSON.stringify(snapshot.context).length);
  } finally {
    env.platform.dispose();
  }
});

function environment() {
  const listeners = new Map<string, ((...args: any[]) => void)[]>();
  let data: any = {
    stat_data: { 世界: { 时间: 100 }, 角色: { 金币: 50 } },
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
      data.stat_data.角色.金币 = 70;
    },
    edit: () => {
      text = '编辑后的正文';
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
test('国策保存完成才通知报纸，保存失败不通知', async () => {
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
      throw new Error('存档失败');
    };
    await assert.rejects(env.platform.commit(snapshot, snapshot.state), /存档失败/);
    assert.equal(notifications.length, 1);
  } finally {
    env.platform.dispose();
  }
});

test('国策写入楼层最外层，保留完整 stat_data、初始化资料与既有 schema', async () => {
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
  test(`生命周期事件 ${change} 取消旧任务，迟到结果不回写`, async () => {
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

test('旧版完整树与进度可读取，成功保存才移到最外层且不改写其他变量', async () => {
  const env = environment();
  try {
    const legacy = demoState();
    env.getData().stat_data.国策 = legacy;
    env.getData().schema = '没有用别管这个';
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

test('两位置同时有资料时以最外层为准，无效最外层资料明确报错', async () => {
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

test('保存不比较国策或世界变量指纹，保留其他变量的最新值', async () => {
  const env = environment();
  try {
    env.getData().国策 = demoState();
    const snapshot = await env.platform.read(defaultConfig());
    env.getData().国策.day++;
    env.changeExternal();
    env.edit();
    await env.platform.commit(snapshot, snapshot.state);
    assert.equal(env.getData().国策.day, snapshot.state.day);
    assert.equal(env.getData().stat_data.角色.金币, 70);
  } finally {
    env.platform.dispose();
  }
});

for (const legacy of [false, true]) {
  test(`一般 MVU 更新保留${legacy ? '旧版' : '最外层'}国策且允许世界变量更新`, () => {
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
test('收到正文而一般 MVU 尚未写入时，不启动背景任务；两者完成后只触发一次', async () => {
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
    await assert.rejects(env.platform.read(defaultConfig()), /等待本楼/);
    env.emit('mvu-write', { message_content: '正文' });
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(count, 1);
    env.emit('received');
    env.emit('generation-end');
    env.emit('mvu-write', { message_content: env.text() });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(count, 1, '同楼层重复完成事件不得重新启动');
    await env.platform.read(defaultConfig());
  } finally {
    env.platform.dispose();
  }
});
test('新正文一开始就取消旧任务，即使新楼尚未插入', async () => {
  const env = environment();
  try {
    const snapshot = await env.platform.read(defaultConfig());
    env.emit('generation-start');
    await assert.rejects(env.platform.commit(snapshot, snapshot.state), /abort/i);
  } finally {
    env.platform.dispose();
  }
});

test('旧存档的正文依据不再验证，编辑后可继续读取', async () => {
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

test('同次来源读取共用一份聊天记录，提交不读取或杂凑历史正文', async () => {
  const env = environment();
  const messages = [
    { message_id: 0, role: 'user', message: '起点', swipe_id: 0, swipes: ['起点'] },
    { message_id: 1, role: 'assistant', message: '第一楼', swipe_id: 0, swipes: ['第一楼'] },
    { message_id: 2, role: 'user', message: '继续', swipe_id: 0, swipes: ['继续'] },
    { message_id: 3, role: 'assistant', message: '第二楼', swipe_id: 0, swipes: ['第二楼'] },
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
    assert.match(JSON.stringify(saved.context), /第二楼/);

    // A later floor can continue even when older story text was edited.
    env.next();
    env.next();
    messages.push(
      { message_id: 4, role: 'user', message: '再继续', swipe_id: 0, swipes: ['再继续'] },
      { message_id: 5, role: 'assistant', message: '第三楼', swipe_id: 0, swipes: ['第三楼'] },
    );
    ranges.length = 0;
    const next = await env.platform.read(config, 'update');
    assert.deepEqual(ranges, ['0-5']);
    assert.equal(next.turn, 3);
    ranges.length = 0;
    messages[1].message = '旧楼已被静默编辑';
    await env.platform.commit(next, next.state);
    assert.ok(!ranges.some((range) => typeof range === 'string' && range.startsWith('0-')));
    await env.platform.read(config, 'update');
  } finally {
    env.platform.dispose();
  }
});

test('quiet 背景生成不会被当成新的正文或封锁手动读取', async () => {
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

test('提交新新闻时标记所在楼层并在正文末尾加标签；标签不算正文编辑，也不重复加入', async () => {
  const { EventSchema } = await import('../src/model');
  const env = environment();
  try {
    const snapshot = await env.platform.read(defaultConfig());
    const state = structuredClone(snapshot.state);
    state.events.news = EventSchema.parse({
      id: 'news',
      at: state.day,
      countries: ['x'],
      title: '边境集结',
      description: '两国军队在边境集结。',
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
    assert.match(injected, /【近期国际大事】[\s\S]*边境集结/);
    env.platform.inject(again.state, false);
    assert.doesNotMatch(injected, /近期国际大事/);
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

test('有提示词模板扩展时，国策以角色主世界书条目读取楼层变量；旧楼层与注入模式改用注入', async () => {
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
    assert.match(injected, /各国动向[\s\S]*<国策动态>/);
    assert.ok(book.some((entry) => entry.name === '国策档案-世界概况'));
    assert.ok(book.some((entry) => entry.name.startsWith('国策档案-国家-')));
    // After a save the floor carries its own view: the entries render it and nothing is injected.
    await env.platform.commit(old, old.state);
    assert.match(env.getData().国策.prompt.overview, /各国动向/);
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
    assert.match(injected, /各国动向/);
    assert.ok(!book.some((entry) => entry.name.startsWith('国策档案-')));
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
        throw new Error('写入失败');
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
    (books.get(name) ?? []).filter((e) => e.name.startsWith('国策档案-国家-')).map((e) => e.name);
  return { env, books, state, settle, countries };
}

test('无角色主世界书时不使用聊天、附加或全域书；设定主书后写入并清理本次追踪的前一目标', async () => {
  const { env, books, state, settle } = bookEnvironment();
  let creations = 0;
  let primary: string | null = null;
  const unrelated = { name: '原有设定', content: '保留', strategy: { type: 'constant', keys: [] } };
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
    assert.match(state.injected, /各国动向/);
    assert.match(state.warnings[0], /当前角色尚未设定主世界书/);
    assert.deepEqual(books.get('chat-only'), [unrelated]);
    assert.deepEqual(books.get('additional-only'), [unrelated]);
    books.set('primary-a', [unrelated]);
    books.set('primary-b', []);
    primary = 'primary-a';
    env.platform.inject((await env.platform.read(defaultConfig())).state);
    await settle();
    assert.equal(state.injected, '');
    assert.ok(books.get('primary-a')!.some((e) => e.name === '国策档案-世界概况'));
    primary = 'primary-b';
    env.platform.inject((await env.platform.read(defaultConfig())).state);
    await settle();
    assert.deepEqual(books.get('primary-a'), [unrelated]);
    assert.ok(books.get('primary-b')!.some((e) => e.name === '国策档案-世界概况'));
    assert.equal(creations, 0);
  } finally {
    env.platform.dispose();
  }
});

test('旧手动世界书设定被忽略，只写角色主书且保留其他书', async () => {
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
    assert.ok(books.get('book-chat-a')!.some((e) => e.name === '国策档案-世界概况'));
    assert.deepEqual(books.get('old-manual'), []);
    assert.equal(state.injected, '');
    assert.equal(state.warnings.length, 0);
  } finally {
    env.platform.dispose();
  }
});

test('角色主世界书同步失败时保留直接注入并提示一次；之后成功才交给条目，不重复送出', async () => {
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
    assert.match(state.injected, /各国动向/, 'the story still gets the data');
    assert.equal(state.warnings.length, 1);
    env.platform.inject(saved.state);
    await settle();
    assert.match(state.injected, /各国动向/);
    assert.equal(state.warnings.length, 1, 'one warning per failure streak');
    env.platform.inject(saved.state);
    await settle();
    assert.equal(state.injected, '', 'handed over to the worldbook after a successful sync');
    assert.ok(books.get('book-chat-a')!.some((e) => e.name === '国策档案-世界概况'));
  } finally {
    env.platform.dispose();
  }
});

test('世界书工作绑定来源聊天与楼层：切换聊天或排入较新的工作后，旧工作不写入', async () => {
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
      Object.keys(fewer.countries).map((id) => `国策档案-国家-${id}`),
    );
  } finally {
    env.platform.dispose();
  }
});

test('每个完成的 AI 楼层在背景任务之前写入快讯条资料：新闻更新时间逐楼承接、所在国家算内部，并加上标签', async () => {
  const { createState, installCountry } = await import('../src/engine');
  const env = environment();
  let state = installCountry(
    createState(0),
    {
      id: 'augustium',
      name: '奥古斯提姆帝国',
      description: '帝国',
      stability: 50,
      warSupport: 50,
      evidence: '测试',
      capabilities: [],
      historical: [],
      nodes: [
        {
          id: 'a',
          name: '国策',
          branch: '主线',
          description: '内容',
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
      ? [{ message_id: 1, role: 'assistant', swipe_id: 0, swipes: ['上一楼'], message: '上一楼' }]
      : typeof range === 'number'
        ? current(range, options)
        : [
            { message_id: 1, role: 'assistant', swipe_id: 0, swipes: ['上一楼'], message: '上一楼' },
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
    floors[3].stat_data.新闻.快讯.经济 = '本楼稍后更新';
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
    assert.equal(extraReady, 0, '刷新报纸不得重新启动国策工作');
    assert.deepEqual(notifications, [['national-focus:news-saved', 3]]);
  } finally {
    env.platform.dispose();
  }
});

test('没有国策资料的楼层不写快讯条，也不加标签', async () => {
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
