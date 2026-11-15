import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { applyProposal, createState, installCountry, startFocus } from '../src/engine';
import { DemoPlatform } from '../src/demo';
import { demoTree } from '../src/demo-tree';
import { workingState } from '../src/generation';
import { EventSchema, NodeSchema, ProposalSchema, TreeSchema, type Politics, type State } from '../src/model';
import { dismissPending, PeriodReplySchema, transitionPeriod } from '../src/periods';
import type { PeriodWork, PromptMessage, Snapshot } from '../src/platform';
import { GENERATE_POLITICS_TASK, GOVERNMENT_TASK, POLITICS_TASK } from '../src/prompts';
import { FocusController } from '../src/workflow';

const node = (id: string, prerequisites: string[][] = []) =>
  NodeSchema.parse({
    id,
    name: id,
    branch: '国家议程',
    description: `${id} 的行动`,
    reason: '设定',
    icon: 'crown',
    x: 0,
    y: id === 'old_done' ? 0 : 1,
    days: 30,
    durationReason: '协商',
    prerequisites,
    requirements: [],
    sustain: [],
    outcomes: [],
    investments: ['行政人员'],
    mutex: null,
    effects: [{ id: 'stability', kind: 'stability', value: 5 }],
  });
const tree = TreeSchema.parse({
  id: 'land',
  name: '试验国',
  description: '试验',
  evidence: '设定',
  analysis: '本期改革',
  stability: 50,
  warSupport: 30,
  branches: [
    {
      id: 'agenda',
      name: '国家议程',
      purpose: '改革',
      supporters: '城市',
      opposition: '领主',
      tradeoff: '权力',
      destination: '新秩序',
    },
  ],
  capabilities: [],
  historical: [{ node: 'old_done', evidence: '既有成果' }],
  nodes: [node('old_done'), node('old_active', [['old_done']])],
});
const politics = (): Politics => ({
  ruling: 'crown',
  factions: [
    { id: 'crown', name: '王党', appeal: '王权高于一切', stance: 'moderate', support: 50 },
    { id: 'army', name: '军部', appeal: '以军治国', stance: 'hardline', support: 30 },
    { id: 'nobles', name: '旧贵族', appeal: '恢复领主特权', stance: 'extreme', support: 20 },
  ],
  members: [
    { id: 'guard', name: '近卫军', kind: 'army', weight: 'heavy', faction: 'army', note: '驻守王都' },
  ],
  succession: '长子继承',
});
/** Day 110: old_done is completed, old_active is the active focus, and an event carries it out. */
function fixture(): State {
  let state = installCountry(createState(100), { ...tree, politics: politics() }, 100);
  state = startFocus(state, 'land', 'old_active');
  state = applyProposal(state, { id: 'advance', until: 110, reason: '时间推进', steps: [] });
  const land = state.countries.land;
  land.capabilities.keep = { id: 'keep', name: '既有制度', active: true, reason: '既成' };
  land.commitments.promise = '保持互通';
  land.locks.old_group = { route: 'old_route', reason: '旧路线' };
  state.events.project = EventSchema.parse({
    id: 'project',
    at: 100,
    countries: ['land'],
    title: '施工',
    description: '已开工',
    evidence: '工程纪录',
    origin: 'background',
    public: true,
    changes: [],
    status: 'ongoing',
    source: { kind: 'focus', country: 'land', node: 'old_active' },
  });
  return state;
}
const coup = { country: 'land', cause: 'government', ruling: 'army', reason: '军部发动政变，女王出走' };
const update = (id = 'coup', transitions: object[] = [{ ...coup, invalidateActive: false }]) => ({
  id,
  until: 110,
  reason: '政变',
  steps: [],
  transitions,
});
/** A government transition as the update parses it. */
const government = (fields: object = {}) =>
  ProposalSchema.parse(update('coup', [{ ...coup, ...fields }])).transitions[0];
function reply(prefix = 'p2_', parent = '') {
  const { x: _x, y: _y, ...content } = node(`${prefix}new`, parent ? [[parent]] : []);
  return PeriodReplySchema.parse({
    summary: '王党失势，军部掌权。',
    tree: { ...tree, periodTitle: '军政时期', agenda: '整军与平乱', historical: [], nodes: [content] },
  });
}
const withoutPending = ({ pending: _pending, ...rest }: Politics) => rest;

class GovernmentPlatform extends DemoPlatform {
  data = fixture();
  outputs: ((messages: PromptMessage[]) => Promise<string>)[] = [];
  sent: PromptMessage[][] = [];
  saves = 0;
  override async read(): Promise<Snapshot> {
    const state = structuredClone(this.data);
    return { identity: 'floor', messageId: 1, day: state.day, turn: 1, state, context: {} };
  }
  override async commit(_source: Snapshot, state: State) {
    this.data = structuredClone(state);
    this.saves++;
  }
  override async generate(messages: PromptMessage[]) {
    this.sent.push(messages);
    return { content: await this.outputs.shift()!(messages) };
  }
}
async function controllerFor(platform: GovernmentPlatform) {
  const controller = new FocusController(platform);
  controller.config.jobs.update.retries = 0;
  controller.config.jobs.generate.retries = 0;
  await controller.refresh();
  return controller;
}
const json = (value: unknown) => async () => JSON.stringify(value);
/** The request data of one sent request. */
const payload = (messages: PromptMessage[]) => {
  const data = messages.find((message) => message.content.includes('{"job":'))!.content;
  return JSON.parse(data.slice(data.indexOf('{')));
};
const pending = { ruling: 'nobles', reason: '旧贵族逼宫', at: 105 };
type Mode = 'auto' | 'off' | 'calibration';
function setMode(state: State, mode: Mode): State {
  state.countries.land.autoPeriod = mode !== 'off';
  state.countries.land.calibration = mode === 'calibration';
  return state;
}

test('换期格式：government 须带 ruling，其他原因不可带；government 一律不承接进行中国策', () => {
  for (const transition of [
    { ...coup, ruling: undefined },
    { country: 'land', cause: 'completed', ruling: 'army', reason: '议程完成' },
  ]) {
    const result = ProposalSchema.safeParse(update('bad', [transition]));
    assert.equal(result.success, false);
    assert.deepEqual(
      result.error!.issues.map((issue) => [issue.path, issue.message]),
      [
        [
          ['transitions', 0, 'ruling'],
          'cause=government 时必须填 ruling（新执政派系的 id）；completed 与 incompatible 不填 ruling',
        ],
      ],
    );
  }
  for (const invalidateActive of [false, true, undefined]) {
    assert.equal(government({ invalidateActive }).invalidateActive, true);
  }
  const parsed = ProposalSchema.parse(
    update('keep', [
      { country: 'land', cause: 'completed', reason: '议程完成' },
      { country: 'peer', cause: 'incompatible', reason: '局势改变', invalidateActive: true },
    ]),
  );
  assert.deepEqual(
    parsed.transitions.map((t) => [t.cause, t.invalidateActive, 'ruling' in t]),
    [
      ['completed', false, false],
      ['incompatible', true, false],
    ],
  );
  const shown = (z.toJSONSchema(ProposalSchema, { io: 'input' }) as Record<string, any>).properties
    .transitions.items;
  assert.deepEqual(shown.properties.cause.enum, ['completed', 'incompatible', 'government']);
  assert.equal(
    shown.properties.ruling.description,
    '新执政派系的 id：cause=government 时必填，其他 cause 不填',
  );
  assert.equal(shown.required.includes('ruling'), false);
});

test('换期验证：没有派系、新执政派系不存在、支持度为 0、已在执政与同国重复都退回；三种国家都检查', async () => {
  const cases: [string, (state: State) => void, object[], RegExp][] = [
    [
      '没有派系',
      (state) => delete state.countries.land.politics,
      [coup],
      /试验国没有派系，不能提出执政更替（cause=government）/,
    ],
    [
      '派系不存在',
      () => {},
      [{ ...coup, ruling: 'rebels' }],
      /执政更替的新执政派系 rebels 不存在：ruling 须照抄 state 中试验国的派系 id/,
    ],
    [
      '支持度为 0',
      (state) => {
        const [crown, army] = state.countries.land.politics!.factions;
        crown.support += army.support;
        army.support = 0;
      },
      [coup],
      /新执政派系「军部」的支持度为 0，不能执政/,
    ],
    [
      '已在执政',
      () => {},
      [{ ...coup, ruling: 'crown' }],
      /「王党」已是试验国的执政派系：同一派系内换人不算执政更替/,
    ],
    [
      '同国重复',
      () => {},
      [coup, { country: 'land', cause: 'completed', reason: '议程完成' }],
      /同一次更新不可对同国重复换期/,
    ],
  ];
  for (const mode of ['auto', 'off', 'calibration'] as const) {
    for (const [name, corrupt, transitions, message] of cases) {
      const platform = new GovernmentPlatform();
      corrupt(setMode(platform.data, mode));
      const controller = await controllerFor(platform);
      try {
        const source = await platform.read();
        await assert.rejects(
          controller.commitUpdate(ProposalSchema.parse(update('bad', transitions)), source),
          message,
          `${mode} ${name}`,
        );
        assert.equal(platform.saves, 0);
        assert.deepEqual(platform.data, source.state);
      } finally {
        controller.dispose();
      }
    }
  }
});

test('自动换期：government 排入换期工作，强制不承接进行中国策；成功时写入新执政派系、清除待决，承诺标示前政府', async () => {
  const platform = new GovernmentPlatform();
  platform.data.countries.land.politics!.pending = pending;
  const before = structuredClone(platform.data.countries.land);
  platform.outputs.push(json(update()), json(reply()));
  const controller = await controllerFor(platform);
  try {
    await controller.run('update');
    assert.ok(
      controller.jobs.every((job) => job.state === 'success'),
      JSON.stringify(controller.jobs),
    );
    assert.equal(platform.sent.length, 2);
    const work = controller.jobs.find((job) => job.periodWork)!.periodWork;
    assert.deepEqual(work, { transition: { ...coup, invalidateActive: true } });
    const request = payload(platform.sent[1]);
    assert.equal(request.anchor, 'old_done');
    assert.deepEqual(request.transition, work!.transition);
    const land = platform.data.countries.land;
    assert.deepEqual(land.politics, { ...withoutPending(before.politics!), ruling: 'army' });
    assert.equal(land.period.number, 2);
    assert.equal(land.period.anchor, 'old_done');
    assert.equal(land.current, '');
    assert.equal(land.nodes.old_active, undefined);
    assert.equal(land.progress.old_done.status, 'completed');
    assert.deepEqual(land.nodes.old_done.prerequisites, []);
    assert.deepEqual(land.capabilities, before.capabilities);
    assert.deepEqual(land.facts, before.facts);
    assert.deepEqual(land.locks, {});
    assert.deepEqual(land.commitments, { promise: '前政府：保持互通' });
    assert.equal(platform.data.events.project.status, 'ongoing');
    assert.equal(platform.data.events.project.source.name, 'old_active');
    assert.equal(land.autoPeriod, true);
  } finally {
    controller.dispose();
  }
});

test('换期：新国策以 anchor 为前置时退回；前政府的标示只加一次，之后新增的承诺在下次更替时才标示', () => {
  assert.throws(
    () => transitionPeriod(fixture(), government(), reply('p2_', 'old_done')),
    /新国策 p2_new 不可以 anchor（old_done）为前置：政权已更替，前期国策只作历史保留/,
  );
  const incompatible = {
    country: 'land',
    cause: 'incompatible' as const,
    reason: '局势改变',
    invalidateActive: true,
  };
  assert.equal(
    transitionPeriod(fixture(), incompatible, reply('p2_', 'old_done')).countries.land.period.number,
    2,
  );
  const first = transitionPeriod(fixture(), government(), reply());
  first.countries.land.commitments.pact = '新盟约';
  const second = transitionPeriod(first, government({ ruling: 'nobles' }), reply('p3_'));
  assert.equal(second.countries.land.politics!.ruling, 'nobles');
  assert.deepEqual(second.countries.land.commitments, {
    promise: '前政府：保持互通',
    pact: '前政府：新盟约',
  });
});

test('换期提交前再检查新执政派系：已不存在或支持度为 0 时整期不提交', () => {
  for (const corrupt of [
    (p: Politics) => {
      p.factions = p.factions.filter((faction) => faction.id !== 'army');
      p.factions[0].support += 30;
      p.members = [];
    },
    (p: Politics) => {
      p.factions[0].support += 30;
      p.factions[1].support = 0;
    },
  ]) {
    const state = fixture();
    corrupt(state.countries.land.politics!);
    assert.throws(() => transitionPeriod(state, government(), reply()), /新执政派系/);
  }
});

for (const outcome of ['failed', 'cancelled'] as const) {
  test(`自动换期的工作${outcome === 'failed' ? '失败' : '取消'}时，执政派系、待决与旧树都不变`, async () => {
    const platform = new GovernmentPlatform();
    platform.data.countries.land.politics!.pending = pending;
    platform.outputs.push(
      json(update()),
      outcome === 'failed' ? async () => '{invalid' : () => new Promise<string>(() => {}),
    );
    const controller = await controllerFor(platform);
    try {
      const work = controller.run('update');
      if (outcome === 'cancelled') {
        for (let i = 0; i < 100 && platform.sent.length < 2; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        controller.cancelAll();
      }
      await work;
      assert.equal(controller.jobs[0].state, outcome);
      const land = platform.data.countries.land;
      assert.ok(platform.data.receipts.includes('coup'));
      assert.equal(land.politics!.ruling, 'crown');
      assert.deepEqual(land.politics!.pending, pending);
      assert.equal(land.period.number, 1);
      assert.equal(land.current, 'old_active');
      assert.deepEqual(land.commitments, { promise: '保持互通' });
    } finally {
      controller.dispose();
    }
  });
}

for (const mode of ['off', 'calibration'] as const) {
  test(`${mode === 'off' ? '关闭自动换期' : '校准中'}的国家：government 写入待决，不换执政派系也不生成；新的提案取代旧的`, async () => {
    const platform = new GovernmentPlatform();
    setMode(platform.data, mode);
    platform.outputs.push(
      json(update()),
      json(update('again', [{ ...coup, ruling: 'nobles', reason: '旧贵族逼宫成功' }])),
    );
    const controller = await controllerFor(platform);
    try {
      await controller.run('update');
      assert.equal(controller.jobs.length, 1);
      assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
      const land = platform.data.countries.land;
      assert.deepEqual(land.politics!.pending, { ruling: 'army', reason: coup.reason, at: 110 });
      assert.equal(land.politics!.ruling, 'crown');
      assert.equal(land.period.number, 1);
      await controller.run('update');
      assert.equal(platform.sent.length, 2, '待决不排入换期工作');
      assert.deepEqual(platform.data.countries.land.politics!.pending, {
        ruling: 'nobles',
        reason: '旧贵族逼宫成功',
        at: 110,
      });
      assert.equal(platform.data.countries.land.politics!.ruling, 'crown');
    } finally {
      controller.dispose();
    }
  });
}

test('换期（批准待决）：不看自动换期开关，开关保持关闭；成功时写入新执政派系并清除待决', async () => {
  const platform = new GovernmentPlatform();
  setMode(platform.data, 'off');
  platform.data.countries.land.politics!.pending = pending;
  platform.outputs.push(json(reply()));
  const controller = await controllerFor(platform);
  try {
    await controller.approvePending('land');
    const [job] = controller.jobs;
    assert.equal(job.state, 'success', job.message);
    assert.deepEqual(job.periodWork, {
      transition: {
        country: 'land',
        cause: 'government',
        ruling: 'nobles',
        reason: pending.reason,
        invalidateActive: true,
      },
      approved: true,
    });
    const land = platform.data.countries.land;
    assert.equal(land.politics!.ruling, 'nobles');
    assert.equal('pending' in land.politics!, false);
    assert.equal(land.period.number, 2);
    assert.equal(land.autoPeriod, false);
  } finally {
    controller.dispose();
  }
});

for (const outcome of ['failed', 'cancelled'] as const) {
  test(`换期${outcome === 'failed' ? '失败' : '取消'}时待决保留；从任务列表重跑同一份工作照样不看开关，成功后清除待决`, async () => {
    const platform = new GovernmentPlatform();
    setMode(platform.data, 'off');
    platform.data.countries.land.politics!.pending = pending;
    platform.outputs.push(
      outcome === 'failed' ? async () => '{invalid' : () => new Promise<string>(() => {}),
    );
    const controller = await controllerFor(platform);
    try {
      const work = controller.approvePending('land');
      if (outcome === 'cancelled') {
        for (let i = 0; i < 100 && !platform.sent.length; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        controller.cancelAll();
      }
      await work;
      const [job] = controller.jobs;
      assert.equal(job.state, outcome);
      assert.deepEqual(platform.data.countries.land.politics!.pending, pending);
      assert.equal(platform.data.countries.land.politics!.ruling, 'crown');
      assert.equal(platform.data.countries.land.period.number, 1);
      platform.outputs.push(json(reply()));
      await controller.run('generate', job.candidate, job.periodWork);
      assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
      const land = platform.data.countries.land;
      assert.equal(land.politics!.ruling, 'nobles');
      assert.equal('pending' in land.politics!, false);
      assert.equal(land.autoPeriod, false);
    } finally {
      controller.dispose();
    }
  });
}

test('换期在校准中、没有待决或待决已放弃时退回，不呼叫模型', async () => {
  const platform = new GovernmentPlatform();
  setMode(platform.data, 'calibration');
  platform.data.countries.land.politics!.pending = pending;
  const controller = await controllerFor(platform);
  const work: PeriodWork = {
    transition: {
      country: 'land',
      cause: 'government',
      ruling: 'nobles',
      reason: pending.reason,
      invalidateActive: true,
    },
    approved: true,
  };
  const candidate = { id: 'land', name: '试验国', description: '试验', evidence: '设定' };
  try {
    const calibrating = /此国尚待校准：新一期要依校准后的现况生成，请先完成「更新局势」再换期/;
    await assert.rejects(controller.approvePending('land'), calibrating);
    assert.equal(controller.jobs.length, 0);
    // A stored work re-run from the job list is refused the same way.
    await controller.run('generate', candidate, work);
    assert.equal(controller.jobs[0].state, 'failed');
    assert.match(controller.jobs[0].message, calibrating);
    platform.data.countries.land.calibration = false;
    platform.data = dismissPending(platform.data, 'land');
    await controller.run('generate', candidate, work);
    assert.equal(controller.jobs[0].state, 'failed');
    assert.match(controller.jobs[0].message, /这项执政更替已不在待决中/);
    await controller.refresh();
    await assert.rejects(controller.approvePending('land'), /此国没有待决的执政更替/);
    assert.equal(platform.sent.length, 0);
    assert.equal(platform.data.countries.land.politics!.ruling, 'crown');
  } finally {
    controller.dispose();
  }
});

test('放弃待决：清除 pending，执政派系与其他资料不变；没有待决时退回', () => {
  const state = fixture();
  state.countries.land.politics!.pending = pending;
  const after = dismissPending(state, 'land');
  assert.equal('pending' in after.countries.land.politics!, false);
  assert.deepEqual(after.countries.land.politics, withoutPending(state.countries.land.politics!));
  assert.deepEqual({ ...after.countries.land, politics: null }, { ...state.countries.land, politics: null });
  assert.equal(after.revision, state.revision + 1);
  assert.equal(state.countries.land.politics!.pending, pending, '不改写输入');
  assert.throws(() => dismissPending(after, 'land'), /此国没有待决的执政更替/);
});

test('执政更替说明：有政局的启用国家时只附在 update 的派系说明之后；reshape、生成、识别与没有政局时都不附', () => {
  const controller = new FocusController(new DemoPlatform());
  const withPolitics = fixture();
  const plain = installCountry(createState(0), demoTree(), 0);
  const contents = (kind: 'identify' | 'generate' | 'update' | 'reshape', state: State) =>
    controller
      .messages(kind, undefined, { stage: kind, state: workingState(state, kind === 'reshape') })
      .map((message) => message.content);
  assert.ok(
    contents('update', withPolitics).some((text) => text.endsWith(`\n${POLITICS_TASK}\n${GOVERNMENT_TASK}`)),
  );
  for (const [kind, state] of [
    ['update', plain],
    ['reshape', withPolitics],
    ['generate', withPolitics],
    ['identify', withPolitics],
  ] as const) {
    assert.equal(
      contents(kind, state).some((text) => text.includes(GOVERNMENT_TASK)),
      false,
      kind,
    );
  }
});

test('换期请求：government 改用不以 anchor 为前置的指示并附生成派系说明，其他原因维持原指示；示范请求在输入上限内', async () => {
  const instructions = {
    government: '政权已更替，anchor 只作历史保留，新节点不得以它为前置',
    completed: '新节点可引用 anchor 作必要前置，不相关议程可独立推进',
  };
  for (const cause of ['government', 'completed'] as const) {
    const platform = new GovernmentPlatform();
    platform.outputs.push(async () => '{}');
    const controller = await controllerFor(platform);
    const transition =
      cause === 'government'
        ? government()
        : { country: 'land', cause, reason: '议程完成', invalidateActive: false };
    try {
      await controller.run(
        'generate',
        { id: 'land', name: '试验国', description: '试验', evidence: '设定' },
        { transition },
      );
      const [messages] = platform.sent;
      const request = payload(messages);
      assert.equal(request.stage, 'period');
      assert.ok(request.instructions.includes(instructions[cause]), cause);
      assert.equal(
        request.instructions.includes(instructions[cause === 'government' ? 'completed' : 'government']),
        false,
      );
      assert.equal(request.anchor, cause === 'government' ? 'old_done' : 'old_active');
      assert.ok(messages.some((message) => message.content.endsWith(`\n${GENERATE_POLITICS_TASK}`)));
    } finally {
      controller.dispose();
    }
  }
  assert.match(
    GENERATE_POLITICS_TASK,
    /transition\.cause=government 时政权已更替：transition\.ruling 的派系现在执政/,
  );
  // The offline sample with factions, as the politics tests use it.
  const demo = new (class extends DemoPlatform {
    sent: PromptMessage[][] = [];
    override async read(...args: Parameters<DemoPlatform['read']>) {
      const snapshot = await super.read(...args);
      snapshot.state.countries.augustium.politics = installCountry(
        createState(0),
        { ...demoTree(), politics: politics() },
        0,
      ).countries.augustium.politics;
      return snapshot;
    }
    override async generate(messages: PromptMessage[]) {
      this.sent.push(messages);
      return { content: '{}' };
    }
  })();
  const controller = new FocusController(demo);
  controller.config.jobs.generate.retries = 0;
  try {
    const transition = { ...government(), country: 'augustium' };
    await controller.run(
      'generate',
      { id: 'augustium', name: '奥古斯提姆帝国', description: '示范', evidence: '示范' },
      { transition },
    );
    const job = controller.jobs[0];
    assert.equal(demo.sent.length, 1, job.message);
    assert.ok(job.inputCharacters! < 120000, String(job.inputCharacters));
  } finally {
    controller.dispose();
  }
});
