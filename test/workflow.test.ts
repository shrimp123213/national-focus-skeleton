import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FocusController } from '../src/workflow';
import { DemoPlatform } from '../src/demo';
import { pauseFocus } from '../src/engine';
import type { Config } from '../src/model';

class ControlledPlatform extends DemoPlatform {
  ready: () => void = () => {};
  day = 114;
  turn = 8;
  outputs: (() => Promise<string>)[] = [];
  requests = 0;
  override async read() {
    return { ...(await super.read()), day: this.day, turn: this.turn, identity: `floor_${this.turn}` };
  }
  override onReady(callback?: () => void) {
    this.ready = callback ?? (() => {});
    return () => {
      this.ready = () => {};
    };
  }
  override async generate() {
    this.requests++;
    return { content: await (this.outputs.shift() ?? (async () => '{}'))() };
  }
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function finished(controller: FocusController) {
  for (let i = 0; i < 200; i++) {
    if (controller.jobs.length && controller.jobs.every((j) => !['running', 'queued'].includes(j.state))) {
      await tick();
      return;
    }
    await tick();
  }
  assert.fail('工作未於測試期限內完成');
}

test('不把玩家現在的暫停操作倒填至尚未結算的故事時間', async () => {
  const platform = new ControlledPlatform();
  const controller = new FocusController(platform);
  await controller.initialize();
  platform.day = 200;
  await assert.rejects(
    controller.mutate((state) => pauseFocus(state, 'augustium'), true),
    /先完成/,
  );
  assert.equal((await platform.read()).state.countries.augustium.current, 'focus_1_1');
  controller.dispose();
});

test('舊背景任務尚在執行時，新樓完成通知會保留並重新判定排程', async () => {
  const platform = new ControlledPlatform();
  let release!: (value: string) => void;
  platform.outputs.push(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  platform.outputs.push(async () =>
    JSON.stringify({ id: 'second', until: 121, reason: '下一樓', steps: [] }),
  );
  const controller = new FocusController(platform);
  controller.config.jobs.update.retries = 0;
  await controller.initialize();
  platform.ready();
  await tick();
  platform.day = 121;
  platform.turn = 9;
  platform.ready();
  release(JSON.stringify({ id: 'first', until: 114, reason: '舊樓', steps: [] }));
  await finished(controller);
  assert.equal(platform.requests, 2);
  assert.equal((await platform.read()).state.day, 121);
  controller.dispose();
});

test('格式失敗重試後才提交，取消逾時請求也不寫入提案', async () => {
  const platform = new ControlledPlatform();
  platform.outputs.push(async () => 'not json');
  platform.outputs.push(async () =>
    JSON.stringify({ id: 'valid', until: 114, reason: '有效回應', steps: [] }),
  );
  const controller = new FocusController(platform);
  await controller.initialize();
  await controller.run('update');
  assert.equal(controller.jobs[0].state, 'success');
  assert.equal(platform.requests, 2);
  const before = (await platform.read()).state;
  platform.outputs.push(() => new Promise(() => {}));
  const pending = controller.run('update');
  await tick();
  controller.cancelAll();
  await pending;
  assert.equal(controller.jobs[0].state, 'cancelled');
  assert.deepEqual((await platform.read()).state, before);
  controller.dispose();
});

test('主連線失敗才使用設定中的備援，排隊任務可立即取消', async () => {
  const platform = new ControlledPlatform();
  platform.outputs.push(async () => {
    throw new Error('API unavailable');
  });
  platform.outputs.push(async () =>
    JSON.stringify({ id: 'fallback', until: 114, reason: '備援', steps: [] }),
  );
  const controller = new FocusController(platform);
  controller.config.apis.push({
    ...controller.config.apis[0],
    name: '備援',
    url: '',
    model: '',
    proxy: '',
    maxTokens: 16384,
    temperature: 0.7,
  });
  controller.config.jobs.update.fallback = ['備援'];
  controller.config.jobs.update.retries = 0;
  await controller.initialize();
  await controller.run('update');
  assert.equal(controller.jobs[0].state, 'success');
  assert.equal(platform.requests, 2);
  platform.outputs.push(() => new Promise(() => {}));
  const active = controller.run('update');
  await tick();
  const queued = controller.run('update');
  await tick();
  assert.equal(controller.jobs[0].state, 'queued');
  controller.cancel(controller.jobs[0].id);
  await queued;
  assert.equal(controller.jobs[0].state, 'cancelled');
  controller.cancelAll();
  await active;
  controller.dispose();
});

test('卸載後清除尚未處理的新樓通知，不讓舊腳本再次呼叫 API', async () => {
  const platform = new ControlledPlatform();
  platform.outputs.push(() => new Promise(() => {}));
  platform.outputs.push(async () =>
    JSON.stringify({ id: 'late', until: 114, reason: '不應執行', steps: [] }),
  );
  const controller = new FocusController(platform);
  await controller.initialize();
  platform.ready();
  await tick();
  platform.ready();
  controller.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(platform.requests, 1);
});

test('完整請求超限時零 API 呼叫，不重試或切備援，也不提交狀態', async () => {
  class OversizedPlatform extends ControlledPlatform {
    override async read() {
      return { ...(await super.read()), context: { worldbook: '大型來源'.repeat(175000) } };
    }
  }
  const platform = new OversizedPlatform();
  const controller = new FocusController(platform);
  controller.config.apis.push({ ...controller.config.apis[0], name: '備援' });
  controller.config.jobs.update.fallback = ['備援'];
  controller.config.jobs.update.retries = 2;
  try {
    await controller.initialize();
    const before = (await platform.read()).state;
    await controller.run('update');
    assert.equal(platform.requests, 0);
    assert.equal(controller.jobs[0].state, 'failed');
    assert.match(controller.jobs[0].message, /輸入過大/);
    assert.ok(controller.jobs[0].inputCharacters! > 700000);
    assert.deepEqual((await platform.read()).state, before);
  } finally {
    controller.dispose();
  }
});
