import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoPlatform, demoTree } from '../src/demo';
import { createState, installCountry, startFocus } from '../src/engine';
import type { State } from '../src/model';
import type { IntegrationInput } from '../src/integration';
import type { PromptMessage, Snapshot } from '../src/platform';
import { DEFAULT_TASK, GUIDANCE_TASK, WORLD_CONTEXT_TASK, promptText } from '../src/prompts';
import { FocusController } from '../src/workflow';
import {
  FOCUS_WORLD,
  GUIDANCE_TAG,
  WORLD_FAMILY,
  parseWorldGuidance,
  worldFingerprint,
  worldMember,
  type WorldObservation,
} from '../src/world-proposal';

const tree = demoTree('试验国', '试验国');
const focus = {
  ...tree.nodes[0],
  days: 30,
  effects: [{ id: 'stability', kind: 'stability' as const, value: 5 }],
};
const guidance = '【试验国】\n- 局势：130 日边境商路重开。\n- 国策：主国策如期完成。';

class WorldPlatform extends DemoPlatform {
  data = startFocus(
    installCountry(createState(100), { ...tree, historical: [], nodes: [focus] }, 100),
    '试验国',
    focus.id,
  );
  day = 130.25;
  saves = 0;
  chat = 'chat-a';
  swipe = 0;
  floor = 8;
  last = 8;
  busy = false;
  available = true;
  sent: PromptMessage[][] = [];
  replies: string[] = [];
  observation: WorldObservation = {
    member: { rootId: 'root', taskId: 'world-a' },
    run: null,
    fingerprint: worldFingerprint({ report: 1 }),
  };
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
  readWorldProposal(): WorldObservation | null {
    return this.available ? structuredClone(this.observation) : null;
  }
  override async read(): Promise<Snapshot> {
    return {
      identity: 'floor',
      messageId: this.floor,
      day: this.day,
      turn: 10,
      state: structuredClone(this.data),
      context: {},
    };
  }
  override async commit(_snapshot: Snapshot, state: State): Promise<void> {
    this.data = structuredClone(state);
    this.saves++;
  }
  override async generate(messages: PromptMessage[]) {
    this.sent.push(messages);
    return {
      content:
        this.replies.shift() ??
        JSON.stringify({ id: `guided-${this.sent.length}`, until: this.day, reason: '依指引', steps: [] }),
    };
  }
}
async function setup() {
  const platform = new WorldPlatform();
  const controller = new FocusController(platform);
  controller.config.jobs.update.retries = 0;
  const reply = await controller.integration.prepare(8, { mode: 'request', requestId: 'run-a' });
  assert.equal(reply.status, 'ready');
  const registration = controller.integration.lookup(reply.nonce)!;
  const result = (extractedTags: Record<string, string> = { [GUIDANCE_TAG]: guidance }, extra = {}) => {
    platform.observation.run = {
      messageId: 8,
      at: registration.registeredAt + 1,
      taskResults: [{ taskId: 'world-a', success: true, extractedTags, ...extra }],
    };
  };
  return { platform, controller, registration, result };
}
/** The guided update starts without being awaited; wait until no task is running. */
async function settle(controller: FocusController) {
  for (let i = 0; i < 500; i++) {
    if (!controller.jobs.some((job) => ['queued', 'running'].includes(job.state))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('任务没有结束');
}
const payload = (messages: PromptMessage[]) => {
  const data = messages.find((message) => message.content.includes('"stage":"update"'))!.content;
  return JSON.parse(data.slice(data.indexOf('{'))) as { guidance?: string; now: number };
};

test('成员依副本族根与属性辨识，不以显示名称辨识，歧义不接受', () => {
  const tasks = [
    { id: 'root', syncAsReplicaFamily: true, replicaFamilySpec: WORLD_FAMILY },
    { id: 'world-a', name: '任意名称', replicaFamilyRootId: 'root', replicaFamilyAttrValue: FOCUS_WORLD },
    {
      id: 'other',
      name: '世界时局与经济简报 阿斯塔利亚',
      replicaFamilyRootId: 'root',
      replicaFamilyAttrValue: '其他世界',
    },
  ];
  assert.deepEqual(worldMember({ tasks }), { rootId: 'root', taskId: 'world-a' });
  assert.equal(worldMember({ tasks: [...tasks, { ...tasks[1], id: 'duplicate' }] }), null);
  assert.equal(worldMember({ tasks: [tasks[1], tasks[2]] }), null);
});

test('指引容错解析空白、围栏、最后一个标签与残余转义，空白指引不算', () => {
  const escaped = JSON.stringify(guidance).slice(1, -1);
  for (const text of [
    guidance,
    ` \n${guidance}\n `,
    `\`\`\`\n${guidance}\n\`\`\``,
    `<${GUIDANCE_TAG}>旧的</${GUIDANCE_TAG}><${GUIDANCE_TAG}>\n${guidance}\n</${GUIDANCE_TAG}>`,
    escaped,
    `<${GUIDANCE_TAG}>${escaped}</${GUIDANCE_TAG}>`,
  ]) {
    assert.equal(parseWorldGuidance(text), guidance, text);
  }
  assert.equal(parseWorldGuidance('第一段\n\n\n\n第二段'), '第一段\n\n第二段');
  assert.throws(() => parseWorldGuidance(' \n '));
  assert.throws(() => parseWorldGuidance(`<${GUIDANCE_TAG}>  </${GUIDANCE_TAG}>`));
});

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

test('登记之后的本楼成员纪录带指引时，自动依指引更新并直接保存；之前的纪录只等待', async () => {
  const { platform, controller, registration, result } = await setup();
  result();
  platform.observation.run!.at = registration.registeredAt - 1;
  controller.refreshGuidance();
  assert.equal(controller.worldGuidance.status, 'waiting');
  assert.ok(controller.integration.lookup(registration.nonce), '等待不使登记失效');
  assert.equal(controller.jobs.length, 0);
  platform.observation.run!.at = registration.registeredAt;
  const before = platform.data.countries['试验国'].stability;
  controller.refreshGuidance();
  assert.equal(controller.worldGuidance.status, 'started');
  assert.equal(controller.integration.lookup(registration.nonce), null, '启动后登记交给本地更新');
  await settle(controller);
  const job = controller.jobs[0];
  assert.equal(job.state, 'success', job.message);
  assert.equal(job.label, '依世界指引');
  assert.equal(job.guidance?.text, guidance);
  assert.equal(job.guidance?.nonce, registration.nonce);
  assert.equal(platform.saves, 1);
  assert.ok(platform.data.receipts.includes('guided-1'));
  assert.equal(platform.data.countries['试验国'].stability, before + 5);
  assert.deepEqual(platform.data.schedules.update, { turn: 10, day: 130.25 });
  assert.ok(job.changes?.countries.some((country) => country.id === '试验国'));
  controller.dispose();
});

test('模型收到 data.guidance 与指引说明；同一份指引只启动一次', async () => {
  const { platform, controller, result } = await setup();
  result();
  controller.refreshGuidance();
  controller.refreshGuidance();
  await settle(controller);
  controller.refreshGuidance();
  assert.equal(platform.sent.length, 1);
  assert.equal(payload(platform.sent[0]).guidance, guidance);
  const task = platform.sent[0].find((message) => message.content.includes(GUIDANCE_TASK))!;
  assert.ok(task.content.startsWith(DEFAULT_TASK.update.split('\n')[0]), '说明附在更新任务指示之后');
  controller.dispose();
});

test('更新任务指示被停用时，指引说明仍单独送出；一般更新不带指引', async () => {
  const { platform, controller, result } = await setup();
  controller.config.jobs.update.prompts.find((item) => item.kind === 'task')!.enabled = false;
  result();
  controller.refreshGuidance();
  await settle(controller);
  assert.ok(platform.sent[0].some((message) => message.content === GUIDANCE_TASK));
  await controller.run('update');
  assert.equal(payload(platform.sent[1]).guidance, undefined);
  assert.equal(
    platform.sent[1].some((message) => message.content.includes(GUIDANCE_TASK)),
    false,
  );
  controller.dispose();
});

for (const [name, extractedTags, extra, reason] of [
  ['跳过', {}, { skipped: true }, 'world_skipped'],
  ['失败', { [GUIDANCE_TAG]: guidance }, { success: false }, 'world_failed'],
  ['没有指引', { UpdateVariable: '只有世界变量' }, {}, 'missing_guidance'],
  ['空白指引', { [GUIDANCE_TAG]: '  ' }, {}, 'missing_guidance'],
] as const) {
  test(`世界任务${name}：不依指引更新，登记结束并记下原因`, async () => {
    const { platform, controller, registration, result } = await setup();
    result(extractedTags, extra);
    controller.refreshGuidance();
    await settle(controller);
    assert.equal(controller.worldGuidance.status, 'ended');
    assert.equal(controller.worldGuidance.reason, reason);
    assert.equal(controller.integration.lookup(registration.nonce), null);
    assert.equal(platform.sent.length, 0, '没有让位的排程时不自动更新');
    controller.dispose();
  });
}

for (const change of ['chat', 'swipe', 'time', 'next'] as const) {
  test(`指引送达前 ${change} 改变：结束等待，不依旧指引更新`, async () => {
    const { platform, controller, result } = await setup();
    result();
    if (change === 'chat') {
      platform.chat = 'chat-b';
    }
    if (change === 'swipe') {
      platform.swipe = 1;
    }
    if (change === 'time') {
      platform.day += 1;
    }
    if (change === 'next') {
      platform.last = 9;
    }
    controller.refreshGuidance();
    await settle(controller);
    assert.equal(controller.worldGuidance.status, 'ended');
    assert.equal(platform.sent.length, 0);
    assert.equal(platform.saves, 0);
    controller.dispose();
  });
}

test('MVU 忙碌或读不到工作流时继续等待，恢复后才依指引更新', async () => {
  const { platform, controller, registration, result } = await setup();
  result();
  platform.busy = true;
  controller.refreshGuidance();
  assert.equal(controller.worldGuidance.status, 'waiting');
  assert.equal(controller.worldGuidance.reason, 'mvu_busy');
  platform.busy = false;
  platform.available = false;
  controller.refreshGuidance();
  assert.equal(controller.worldGuidance.reason, 'workflow_unknown');
  assert.ok(controller.integration.lookup(registration.nonce));
  platform.available = true;
  controller.refreshGuidance();
  await settle(controller);
  assert.equal(platform.saves, 1);
  controller.dispose();
});

test('等待中手动更新使登记失效，之后送达的指引不再启动第二次更新', async () => {
  const { platform, controller, result } = await setup();
  await controller.run('update');
  assert.equal(controller.worldGuidance.status, 'none');
  result();
  controller.refreshGuidance();
  await settle(controller);
  assert.equal(platform.sent.length, 1);
  assert.equal(payload(platform.sent[0]).guidance, undefined);
  controller.dispose();
});

test('依指引更新失败保留指引供重试；楼层已变时重试不套用', async () => {
  const { platform, controller, result } = await setup();
  platform.replies.push('{invalid');
  result();
  controller.refreshGuidance();
  await settle(controller);
  const failed = controller.jobs[0];
  assert.equal(failed.state, 'failed');
  assert.equal(failed.guidance?.text, guidance);
  assert.equal(platform.saves, 0);
  platform.floor = 9;
  await controller.runGuided(failed.guidance!);
  assert.equal(controller.jobs[0].state, 'failed');
  assert.match(controller.jobs[0].message, /世界指引所属的楼层或故事时间已改变/);
  assert.equal(platform.sent.length, 1, '楼层已变时不呼叫模型');
  platform.floor = 8;
  await controller.runGuided(failed.guidance!);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  assert.equal(payload(platform.sent[1]).guidance, guidance);
  assert.equal(platform.saves, 1);
  controller.dispose();
});
