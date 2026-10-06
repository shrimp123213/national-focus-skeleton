import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoPlatform, demoTree } from '../src/demo';
import { createState, installCountry } from '../src/engine';
import { ProposalSchema, type State } from '../src/model';
import type { IntegrationInput } from '../src/integration';
import type { Platform, PromptMessage, Snapshot } from '../src/platform';
import { ProposalRepairSchema, type ProposalRepairMaterial } from '../src/proposal-repair';
import { REPAIR_TASK, WORLD_CONTEXT_TASK, DEFAULT_TASK, promptText } from '../src/prompts';
import { FocusController } from '../src/workflow';
import { worldFingerprint, type WorldObservation } from '../src/world-proposal';

const tree = demoTree('试验国', '试验国');
const valid = { reason: '删除不存在的选策，保留世界结果', steps: [] };
const original = { ...valid, id: 'world-original', until: 130.25 };

test('更新 task 的世界指示原文也追加至自订任务，既有设定不变且不重复', () => {
  const item = {
    id: 'task',
    kind: 'task' as const,
    name: '任务指示',
    role: 'system' as const,
    content: '自订更新指示',
    enabled: true,
  };
  assert.equal(promptText(item, 'update'), `${item.content}\n${WORLD_CONTEXT_TASK}`);
  assert.equal(item.content, '自订更新指示');
  assert.equal(promptText({ ...item, content: DEFAULT_TASK.update }, 'update'), DEFAULT_TASK.update);
  assert.equal(promptText(item, 'reshape'), item.content);
});

class RepairPlatform extends DemoPlatform {
  data = installCountry(createState(100), { ...tree, historical: [] }, 100);
  day = 130.25;
  chat = 'chat-a';
  swipe = 0;
  last = 8;
  busy = false;
  saves = 0;
  stored = new Map<string, unknown>();
  requests: PromptMessage[][] = [];
  outputs: (string | Error)[] = [];
  respond?: () => Promise<void>;
  observation: WorldObservation = {
    member: { rootId: 'root', taskId: 'world-a' },
    run: null,
    patchLog: null,
    world: { 局势: '两国签署通商协议' },
    fingerprint: worldFingerprint({ 局势: '两国签署通商协议' }),
  };
  override chatId() {
    return this.chat;
  }
  readIntegration(): IntegrationInput {
    return {
      chatId: this.chat,
      messageId: 8,
      lastMessageId: this.last,
      swipeId: this.swipe,
      role: 'assistant',
      extraAnalysis: this.busy,
      timePath: 'now',
      data: { stat_data: { now: this.day }, 国策: this.data },
      world: { ...this.observation.member!, fingerprint: this.observation.fingerprint },
    };
  }
  readWorldProposal() {
    return structuredClone(this.observation);
  }
  loadProposalRepair() {
    return structuredClone(this.stored.get(this.chat));
  }
  saveProposalRepair(material: ProposalRepairMaterial | null, chat: string) {
    if (material) {
      this.stored.set(chat, structuredClone(material));
    } else {
      this.stored.delete(chat);
    }
  }
  override async read(): Promise<Snapshot> {
    return {
      identity: 'floor',
      messageId: 8,
      day: this.day,
      turn: 10,
      state: structuredClone(this.data),
      context: { history: ['本楼正文'], world: this.observation.world },
    };
  }
  override async commit(_snapshot: Snapshot, state: State) {
    this.saves++;
    this.data = structuredClone(state);
  }
  override async generate(...args: Parameters<Platform['generate']>) {
    this.requests.push(structuredClone(args[0]));
    await this.respond?.();
    const output = this.outputs.shift() ?? JSON.stringify(valid);
    if (output instanceof Error) {
      throw output;
    }
    return { content: output };
  }
}

async function setup(reason: 'invalid_rules' | 'invalid_proposal' | 'until_mismatch' = 'invalid_rules') {
  const platform = new RepairPlatform();
  platform.data.countries[tree.id].control = 'ai';
  const controller = new FocusController(platform);
  controller.config.jobs.update.retries = 0;
  const ready = await controller.integration.prepare(8, { mode: 'request', requestId: 'world-run' });
  assert.equal(ready.status, 'ready');
  const registration = controller.integration.lookup(ready.nonce)!;
  let raw = JSON.stringify({
    nonce: ready.nonce,
    proposal: {
      ...original,
      steps: [
        {
          at: 120,
          facts: [],
          events: [],
          selections: [{ country: tree.id, node: 'missing', reason: '原意图' }],
        },
      ],
    },
  });
  if (reason === 'invalid_proposal') {
    raw = '{"nonce":"' + ready.nonce + '","proposal": unfinished';
  } else if (reason === 'until_mismatch') {
    raw = JSON.stringify({ nonce: ready.nonce, proposal: { ...original, until: 1 } });
  }
  platform.observation.run = {
    messageId: 8,
    at: registration.registeredAt + 1,
    taskResults: [{ taskId: 'world-a', success: true, extractedTags: { 国策提案: raw } }],
  };
  controller.refreshProposal();
  return { platform, controller, registration, raw };
}

for (const reason of ['invalid_rules', 'invalid_proposal', 'until_mismatch'] as const) {
  test(`${reason} 保存原文、完整来源、基底、世界与错误；修复只待审，接受才保存`, async () => {
    const { platform, controller, registration, raw } = await setup(reason);
    try {
      const material = ProposalRepairSchema.parse(platform.loadProposalRepair());
      assert.equal(material.raw, raw);
      assert.equal(material.reason, reason);
      assert.deepEqual(material.registration, registration);
      assert.deepEqual(material.world, platform.observation.world);
      assert.ok(material.errors[0].length);
      if (reason === 'invalid_rules') {
        assert.equal(controller.integration.lookup(registration.nonce), null);
        assert.match(material.errors[0], /国策不存在/);
      }
      const before = structuredClone(platform.data);
      const world = structuredClone(platform.observation);
      // Script owns both fields, including malformed model values.
      platform.outputs.push(JSON.stringify({ ...valid, id: {}, until: 'wrong' }));
      assert.equal(await controller.repairProposal(), true);
      assert.equal(controller.integration.lookup(registration.nonce), null);
      assert.equal(controller.externalProposal.status, 'pending');
      assert.equal(controller.externalProposal.origin, 'repair');
      assert.equal(platform.saves, 0);
      assert.deepEqual(platform.data, before);
      const repaired = controller.externalProposal.proposal!;
      assert.notEqual(repaired.id, original.id);
      assert.equal(repaired.until, registration.now);
      const messages = platform.requests[0];
      assert.equal(messages.find((m) => m.name === '修复任务指示')?.content, REPAIR_TASK);
      const content = messages.find((m) => m.name === '任务资料')!.content;
      const payload = JSON.parse(content.slice(content.indexOf('{')));
      assert.equal(payload.failed.raw, raw);
      assert.deepEqual(payload.failed.errors, material.errors);
      assert.deepEqual(payload.world, material.world);
      assert.equal(payload.context.world, undefined);
      assert.equal(payload.schema.properties.id, undefined);
      controller.refreshProposal();
      assert.equal(controller.externalProposal.status, 'pending');
      assert.equal(await controller.accept(), true);
      assert.equal(await controller.accept(), false);
      assert.equal(platform.saves, 1);
      assert.deepEqual(platform.data.receipts, [repaired.id]);
      assert.equal(platform.loadProposalRepair(), undefined);
      assert.deepEqual(platform.observation, world);
    } finally {
      controller.dispose();
    }
  });
}

for (const failure of [
  new Error('API unavailable'),
  '{invalid',
  JSON.stringify({ reason: '仍非法', steps: [{ at: 1 }] }),
]) {
  test(`修复失败保留材料、显示错误并可重试：${String(failure).slice(0, 30)}`, async () => {
    const { platform, controller } = await setup();
    try {
      const material = platform.loadProposalRepair();
      platform.outputs.push(failure);
      assert.equal(await controller.repairProposal(), false);
      assert.equal(controller.proposalRepair?.status, 'failed');
      assert.ok(controller.proposalRepair?.error);
      assert.deepEqual(platform.loadProposalRepair(), material);
      assert.equal(platform.saves, 0);
      assert.equal(await controller.repairProposal(), true);
      assert.equal(controller.externalProposal.status, 'pending');
    } finally {
      controller.dispose();
    }
  });
}

for (const change of ['chat', 'swipe', 'time', 'state', 'latest', 'world', 'run'] as const) {
  test(`修复后 ${change} 改变，接受时过期且不保存`, async () => {
    const { platform, controller } = await setup();
    try {
      assert.equal(await controller.repairProposal(), true);
      switch (change) {
        case 'chat':
          platform.chat = 'chat-b';
          break;
        case 'swipe':
          platform.swipe++;
          break;
        case 'time':
          platform.day++;
          break;
        case 'state':
          platform.data.countries[tree.id].stability++;
          break;
        case 'latest':
          platform.last++;
          break;
        case 'world':
          platform.observation.world = { 局势: '战争' };
          break;
        case 'run':
          platform.observation.run!.at++;
          break;
      }
      assert.equal(await controller.accept(), false);
      assert.equal(controller.externalProposal.status, 'expired');
      assert.equal(controller.proposalRepair?.status, 'expired');
      assert.equal(platform.saves, 0);
    } finally {
      controller.dispose();
    }
  });
}

test('局势更新即使失败，也作废修复材料且不复活原 nonce', async () => {
  const { platform, controller, registration } = await setup();
  try {
    platform.outputs.push(new Error('update failed'));
    await controller.run('update');
    assert.equal(controller.proposalRepair, null);
    assert.equal(platform.loadProposalRepair(), undefined);
    assert.equal(controller.integration.lookup(registration.nonce), null);
    assert.equal(await controller.repairProposal(), false);
    assert.equal(platform.saves, 0);
  } finally {
    controller.dispose();
  }
});

test('修复生成中改用局势更新，迟到修复不会进入待审', async () => {
  const { platform, controller } = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  platform.respond = async () => {
    started();
    await gate;
  };
  const repair = controller.repairProposal();
  try {
    await running;
    platform.respond = undefined;
    platform.outputs.push(JSON.stringify(original));
    await controller.run('update');
    release();
    assert.equal(await repair, false);
    assert.notEqual(controller.externalProposal.status, 'pending');
    assert.equal(controller.proposalRepair, null);
    assert.equal(platform.loadProposalRepair(), undefined);
  } finally {
    release();
    controller.dispose();
  }
});

test('重载恢复材料但不恢复 nonce；来源曾过期后不能因还原数据复活', async () => {
  const { platform, controller, registration } = await setup();
  controller.dispose();
  const reloaded = new FocusController(platform);
  try {
    await reloaded.initialize();
    assert.equal(reloaded.proposalRepair?.status, 'available');
    assert.equal(reloaded.integration.lookup(registration.nonce), null);
    platform.swipe++;
    reloaded.refreshProposal();
    assert.equal(reloaded.proposalRepair?.status, 'expired');
    platform.swipe--;
    assert.equal(await reloaded.repairProposal(), false);
    reloaded.dispose();
    const again = new FocusController(platform);
    try {
      await again.initialize();
      assert.equal(again.proposalRepair?.status, 'expired');
      assert.equal(await again.repairProposal(), false);
    } finally {
      again.dispose();
    }
  } finally {
    reloaded.dispose();
  }
});

test('修复输入过大不会呼叫 API，完整材料不截断；调整上限后可重试', async () => {
  const { platform, controller } = await setup();
  try {
    controller.config.sources.maxInputCharacters = 1000;
    assert.equal(await controller.repairProposal(), false);
    assert.equal(platform.requests.length, 0);
    assert.match(controller.proposalRepair!.error!, /输入过大/);
    assert.ok(platform.loadProposalRepair());
    controller.config.sources.maxInputCharacters = 120000;
    assert.equal(await controller.repairProposal(), true);
  } finally {
    controller.dispose();
  }
});

test('MVU 暂忙不作废修复预览，恢复后仍需人工接收', async () => {
  const { platform, controller } = await setup();
  try {
    await controller.repairProposal();
    platform.busy = true;
    assert.equal(await controller.accept(), false);
    assert.equal(platform.saves, 0);
    platform.busy = false;
    controller.refreshProposal();
    assert.equal(controller.externalProposal.status, 'pending');
    assert.equal(await controller.accept(), true);
  } finally {
    controller.dispose();
  }
});

test('新世界请求取代修复材料，不能接收旧的修复预览', async () => {
  const { platform, controller } = await setup();
  try {
    await controller.repairProposal();
    const next = await controller.integration.prepare(8, { mode: 'request', requestId: 'world-next' });
    assert.equal(next.status, 'ready');
    assert.equal(controller.proposalRepair, null);
    assert.equal(platform.loadProposalRepair(), undefined);
    assert.equal(await controller.accept(), false);
    assert.equal(platform.saves, 0);
  } finally {
    controller.dispose();
  }
});

test('修复接受排队读取期间国策改变，不保存旧预览', async () => {
  const { platform, controller } = await setup();
  try {
    await controller.repairProposal();
    const read = platform.read.bind(platform);
    platform.read = async () => {
      const snapshot = await read();
      platform.data.countries[tree.id].stability++;
      return snapshot;
    };
    assert.equal(await controller.accept(), false);
    assert.equal(controller.externalProposal.status, 'expired');
    assert.equal(platform.saves, 0);
  } finally {
    controller.dispose();
  }
});

test('修复待处理时自动局势更新让位，不呼叫第二条推演', async () => {
  const { platform, controller } = await setup();
  try {
    controller.config.jobs.identify.schedule = 'manual';
    controller.config.jobs.reshape.schedule = 'manual';
    controller.config.jobs.update.schedule = 'reply';
    await controller.runScheduled();
    assert.equal(platform.requests.length, 0);
    assert.equal(controller.proposalRepair?.status, 'available');
  } finally {
    controller.dispose();
  }
});

for (const unsafe of ['missing', 'nonce', 'receipted'] as const) {
  test(`${unsafe} 不建立可重复结算的修复入口`, async () => {
    const platform = new RepairPlatform();
    if (unsafe === 'receipted') {
      platform.data.receipts.push(original.id);
    }
    const controller = new FocusController(platform);
    try {
      const ready = await controller.integration.prepare(8, { mode: 'request', requestId: unsafe });
      assert.equal(ready.status, 'ready');
      const registered = controller.integration.lookup(ready.nonce)!;
      platform.observation.run = {
        messageId: 8,
        at: registered.registeredAt + 1,
        taskResults: [
          {
            taskId: 'world-a',
            success: true,
            extractedTags: {
              国策提案:
                unsafe === 'missing'
                  ? ''
                  : JSON.stringify({
                      nonce: unsafe === 'nonce' ? 'wrong' : ready.nonce,
                      proposal: { ...original, until: 1, steps: 'invalid' },
                    }),
            },
          },
        ],
      };
      controller.refreshProposal();
      assert.equal(controller.proposalRepair, null);
      assert.equal(await controller.repairProposal(), false);
      assert.equal(platform.requests.length, 0);
    } finally {
      controller.dispose();
    }
  });
}

test('修复共用 update 专属 API 路由，替换被停用的 task 指示', async () => {
  const { platform, controller } = await setup();
  try {
    controller.config.apis.push({ ...controller.config.apis[0], name: 'update-only' });
    controller.config.jobs.update.api = 'update-only';
    controller.config.jobs.update.prompts.find((p) => p.kind === 'task')!.enabled = false;
    const generate = platform.generate.bind(platform);
    platform.generate = async (...args) => {
      assert.equal(args[1].name, 'update-only');
      assert.equal(args[0].filter((m) => m.content === REPAIR_TASK).length, 1);
      return generate(...args);
    };
    assert.equal(await controller.repairProposal(), true);
  } finally {
    controller.dispose();
  }
});

test('修复接受尚在读取时改用局势更新，即使本地更新失败也不能接收旧修复', async () => {
  const { platform, controller } = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await controller.repairProposal();
    const read = platform.read.bind(platform);
    let first = true;
    platform.read = async () => {
      if (first) {
        first = false;
        await gate;
      }
      return read();
    };
    const accepting = controller.accept();
    platform.outputs.push(new Error('local update failed'));
    await controller.run('update');
    release();
    assert.equal(await accepting, false);
    assert.equal(platform.saves, 0);
    assert.equal(controller.proposalRepair, null);
    assert.equal(controller.externalProposal.reason, 'update_started');
  } finally {
    release();
    controller.dispose();
  }
});
