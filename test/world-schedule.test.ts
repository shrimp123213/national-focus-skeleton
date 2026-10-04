import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predictWorldSchedule } from '../src/world-schedule';
import { storyDay } from '../src/platform';
import { TavernPlatform, type TavernApi } from '../src/tavern';

function settings(previous = '复兴纪元490年-1月-1日-星期一-08:30') {
  return {
    enabled: true,
    tasks: [
      { id: 'root', enabled: true, syncAsReplicaFamily: true, replicaFamilySpec: '世界状态摘要@world' },
      {
        id: 'world',
        enabled: true,
        replicaFamilyRootId: 'root',
        replicaFamilyAttrValue: '阿斯塔利亚',
        schedule: {
          mode: 'time',
          timeInterval: {
            value: 1,
            unit: 'week',
            timeSource: { type: 'message_tag', scope: 'current_ai', tagNames: ['tp'] },
          },
        },
      },
    ],
    scheduleState: {
      world: { lastRunChatKey: 'chat', lastRunGameTimeRaw: previous, lastRunGameTimeMs: -1 },
    } as Record<string, { lastRunChatKey?: string; lastRunGameTimeRaw?: string; lastRunGameTimeMs?: number }>,
  };
}
function predict(raw: string, config = settings()) {
  return predictWorldSchedule(config, 'chat', `<tp>${raw} @ 地点|氛围</tp>`);
}

// Representative boundaries from schedule.ts / parse-game-time.ts at 1dc0d38.
for (const [current, expected] of [
  ['复兴纪元490年-1月-8日-星期一-08:29', 'not_due'],
  ['复兴纪元490年-1月-8日-星期一-08:30', 'due'],
  ['复兴纪元490年-1月-8日-星期一-08:31', 'due'],
] as const) {
  test(`固定版本每周边界 ${current}: ${expected}`, () => {
    const config = settings();
    const before = structuredClone(config);
    assert.equal(predict(current, config).status, expected);
    assert.deepEqual(config, before);
  });
}
test('首次、换聊天与时间回退放行，不执行第三方自愈写入', () => {
  const first = settings();
  delete first.scheduleState.world;
  assert.equal(predict('复兴纪元490年-1月-1日-星期一-08:30', first).reason, 'first_run');
  const different = settings();
  different.scheduleState.world.lastRunChatKey = 'other';
  const before = structuredClone(different);
  assert.equal(predict('复兴纪元490年-1月-1日-星期一-08:30', different).reason, 'different_chat');
  assert.deepEqual(different, before);
  const regressed = settings();
  assert.equal(predict('复兴纪元489年-12月-31日-星期一-08:30', regressed).reason, 'time_regressed');
  assert.deepEqual(regressed, settings());
});
for (const [from, to, days] of [
  ['490年-2月-28日', '490年-3月-1日', 4],
  ['490年-4月-30日', '490年-5月-1日', 2],
  ['490年-12月-31日', '491年-1月-1日', 1],
] as const) {
  test(`31/372 日历 ${from} 到 ${to} 为 ${days} 天`, () => {
    const config = settings(`复兴纪元${from}-星期一-08:30`);
    config.tasks[1].schedule!.timeInterval.unit = 'day';
    config.tasks[1].schedule!.timeInterval.value = days;
    assert.equal(predict(`复兴纪元${to}-星期一-08:30`, config).status, 'due');
    assert.equal(predict(`复兴纪元${to}-星期一-08:29`, config).status, 'not_due');
    assert.equal(storyDay('490-03-01') - storyDay('490-02-28'), 1, '国策公历不受预测日轴影响');
  });
}
for (const [unit, current] of [
  ['minute', '490年-1月-1日-星期一-08:31'],
  ['hour', '490年-1月-1日-星期一-09:30'],
  ['month', '490年-2月-1日-星期一-08:30'],
  ['year', '491年-1月-1日-星期一-08:30'],
] as const) {
  test(`支持已核对的 ${unit} 间隔`, () => {
    const config = settings();
    config.tasks[1].schedule!.timeInterval.unit = unit;
    assert.equal(predict(`复兴纪元${current}`, config).status, 'due');
  });
}
test('有效设置按成员取排程；停用、其他世界、成员歧义分别处理', () => {
  const config = settings();
  const member = config.tasks[1];
  assert.ok(member.schedule);
  config.tasks.push({
    ...structuredClone(member),
    id: 'other',
    replicaFamilyAttrValue: '其他世界',
    replicaFamilyRootId: 'root',
    schedule: structuredClone(member.schedule),
  });
  config.tasks[2].schedule!.timeInterval.value = 100;
  assert.equal(predict('复兴纪元490年-1月-8日-星期一-08:30', config).status, 'due');
  config.tasks[1].schedule!.timeInterval.value = 2;
  assert.equal(predict('复兴纪元490年-1月-8日-星期一-08:30', config).status, 'not_due');
  config.tasks[1].enabled = false;
  assert.equal(predict('复兴纪元490年-1月-8日-星期一-08:30', config).reason, 'disabled');
  config.tasks[1].enabled = true;
  config.enabled = false;
  assert.equal(predict('复兴纪元490年-1月-8日-星期一-08:30', config).reason, 'disabled');
  config.enabled = true;
  config.tasks[2].replicaFamilyAttrValue = '阿斯塔利亚';
  assert.equal(predict('复兴纪元490年-1月-8日-星期一-08:30', config).reason, 'member_unknown');
  config.tasks.splice(1);
  assert.equal(predict('复兴纪元490年-1月-8日-星期一-08:30', config).reason, 'member_unknown');
});
test('不支援的模式、来源、格式与旧时间状态回传未知', () => {
  const now = '复兴纪元490年-1月-8日-星期一-08:30';
  for (const change of ['mode', 'source', 'scope', 'tags', 'unit', 'anchor'] as const) {
    const config = settings();
    const interval = config.tasks[1].schedule!.timeInterval;
    if (change === 'mode') {
      config.tasks[1].schedule!.mode = 'round';
    }
    if (change === 'source') {
      interval.timeSource.type = 'variable';
    }
    if (change === 'scope') {
      interval.timeSource.scope = 'current_pair';
    }
    if (change === 'tags') {
      interval.timeSource.tagNames = ['tp', 'time'];
    }
    if (change === 'unit') {
      interval.unit = 'century';
    }
    if (change === 'anchor') {
      config.scheduleState.world.lastRunGameTimeRaw = 'old format';
    }
    assert.equal(predict(now, config).status, 'unknown', change);
  }
  const config = settings();
  delete config.scheduleState.world.lastRunGameTimeRaw;
  assert.equal(predict(now, config).reason, 'unknown_anchor');
  for (const raw of ['490-01-08 08:30', '复兴纪元490年-13月-8日-星期一-08:30', '', '第8天']) {
    assert.equal(predict(raw).reason, 'invalid_time');
  }
});
test('酒馆预测读取公开有效设置与工作流聊天键，正文编辑通知沿用轮询入口', () => {
  const config = settings();
  config.scheduleState.world.lastRunChatKey = 'workflow-key';
  let content = '<tp>复兴纪元490年-1月-2日-星期二-08:30 @ 地点</tp>';
  let reads = 0;
  const listeners = new Map<string, (...args: any[]) => void>();
  const api: TavernApi = {
    parent: {
      SillyTavern: { getContext: () => ({ chatId: 'workflow-key' }) },
      AcuPostProcessAPI: {
        getEffectiveSettings: () => {
          reads++;
          return config;
        },
        getRunStatusForFloor: () => null,
      },
    },
    SillyTavern: { getCurrentChatId: () => 'national-key' },
    getLastMessageId: () => 8,
    getChatMessages: () => [{ message_id: 8, swipe_id: 1, swipes: ['旧分支', content], role: 'assistant' }],
    eventOn: (event, callback) => {
      listeners.set(event, callback);
      return { stop() {} };
    },
    tavern_events: { MESSAGE_EDITED: 'edit' },
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
  try {
    const source = platform.readScheduleSource()!;
    assert.equal(source.swipeId, 1);
    assert.equal(source.content, content);
    assert.equal(platform.predictWorldSchedule(source).status, 'not_due');
    config.tasks[1].schedule!.timeInterval.unit = 'day';
    assert.equal(platform.predictWorldSchedule(source).status, 'due', '每次读取实际生效的设定');
    assert.equal(reads, 2);
    let ticks = 0;
    platform.onIntegrationTick(() => {
      ticks++;
    });
    content += '编辑正文';
    listeners.get('edit')!();
    assert.equal(ticks, 1);
    assert.equal(platform.readScheduleSource()!.content, content);
    delete api.parent!.AcuPostProcessAPI;
    assert.deepEqual(platform.predictWorldSchedule(source), { status: 'unknown', reason: 'unavailable' });
  } finally {
    platform.dispose();
  }
});
