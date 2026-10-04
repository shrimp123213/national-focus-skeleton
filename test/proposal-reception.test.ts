import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoPlatform, demoTree } from '../src/demo';
import { createState, installCountry, startFocus } from '../src/engine';
import { ProposalSchema, type State } from '../src/model';
import type { IntegrationInput, IntegrationReady } from '../src/integration';
import type { Snapshot } from '../src/platform';
import { FocusController } from '../src/workflow';
import { TavernPlatform, type TavernApi } from '../src/tavern';
import {
  FOCUS_WORLD,
  WORLD_FAMILY,
  parseWorldProposal,
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
const proposal = ProposalSchema.parse({ id: 'external-1', until: 130.25, reason: '推演', steps: [] });
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
  last = 8;
  busy = false;
  available = true;
  body = '正文';
  observation: WorldObservation = {
    member: { rootId: 'root', taskId: 'world-a' },
    run: null,
    fingerprint: worldFingerprint({ report: 1 }),
    patchLog: null,
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
      messageId: 8,
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
  override async generate() {
    return { content: '{invalid-json' };
  }
}
async function setup() {
  const platform = new WorldPlatform();
  const controller = new FocusController(platform);
  const reply = await controller.integration.prepare(8, { mode: 'request', requestId: 'run-a' });
  assert.equal(reply.status, 'ready');
  const registration = controller.integration.lookup(reply.nonce)!;
  platform.observation.run = {
    messageId: 8,
    at: registration.registeredAt + 1,
    taskResults: [
      {
        taskId: 'world-a',
        success: true,
        extractedTags: { 国策提案: JSON.stringify({ nonce: reply.nonce, proposal }) },
      },
    ],
  };
  return { platform, controller, reply: reply as IntegrationReady, registration };
}

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

test('提案容错解析空白、围栏、最后一个裸标签、字符串与残余转义', () => {
  const raw = JSON.stringify({ nonce: 'n', proposal });
  const encoded = JSON.stringify(raw);
  for (const text of [
    raw,
    ` \n${raw}\n `,
    `\`\`\`json\n${raw}\n\`\`\``,
    `<国策提案>bad</国策提案><国策提案>${raw}</国策提案>`,
    encoded,
    encoded.slice(1, -1),
  ]) {
    assert.deepEqual(parseWorldProposal(text), { nonce: 'n', proposal });
  }
  assert.throws(() => parseWorldProposal('{broken'));
  assert.throws(() => parseWorldProposal(JSON.stringify({ nonce: '', proposal })));
});

test('只有登记之后的本楼成员纪录才进入待接收，等待不使 nonce 失效', async () => {
  const { platform, controller, registration, reply } = await setup();
  platform.observation.run!.at = registration.registeredAt - 1;
  controller.refreshProposal();
  assert.equal(controller.externalProposal.status, 'waiting');
  assert.ok(controller.integration.lookup(reply.nonce));
  platform.observation.run!.at = registration.registeredAt;
  controller.refreshProposal();
  assert.equal(controller.externalProposal.status, 'pending');
  assert.equal(
    controller.externalProposal.preview!.countries['试验国'].stability,
    platform.data.countries['试验国'].stability + 5,
  );
  assert.equal(platform.saves, 0);
  controller.dispose();
});

test('合法空世界 patch 不拒收；两次接收只保存、结算与记录排程一次', async () => {
  const { platform, controller, registration, reply } = await setup();
  platform.observation.patchLog = {
    messageId: 8,
    timestamp: registration.registeredAt,
    ops: [],
    issues: [],
    failedFragments: [],
  };
  controller.refreshProposal();
  assert.equal(controller.externalProposal.evidence!.changed, false);
  assert.equal(controller.externalProposal.evidence!.patch.operationCount, 0);
  const before = platform.data.countries['试验国'].stability;
  const one = controller.accept();
  const two = controller.accept();
  assert.equal(one, two);
  assert.deepEqual(await Promise.all([one, two]), [true, true]);
  assert.equal(platform.saves, 1);
  assert.equal(platform.data.countries['试验国'].stability, before + 5);
  assert.deepEqual(platform.data.schedules.update, { turn: 10, day: 130.25 });
  assert.equal(controller.integration.lookup(reply.nonce), null);
  assert.equal(await controller.accept(), false);
  assert.equal(controller.externalProposal.status, 'accepted');
  controller.dispose();
});

test('世界更新后的差异只供审阅；合并日志不把其他世界问题归给负责世界', async () => {
  const { platform, controller, registration, reply } = await setup();
  platform.observation.fingerprint = worldFingerprint({ report: 2 });
  platform.observation.patchLog = {
    messageId: 8,
    timestamp: registration.registeredAt,
    ops: [{ op: 'replace', path: `/世界/${FOCUS_WORLD}/刊报日期`, value: 2 }],
    issues: [{ kind: 'apply', message: '其他世界失败', op: { path: '/其他世界/日期' } }],
    failedFragments: [{ index: 1, snippet: '不能解析或归属的片段', message: '语法错误' }],
  };
  assert.ok(controller.integration.lookup(reply.nonce), '世界资料改变不作废国策来源');
  controller.refreshProposal();
  const evidence = controller.externalProposal.evidence!;
  assert.equal(evidence.changed, true);
  assert.equal(evidence.patch.operationCount, 1);
  assert.deepEqual(evidence.patch.issues, []);
  assert.equal(evidence.patch.unassigned, 1);
  assert.equal(await controller.accept(), true);
  controller.dispose();
});

for (const change of ['chat', 'swipe', 'time', 'next', 'state', 'world', 'result'] as const) {
  test(`预览后 ${change} 改变不能接收`, async () => {
    const { platform, controller } = await setup();
    controller.refreshProposal();
    if (change === 'chat') {
      platform.chat = 'chat-b';
    }
    if (change === 'swipe') {
      platform.swipe = 1;
    }
    if (change === 'time') {
      platform.day += 1 / 1440;
    }
    if (change === 'next') {
      platform.last = 9;
    }
    if (change === 'state') {
      platform.data.countries['试验国'].stability++;
    }
    if (change === 'world') {
      platform.observation.fingerprint = worldFingerprint({ report: 2 });
    }
    if (change === 'result') {
      platform.observation.run!.at++;
    }
    assert.equal(await controller.accept(), false);
    assert.equal(platform.saves, 0);
    assert.equal(controller.externalProposal.status, 'expired');
    controller.dispose();
  });
}

for (const failure of [
  'until',
  'rules',
  'nonce',
  'member',
  'failed',
  'skipped',
  'issues',
  'missing',
  'malformed',
] as const) {
  test(`${failure} 直接阻止接收`, async () => {
    const { platform, controller, registration } = await setup();
    const result = platform.observation.run!.taskResults[0];
    if (failure === 'until') {
      result.extractedTags!.国策提案 = JSON.stringify({
        nonce: registration.nonce,
        proposal: { ...proposal, until: 130 },
      });
    }
    if (failure === 'rules') {
      result.extractedTags!.国策提案 = JSON.stringify({
        nonce: registration.nonce,
        proposal: { ...proposal, steps: [{ country: 'missing', at: 130, action: 'start', focus: 'no' }] },
      });
    }
    if (failure === 'nonce') {
      result.extractedTags!.国策提案 = JSON.stringify({ nonce: 'other', proposal });
    }
    if (failure === 'member') {
      platform.observation.member!.taskId = 'other';
    }
    if (failure === 'failed') {
      result.success = false;
    }
    if (failure === 'skipped') {
      result.skipped = true;
      result.skipReason = '未到期';
    }
    if (failure === 'issues') {
      platform.observation.patchLog = {
        messageId: 8,
        timestamp: registration.registeredAt,
        ops: [],
        failedFragments: [],
        issues: [
          {
            kind: 'apply',
            message: '不能写入',
            op: { op: 'replace', path: `/${FOCUS_WORLD}/日期`, value: 1 },
          },
        ],
      };
    }
    if (failure === 'missing') {
      result.extractedTags = {};
    }
    if (failure === 'malformed') {
      result.extractedTags!.国策提案 = '{bad';
    }
    controller.refreshProposal();
    assert.ok(['rejected', 'unavailable'].includes(controller.externalProposal.status));
    assert.equal(await controller.accept(), false);
    assert.equal(platform.saves, 0);
    controller.dispose();
  });
}

test('国策规则拒收保留具体原因，供界面和诊断记录显示', async () => {
  const { platform, controller, reply } = await setup();
  platform.observation.run!.taskResults[0].extractedTags!.国策提案 = JSON.stringify({
    nonce: reply.nonce,
    proposal: {
      ...proposal,
      steps: [
        {
          at: 130.25,
          facts: [],
          events: [],
          selections: [{ country: '试验国', node: 'missing', reason: '选策' }],
        },
      ],
    },
  });
  controller.refreshProposal();
  assert.equal(controller.externalProposal.reason, 'invalid_rules');
  assert.ok(controller.externalProposal.detail);
  assert.equal(controller.proposalDiagnostics[0].detail, controller.externalProposal.detail);
  assert.equal(await controller.accept(), false);
  assert.equal(platform.saves, 0);
  controller.dispose();
});

for (const failure of ['none', 'apply', 'fragment'] as const) {
  test(`世界路径自动修复不等于写入失败，后续 ${failure} 仍独立检查`, async () => {
    const { platform, controller, registration } = await setup();
    const op = { op: 'replace', path: `/世界/${FOCUS_WORLD}/日期`, value: 1 };
    const healed = { kind: 'heal', message: '路径规范化：别名改为规范路径', op };
    platform.observation.patchLog = {
      messageId: 8,
      timestamp: registration.registeredAt,
      ops: [op],
      issues: failure === 'apply' ? [healed, { kind: 'apply', message: '写入未生效', op }] : [healed],
      failedFragments:
        failure === 'fragment' ? [{ index: 1, message: '无法套用', snippet: JSON.stringify(op) }] : [],
    };
    controller.refreshProposal();
    assert.equal(controller.externalProposal.status, failure === 'none' ? 'pending' : 'rejected');
    assert.equal(controller.externalProposal.evidence!.patch.issues[0].kind, 'heal');
    assert.equal(await controller.accept(), failure === 'none');
    assert.equal(platform.saves, failure === 'none' ? 1 : 0);
    controller.dispose();
  });
}

test('MVU 忙碌暂缓接收但不作废登记；工作流正文注入不影响登记', async () => {
  const { platform, controller, reply } = await setup();
  controller.refreshProposal();
  platform.busy = true;
  assert.equal(await controller.accept(), false);
  assert.equal(controller.externalProposal.reason, 'mvu_busy');
  platform.busy = false;
  platform.body += '<工作流变量更新>注入</工作流变量更新>';
  assert.ok(controller.integration.lookup(reply.nonce));
  controller.refreshProposal();
  assert.equal(await controller.accept(), true);
  controller.dispose();
});

test('工作流状态未知或纪录消失时不能接收，恢复相同纪录后仍可审阅', async () => {
  const { platform, controller, reply } = await setup();
  controller.refreshProposal();
  platform.available = false;
  assert.equal(await controller.accept(), false);
  assert.equal(controller.externalProposal.reason, 'workflow_unknown');
  platform.available = true;
  const run = platform.observation.run;
  platform.observation.run = null;
  controller.refreshProposal();
  assert.equal(controller.externalProposal.status, 'waiting');
  assert.ok(controller.integration.lookup(reply.nonce));
  platform.observation.run = run;
  controller.refreshProposal();
  assert.equal(await controller.accept(), true);
  controller.dispose();
});

test('排队保存时再次检查，读取快照期间变更不能通过已看过的预览', async () => {
  const { platform, controller } = await setup();
  controller.refreshProposal();
  const original = platform.read.bind(platform);
  let reads = 0;
  platform.read = async () => {
    const snapshot = await original();
    if (++reads === 2) {
      platform.data.countries['试验国'].stability++;
    }
    return snapshot;
  };
  assert.equal(await controller.accept(), false);
  assert.equal(platform.saves, 0);
  controller.dispose();
});

test('被覆写为接收前状态后可人工重试；普通 nonce 查询保持失效', async () => {
  const { platform, controller, reply } = await setup();
  const before = structuredClone(platform.data);
  controller.refreshProposal();
  assert.equal(await controller.accept(), true);
  platform.data = before;
  controller.refreshProposal();
  assert.equal(controller.externalProposal.status, 'overwritten');
  assert.equal(controller.integration.lookup(reply.nonce), null);
  assert.equal(await controller.accept(), true);
  assert.equal(platform.saves, 2);
  assert.equal(platform.data.receipts.filter((id) => id === proposal.id).length, 1);
  assert.equal(controller.externalProposal.status, 'accepted');
  controller.dispose();
});

for (const afterDetection of [false, true]) {
  test(`覆写${afterDetection ? '已侦测后' : '同时'}另有国策变更，拒绝重试`, async () => {
    const { platform, controller } = await setup();
    const before = structuredClone(platform.data);
    controller.refreshProposal();
    await controller.accept();
    platform.data = before;
    if (afterDetection) {
      controller.refreshProposal();
    }
    platform.data.countries['试验国'].stability++;
    controller.refreshProposal();
    assert.equal(controller.externalProposal.status, 'expired');
    assert.equal(await controller.accept(), false);
    assert.equal(platform.saves, 1);
    controller.dispose();
  });
}

test('手动补救开始立即取消待接收，失败后晚到提案不复活', async () => {
  const { controller, reply } = await setup();
  controller.config.jobs.update.retries = 0;
  controller.refreshProposal();
  const run = controller.run('update');
  assert.equal(controller.externalProposal.status, 'expired');
  assert.equal(controller.externalProposal.reason, 'update_started');
  assert.equal(controller.integration.lookup(reply.nonce), null);
  await run;
  controller.refreshProposal();
  assert.equal(controller.externalProposal.status, 'expired');
  assert.equal(await controller.accept(), false);
  controller.dispose();
});

test('拒收与新请求使旧提案失效；重载不恢复；诊断可清除且不保存世界快照', async () => {
  const { platform, controller, reply } = await setup();
  controller.refreshProposal();
  controller.reject();
  assert.equal(controller.externalProposal.reason, 'user_rejected');
  assert.equal(controller.integration.lookup(reply.nonce), null);
  const second = await controller.integration.prepare(8, { mode: 'request', requestId: 'run-b' });
  assert.equal(second.status, 'ready');
  platform.observation.run!.at = controller.integration.lookup(second.nonce)!.registeredAt;
  controller.refreshProposal();
  assert.equal(controller.externalProposal.reason, 'nonce_mismatch');
  assert.ok(controller.integration.lookup(second.nonce), '晚到旧轮结果不得取消新请求');
  const reloaded = new FocusController(platform);
  reloaded.refreshProposal();
  assert.equal(reloaded.externalProposal.status, 'none');
  assert.ok(controller.proposalDiagnostics.length);
  assert.equal(JSON.stringify(controller.proposalDiagnostics).includes('"report"'), false);
  controller.clearProposalDiagnostics();
  assert.deepEqual(controller.proposalDiagnostics, []);
  reloaded.dispose();
  controller.dispose();
});

function periodReply(): string {
  const { x, y, ...content } = focus;
  return JSON.stringify({
    summary: '旧期完成，进入落实阶段',
    tree: {
      ...tree,
      periodTitle: '落实新制度',
      agenda: '巩固成果',
      historical: [],
      branches: [
        {
          id: 'p2_agenda',
          name: content.branch,
          purpose: '落实制度',
          supporters: '议会',
          opposition: '既有团体',
          tradeoff: '行政资源',
          destination: '稳定执行',
        },
      ],
      nodes: [{ ...content, id: 'p2_new', prerequisites: [[focus.id]] }],
    },
  });
}
async function jobsFinished(controller: FocusController): Promise<void> {
  if (controller.jobs.every((job) => !['queued', 'running'].includes(job.state))) {
    return;
  }
  await new Promise<void>((resolve) => {
    const stop = controller.subscribe(() => {
      if (controller.jobs.every((job) => !['queued', 'running'].includes(job.state))) {
        stop();
        resolve();
      }
    });
  });
}
for (const overwrite of [false, true]) {
  test(`外部提案换期${overwrite ? '在覆写后取消旧工作，人工重试后重新排入' : '重复接收只排入一次'}`, async () => {
    const { platform, controller, reply } = await setup();
    const before = structuredClone(platform.data);
    controller.config.jobs.generate.retries = 0;
    const withPeriod = {
      ...proposal,
      transitions: [{ country: '试验国', cause: 'completed', reason: '本期已完成', invalidateActive: false }],
    };
    platform.observation.run!.taskResults[0].extractedTags!.国策提案 = JSON.stringify({
      nonce: reply.nonce,
      proposal: withPeriod,
    });
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    platform.generate = async () => {
      calls++;
      entered();
      await gate;
      return { content: periodReply() };
    };
    controller.refreshProposal();
    assert.equal(controller.externalProposal.status, 'pending');
    const first = controller.accept();
    const second = controller.accept();
    assert.equal(await first, true);
    assert.equal(await second, true);
    await waiting;
    if (overwrite) {
      platform.data = before;
      controller.refreshProposal();
      assert.equal(controller.externalProposal.status, 'overwritten');
      release();
      await jobsFinished(controller);
      assert.equal(platform.saves, 1, '旧换期结果不得保存到已经回退的国策');
      assert.equal(await controller.accept(), true);
    } else {
      release();
    }
    await jobsFinished(controller);
    assert.equal(calls, overwrite ? 2 : 1);
    assert.equal(platform.saves, overwrite ? 3 : 2);
    assert.equal(platform.data.countries['试验国'].period.number, 2);
    assert.equal(controller.jobs[0].state, 'success', JSON.stringify(controller.jobs));
    controller.dispose();
  });
}

test('覆写重试资格被手动补救或新请求永久取消', async () => {
  for (const action of ['manual', 'request'] as const) {
    const { platform, controller, reply } = await setup();
    const before = structuredClone(platform.data);
    controller.refreshProposal();
    await controller.accept();
    platform.data = before;
    controller.refreshProposal();
    assert.equal(controller.externalProposal.status, 'overwritten');
    if (action === 'manual') {
      const access = controller.integration.beginUpdate('manual');
      assert.equal(access.status, 'acquired');
      controller.integration.endUpdate(access.token);
    } else {
      await controller.integration.prepare(8, { mode: 'request', requestId: 'new-world' });
    }
    assert.equal(controller.integration.retry(reply.nonce), null);
    assert.equal(await controller.accept(), false);
    assert.equal(platform.saves, 1);
    controller.dispose();
  }
});

test('酒馆边界读取当前成员的运行纪录与世界指纹，MVU 开始和结束控制忙碌状态', () => {
  const listeners = new Map<string, (...args: any[]) => void>();
  const data = {
    stat_data: { now: 100 },
    国策: createState(100),
    addon_data: { 世界: { [FOCUS_WORLD]: { day: 100 } } },
    post_process_tags: { 国策提案: '不得读取此旧裸标签' },
  };
  const run = {
    messageId: 8,
    at: 100,
    taskResults: [{ taskId: 'world-a', success: true, extractedTags: { 国策提案: 'member-tag' } }],
  };
  const api: TavernApi = {
    parent: {
      AcuPostProcessAPI: {
        getEffectiveSettings: () => ({
          tasks: [
            { id: 'root', syncAsReplicaFamily: true, replicaFamilySpec: WORLD_FAMILY },
            { id: 'world-a', replicaFamilyRootId: 'root', replicaFamilyAttrValue: FOCUS_WORLD },
          ],
        }),
        getRunStatusForFloor: (id) => {
          assert.equal(id, 8);
          return run;
        },
      },
      Addon: { getLastPatchLog: () => null },
    },
    SillyTavern: { getCurrentChatId: () => 'chat' },
    getLastMessageId: () => 8,
    getChatMessages: () => [{ message_id: 8, swipe_id: 0, swipes: ['正文'], role: 'assistant' }],
    Mvu: {
      getMvuData: () => data,
      replaceMvuData: async () => {},
      isDuringExtraAnalysis: () => false,
      events: { VARIABLE_UPDATE_STARTED: 'start', VARIABLE_UPDATE_ENDED: 'end' },
    },
    eventOn: (event, callback) => {
      listeners.set(event, callback);
      return { stop() {} };
    },
    tavern_events: {},
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
  const config = platform.loadConfig();
  config.sources.timePath = 'now';
  try {
    const observation = platform.readWorldProposal(8)!;
    assert.equal(observation.run!.taskResults[0].extractedTags!.国策提案, 'member-tag');
    assert.equal(observation.fingerprint, worldFingerprint(data.addon_data.世界[FOCUS_WORLD]));
    const ready = platform.readIntegration(8, config);
    assert.equal('status' in ready, false);
    if (!('status' in ready)) {
      assert.deepEqual(ready.world, {
        rootId: 'root',
        taskId: 'world-a',
        fingerprint: observation.fingerprint,
      });
    }
    listeners.get('start')!();
    assert.deepEqual(platform.readIntegration(8, config), {
      version: 1,
      status: 'unavailable',
      reason: 'mvu_busy',
    });
    listeners.get('end')!(structuredClone(data), data);
    assert.equal('status' in platform.readIntegration(8, config), false);
  } finally {
    platform.dispose();
  }
});
