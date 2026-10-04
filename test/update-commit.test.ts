import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, installCountry, startFocus } from '../src/engine';
import { DemoPlatform, demoTree } from '../src/demo';
import { ProposalSchema, type State } from '../src/model';
import type { Snapshot } from '../src/platform';
import { FocusController } from '../src/workflow';

const tree = demoTree('land', '试验国');
const focus = {
  ...tree.nodes[0],
  days: 30,
  effects: [{ id: 'stability', kind: 'stability' as const, value: 5 }],
};
const transition = {
  country: 'land',
  cause: 'completed' as const,
  reason: '本期完成，转向落实',
  invalidateActive: false,
};
const proposal = ProposalSchema.parse({
  id: 'switch',
  until: 130,
  reason: '时间推进',
  steps: [],
  transitions: [transition],
});

class UpdatePlatform extends DemoPlatform {
  data = startFocus(
    installCountry(createState(100), { ...tree, historical: [], nodes: [focus] }, 100),
    'land',
    focus.id,
  );
  day = 130;
  saves = 0;
  calls = 0;
  outputs: string[] = [];
  override async read(): Promise<Snapshot> {
    return {
      identity: 'floor',
      messageId: 1,
      day: this.day,
      turn: 1,
      state: structuredClone(this.data),
      context: {},
    };
  }
  override async commit(source: Snapshot, state: State): Promise<void> {
    this.data = structuredClone(state);
    this.saves++;
  }
  override async generate() {
    this.calls++;
    assert.ok(this.outputs.length, '不得额外请求模型');
    return { content: this.outputs.shift()! };
  }
}

for (const queued of [true, false]) {
  test(`同一局势提案${queued ? '重复排队' : '保存后重送'}只保存、结算与排入换期一次`, async () => {
    const platform = new UpdatePlatform();
    const controller = new FocusController(platform);
    const source = await platform.read();
    let release!: () => void;
    let entered!: () => void;
    const saving = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commit = platform.commit.bind(platform);
    platform.commit = async (snapshot, state) => {
      entered();
      await gate;
      await commit(snapshot, state);
    };
    const first = controller.commitUpdate(proposal, source);
    try {
      await saving;
      // Both calls retain the pre-save snapshot; deduplication must use the queued read.
      const resend = () => controller.commitUpdate(proposal, { ...source, turn: 2 });
      const second = queued ? resend() : null;
      release();
      const saved = await first;
      const repeated = await (second ?? resend());
      assert.equal(platform.saves, 1, '重复提案不得再次保存');
      assert.equal(platform.data.revision, source.state.revision + 1);
      assert.equal(platform.data.countries.land.stability, source.state.countries.land.stability + 5);
      assert.deepEqual(platform.data.countries.land.progress[focus.id].applied, ['stability']);
      assert.deepEqual(platform.data.receipts, [...source.state.receipts, proposal.id]);
      assert.deepEqual(platform.data.schedules.update, { turn: 1, day: 130 });
      assert.deepEqual(saved.periods, [
        {
          candidate: { id: tree.id, name: tree.name, description: tree.description, evidence: tree.evidence },
          work: { transition },
        },
      ]);
      assert.deepEqual(repeated.periods, []);
      assert.deepEqual(saved.state, platform.data);
      assert.deepEqual(repeated.state, platform.data);
      assert.equal(platform.calls, 0, '提交只返回换期工作，由调用端排程');
    } finally {
      release();
      controller.dispose();
    }
  });
}

test('共用提交拒绝非精确终点与无效换期，不保存部分效果或排程', async () => {
  const platform = new UpdatePlatform();
  const controller = new FocusController(platform);
  const source = await platform.read();
  try {
    await assert.rejects(
      controller.commitUpdate({ ...proposal, until: source.day + 0.5 }, source),
      /更新终点必须等于来源故事时间/,
    );
    await assert.rejects(
      controller.commitUpdate({ ...proposal, until: source.day + 0.5 }, { ...source, day: source.day + 0.5 }),
      /更新终点必须等于来源故事时间/,
    );
    await assert.rejects(
      controller.commitUpdate({ ...proposal, transitions: [transition, transition] }, source),
      /同一次更新不可对同国重复换期/,
    );
    assert.equal(platform.saves, 0);
    assert.deepEqual(platform.data, source.state);
  } finally {
    controller.dispose();
  }
});

test('共用提交保存失败后可重送，只有保存成功才返回换期工作', async () => {
  const platform = new UpdatePlatform();
  const controller = new FocusController(platform);
  const source = await platform.read();
  const commit = platform.commit.bind(platform);
  platform.commit = async () => {
    throw new Error('保存失败');
  };
  try {
    await assert.rejects(controller.commitUpdate(proposal, source), /保存失败/);
    assert.deepEqual(platform.data, source.state);
    platform.commit = commit;
    const saved = await controller.commitUpdate(proposal, source);
    assert.equal(platform.saves, 1);
    assert.equal(saved.periods.length, 1);
    assert.ok(saved.state.receipts.includes(proposal.id));
    assert.deepEqual((await controller.commitUpdate(proposal, source)).periods, []);
    assert.equal(platform.saves, 1);
  } finally {
    controller.dispose();
  }
});

test('共用提交排队期间来源取消，迟到的提案不保存', async () => {
  const platform = new UpdatePlatform();
  const controller = new FocusController(platform);
  const source = await platform.read();
  const lifecycle = new AbortController();
  const task = new AbortController();
  try {
    const pending = controller.commitUpdate(proposal, { ...source, signal: lifecycle.signal }, task.signal);
    lifecycle.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(platform.saves, 0);
    assert.deepEqual(platform.data, source.state);
  } finally {
    controller.dispose();
  }
});

test('独立更新仍结算并生成下一期，重送不再次保存或生成', async () => {
  const platform = new UpdatePlatform();
  const controller = new FocusController(platform);
  controller.config.jobs.update.retries = 0;
  controller.config.jobs.generate.retries = 0;
  const { x, y, ...content } = focus;
  platform.outputs.push(
    JSON.stringify(proposal),
    JSON.stringify({
      summary: '旧期制度已完成，进入落实阶段。',
      tree: {
        ...tree,
        periodTitle: '落实新制度',
        agenda: '巩固已取得的成果',
        branches: [
          {
            id: 'p2_agenda',
            name: content.branch,
            purpose: '落实已建立的制度',
            supporters: '地方议会',
            opposition: '既有利益团体',
            tradeoff: '投入行政资源',
            destination: '形成稳定的执行程序',
          },
        ],
        historical: [],
        nodes: [{ ...content, id: 'p2_new', prerequisites: [[focus.id]] }],
      },
    }),
  );
  try {
    await controller.run('update');
    assert.ok(
      controller.jobs.every((job) => job.state === 'success'),
      JSON.stringify(controller.jobs),
    );
    assert.equal(platform.calls, 2);
    assert.equal(platform.saves, 2, '局势与换期各保存一次');
    assert.equal(platform.data.countries.land.period.number, 2);
    assert.deepEqual(platform.data.schedules.update, { turn: 1, day: 130 });
    assert.deepEqual(platform.data.schedules.generate, { turn: 1, day: 130 });
    const before = structuredClone(platform.data);
    platform.outputs.push(JSON.stringify(proposal));
    await controller.run('update');
    assert.ok(
      controller.jobs.every((job) => job.state === 'success'),
      JSON.stringify(controller.jobs),
    );
    assert.equal(platform.calls, 3);
    assert.equal(platform.saves, 2);
    assert.deepEqual(platform.data, before);
  } finally {
    controller.dispose();
  }
});
