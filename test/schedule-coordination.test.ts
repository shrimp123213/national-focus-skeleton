import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoPlatform, demoState } from '../src/demo';
import { migrateCountryKeys } from '../src/engine';
import { FocusController } from '../src/workflow';
import type { IntegrationInput } from '../src/integration';
import type { State } from '../src/model';
import type { Snapshot } from '../src/platform';
import type { WorldObservation } from '../src/world-proposal';
import { PREDICTION_WAIT_MS, type ScheduleSource, type WorldSchedulePrediction } from '../src/world-schedule';

class SchedulePlatform extends DemoPlatform {
  data = migrateCountryKeys(demoState());
  source: ScheduleSource = {
    chatId: 'chat',
    messageId: 8,
    swipeId: 0,
    content: '<tp>复兴纪元490年-1月-8日-星期一-08:30 @ 地点</tp>',
  };
  day = 114;
  turn = 8;
  busy = false;
  calls = 0;
  fail = false;
  tick = () => {};
  prediction: WorldSchedulePrediction = {
    status: 'due',
    reason: 'interval_due',
    member: { taskId: 'world', rootId: 'root' },
  };
  observation: WorldObservation = {
    member: { taskId: 'world', rootId: 'root' },
    run: null,
    fingerprint: 'world',
    patchLog: null,
  };
  readScheduleSource() {
    return structuredClone(this.source);
  }
  predictWorldSchedule() {
    return structuredClone(this.prediction);
  }
  readWorldProposal() {
    return structuredClone(this.observation);
  }
  onIntegrationTick(callback: () => void) {
    this.tick = callback;
    return () => {
      this.tick = () => {};
    };
  }
  readIntegration(messageId: number): IntegrationInput {
    return {
      ...this.source,
      messageId,
      lastMessageId: this.source.messageId,
      role: 'assistant',
      extraAnalysis: this.busy,
      data: { stat_data: { now: this.day }, 国策: this.data },
      timePath: 'now',
      world: { ...this.observation.member!, fingerprint: this.observation.fingerprint },
    };
  }
  override async read(): Promise<Snapshot> {
    if (this.busy) {
      throw new Error('MVU busy');
    }
    return {
      identity: JSON.stringify([this.source.chatId, this.source.messageId, this.source.swipeId]),
      messageId: this.source.messageId,
      day: this.day,
      turn: this.turn,
      state: structuredClone(this.data),
      context: {},
    };
  }
  override async commit(_source: Snapshot, state: State) {
    this.data = structuredClone(state);
  }
  override async generate() {
    this.calls++;
    return {
      content: this.fail
        ? '{invalid'
        : JSON.stringify({ id: `own-${this.calls}`, until: this.day, reason: '自动更新', steps: [] }),
    };
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function setup() {
  const platform = new SchedulePlatform();
  const controller = new FocusController(platform);
  await controller.initialize();
  for (const job of Object.values(controller.config.jobs)) {
    job.schedule = 'manual';
  }
  controller.config.jobs.update.schedule = 'reply';
  controller.config.jobs.update.retries = 0;
  return { platform, controller };
}
async function register(controller: FocusController, requestId = 'world-a') {
  const reply = await controller.integration.prepare(8, { mode: 'request', requestId });
  assert.equal(reply.status, 'ready');
  return reply;
}
function worldResult(platform: SchedulePlatform, nonce: string, id = 'external') {
  platform.observation.run = {
    messageId: 8,
    at: Date.now(),
    taskResults: [
      {
        taskId: 'world',
        success: true,
        extractedTags: {
          国策提案: JSON.stringify({
            nonce,
            proposal: { id, until: platform.day, reason: '世界提案', steps: [] },
          }),
        },
      },
    ],
  };
}

test('世界先登记优先于未到期预测；没有提案也不自行接管，手动失败使旧登记永久失效', async () => {
  const { platform, controller } = await setup();
  const reply = await register(controller);
  platform.prediction = { status: 'not_due', reason: 'interval_pending' };
  await controller.runScheduled();
  await controller.runScheduled();
  assert.equal(platform.calls, 0);
  assert.equal(controller.scheduleCoordination.status, 'proposal_wait');
  platform.fail = true;
  await controller.run('update');
  assert.equal(platform.calls, 1);
  assert.equal(controller.integration.lookup(reply.nonce), null);
  worldResult(platform, reply.nonce);
  controller.refreshProposal();
  assert.equal(await controller.accept(), false);
  controller.dispose();
});
test('国策先开始时不可提供资料；提交后新请求读取最新状态', async () => {
  const { platform, controller } = await setup();
  platform.prediction = { status: 'unknown', reason: 'unavailable' };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const generate = platform.generate.bind(platform);
  platform.generate = async () => {
    await gate;
    return generate();
  };
  const work = controller.runScheduled();
  await flush();
  assert.deepEqual(await controller.integration.prepare(8, { mode: 'request', requestId: 'too-late' }), {
    version: 1,
    status: 'unavailable',
    reason: 'update_busy',
  });
  release();
  await work;
  const next = await register(controller, 'after-save');
  assert.ok(controller.integration.lookup(next.nonce)!.state.receipts.includes('own-1'));
  controller.dispose();
});
test('自身未到期不做预测等待、不启动更新', async () => {
  const { platform, controller } = await setup();
  platform.data.schedules.update = { turn: 8, day: 114 };
  await controller.runScheduled();
  assert.equal(platform.calls, 0);
  assert.equal(controller.scheduleCoordination.status, 'idle');
  controller.dispose();
});
test('预测等待中登记立即让位；10 秒后仍不自动接管有效登记', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { platform, controller } = await setup();
  const work = controller.runScheduled();
  await flush();
  assert.equal(controller.scheduleCoordination.status, 'prediction_wait');
  await register(controller);
  await work;
  assert.equal(controller.scheduleCoordination.status, 'proposal_wait');
  t.mock.timers.tick(PREDICTION_WAIT_MS);
  await controller.runScheduled();
  assert.equal(platform.calls, 0);
  controller.dispose();
});
test('没有工作流结果最多等待一次；失败重试不再等待同一来源', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { platform, controller } = await setup();
  platform.fail = true;
  const work = controller.runScheduled();
  await flush();
  t.mock.timers.tick(PREDICTION_WAIT_MS - 1);
  await flush();
  assert.equal(platform.calls, 0);
  t.mock.timers.tick(1);
  await work;
  assert.equal(platform.calls, 1);
  await controller.runScheduled();
  assert.equal(platform.calls, 2);
  controller.dispose();
});
for (const change of ['chat', 'swipe', 'floor', 'body', 'manual', 'cancel'] as const) {
  test(`预测等待中 ${change} 取消旧计时器`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const { platform, controller } = await setup();
    const work = controller.runScheduled();
    await flush();
    if (change === 'chat') {
      platform.source.chatId = 'other';
    }
    if (change === 'swipe') {
      platform.source.swipeId++;
    }
    if (change === 'floor') {
      platform.source.messageId++;
    }
    if (change === 'body') {
      platform.source.content += '编辑';
    }
    if (change === 'manual') {
      await controller.run('update');
    }
    if (change === 'cancel') {
      controller.cancelAll();
    }
    platform.tick();
    await work;
    t.mock.timers.tick(PREDICTION_WAIT_MS);
    await flush();
    assert.equal(platform.calls, change === 'manual' ? 1 : 0);
    controller.dispose();
  });
}
for (const skipped of [true, false]) {
  test(`新的执行纪录${skipped ? '跳过' : '没有提案'}可提前解除等待`, async () => {
    const { platform, controller } = await setup();
    platform.observation.run = { messageId: 8, at: 1, taskResults: [] };
    const work = controller.runScheduled();
    await flush();
    platform.tick();
    assert.equal(controller.scheduleCoordination.status, 'prediction_wait');
    platform.observation.run = {
      messageId: 8,
      at: Date.now(),
      taskResults: [{ taskId: 'world', success: !skipped, skipped, extractedTags: {} }],
    };
    platform.tick();
    await work;
    assert.equal(platform.calls, 1);
    controller.dispose();
  });
}
test('等待结束后重新检查自身到期；中途已有保存就不再生成', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { platform, controller } = await setup();
  const work = controller.runScheduled();
  await flush();
  platform.data.schedules.update = { turn: 8, day: 114 };
  t.mock.timers.tick(PREDICTION_WAIT_MS);
  await work;
  assert.equal(platform.calls, 0);
  assert.equal(controller.scheduleCoordination.reason, 'not_due');
  controller.dispose();
});
test('等待结束与登记接近时，保存前的同步入口仍让位', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { platform, controller } = await setup();
  const work = controller.runScheduled();
  await flush();
  const read = platform.read.bind(platform);
  platform.read = async () => {
    const snapshot = await read();
    await register(controller);
    return snapshot;
  };
  t.mock.timers.tick(PREDICTION_WAIT_MS);
  await work;
  assert.equal(platform.calls, 0);
  assert.equal(controller.scheduleCoordination.status, 'proposal_wait');
  controller.dispose();
});
test('计时器刚结束、快照读取尚未结束时手动补救，旧自动工作仍取消', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { platform, controller } = await setup();
  const work = controller.runScheduled();
  await flush();
  const read = platform.read.bind(platform);
  let first = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  platform.read = async () => {
    const snapshot = await read();
    if (first) {
      first = false;
      await gate;
    }
    return snapshot;
  };
  t.mock.timers.tick(PREDICTION_WAIT_MS);
  await flush();
  platform.fail = true;
  await controller.run('update');
  release();
  await work;
  assert.equal(platform.calls, 1, '手动失败也不得让旧自动工作接手');
  controller.dispose();
});
test('晚到的跳过或空纪录不撤销有效 nonce，也不启动第二条自动更新', async () => {
  for (const skipped of [true, false]) {
    const { platform, controller } = await setup();
    const work = controller.runScheduled();
    await flush();
    const reply = await register(controller);
    platform.observation.run = {
      messageId: 8,
      at: Date.now(),
      taskResults: [{ taskId: 'world', success: true, skipped, extractedTags: {} }],
    };
    platform.tick();
    await work;
    await controller.runScheduled();
    assert.ok(controller.integration.lookup(reply.nonce));
    assert.equal(controller.externalProposal.reason, skipped ? 'world_skipped' : 'missing_proposal');
    assert.equal(platform.calls, 0);
    controller.dispose();
  }
});
test('超时不能略过 MVU 忙碌检查', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { platform, controller } = await setup();
  const work = controller.runScheduled();
  await flush();
  platform.busy = true;
  t.mock.timers.tick(PREDICTION_WAIT_MS);
  await assert.rejects(work, /MVU busy/);
  assert.equal(platform.calls, 0);
  controller.dispose();
});
test('取消国策更新不恢复旧登记，非同步准备也不能登记旧资料', async () => {
  const { platform, controller } = await setup();
  platform.prediction = { status: 'unknown', reason: 'unavailable' };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const preparing = controller.integration.prepare(8, { mode: 'request', requestId: 'pending' }, gate);
  const generate = platform.generate.bind(platform);
  platform.generate = async () => {
    await gate;
    return generate();
  };
  const work = controller.runScheduled();
  await flush();
  controller.cancelAll();
  release();
  await work;
  assert.equal((await preparing).status, 'unavailable');
  assert.equal(controller.jobs[0].state, 'cancelled');
  controller.dispose();
});
test('回退侦测超出短窗口仍有效，新请求不清除；确认后不重复提示', async () => {
  const { platform, controller } = await setup();
  const before = structuredClone(platform.data);
  const reply = await register(controller);
  worldResult(platform, reply.nonce);
  controller.refreshProposal();
  assert.equal(await controller.accept(), true);
  for (let i = 0; i < 12; i++) {
    controller.refreshProposal();
  }
  await register(controller, 'rerun');
  platform.data = before;
  controller.refreshProposal();
  const notice = controller.rollbackNotice!;
  assert.equal(notice.messageId, 8);
  assert.equal(notice.swipeId, 0);
  assert.equal(notice.receiptMissing, true);
  assert.equal(notice.returnedToBefore, true);
  assert.equal(notice.proposalId, 'external');
  assert.ok(notice.detectedAt);
  assert.deepEqual(platform.data, before, '只提示，不自动恢复');
  controller.dismissRollback();
  controller.refreshProposal();
  assert.equal(controller.rollbackNotice, null);
  controller.dispose();
});
test('revision 降低本身不触发回退，receipt 消失即使不等于旧状态也提示；换楼清除', async () => {
  const { platform, controller } = await setup();
  const reply = await register(controller);
  worldResult(platform, reply.nonce);
  controller.refreshProposal();
  await controller.accept();
  for (let i = 0; i < 12; i++) {
    controller.refreshProposal();
  }
  platform.data.revision = 0;
  controller.refreshProposal();
  assert.equal(controller.rollbackNotice, null);
  platform.data.receipts = [];
  controller.refreshProposal();
  assert.equal(controller.rollbackNotice!.receiptMissing, true);
  assert.equal(controller.rollbackNotice!.returnedToBefore, false);
  platform.source.messageId++;
  controller.refreshProposal();
  assert.equal(controller.rollbackNotice, null);
  controller.dispose();
});
test('新的接收清除回退提示，换 swipe 与重载也清除记忆体追踪', async () => {
  const { platform, controller } = await setup();
  const before = structuredClone(platform.data);
  const first = await register(controller);
  worldResult(platform, first.nonce);
  controller.refreshProposal();
  await controller.accept();
  for (let i = 0; i < 12; i++) {
    controller.refreshProposal();
  }
  platform.data = before;
  controller.refreshProposal();
  assert.ok(controller.rollbackNotice);
  const next = await register(controller, 'next');
  worldResult(platform, next.nonce, 'next');
  controller.refreshProposal();
  assert.equal(await controller.accept(), true);
  assert.equal(controller.rollbackNotice, null);
  platform.data.receipts = [];
  controller.refreshProposal();
  assert.ok(controller.rollbackNotice);
  platform.source.swipeId++;
  controller.refreshProposal();
  assert.equal(controller.rollbackNotice, null);
  const reloaded = new FocusController(platform);
  reloaded.refreshProposal();
  assert.equal(reloaded.rollbackNotice, null);
  reloaded.dispose();
  controller.dispose();
});
test('已有 receipt 的重复提案没有新效果，不误判为回到接收前状态', async () => {
  const { platform, controller } = await setup();
  platform.data.receipts.push('external');
  const reply = await register(controller);
  worldResult(platform, reply.nonce);
  controller.refreshProposal();
  assert.equal(await controller.accept(), true);
  for (let i = 0; i < 12; i++) {
    controller.refreshProposal();
  }
  assert.equal(controller.rollbackNotice, null);
  controller.dispose();
});
