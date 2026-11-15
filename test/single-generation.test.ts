import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FocusController } from '../src/workflow';
import { createState } from '../src/engine';
import { defaultConfig, StateSchema, type Config, type State } from '../src/model';
import type { GenerateResult, Platform, PromptMessage, Snapshot } from '../src/platform';
import { importTrees, parseTreeFile } from '../src/tree-io';

class SingleCountryPlatform implements Platform {
  async worldbooks() {
    return { character: [], all: [] };
  }
  chatId(): string {
    return 'test';
  }
  async models(): Promise<string[]> {
    return [];
  }
  demo = false;
  state = createState(100);
  config = defaultConfig();
  calls: Record<string, any>[] = [];
  commits = 0;
  revision = 0;
  block = false;
  invalid = '';
  failedResponses = 0;
  branchCount = 3;
  nodeCount = 5;
  historical = false;
  /** Skeleton runs: leave out the core branch's stat change, so its relations have no rule. */
  noTension = false;
  /** Skeleton runs: extra skeleton edits applied to the generated focuses. */
  tweak?: (nodes: Record<string, any>[]) => void;
  /** Skeleton runs: edits applied to the whole skeleton (branches, relations). */
  tweakSkeleton?: (skeleton: Record<string, any>) => void;
  /** Skeleton correction replies: patch operations for a skeleton-fix request (default: none). */
  fixer?: (request: Record<string, any>) => unknown[];
  /** First fill reply: leave out this many focuses, and break this many (invalid days). */
  fillDrop = 0;
  fillBad = 0;
  /** Fill replies with this 0-based index return broken JSON. */
  fillFailAt = -1;
  /** Leave out turning points to test the feedback. */
  plain = false;
  context = {
    history: [{ role: 'assistant', content: '本楼正文' }],
    worldbook: [{ content: '国家设定' }],
    variables: { 世界: { 时间: 100 } },
    requirements: '玩家补充要求',
  };
  constructor() {
    this.state.settings.size = 'standard';
    this.config.jobs.generate.retries = 0;
  }
  async read(): Promise<Snapshot> {
    return {
      identity: 'floor1',
      messageId: 1,
      day: 100,
      turn: 1,
      state: structuredClone(this.state),
      context: this.context,
    };
  }
  async commit(snapshot: Snapshot, state: State) {
    this.state = structuredClone(state);
    this.revision++;
    this.commits++;
  }
  async generate(messages: PromptMessage[]): Promise<GenerateResult> {
    const data = messages.find((m) => m.role === 'user')!.content;
    return { content: await this.respond(data.slice(data.indexOf('{'))) };
  }
  private async respond(prompt: string): Promise<string> {
    const p = JSON.parse(prompt);
    this.calls.push(p);
    if (this.block) {
      return new Promise(() => {});
    }
    if (this.failedResponses-- > 0) {
      return '{"nodes":[';
    }
    const branches = Array.from({ length: this.branchCount }, (_, i) => ({
      id: `b${i}`,
      name: `分支${i}`,
      purpose: '制度改革',
      supporters: '城市',
      opposition: '领主',
      tradeoff: '效率与自治',
      destination: '共同制度',
    }));
    const nodes = branches.flatMap((branch, b) =>
      Array.from({ length: this.nodeCount }, (_, i) => {
        const id = `${branch.id}_${i}`;
        return {
          id,
          name: `国策${id}`,
          branch: branch.name,
          description: `${id} 的实施方式及取舍`,
          reason: '根据设定',
          icon: 'crown',
          days: 35,
          durationReason: '协商与实施',
          prerequisites:
            i === 0
              ? b === 0
                ? []
                : [['b0_0']]
              : i === 1 || i === 2
                ? [[`${branch.id}_0`]]
                : i === 3
                  ? [[`${branch.id}_1`, `${branch.id}_2`]]
                  : [[`${branch.id}_${i - 1}`]],
          mutex:
            i === 1 || i === 2
              ? { group: `choice_${branch.id}`, route: `route${i}`, lock: 'complete', reason: '不同制度选择' }
              : null,
          requirements:
            this.invalid === 'capability' && id === 'b0_0'
              ? [{ kind: 'capability', id: 'cap_b0_1', label: '只有后续国策才提供' }]
              : [],
          sustain: [],
          outcomes: [],
          investments: [`${id} 行政投入`],
          impact: i === this.nodeCount - 1 && !this.plain ? 'pivotal' : 'normal',
          news:
            i === this.nodeCount - 1
              ? {
                  headline: `${id} 震动邻国`,
                  body: '各国重新评估局势',
                  option: { label: '知道了', text: '' },
                }
              : null,
          effects: [{ id: 'gain', kind: 'capability', key: `cap_${id}`, name: `制度${id}`, active: true }],
        };
      }),
    );
    if (this.invalid === 'route') {
      nodes[3].mutex = { group: 'choice_b0', route: 'route3', lock: 'complete', reason: '和全部前置互斥' };
    }
    if (this.invalid === 'reference') {
      nodes[3].prerequisites = [['missing']];
    }
    const header = {
      id: p.candidate?.id ?? 'unexpected',
      name: '试验国',
      description: '改革十字路口',
      evidence: '设定',
      analysis: '地方自治与集权矛盾',
      stability: 60,
      warSupport: 30,
      capabilities: [],
    };
    return JSON.stringify({
      id: p.candidate?.id ?? 'unexpected',
      name: '试验国',
      description: '改革十字路口',
      evidence: '设定',
      analysis: '地方自治与集权矛盾',
      stability: 60,
      warSupport: 30,
      capabilities: [],
      historical: this.historical ? [{ node: 'b0_0', evidence: '已建好，但当年能力已毁' }] : [],
      branches,
      nodes,
    });
  }
  async sources() {
    return [];
  }
  loadConfig(): Config {
    return this.config;
  }
  saveConfig(config: Config) {
    this.config = config;
  }
  onReady() {
    return () => {};
  }
  onChange() {
    return () => {};
  }
  inject() {}
}
const candidate = { id: 'testland', name: '试验国', description: '候选', evidence: '设定' };

test('每国仅一次 API 取得完整树，完整来源同时送入并于本机排版后提交', async () => {
  const platform = new SingleCountryPlatform();
  const controller = new FocusController(platform);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  assert.equal(platform.calls.length, 1);
  assert.deepEqual(platform.calls[0].context, platform.context);
  assert.deepEqual(platform.calls[0].candidate, candidate);
  assert.equal(platform.commits, 1);
  const country = platform.state.countries.testland;
  assert.equal(Object.keys(country.nodes).length, 15);
  assert.equal(country.branches.length, 3);
  assert.equal(new Set(Object.values(country.nodes).map((n) => `${n.x},${n.y}`)).size, 15);
  const { analysis: _analysis, branches: _branches, ...legacy } = country;
  const loaded = StateSchema.parse({ ...platform.state, countries: { testland: legacy } });
  assert.deepEqual(loaded.countries.testland.branches, []);
  assert.deepEqual(loaded.countries.testland.progress, country.progress);
});

test('生成回复使用分支 ID 或混合名称时，本机转换后一次请求即可保存完整树', async () => {
  for (const mixed of [false, true]) {
    const platform = new SingleCountryPlatform();
    const generate = platform.generate.bind(platform);
    let response: Record<string, any>;
    platform.generate = async (messages) => {
      const result = await generate(messages);
      response = JSON.parse(result.content);
      response.nodes.forEach((node: Record<string, any>, index: number) => {
        if (!mixed || index % 2 === 0) {
          node.branch = response.branches.find(
            (branch: Record<string, any>) => branch.name === node.branch,
          ).id;
        }
      });
      return { content: JSON.stringify(response) };
    };
    const controller = new FocusController(platform);
    try {
      await controller.run('generate', candidate);
      assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
      assert.equal(platform.calls.length, 1);
      assert.equal(platform.commits, 1);
      const country = platform.state.countries.testland;
      assert.equal(Object.keys(country.nodes).length, 15);
      for (const node of Object.values(country.nodes)) {
        const source = response!.nodes.find((item: Record<string, any>) => item.id === node.id);
        assert.equal(node.branch, `分支${node.id[1]}`);
        assert.deepEqual(node.effects, source.effects);
        assert.deepEqual(node.prerequisites, source.prerequisites);
      }
    } finally {
      controller.dispose();
    }
  }
});

test('不存在、空白或歧义分支仍拒绝保存，错误指出具体分支', async () => {
  const cases = [
    { kind: 'missing', expected: /b0_0.*不存在.*missing_branch/ },
    { kind: 'empty', expected: /分支「空分支」没有任何国策/ },
    { kind: 'ambiguous', expected: /b0_0.*b0.*多个分支/ },
  ];
  for (const item of cases) {
    const platform = new SingleCountryPlatform();
    const generate = platform.generate.bind(platform);
    platform.generate = async (messages) => {
      const result = await generate(messages);
      const response = JSON.parse(result.content);
      if (item.kind === 'missing') {
        response.nodes[0].branch = 'missing_branch';
      } else if (item.kind === 'empty') {
        response.branches.push({ ...response.branches[0], id: 'empty', name: '空分支' });
      } else {
        response.branches[1].name = 'b0';
        response.nodes[0].branch = 'b0';
      }
      return { content: JSON.stringify(response) };
    };
    const controller = new FocusController(platform);
    try {
      await controller.run('generate', candidate);
      assert.equal(controller.jobs[0].state, 'failed');
      assert.match(controller.jobs[0].message, item.expected);
      assert.equal(platform.commits, 0);
      assert.equal(platform.calls.length, 1);
    } finally {
      controller.dispose();
    }
  }
});

test('历史国策不重新要求当年的能力，也不重发历史效果', async () => {
  const platform = new SingleCountryPlatform();
  platform.historical = true;
  platform.invalid = 'capability';
  const controller = new FocusController(platform);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  assert.equal(platform.state.countries.testland.progress.b0_0.status, 'completed');
  assert.equal(platform.state.countries.testland.capabilities.cap_b0_0, undefined);
  assert.equal(platform.calls.length, 1);
});

test('取消与结构错误均不提交，连线限额 1 时取消后不执行排队国家', async () => {
  for (const defect of ['route', 'capability', 'reference']) {
    const platform = new SingleCountryPlatform();
    platform.invalid = defect;
    const controller = new FocusController(platform);
    await controller.run('generate', candidate);
    assert.equal(controller.jobs[0].state, 'failed');
    assert.equal(platform.commits, 0);
    assert.equal(platform.calls.length, 1);
  }
  const platform = new SingleCountryPlatform();
  platform.block = true;
  platform.config.jobs.generate.primaryMaxConcurrency = 1;
  const controller = new FocusController(platform);
  const run = controller.enable([candidate, { ...candidate, id: 'second' }]);
  try {
    for (let i = 0; i < 100 && !platform.calls.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(platform.calls.length, 1);
    controller.cancelAll();
    await run;
    assert.ok(controller.jobs.every((job) => job.state === 'cancelled'));
    assert.equal(platform.commits, 0);
    assert.equal(platform.calls.length, 1);
  } finally {
    controller.dispose();
    await run;
  }
});

test('只有失败才依既有重试设定再次请求，不追加分支或审查请求', async () => {
  const platform = new SingleCountryPlatform();
  platform.config.jobs.generate.retries = 1;
  platform.failedResponses = 1;
  const controller = new FocusController(platform);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  assert.equal(platform.calls.length, 2);
  assert.equal(platform.commits, 1);
  assert.deepEqual(
    platform.calls.map((p) => p.candidate.id),
    ['testland', 'testland'],
  );
});

test('每期规模是上限与篇幅目标，不强制重要节点或最低数量', async () => {
  for (const size of ['standard', 'large'] as const) {
    const platform = new SingleCountryPlatform();
    platform.state.settings.size = size;
    platform.branchCount = 1;
    platform.nodeCount = 4;
    platform.plain = true;
    const controller = new FocusController(platform);
    await controller.run('generate', candidate);
    assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
    assert.equal(platform.calls.length, 1);
    assert.equal(Object.keys(platform.state.countries.testland.nodes).length, 4);
  }
});

test('大型每期单次生成且最多 24 项；超额结果不提交', async () => {
  for (const count of [8, 9]) {
    const platform = new SingleCountryPlatform();
    platform.state.settings.size = 'large';
    platform.nodeCount = count;
    const controller = new FocusController(platform);
    await controller.run('generate', candidate);
    assert.equal(controller.jobs[0].state, count === 8 ? 'success' : 'failed', controller.jobs[0].message);
    assert.equal(platform.commits, count === 8 ? 1 : 0);
    assert.equal(platform.calls.length, 1);
  }
});

type Reply = Record<string, any>;
/** One generate run whose reply gets `change`; returns the job, the platform and the reply sent. */
async function generateWith(change: (reply: Reply) => void) {
  const platform = new SingleCountryPlatform();
  const generate = platform.generate.bind(platform);
  let reply: Reply = {};
  platform.generate = async (messages) => {
    reply = JSON.parse((await generate(messages)).content);
    change(reply);
    return { content: JSON.stringify(reply) };
  };
  const controller = new FocusController(platform);
  try {
    await controller.run('generate', candidate);
    return { job: controller.jobs[0], platform, reply };
  } finally {
    controller.dispose();
  }
}
const generatedPolitics = () => ({
  ruling: 'crown',
  factions: [
    { id: 'crown', name: '王党', appeal: '王权高于一切', leader: '女王', stance: 'hardline', support: 50 },
    { id: 'nobles', name: '旧贵族', appeal: '恢复领主特权', stance: 'extreme', support: 30 },
    { id: 'guilds', name: '商会派', appeal: '开放商路', stance: 'moderate', support: 20 },
  ],
  members: [
    { id: 'hohen', name: '霍亨家族', kind: 'family', weight: 'heavy', faction: 'nobles', note: '北境大领主' },
    {
      id: 'academy',
      name: '星辉学塔',
      kind: 'institution',
      weight: 'medium',
      faction: null,
      note: '不涉政争',
    },
  ],
  succession: '女王指定继承人，由枢密院确认',
});
const condition = (faction: string, minimum = 40) => ({
  kind: 'support',
  faction,
  minimum,
  label: `${faction} 支持度 ≥ ${minimum}`,
});
const focusOf = (reply: Reply, id: string) => reply.nodes.find((node: Reply) => node.id === id);
/** Politics and faction rules in every place; b2_1 names `reform`, which b1_0 creates. */
function withFactions(reply: Reply) {
  reply.politics = generatedPolitics();
  focusOf(reply, 'b0_1').requirements.push(condition('crown'));
  focusOf(reply, 'b0_1').mutex.backers = ['crown'];
  focusOf(reply, 'b0_2').mutex.backers = ['nobles', 'guilds'];
  focusOf(reply, 'b0_3').effects.push(
    { id: 'turn', kind: 'member', member: 'hohen', faction: 'crown' },
    { id: 'fall', kind: 'support', faction: 'nobles', value: -10 },
    { id: 'rise', kind: 'support', faction: 'crown', value: 10, when: [condition('crown', 30)] },
  );
  focusOf(reply, 'b1_0').effects.push({
    id: 'found',
    kind: 'faction',
    key: 'reform',
    name: '改革党',
    appeal: '废除特权',
    stance: 'moderate',
    support: 10,
  });
  focusOf(reply, 'b2_1').requirements.push(condition('reform', 10));
  focusOf(reply, 'b2_1').mutex.backers = ['reform'];
}

test('生成回复带政局：连同派系规则安装，派系依序取得色位，可引用另一国策建立的派系；不带政局照旧', async () => {
  const { job, platform, reply } = await generateWith(withFactions);
  assert.equal(job.state, 'success', job.message);
  const country = platform.state.countries.testland;
  assert.deepEqual(country.politics, {
    ...reply.politics,
    factions: reply.politics.factions.map((faction: Reply, color: number) => ({ ...faction, color })),
  });
  assert.deepEqual(country.nodes.b0_1.requirements, [condition('crown')]);
  assert.deepEqual(country.nodes.b0_3.effects, focusOf(reply, 'b0_3').effects);
  assert.deepEqual(country.nodes.b2_1.mutex?.backers, ['reform']);
  const plain = await generateWith(() => {});
  assert.equal(plain.job.state, 'success', plain.job.message);
  assert.equal('politics' in plain.platform.state.countries.testland, false);
});

const sevenFactions = Array.from({ length: 7 }, (_, i) => ({
  id: `f${i}`,
  name: `派系${i}`,
  appeal: '诉求',
  stance: 'moderate',
  support: i ? 10 : 40,
}));
/** Name, change, error, and whether a tree file with the same content imports (relaxed rules). */
const generationRejects: [string, (reply: Reply) => void, RegExp, boolean][] = [
  [
    '只有 1 个派系',
    (r) => {
      r.politics = { ...generatedPolitics(), factions: [generatedPolitics().factions[0]], members: [] };
      r.politics.factions[0].support = 100;
    },
    /生成时派系须为 2–6 个/,
    true,
  ],
  [
    '7 个派系',
    (r) => {
      r.politics = { ...generatedPolitics(), ruling: 'f0', factions: sevenFactions, members: [] };
    },
    /生成时派系须为 2–6 个/,
    true,
  ],
  [
    '执政派系支持度为 0',
    (r) => {
      r.politics = generatedPolitics();
      r.politics.factions[0].support = 0;
      r.politics.factions[1].support = 80;
    },
    /执政派系「王党」的支持度须大于 0/,
    true,
  ],
  [
    '条件引用不存在的派系',
    (r) => {
      withFactions(r);
      focusOf(r, 'b0_1').requirements[0].faction = 'ghost';
    },
    /国策 b0_1 引用的派系 ghost 不存在/,
    true,
  ],
  [
    '效果引用不存在的派系',
    (r) => {
      withFactions(r);
      focusOf(r, 'b0_3').effects.find((effect: Reply) => effect.id === 'fall').faction = 'ghost';
    },
    /国策 b0_3 引用的派系 ghost 不存在/,
    true,
  ],
  [
    'backers 引用不存在的派系',
    (r) => {
      withFactions(r);
      focusOf(r, 'b0_2').mutex.backers = ['nobles', 'ghost'];
    },
    /国策 b0_2 引用的派系 ghost 不存在/,
    true,
  ],
  [
    '引用没有国策建立的派系',
    (r) => {
      withFactions(r);
      focusOf(r, 'b1_0').effects.pop();
    },
    /国策 b2_1 引用的派系 reform 不存在/,
    true,
  ],
  [
    '成员不存在',
    (r) => {
      withFactions(r);
      focusOf(r, 'b0_3').effects[1].member = 'nobody';
    },
    /国策 b0_3 的效果 turn：成员 nobody 不存在/,
    true,
  ],
  [
    '没有政局却用派系规则',
    (r) => {
      withFactions(r);
      delete r.politics;
    },
    /国策 b0_1 使用了派系条件、派系效果或 backers，但此国没有派系/,
    false,
  ],
  [
    '填写色位',
    (r) => {
      r.politics = generatedPolitics();
      Object.assign(r.politics.factions[0], { color: 0 });
    },
    /Unrecognized key.*color/,
    true,
  ],
  [
    '填写待决',
    (r) => {
      r.politics = { ...generatedPolitics(), pending: { ruling: 'nobles', reason: '议会罢免', at: 0 } };
    },
    /Unrecognized key.*pending/,
    true,
  ],
];
for (const [name, change, message, imports] of generationRejects) {
  test(`生成时验证退回：${name}；同样内容的国策树档案${imports ? '仍可依宽松规则汇入' : '也不能汇入'}`, async () => {
    const { job, platform, reply } = await generateWith(change);
    assert.equal(job.state, 'failed');
    assert.match(job.message, message);
    assert.equal(platform.commits, 0);
    assert.equal(platform.calls.length, 1);
    const load = () =>
      importTrees(createState(100), parseTreeFile(reply), { withProgress: false, replace: false });
    if (imports) {
      assert.equal(load().countries.testland.politics?.factions.length, reply.politics.factions.length);
    } else {
      assert.throws(load, message);
    }
  });
}

test('每次生成由脚本抽结构签送入请求，保存在国家资料；同批两国的结构签不撞形', async () => {
  const platform = new SingleCountryPlatform();
  const controller = new FocusController(platform);
  const other = { id: 'otherland', name: '另一国', description: '候选', evidence: '设定' };
  await controller.enable([candidate, other]);
  assert.deepEqual(
    controller.jobs.map((job) => job.state),
    ['success', 'success'],
  );
  const { signature } = await import('../src/structure');
  const shapes = [platform.state.countries.testland.shape!, platform.state.countries.otherland.shape!];
  for (const [index, shape] of shapes.entries()) {
    const sent = platform.calls.find((call) => call.candidate.id === [candidate, other][index].id)!.structure;
    assert.equal(sent.type.name, shape.type.name);
    assert.equal(sent.naming.name, shape.naming.name);
    assert.deepEqual(
      sent.lots.map((lot: { name: string }) => lot.name),
      shape.lots.map((lot) => lot.name),
    );
  }
  assert.notEqual(signature(shapes[0]), signature(shapes[1]));
});
