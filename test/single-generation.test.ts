import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FocusController } from '../src/workflow';
import { createState } from '../src/engine';
import { defaultConfig, StateSchema, type Config, type State } from '../src/model';
import type { GenerateResult, Platform, PromptMessage, Snapshot } from '../src/platform';

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
    history: [{ role: 'assistant', content: '本樓正文' }],
    worldbook: [{ content: '國家設定' }],
    variables: { 世界: { 時間: 100 } },
    requirements: '玩家補充要求',
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
      opposition: '領主',
      tradeoff: '效率與自治',
      destination: '共同制度',
    }));
    const nodes = branches.flatMap((branch, b) =>
      Array.from({ length: this.nodeCount }, (_, i) => {
        const id = `${branch.id}_${i}`;
        return {
          id,
          name: `國策${id}`,
          branch: branch.name,
          description: `${id} 的實施方式及取捨`,
          reason: '根據設定',
          icon: 'crown',
          days: 35,
          durationReason: '協商與實施',
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
              ? { group: `choice_${branch.id}`, route: `route${i}`, lock: 'complete', reason: '不同制度選擇' }
              : null,
          requirements:
            this.invalid === 'capability' && id === 'b0_0'
              ? [{ kind: 'capability', id: 'cap_b0_1', label: '只有後續國策才提供' }]
              : [],
          sustain: [],
          outcomes: [],
          investments: [`${id} 行政投入`],
          impact: i === this.nodeCount - 1 && !this.plain ? 'pivotal' : 'normal',
          news:
            i === this.nodeCount - 1
              ? {
                  headline: `${id} 震動鄰國`,
                  body: '各國重新評估局勢',
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
      name: '試驗國',
      description: '改革十字路口',
      evidence: '設定',
      analysis: '地方自治與集權矛盾',
      stability: 60,
      warSupport: 30,
      capabilities: [],
    };
    return JSON.stringify({
      id: p.candidate?.id ?? 'unexpected',
      name: '試驗國',
      description: '改革十字路口',
      evidence: '設定',
      analysis: '地方自治與集權矛盾',
      stability: 60,
      warSupport: 30,
      capabilities: [],
      historical: this.historical ? [{ node: 'b0_0', evidence: '已建好，但當年能力已毀' }] : [],
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
const candidate = { id: 'testland', name: '試驗國', description: '候選', evidence: '設定' };

test('每國僅一次 API 取得完整樹，完整來源同時送入並於本機排版後提交', async () => {
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

test('生成回覆使用分支 ID 或混合名稱時，本機轉換後一次請求即可保存完整樹', async () => {
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

test('不存在、空白或歧義分支仍拒絕保存，錯誤指出具體分支', async () => {
  const cases = [
    { kind: 'missing', expected: /b0_0.*不存在.*missing_branch/ },
    { kind: 'empty', expected: /分支「空分支」沒有任何國策/ },
    { kind: 'ambiguous', expected: /b0_0.*b0.*多個分支/ },
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

test('歷史國策不重新要求當年的能力，也不重發歷史效果', async () => {
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

test('取消與結構錯誤均不提交，連線限額 1 時取消後不執行排隊國家', async () => {
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

test('只有失敗才依既有重試設定再次請求，不追加分支或審查請求', async () => {
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

test('每期規模是上限與篇幅目標，不強制重要節點或最低數量', async () => {
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

test('大型每期單次生成且最多 24 項；超額結果不提交', async () => {
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
