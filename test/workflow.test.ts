import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FocusController } from '../src/workflow';
import { DemoPlatform } from '../src/demo';
import { pauseFocus } from '../src/engine';
import type { Config } from '../src/model';

class ControlledPlatform extends DemoPlatform {
  ready: () => void = () => {};
  sourceRun = new AbortController();
  day = 114;
  turn = 8;
  outputs: (() => Promise<string>)[] = [];
  requests = 0;
  override async read() {
    return {
      ...(await super.read()),
      day: this.day,
      turn: this.turn,
      signal: this.sourceRun.signal,
      identity: `floor_${this.turn}`,
    };
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
  assert.fail('工作未于测试期限内完成');
}

test('不把玩家现在的暂停操作倒填至尚未结算的故事时间', async () => {
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

test('手动任务不为排程读取存档，自动任务仍依楼层检查', async () => {
  const platform = new ControlledPlatform();
  let reads = 0;
  const read = platform.read.bind(platform);
  platform.read = async () => {
    reads++;
    return read();
  };
  const controller = new FocusController(platform);
  try {
    for (const job of Object.values(controller.config.jobs)) {
      job.schedule = 'manual';
    }
    await controller.runScheduled();
    assert.equal(reads, 0);
    assert.equal(platform.requests, 0);
    controller.config.jobs.update.schedule = 'reply';
    platform.outputs.push(async () =>
      JSON.stringify({ id: 'scheduled', until: 114, reason: '排程', steps: [] }),
    );
    await controller.runScheduled();
    assert.equal(platform.requests, 1);
    assert.equal(controller.jobs[0].state, 'success');
    reads = 0;
    await controller.runScheduled();
    assert.equal(reads, 1);
    assert.equal(platform.requests, 1);
  } finally {
    controller.dispose();
  }
});

test('旧背景任务尚在执行时，新楼完成通知会保留并重新判定排程', async () => {
  const platform = new ControlledPlatform();
  let release!: (value: string) => void;
  platform.outputs.push(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  platform.outputs.push(async () =>
    JSON.stringify({ id: 'second', until: 121, reason: '下一楼', steps: [] }),
  );
  const controller = new FocusController(platform);
  controller.config.jobs.update.retries = 0;
  await controller.initialize();
  platform.ready();
  await tick();
  platform.day = 121;
  platform.turn = 9;
  platform.ready();
  release(JSON.stringify({ id: 'first', until: 114, reason: '旧楼', steps: [] }));
  await finished(controller);
  assert.equal(platform.requests, 2);
  assert.equal((await platform.read()).state.day, 121);
  assert.equal(controller.jobs.find((job) => job.state === 'cancelled')?.kind, 'update');
  assert.ok(!(await platform.read()).state.receipts.includes('first'));
  controller.dispose();
});

test('格式失败重试后才提交，取消逾时请求也不写入提案', async () => {
  const platform = new ControlledPlatform();
  platform.outputs.push(async () => 'not json');
  platform.outputs.push(async () =>
    JSON.stringify({ id: 'valid', until: 114, reason: '有效回应', steps: [] }),
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

test('主连线失败使用备援，不同任务可并行且可个别取消', async () => {
  const platform = new ControlledPlatform();
  platform.outputs.push(async () => {
    throw new Error('API unavailable');
  });
  platform.outputs.push(async () =>
    JSON.stringify({ id: 'fallback', until: 114, reason: '备援', steps: [] }),
  );
  const controller = new FocusController(platform);
  controller.config.apis.push({
    ...controller.config.apis[0],
    name: '备援',
    url: '',
    model: '',
    proxy: '',
    maxTokens: 16384,
    temperature: 0.7,
  });
  controller.config.jobs.update.fallback = ['备援'];
  controller.config.jobs.update.retries = 0;
  controller.config.sources.maxInputCharacters = 200000;
  try {
    await controller.initialize();
    await controller.run('update');
    assert.equal(controller.jobs[0].state, 'success');
    assert.equal(platform.requests, 2);
    platform.outputs.push(
      () => new Promise(() => {}),
      () => new Promise(() => {}),
    );
    const active = controller.run('update');
    await tick();
    const parallel = controller.run('reshape');
    await tick();
    assert.equal(controller.jobs[0].state, 'running');
    assert.equal(platform.requests, 4, '更新及改树请求可同时执行');
    controller.cancel(controller.jobs[0].id);
    await parallel;
    assert.equal(controller.jobs[0].state, 'cancelled');
    controller.cancelAll();
    await active;
  } finally {
    controller.dispose();
  }
});

test('卸载后清除尚未处理的新楼通知，不让旧脚本再次呼叫 API', async () => {
  const platform = new ControlledPlatform();
  platform.outputs.push(() => new Promise(() => {}));
  platform.outputs.push(async () =>
    JSON.stringify({ id: 'late', until: 114, reason: '不应执行', steps: [] }),
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

test('完整请求超限时零 API 呼叫，不重试或切备援，也不提交状态', async () => {
  class OversizedPlatform extends ControlledPlatform {
    override async read() {
      return { ...(await super.read()), context: { worldbook: '大型来源'.repeat(175000) } };
    }
  }
  const platform = new OversizedPlatform();
  const controller = new FocusController(platform);
  controller.config.apis.push({ ...controller.config.apis[0], name: '备援' });
  controller.config.jobs.update.fallback = ['备援'];
  controller.config.jobs.update.retries = 2;
  try {
    await controller.initialize();
    const before = (await platform.read()).state;
    await controller.run('update');
    assert.equal(platform.requests, 0);
    assert.equal(controller.jobs[0].state, 'failed');
    assert.match(controller.jobs[0].message, /输入过大/);
    assert.ok(controller.jobs[0].inputCharacters! > 700000);
    assert.deepEqual((await platform.read()).state, before);
  } finally {
    controller.dispose();
  }
});

test('同一任务重复点击不额外排队或呼叫 API，完成后仍能手动重跑', async () => {
  const platform = new ControlledPlatform();
  let release!: (value: string) => void;
  platform.outputs.push(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const controller = new FocusController(platform);
  try {
    const first = controller.run('update');
    await tick();
    await controller.run('update');
    assert.equal(platform.requests, 1);
    assert.equal(controller.jobs.length, 1);
    release(JSON.stringify({ id: 'once', until: 114, reason: '手动更新', steps: [] }));
    await first;
    platform.outputs.push(async () => JSON.stringify({ id: 'again', until: 114, reason: '重跑', steps: [] }));
    await controller.run('update');
    assert.equal(platform.requests, 2);
    assert.ok((await platform.read()).state.receipts.includes('again'));
  } finally {
    controller.dispose();
  }
});

test('正文生命周期取消正在生成的工作，供应商迟到回应也不提交', async () => {
  const platform = new ControlledPlatform();
  let release!: (value: string) => void;
  platform.outputs.push(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const controller = new FocusController(platform);
  try {
    const before = (await platform.read()).state;
    const pending = controller.run('update');
    await tick();
    platform.sourceRun.abort();
    await pending;
    release(JSON.stringify({ id: 'late', until: 114, reason: '迟到回应', steps: [] }));
    await tick();
    assert.equal(controller.jobs[0].state, 'cancelled');
    assert.deepEqual((await platform.read()).state, before);
  } finally {
    controller.dispose();
  }
});

test('背景生成期间的玩家操作保留，回应套用到最新国策而不比对来源', async () => {
  const platform = new ControlledPlatform();
  let release!: (value: string) => void;
  platform.outputs.push(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const controller = new FocusController(platform);
  try {
    const pending = controller.run('update');
    await tick();
    await controller.mutate((state) => pauseFocus(state, 'augustium'));
    release(JSON.stringify({ id: 'latest', until: 114, reason: '更新局势', steps: [] }));
    await pending;
    assert.equal(controller.jobs[0].state, 'success');
    assert.equal((await platform.read()).state.countries.augustium.progress.focus_1_1.status, 'paused');
    assert.ok((await platform.read()).state.receipts.includes('latest'));
  } finally {
    controller.dispose();
  }
});

test('旧总并行上限被忽略，不同任务并行后依序保存且保留所有结果', async () => {
  const platform = new ControlledPlatform();
  const releases: ((value: string) => void)[] = [];
  platform.outputs.push(
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
    () =>
      new Promise((resolve) => {
        releases.push(resolve);
      }),
  );
  const commit = platform.commit.bind(platform);
  platform.commit = async (snapshot, state) => {
    await tick();
    await commit(snapshot, state);
  };
  const config = platform.loadConfig();
  platform.loadConfig = () => ({ ...config, concurrency: 1 });
  const controller = new FocusController(platform);
  assert.equal(Object.hasOwn(controller.config, 'concurrency'), false);
  controller.config.sources.maxInputCharacters = 200000;
  try {
    const first = controller.run('update');
    const second = controller.run('reshape');
    for (let i = 0; i < 100 && releases.length < 2; i++) {
      await tick();
    }
    assert.equal(releases.length, 2, JSON.stringify(controller.jobs));
    releases[0](JSON.stringify({ id: 'parallel_a', until: 114, reason: '更新', steps: [] }));
    releases[1](JSON.stringify({ id: 'parallel_b', until: 114, reason: '改树', steps: [] }));
    await Promise.all([first, second]);
    assert.ok(
      controller.jobs.every((job) => job.state === 'success'),
      JSON.stringify(controller.jobs),
    );
    const saved = (await platform.read()).state;
    assert.ok(saved.receipts.includes('parallel_a'));
    assert.ok(saved.receipts.includes('parallel_b'));
  } finally {
    controller.dispose();
  }
});
