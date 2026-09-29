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

test('手動任務不為排程讀取存檔，自動任務仍依樓層檢查', async () => {
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
  assert.equal(controller.jobs.find((job) => job.state === 'cancelled')?.kind, 'update');
  assert.ok(!(await platform.read()).state.receipts.includes('first'));
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
  const queued = controller.run('reshape');
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

test('同一任務重複點擊不額外排隊或呼叫 API，完成後仍能手動重跑', async () => {
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
    release(JSON.stringify({ id: 'once', until: 114, reason: '手動更新', steps: [] }));
    await first;
    platform.outputs.push(async () => JSON.stringify({ id: 'again', until: 114, reason: '重跑', steps: [] }));
    await controller.run('update');
    assert.equal(platform.requests, 2);
    assert.ok((await platform.read()).state.receipts.includes('again'));
  } finally {
    controller.dispose();
  }
});

test('正文生命週期取消正在生成的工作，供應商遲到回應也不提交', async () => {
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
    release(JSON.stringify({ id: 'late', until: 114, reason: '遲到回應', steps: [] }));
    await tick();
    assert.equal(controller.jobs[0].state, 'cancelled');
    assert.deepEqual((await platform.read()).state, before);
  } finally {
    controller.dispose();
  }
});

test('背景生成期間的玩家操作保留，回應套用到最新國策而不比對來源', async () => {
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
    release(JSON.stringify({ id: 'latest', until: 114, reason: '更新局勢', steps: [] }));
    await pending;
    assert.equal(controller.jobs[0].state, 'success');
    assert.equal((await platform.read()).state.countries.augustium.progress.focus_1_1.status, 'paused');
    assert.ok((await platform.read()).state.receipts.includes('latest'));
  } finally {
    controller.dispose();
  }
});

test('並行任務回應依序保存，後一筆保留先前已保存的結果', async () => {
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
  const controller = new FocusController(platform);
  controller.config.concurrency = 2;
  controller.config.sources.maxInputCharacters = 200000;
  try {
    const first = controller.run('update');
    const second = controller.run('reshape');
    for (let i = 0; i < 100 && releases.length < 2; i++) {
      await tick();
    }
    assert.equal(releases.length, 2, JSON.stringify(controller.jobs));
    releases[0](JSON.stringify({ id: 'parallel_a', until: 114, reason: '更新', steps: [] }));
    releases[1](JSON.stringify({ id: 'parallel_b', until: 114, reason: '改樹', steps: [] }));
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
