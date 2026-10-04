import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoPlatform, demoState } from '../src/demo';
import { migrateCountryKeys } from '../src/engine';
import {
  FocusIntegration,
  integrationSource,
  unavailable,
  type IntegrationApi,
  type IntegrationInput,
  type IntegrationReply,
  type IntegrationReady,
} from '../src/integration';
import { EventSchema, defaultConfig, type State } from '../src/model';
import { storyDay } from '../src/platform';
import { TavernPlatform, type TavernApi } from '../src/tavern';
import { FocusController } from '../src/workflow';

function input(): IntegrationInput {
  const state = migrateCountryKeys(demoState());
  state.countries['北境联邦'].cursor = 103.75;
  state.events.saved = EventSchema.parse({
    id: 'saved',
    at: 110,
    countries: ['北境联邦'],
    title: '谈判',
    description: '已开始',
    evidence: '记录',
    origin: 'background',
    public: false,
    changes: [],
    status: 'ongoing',
    timeline: [
      { at: 110, text: '已开始' },
      { at: 111, text: '仍在协商' },
    ],
  });
  return {
    chatId: 'chat-a',
    messageId: 8,
    swipeId: 0,
    lastMessageId: 8,
    role: 'assistant',
    extraAnalysis: false,
    data: { stat_data: { 时间: { 当前: '复兴纪元490年-10月-15日-星期三-14:25' } }, 国策: state },
    timePath: '时间.当前',
  };
}
function ready(reply: IntegrationReply): IntegrationReady {
  assert.equal(reply.status, 'ready', JSON.stringify(reply));
  return reply;
}
const request = (requestId = 'world-1') => ({ mode: 'request' as const, requestId });

test('资料包含精确时间、各国实际 cursor、完整定义与实际保存记录，不推进或写入国策', async () => {
  const source = input();
  const before = structuredClone(source);
  const integration = new FocusIntegration(() => source);
  const data = ready(await integration.prepare(8, request()));
  assert.equal(data.version, 1);
  assert.equal(data.now, storyDay('490-10-15 14:25'));
  assert.notEqual(data.now, Math.floor(data.now));
  assert.deepEqual(data.cursors, { 奥古斯提姆帝国: 114, 北境联邦: 103.75, 苍海同盟: 114 });
  assert.equal(data.schema.type, 'object');
  assert.ok(data.schema.properties?.transitions);
  assert.equal(Object.hasOwn(data.state, 'instructions'), false);
  assert.equal(JSON.stringify(data.state).includes('"review"'), false);
  assert.equal(data.history.complete, false);
  assert.equal(data.history.since, null);
  assert.deepEqual(data.history.events.saved.timeline, [
    { at: 110, text: '已开始' },
    { at: 111, text: '仍在协商' },
  ]);
  assert.equal(data.history.events.saved.public, false, '资料提供不套用正文迷雾');
  assert.deepEqual(source, before);
  const registered = integration.lookup(data.nonce)!;
  assert.equal(registered.chatId, source.chatId);
  assert.equal(registered.swipeId, 0);
  assert.deepEqual(registered.state, source.data.国策);
  data.cursors['北境联邦'] = 999;
  registered.state.countries['北境联邦'].cursor = 999;
  assert.equal(integration.lookup(data.nonce)?.cursors['北境联邦'], 103.75, '回传值不可修改内部登记');
});

const unavailableCases: [string, (source: IntegrationInput) => void][] = [
  [
    'mvu_busy',
    (source) => {
      source.extraAnalysis = true;
    },
  ],
  [
    'missing_stat_data',
    (source) => {
      delete source.data.stat_data;
    },
  ],
  [
    'missing_state',
    (source) => {
      delete source.data.国策;
    },
  ],
  [
    'invalid_state',
    (source) => {
      source.data.国策 = {};
    },
  ],
  [
    'invalid_time',
    (source) => {
      source.data.stat_data = { 时间: { 当前: '无日期' } };
    },
  ],
  [
    'not_assistant',
    (source) => {
      source.role = 'user';
    },
  ],
  [
    'not_latest',
    (source) => {
      source.lastMessageId = 9;
    },
  ],
  [
    'source_changed',
    (source) => {
      source.signal = AbortSignal.abort();
    },
  ],
];
for (const [reason, change] of unavailableCases) {
  test(`资料未就绪：${reason} 不登记 nonce`, async () => {
    const source = input();
    change(source);
    const integration = new FocusIntegration(() => source);
    const result = await integration.prepare(8, request());
    assert.deepEqual(result, { version: 1, status: 'unavailable', reason });
    assert.equal(integration.lookup('unknown'), null);
  });
}

test('预览默认不登记或作废；同一请求重复渲染复用 nonce，新请求使旧 nonce 永久失效', async () => {
  const source = input();
  const integration = new FocusIntegration(() => source);
  assert.deepEqual(await integration.prepare(8), unavailable('preview'));
  assert.deepEqual(await integration.prepare(8, { mode: 'request' }), unavailable('invalid_request'));
  const [a, b] = await Promise.all([integration.prepare(8, request()), integration.prepare(8, request())]);
  const first = ready(a);
  assert.equal(ready(b).nonce, first.nonce);
  assert.deepEqual(await integration.prepare(8, { mode: 'preview' }), unavailable('preview'));
  assert.ok(integration.lookup(first.nonce));
  assert.equal(ready(await integration.prepare(8, request())).nonce, first.nonce);
  const next = ready(await integration.prepare(8, request('world-2')));
  assert.notEqual(next.nonce, first.nonce);
  assert.equal(integration.lookup(first.nonce), null);
  assert.deepEqual(await integration.prepare(8, request()), unavailable('request_expired'));
  assert.ok(integration.lookup(next.nonce));
});

test('工作流追加变量更新区块与替换正文标签不作废 nonce，登记不含正文', async () => {
  const source = { ...input(), content: '<content>正文</content>' };
  const integration = new FocusIntegration(() => source);
  const first = ready(await integration.prepare(8, request()));
  source.content += '\n<工作流变量更新>本轮更新</工作流变量更新>';
  assert.ok(integration.lookup(first.nonce));
  source.content = source.content.replace('<content>正文</content>', '<content>替换后的正文</content>');
  const registered = integration.lookup(first.nonce);
  assert.ok(registered);
  assert.equal(Object.hasOwn(registered, 'content'), false);
  assert.equal(ready(await integration.prepare(8, request())).nonce, first.nonce);
});

for (const field of ['chat', 'swipe', 'time', 'state'] as const) {
  test(`${field} 改变后登记失效，即使 revision 相同也拒绝，恢复旧值不复活`, async () => {
    let source = input();
    const before = structuredClone(source);
    const integration = new FocusIntegration(() => source);
    const first = ready(await integration.prepare(8, request()));
    if (field === 'chat') {
      source.chatId = 'chat-b';
    }
    if (field === 'swipe') {
      source.swipeId = 1;
    }
    if (field === 'time') {
      source.data.stat_data = { 时间: { 当前: '490-10-15 14:26' } };
    }
    if (field === 'state') {
      (source.data.国策 as State).countries['北境联邦'].control = 'player';
    }
    assert.equal(integration.lookup(first.nonce), null);
    source = before;
    assert.equal(integration.lookup(first.nonce), null);
    assert.deepEqual(await integration.prepare(8, request()), unavailable('request_expired'));
  });
}

test('来源生命周期中断后即使切回同一分支，旧登记也失效', async () => {
  const source = input();
  const life = new AbortController();
  source.signal = life.signal;
  const integration = new FocusIntegration(() => source);
  const first = ready(await integration.prepare(8, request()));
  life.abort();
  source.signal = new AbortController().signal;
  assert.equal(integration.lookup(first.nonce), null);
});

test('排程入口有登记就让位；手动取得执行权使登记失效，释放后不恢复', async () => {
  const source = input();
  const integration = new FocusIntegration(() => source);
  const first = ready(await integration.prepare(8, request()));
  assert.deepEqual(integration.beginUpdate('scheduled'), { status: 'waiting', nonce: first.nonce });
  const access = integration.beginUpdate('manual');
  assert.equal(access.status, 'acquired');
  assert.equal(integration.lookup(first.nonce), null);
  assert.deepEqual(await integration.prepare(8, request('world-2')), unavailable('update_busy'));
  if (access.status === 'acquired') {
    integration.endUpdate(access.token);
  }
  assert.equal(integration.lookup(first.nonce), null);
  assert.deepEqual(await integration.prepare(8, request()), unavailable('request_expired'));
  const fresh = ready(await integration.prepare(8, request('world-2')));
  assert.ok(integration.lookup(fresh.nonce));
});

test('非同步准备期间自身更新取得并释放执行权，旧资料仍不得完成登记', async () => {
  const source = input();
  const integration = new FocusIntegration(() => source);
  let release!: () => void;
  const writes = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = integration.prepare(8, request(), writes);
  const access = integration.beginUpdate('manual');
  if (access.status === 'acquired') {
    integration.endUpdate(access.token);
  }
  release();
  assert.deepEqual(await pending, unavailable('request_expired'));
  assert.deepEqual(await integration.prepare(8, request()), unavailable('request_expired'));
  ready(await integration.prepare(8, request('world-2')));
});

test('非同步准备结束会重新核对来源与 MVU 状态，新请求可取代旧准备', async () => {
  for (const change of ['time', 'busy', 'request'] as const) {
    const source = input();
    const integration = new FocusIntegration(() => source);
    let release!: () => void;
    const writes = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = integration.prepare(8, request(), writes);
    let fresh: IntegrationReady | undefined;
    if (change === 'time') {
      source.data.stat_data = { 时间: { 当前: '490-10-15 14:26' } };
    }
    if (change === 'busy') {
      source.extraAnalysis = true;
    }
    if (change === 'request') {
      fresh = ready(await integration.prepare(8, request('world-2')));
    }
    release();
    assert.deepEqual(
      await pending,
      unavailable(change === 'time' ? 'source_changed' : change === 'busy' ? 'mvu_busy' : 'request_expired'),
    );
    if (fresh) {
      assert.ok(integration.lookup(fresh.nonce));
    }
  }
});

class IntegrationPlatform extends DemoPlatform {
  source = input();
  exposed?: IntegrationApi;
  readIntegration() {
    return this.source;
  }
  bindIntegration(api: IntegrationApi) {
    this.exposed = api;
    return () => {
      this.exposed = undefined;
    };
  }
  override async generate() {
    return { content: '{bad-json' };
  }
}

test('控制器手动更新开始即作废 nonce，模型失败后不恢复；新控制器与卸载后无登记', async () => {
  const platform = new IntegrationPlatform();
  const controller = new FocusController(platform);
  await controller.initialize();
  controller.config.jobs.update.retries = 0;
  const api = platform.exposed!;
  try {
    const first = ready(await api.prepare(8, request()));
    const second = new FocusController(platform);
    assert.equal(second.integration.lookup(first.nonce), null);
    second.dispose();
    const work = controller.run('update');
    assert.equal(api.lookup(first.nonce), null);
    assert.deepEqual(await api.prepare(8, request('world-2')), unavailable('update_busy'));
    await work;
    assert.equal(controller.jobs[0].state, 'failed');
    assert.equal(api.lookup(first.nonce), null);
    ready(await api.prepare(8, request('world-2')));
  } finally {
    controller.dispose();
  }
  assert.equal(platform.exposed, undefined);
  assert.deepEqual(await api.prepare(8, request('world-3')), unavailable('disposed'));
});

test('控制器取消更新释放执行权，但旧请求与 nonce 不恢复', async () => {
  const platform = new IntegrationPlatform();
  const controller = new FocusController(platform);
  await controller.initialize();
  try {
    const api = platform.exposed!;
    const first = ready(await api.prepare(8, request()));
    const work = controller.run('update');
    controller.cancelAll();
    await work;
    assert.equal(controller.jobs[0].state, 'cancelled');
    assert.equal(api.lookup(first.nonce), null);
    assert.deepEqual(await api.prepare(8, request()), unavailable('request_expired'));
    ready(await api.prepare(8, request('world-2')));
  } finally {
    controller.dispose();
  }
});

test('酒馆全域绑定读取指定末楼，不依赖就绪计时器；异常以原因代码回传，卸载移除 API', async () => {
  const source = input();
  let content = '正文';
  const mvuData = { stat_data: source.data.stat_data!, 国策: source.data.国策 };
  let requested: number | undefined;
  const parent: NonNullable<TavernApi['parent']> = {};
  const listeners = new Map<string, (...args: any[]) => void>();
  const api: TavernApi = {
    parent,
    SillyTavern: { getCurrentChatId: () => source.chatId },
    getLastMessageId: () => source.lastMessageId,
    getChatMessages: () => [
      {
        message_id: source.messageId,
        swipe_id: source.swipeId,
        swipes: [content, '分支二'],
        role: source.role,
        message: content,
      },
    ],
    Mvu: {
      getMvuData: ({ message_id }) => {
        requested = message_id;
        return mvuData;
      },
      replaceMvuData: async () => {
        assert.fail('不得写入 MVU');
      },
      isDuringExtraAnalysis: () => source.extraAnalysis,
      events: {},
    },
    eventOn: (event, listener) => {
      listeners.set(event, listener);
      return { stop() {} };
    },
    tavern_events: { MESSAGE_RECEIVED: 'received', CHAT_CHANGED: 'chat' },
    generateRaw: async () => '',
    stopGenerationById: () => true,
    getGlobalWorldbookNames: () => [],
    getCharWorldbookNames: () => ({ primary: null, additional: [] }),
    getWorldbook: async () => [],
    injectPrompts: () => ({ uninject() {} }),
    uninjectPrompts() {},
  };
  const storage: Storage = {
    length: 0,
    getItem: () => null,
    setItem() {},
    removeItem() {},
    clear() {},
    key: () => null,
  };
  const platform = new TavernPlatform(api, storage);
  const config = defaultConfig();
  config.sources.timePath = source.timePath;
  const integration = new FocusIntegration((messageId) => platform.readIntegration(messageId, config));
  const exposed: IntegrationApi = {
    version: 1,
    prepare: (id, options) => integration.prepare(id, options),
    lookup: (nonce) => integration.lookup(nonce),
  };
  platform.bindIntegration(exposed);
  try {
    listeners.get('received')?.(8, 'normal');
    await assert.rejects(platform.read(config), /等待本楼/);
    const first = ready(await parent.NationalFocusIntegration!.prepare(8, request()));
    assert.equal(requested, 8);
    assert.equal(first.now, storyDay('490-10-15 14:25'));
    content += '\n<工作流变量更新>本轮更新</工作流变量更新>';
    assert.ok(exposed.lookup(first.nonce), '实际酒馆正文注入不作废登记');
    assert.deepEqual(await exposed.prepare(7, request('old-floor')), unavailable('not_latest'));
    source.extraAnalysis = true;
    assert.deepEqual(await exposed.prepare(8, request('busy')), unavailable('mvu_busy'));
    source.extraAnalysis = false;
    const mvu = api.Mvu;
    delete api.Mvu;
    assert.deepEqual(await exposed.prepare(8, request('no-mvu')), unavailable('mvu_unavailable'));
    api.Mvu = mvu;
    source.swipeId = 1;
    listeners.get('chat')?.();
    assert.equal(exposed.lookup(first.nonce), null);
    assert.equal('status' in integrationSource(platform.readIntegration(8, config)), false);
  } finally {
    integration.dispose();
    platform.dispose();
  }
  assert.equal(parent.NationalFocusIntegration, undefined);
});
