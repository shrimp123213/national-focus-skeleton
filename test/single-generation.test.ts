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
  stale = false;
  invalid = '';
  failedResponses = 0;
  branchCount = 3;
  nodeCount = 6;
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
    this.state.settings.size = 'small';
    this.config.jobs.generate.retries = 0;
  }
  async read(): Promise<Snapshot> {
    return {
      identity: 'floor1',
      fingerprint: String(this.revision),
      day: 100,
      turn: 1,
      state: structuredClone(this.state),
      context: this.context,
    };
  }
  async commit(snapshot: Snapshot, state: State) {
    if (snapshot.fingerprint !== String(this.revision)) {
      throw new Error('STALE:來源已改變');
    }
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
    if (this.stale) {
      this.revision++;
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
    if (p.stage === 'skeleton') {
      const skeletonNodes = nodes.map((node) => {
        const i = Number(node.id.split('_')[1]);
        return {
          id: node.id,
          name: node.name,
          branch: node.branch,
          gist: `${node.id} 的要點`,
          prerequisites: node.prerequisites,
          mutex: node.mutex ? { group: node.mutex.group, route: node.mutex.route, lock: 'complete' } : null,
          impact: node.impact,
          action: node.impact === 'pivotal' ? `${node.id} 的國家行動` : null,
          provides: [`cap_${node.id}`],
          revokes: [],
          stats: { stability: i === 1 && !this.noTension ? -5 : 0, warSupport: 0 },
          // Core branch 分支0 costs stability at b0_1; other branches' b*_5 need stability.
          requirements:
            node.id.endsWith('_5') && !node.id.startsWith('b0_') ? [{ kind: 'stability', minimum: 20 }] : [],
          sustain: [],
          outcomes: [],
        };
      });
      this.tweak?.(skeletonNodes);
      const skeleton: Record<string, any> = {
        ...header,
        branches: branches.map((branch, i) =>
          i === 0 ? { ...branch, core: true, coreReason: '核心制度抉擇' } : branch,
        ),
        relations: branches.slice(1).map((branch) => ({
          from: 'b0_1',
          to: `${branch.id}_5`,
          kind: 'exchange',
          change: '中央改革消耗穩定度，推遲地方計畫',
        })),
        choices: branches.map((branch) => ({
          group: `choice_${branch.id}`,
          routes: [
            { id: 'route1', name: '甲案', supporters: '城市' },
            { id: 'route2', name: '乙案', supporters: '領主' },
          ],
          reason: '不同制度選擇',
        })),
        capabilityCatalog: nodes.map((node) => ({ key: `cap_${node.id}`, name: `制度${node.id}` })),
        facts: [],
        historical: [],
        nodes: skeletonNodes,
      };
      this.tweakSkeleton?.(skeleton);
      return JSON.stringify(skeleton);
    }
    if (p.stage === 'skeleton-fix') {
      return JSON.stringify({ patch: this.fixer?.(p) ?? [] });
    }
    if (p.stage === 'fill') {
      const index = this.calls.filter((call) => call.stage === 'fill').length - 1;
      if (index === this.fillFailAt) {
        return '{"nodes":[';
      }
      let batch = p.batch as Record<string, any>[];
      if (index === 0) {
        batch = batch.slice(0, batch.length - this.fillDrop);
      }
      return JSON.stringify({
        nodes: batch.map((item, i) => ({
          id: item.id,
          description: `${item.id} 的實施方式及取捨`,
          reason: '根據設定',
          icon: 'crown',
          days: index === 0 && i < this.fillBad ? -1 : 35,
          durationReason: '協商與實施',
          investments: [`${item.id} 行政投入`],
          commitments: [],
          mutexReason: item.mutex ? '不同制度選擇' : null,
          news:
            item.impact === 'pivotal'
              ? {
                  headline: `${item.id} 震動鄰國`,
                  body: '各國重新評估局勢',
                  option: { label: '知道了', text: '' },
                }
              : null,
        })),
      });
    }
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
  assert.equal(Object.keys(country.nodes).length, 18);
  assert.equal(country.branches.length, 3);
  assert.equal(new Set(Object.values(country.nodes).map((n) => `${n.x},${n.y}`)).size, 18);
  const { analysis: _analysis, branches: _branches, ...legacy } = country;
  const loaded = StateSchema.parse({ ...platform.state, countries: { testland: legacy } });
  assert.deepEqual(loaded.countries.testland.branches, []);
  assert.deepEqual(loaded.countries.testland.progress, country.progress);
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

const large = (branchCount: number, nodeCount: number, segmentMax = 25) => {
  const platform = new SingleCountryPlatform();
  platform.state.settings.size = 'large';
  platform.branchCount = branchCount;
  platform.nodeCount = nodeCount;
  platform.config.apis[0].segmentMax = segmentMax;
  return platform;
};

test('標準以上先生成骨架，再分批填寫（可跨分支），合併驗證後才保存；兩國分別保存', async () => {
  const platform = new SingleCountryPlatform();
  platform.state.settings.size = 'epic';
  platform.branchCount = 5;
  platform.nodeCount = 30;
  platform.config.apis[0].segmentMax = 40;
  const controller = new FocusController(platform);
  await controller.enable([candidate, { ...candidate, id: 'second' }]);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  // 1 skeleton + ceil(150 / 40) = 4 fill batches, per country.
  assert.deepEqual(
    platform.calls.slice(0, 5).map((p) => `${p.stage}:${p.batch?.length ?? ''}`),
    ['skeleton:', 'fill:40', 'fill:40', 'fill:40', 'fill:30'],
  );
  assert.equal(platform.calls.length, 10);
  // A batch spans branches: 30 of 分支0, then 10 of 分支1.
  assert.deepEqual(
    [...new Set(platform.calls[1].batch.map((n: { branch: string }) => n.branch))],
    ['分支0', '分支1'],
  );
  // Fill requests see the whole skeleton and the fill schema, not the structure fields.
  assert.equal(platform.calls[1].skeleton.nodes.length, 150);
  assert.match(JSON.stringify(platform.calls[1].schema), /mutexReason/);
  assert.doesNotMatch(JSON.stringify(platform.calls[1].schema), /prerequisites/);
  assert.equal(platform.commits, 2);
  const country = platform.state.countries.testland;
  assert.equal(Object.keys(country.nodes).length, 150);
  assert.equal(country.nodes.b0_5.description, 'b0_5 的實施方式及取捨');
  assert.deepEqual(country.nodes.b1_0.prerequisites, [['b0_0']]);
  assert.equal(country.nodes.b0_1.mutex?.reason, '不同制度選擇');
  assert.deepEqual(
    country.nodes.b0_1.effects.map((e) => e.kind),
    ['capability', 'stability'],
  );
  assert.equal(Object.keys(platform.state.countries.second.nodes).length, 150);
});

test('API 預設的「每批填寫國策數」決定批次大小：調高或不限時請求更少', async () => {
  for (const [segmentMax, calls] of [
    [40, 4],
    [0, 2],
    [15, 8],
  ] as const) {
    const platform = large(5, 20, segmentMax);
    const controller = new FocusController(platform);
    await controller.run('generate', candidate);
    assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
    assert.equal(platform.calls.length, calls, `segmentMax=${segmentMax}`);
    assert.equal(Object.keys(platform.state.countries.testland.nodes).length, 100);
  }
});

test('生成任務指定的主要 API 優先於目前聊天的預設；預覽顯示骨架請求', async () => {
  const platform = new SingleCountryPlatform();
  platform.state.settings.size = 'large';
  platform.config.apis.push({ ...platform.config.apis[0], name: '長輸出', segmentMax: 60 });
  platform.config.jobs.generate.api = '長輸出';
  const controller = new FocusController(platform);
  assert.equal(controller.segmentMax(), 60);
  // v0.13.3: the generate task's own value wins over the older API preset value.
  controller.config.jobs.generate.segmentMax = 15;
  assert.equal(controller.segmentMax(), 15);
  controller.config.jobs.generate.segmentMax = undefined;
  const messages = await controller.preview('generate');
  assert.match(messages.map((m) => m.content).join('\n'), /"stage":"skeleton"/);
});

test('填寫逐項接受：一批 40 項中 36 項通過就保留，只補填缺漏與不合格的 4 項並附原因', async () => {
  const platform = large(5, 20, 40);
  platform.fillDrop = 3;
  platform.fillBad = 1;
  const controller = new FocusController(platform);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  const fills = platform.calls.filter((p) => p.stage === 'fill');
  // 3 batches, then one refill with only the 4 IDs; the first batch is not asked again.
  assert.deepEqual(
    fills.map((p) => p.batch.length),
    [40, 40, 20, 4],
  );
  const refill = fills[3].batch as { id: string; previousError: string }[];
  assert.deepEqual(
    refill.map((n) => n.id),
    ['b0_0', 'b1_17', 'b1_18', 'b1_19'],
  );
  assert.match(refill[0].previousError, /days/);
  assert.match(refill[1].previousError, /沒有這個國策/);
  assert.equal(Object.keys(platform.state.countries.testland.nodes).length, 100);
});

test('骨架的結構錯誤只重寫骨架，並把原因回饋給模型', async () => {
  const cases: [(p: SingleCountryPlatform) => void, RegExp][] = [
    [(p) => (p.branchCount = 8), /分支數須為 4–6，本次有 8 支/],
    [(p) => (p.nodeCount = 10), /骨架須有 70–100 個國策，本次有 50 個/],
    [(p) => (p.noTension = true), /關係 b0_1 → b1_5（利益交換）沒有實際規則對應/],
    [
      (p) =>
        (p.tweakSkeleton = (skeleton) => {
          // Plain prerequisites (b*_0 needs b0_0) are links, but do not change choices.
          skeleton.relations = skeleton.branches.slice(1).map((b: { id: string }) => ({
            from: 'b0_0',
            to: `${b.id}_0`,
            kind: 'synergy',
            change: '先完成中央改組才能展開',
          }));
        }),
      /核心分支「分支0」至少要改變 2 支其他分支的選擇（目前 0 支）/,
    ],
    [
      (p) =>
        (p.tweakSkeleton = (skeleton) => {
          skeleton.relations = skeleton.relations.slice(0, 2);
        }),
      /分支「分支3」沒有參與任何跨分支關係；請加入關係，或寫 independent/,
    ],
    [
      (p) =>
        (p.tweakSkeleton = (skeleton) => {
          skeleton.branches[1].independent = '沿海燈塔修繕早已確定經費';
        }),
      /分支「分支1」標記為獨立，卻參與跨分支關係/,
    ],
    [
      (p) =>
        (p.tweakSkeleton = (skeleton) => {
          skeleton.branches[1].core = true;
          skeleton.branches[1].coreReason = '另一個核心';
        }),
      /必須恰好有一支分支標記 core=true/,
    ],
    [
      (p) =>
        (p.tweak = (nodes) => {
          nodes.find((n) => n.id === 'b0_5')!.requirements = [{ kind: 'fact', id: 'unknown_fact' }];
        }),
      /fact 條件 unknown_fact 不在 facts 中/,
    ],
  ];
  for (const [setup, reason] of cases) {
    const platform = large(5, 20);
    setup(platform);
    platform.config.jobs.generate.retries = 1;
    const controller = new FocusController(platform);
    await controller.run('generate', candidate);
    assert.equal(controller.jobs[0].state, 'failed');
    // Patches first; the task retry (retries=1) buys a second block, and since the first block
    // made no progress, it starts from a fresh skeleton told what could not be resolved.
    assert.deepEqual(
      platform.calls.map((p) => p.stage),
      [
        'skeleton',
        'skeleton-fix',
        'skeleton-fix',
        'skeleton-fix',
        'skeleton',
        'skeleton-fix',
        'skeleton-fix',
        'skeleton-fix',
      ],
    );
    assert.match(platform.calls[1].issues.join('\n'), reason);
    assert.deepEqual(platform.calls[0].previousProblems, []);
    assert.match(platform.calls[4].previousProblems.join('\n'), reason);
    assert.match(controller.jobs[0].message, /骨架修正 6 輪（2 次嘗試）後仍有/);
  }
});

test('關係表：核心分支、獨立分支與規則說明會存進國策樹；「必須沒有」與條件式成果由骨架固定', async () => {
  const platform = large(5, 20);
  platform.tweakSkeleton = (skeleton) => {
    skeleton.relations = skeleton.relations.slice(0, 2);
    skeleton.branches[3].independent = '本支處理既有燈塔修繕，經費已定';
    skeleton.branches[4].independent = '本支只整理既有檔案';
  };
  platform.tweak = (nodes) => {
    // A shared focus with a route-specific outcome, and a "must not have" condition.
    nodes.find((n) => n.id === 'b2_8')!.conditional = [
      { when: [{ kind: 'capability', id: 'cap_b0_1' }], provides: ['cap_b0_19'], stats: { stability: 2 } },
    ];
    nodes.find((n) => n.id === 'b2_9')!.requirements = [{ kind: 'capability', id: 'cap_b0_2', negate: true }];
  };
  const controller = new FocusController(platform);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  const country = platform.state.countries.testland;
  assert.equal(country.branches[0].core, true);
  assert.equal(country.branches[3].independent, '本支處理既有燈塔修繕，經費已定');
  assert.equal(country.relations?.length, 2);
  assert.match(
    country.relations![0].via.join(),
    /「國策b0_1」使穩定度 -5 →「國策b1_5」的開始條件要求穩定度 ≥ 20/,
  );
  const conditional = country.nodes.b2_8.effects.filter((e) => e.when?.length);
  assert.deepEqual(
    conditional.map((e) => e.id),
    ['if0_gain_cap_b0_19', 'if0_stability'],
  );
  assert.equal(conditional[0].when![0].label, '制度b0_1');
  assert.deepEqual(country.nodes.b2_9.requirements[0], {
    kind: 'capability',
    id: 'cap_b0_2',
    label: '沒有「制度b0_2」',
    negate: true,
  });
  // Fill requests see each focus's relations.
  const b1 = platform.calls
    .filter((p) => p.stage === 'fill')
    .flatMap((p) => p.batch)
    .find((n: { id: string }) => n.id === 'b1_5');
  assert.equal(b1.relations[0].change, '中央改革消耗穩定度，推遲地方計畫');
});

test('永遠無法成立的條件在骨架階段退回', async () => {
  const cases: [(nodes: Record<string, any>[]) => void, RegExp][] = [
    [
      // b0_0 is a mandatory ancestor of b0_5 and nothing revokes its capability.
      (nodes) =>
        (nodes.find((n) => n.id === 'b0_5')!.requirements = [
          { kind: 'capability', id: 'cap_b0_0', negate: true },
        ]),
      /國策 b0_5 的開始條件要求沒有「制度b0_0」，但它開始前一定已有「制度b0_0」/,
    ],
    [
      (nodes) => {
        const source = nodes.find((n) => n.id === 'b2_8')!;
        source.provides = [];
        source.conditional = [{ when: [{ kind: 'capability', id: 'cap_b0_1' }], provides: ['cap_b2_8'] }];
        nodes.find((n) => n.id === 'b2_9')!.sustain = [{ kind: 'capability', id: 'cap_b2_8' }];
      },
      /能力「制度b2_8」只由條件式成果提供，不能作為國策 b2_9 的推進條件/,
    ],
  ];
  for (const [tweak, reason] of cases) {
    const platform = large(5, 20);
    platform.config.jobs.generate.retries = 0;
    platform.tweak = tweak;
    const controller = new FocusController(platform);
    await controller.run('generate', candidate);
    assert.equal(controller.jobs[0].state, 'failed');
    assert.match(controller.jobs[0].message, reason);
  }
});

test('GPT 審查修正：「沒有 K 才能建立 K」可以通過；注定走不通的否定條件、互相矛盾的條件、規則上並不獨立的獨立分支會退回', async () => {
  const ok = large(5, 20);
  ok.tweak = (nodes) => {
    nodes.find((n) => n.id === 'b0_4')!.requirements = [{ kind: 'capability', id: 'cap_b0_4', negate: true }];
  };
  let controller = new FocusController(ok);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);

  const cases: [(p: SingleCountryPlatform) => void, RegExp][] = [
    [
      // The only revoker (b0_5) comes after the blocked focus (b0_4).
      (p) =>
        (p.tweak = (nodes) => {
          nodes.find((n) => n.id === 'b0_4')!.requirements = [
            { kind: 'capability', id: 'cap_b0_0', negate: true },
          ];
          nodes.find((n) => n.id === 'b0_5')!.revokes = ['cap_b0_0'];
        }),
      /國策 b0_4 的開始條件要求沒有「制度b0_0」，但它開始前一定已有「制度b0_0」，而且沒有能在它之前完成的國策撤銷/,
    ],
    [
      (p) =>
        (p.tweak = (nodes) => {
          const node = nodes.find((n) => n.id === 'b3_5')!;
          node.requirements.push({ kind: 'capability', id: 'cap_b1_0' });
          node.sustain = [{ kind: 'capability', id: 'cap_b1_0', negate: true }];
        }),
      /國策 b3_5 同時要求有與沒有「制度b1_0」，條件互相矛盾/,
    ],
    [
      (p) => {
        p.tweakSkeleton = (skeleton) => {
          skeleton.relations = skeleton.relations.slice(0, 2);
          skeleton.branches[3].independent = '本支處理既有燈塔修繕';
          skeleton.branches[4].independent = '本支只整理既有檔案';
        };
        p.tweak = (nodes) => {
          nodes.find((n) => n.id === 'b3_5')!.requirements.push({ kind: 'capability', id: 'cap_b0_0' });
        };
      },
      /分支「分支3」標記為獨立，但規則上與分支「分支0」互相影響（「國策b0_0」提供「制度b0_0」/,
    ],
  ];
  for (const [setup, reason] of cases) {
    const platform = large(5, 20);
    platform.config.jobs.generate.retries = 0;
    setup(platform);
    controller = new FocusController(platform);
    await controller.run('generate', candidate);
    assert.equal(controller.jobs[0].state, 'failed');
    assert.match(controller.jobs[0].message, reason);
  }
});

test('GPT 第二輪審查：擇一前置的撤銷者要能繞過受阻國策且不鎖掉它的路線；獨立分支只能共用起點國策', async () => {
  const orCase = (alternative: string) => (nodes: Record<string, any>[]) => {
    const blocked = nodes.find((n) => n.id === 'b0_4')!;
    blocked.requirements = [{ kind: 'capability', id: 'cap_b0_0', negate: true }];
    blocked.mutex = { group: 'choice_b0', route: 'route1', lock: 'complete' };
    const revoker = nodes.find((n) => n.id === 'b1_4')!;
    revoker.revokes = ['cap_b0_0'];
    revoker.prerequisites = [['b0_4', alternative]];
  };
  // Legal: b2_4 is compatible with b0_4's route, so b1_4 can revoke the capability first.
  const legal = large(5, 20);
  legal.tweak = orCase('b2_4');
  let controller = new FocusController(legal);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);

  const cases: [(p: SingleCountryPlatform) => void, RegExp][] = [
    [
      // The only way around b0_4 goes through b0_2, which is b0_4's excluded route.
      (p) => (p.tweak = orCase('b0_2')),
      /國策 b0_4 的開始條件要求沒有「制度b0_0」，但它開始前一定已有「制度b0_0」，而且沒有能在它之前完成的國策撤銷/,
    ],
    [
      (p) => {
        p.tweakSkeleton = (skeleton) => {
          skeleton.relations = skeleton.relations.slice(0, 2);
          skeleton.branches[3].independent = '本支處理既有燈塔修繕';
          skeleton.branches[4].independent = '本支只整理既有檔案';
        };
        p.tweak = (nodes) => {
          nodes.find((n) => n.id === 'b3_0')!.prerequisites = [['b0_19']];
        };
      },
      /分支「分支3」標記為獨立，但「國策b3_0」以其他分支中後期的「國策b0_19」為前置/,
    ],
  ];
  for (const [setup, reason] of cases) {
    const platform = large(5, 20);
    platform.config.jobs.generate.retries = 0;
    setup(platform);
    controller = new FocusController(platform);
    await controller.run('generate', candidate);
    assert.equal(controller.jobs[0].state, 'failed');
    assert.match(controller.jobs[0].message, reason);
  }
});

test('骨架的明確筆誤在本機修正，不發修正請求：分支名稱簡繁、中文關係類型、自創的否定條件、條件裡的 label、缺少的鎖定時機', async () => {
  const platform = large(5, 20);
  platform.tweak = (nodes) => {
    nodes.find((n) => n.id === 'b0_7')!.branch = '分支 0';
    nodes.find((n) => n.id === 'b1_7')!.branch = 'b1';
    nodes.find((n) => n.id === 'b2_9')!.requirements = [
      { kind: 'not_capability', id: 'cap_b0_2', label: '沒有乙案' },
    ];
    delete nodes.find((n) => n.id === 'b0_1')!.mutex.lock;
  };
  platform.tweakSkeleton = (skeleton) => {
    skeleton.relations[0].kind = '利益交換';
  };
  const controller = new FocusController(platform);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  assert.ok(!platform.calls.some((p) => p.stage === 'skeleton-fix'));
  const country = platform.state.countries.testland;
  assert.equal(country.nodes.b0_7.branch, '分支0');
  assert.equal(country.nodes.b1_7.branch, '分支1');
  assert.equal((country.nodes.b2_9.requirements[0] as { negate?: boolean }).negate, true);
  assert.equal(country.nodes.b0_1.mutex?.lock, 'complete');
  assert.equal(country.relations![0].kind, 'exchange');
});

test('骨架有錯時一次列出所有問題，以 JSON Patch 局部修正；數量不足用 insert 補齊，不重寫整份', async () => {
  const platform = new SingleCountryPlatform();
  platform.state.settings.size = 'large';
  platform.branchCount = 5;
  platform.nodeCount = 13; // 65 focuses: 5 short of 70.
  platform.tweak = (nodes) => {
    nodes.find((n) => n.id === 'b0_5')!.provides.push('cap_unknown');
    nodes.find((n) => n.id === 'b3_2')!.requirements = [{ kind: 'wish', id: 'cap_b3_0' }];
  };
  platform.fixer = (request) => {
    if (request.issues.some((issue: string) => issue.includes('/nodes/b3_2/requirements/0/kind'))) {
      return [
        { op: 'replace', path: '/nodes/b3_2/requirements/0/kind', value: 'capability' },
        { op: 'insert', path: '/capabilityCatalog/-', value: { key: 'cap_unknown', name: '新設制度' } },
      ];
    }
    let previous = 'b4_12';
    return Array.from({ length: 5 }, (_, i) => {
      const id = `b4_x${i}`;
      const op = {
        op: 'insert',
        path: '/nodes/-',
        value: {
          id,
          name: `補充${id}`,
          branch: '分支4',
          gist: '補上的國策',
          prerequisites: [[previous]],
          mutex: null,
          impact: 'normal',
        },
      };
      previous = id;
      return op;
    });
  };
  const controller = new FocusController(platform);
  controller.config.runLog = true;
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  const fixes = platform.calls.filter((p) => p.stage === 'skeleton-fix');
  assert.equal(platform.calls.filter((p) => p.stage === 'skeleton').length, 1);
  // The run log names each request's stage, so fix rounds are visible to the player.
  assert.deepEqual(
    controller.logs
      .map((log) => log.stage)
      .reverse()
      .slice(0, 3),
    ['生成骨架', '修正骨架（第 1/3 輪，1 個問題）', '修正骨架（第 2/3 輪，1 個問題）'],
  );
  assert.equal(fixes.length, 2);
  // Round 1: the schema problem, named by focus id. Round 2: every remaining problem at once.
  assert.match(fixes[0].issues.join('\n'), /\/nodes\/b3_2\/requirements\/0\/kind/);
  assert.match(
    fixes[1].issues.join('\n'),
    /骨架須有 70–100 個國策，本次有 65 個：請用 insert \/nodes\/- 新增至少 5 個國策/,
  );
  assert.equal(Object.keys(platform.state.countries.testland.nodes).length, 70);
  assert.equal(platform.state.countries.testland.nodes.b4_x4.prerequisites[0][0], 'b4_x3');
});

test('修正輪數用完時不保存；重跑從目前的骨架繼續修正，不重新生成骨架', async () => {
  const platform = large(5, 20);
  platform.config.jobs.generate.retries = 0;
  platform.tweak = (nodes) => {
    nodes.find((n) => n.id === 'b0_5')!.provides.push('cap_unknown');
    nodes.find((n) => n.id === 'b1_5')!.provides.push('cap_missing');
  };
  const controller = new FocusController(platform);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'failed');
  assert.match(
    controller.jobs[0].message,
    /骨架修正 3 輪（1 次嘗試）後仍有 2 個問題[\s\S]*cap_unknown[\s\S]*cap_missing/,
  );
  platform.fixer = () => [
    { op: 'insert', path: '/capabilityCatalog/-', value: { key: 'cap_unknown', name: '甲' } },
    { op: 'insert', path: '/capabilityCatalog/-', value: { key: 'cap_missing', name: '乙' } },
  ];
  const before = platform.calls.length;
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  assert.equal(platform.calls[before].stage, 'skeleton-fix');
  assert.ok(!platform.calls.slice(before).some((p) => p.stage === 'skeleton'));
});

test('撤銷能力不能把需要它的國策卡死；必經前置或互斥的情況可以通過；互斥可以跨分支', async () => {
  const unsafe = large(5, 20);
  unsafe.config.jobs.generate.retries = 0;
  unsafe.tweak = (nodes) => {
    nodes.find((n) => n.id === 'b1_6')!.revokes = ['cap_b0_2'];
    nodes.find((n) => n.id === 'b0_6')!.sustain = [{ kind: 'capability', id: 'cap_b0_2' }];
  };
  let controller = new FocusController(unsafe);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'failed');
  assert.match(controller.jobs[0].message, /b1_6 撤銷能力 cap_b0_2 後，需要它的國策 b0_6 可能永遠無法推進/);

  const restored = large(5, 20);
  restored.tweak = (nodes) => {
    nodes.find((n) => n.id === 'b1_6')!.revokes = ['cap_b0_2'];
    nodes.find((n) => n.id === 'b0_6')!.sustain = [{ kind: 'capability', id: 'cap_b0_2' }];
    // b1_7 always comes after b1_6 and gives the capability back.
    nodes.find((n) => n.id === 'b1_7')!.provides.push('cap_b0_2');
  };
  controller = new FocusController(restored);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);

  const safe = large(5, 20);
  safe.tweak = (nodes) => {
    nodes.find((n) => n.id === 'b1_6')!.revokes = ['cap_b0_2'];
    // b1_5 must be completed before b1_6, so the revocation cannot strand it.
    nodes.find((n) => n.id === 'b1_5')!.requirements.push({ kind: 'capability', id: 'cap_b0_2' });
    // A route of 分支1's choice used in 分支0.
    nodes.find((n) => n.id === 'b0_4')!.mutex = { group: 'choice_b1', route: 'route1', lock: 'start' };
  };
  controller = new FocusController(safe);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  const country = safe.state.countries.testland;
  assert.deepEqual(country.nodes.b1_6.effects[1], {
    id: 'lose_cap_b0_2',
    kind: 'capability',
    key: 'cap_b0_2',
    name: '制度b0_2',
    active: false,
  });
  assert.equal(country.nodes.b0_4.mutex?.lock, 'start');
});

test('填寫中途失敗時不保存；重跑沿用骨架與已填好的國策，只填剩下的', async () => {
  const platform = large(5, 20, 40);
  platform.fillFailAt = 1;
  const controller = new FocusController(platform);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'failed');
  assert.equal(platform.commits, 0);
  assert.deepEqual(
    platform.calls.map((p) => p.stage),
    ['skeleton', 'fill', 'fill'],
  );
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  assert.deepEqual(
    platform.calls.slice(3).map((p) => `${p.stage}:${p.batch.length}:${p.batch[0].id}`),
    ['fill:40:b2_0', 'fill:20:b4_0'],
  );
  assert.equal(Object.keys(platform.state.countries.testland.nodes).length, 100);
});

test('取消、來源過期與結構錯誤均不提交，取消多國任務後不繼續下一國', async () => {
  for (const defect of ['stale', 'route', 'capability', 'reference']) {
    const platform = new SingleCountryPlatform();
    platform.stale = defect === 'stale';
    platform.invalid = defect;
    const controller = new FocusController(platform);
    await controller.run('generate', candidate);
    assert.equal(controller.jobs[0].state, defect === 'stale' ? 'stale' : 'failed');
    assert.equal(platform.commits, 0);
    assert.equal(platform.calls.length, 1);
  }
  const platform = new SingleCountryPlatform();
  platform.block = true;
  const controller = new FocusController(platform);
  const run = controller.enable([candidate, { ...candidate, id: 'second' }]);
  for (let i = 0; i < 100 && !platform.calls.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(platform.calls.length, 1);
  controller.cancelAll();
  await run;
  assert.equal(controller.jobs[0].state, 'cancelled');
  assert.equal(platform.commits, 0);
  assert.equal(platform.calls.length, 1);
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

test('沒有重要國策的樹會被退回，並把缺少的分支告訴模型', async () => {
  const platform = new SingleCountryPlatform();
  platform.plain = true;
  platform.config.jobs.generate.retries = 1;
  const controller = new FocusController(platform);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'failed');
  assert.match(platform.calls[1].correction, /分支「分支0」沒有重要國策/);
});

test('任務重試次數讓骨架多修正幾輪；有進展時繼續修正，不重新生成骨架', async () => {
  const platform = large(5, 20);
  platform.config.jobs.generate.retries = 2;
  platform.tweak = (nodes) => {
    for (const [i, id] of ['b0_5', 'b1_5', 'b2_5', 'b3_5', 'b4_5'].entries()) {
      nodes.find((n) => n.id === id)!.provides.push(`cap_unknown${i}`);
    }
  };
  // Each round fixes one missing capability: slow but steady progress.
  let next = 0;
  platform.fixer = () => [
    { op: 'insert', path: '/capabilityCatalog/-', value: { key: `cap_unknown${next}`, name: `補${next++}` } },
  ];
  const controller = new FocusController(platform);
  await controller.run('generate', candidate);
  assert.equal(controller.jobs[0].state, 'success', controller.jobs[0].message);
  const stages = platform.calls.map((p) => p.stage).filter((stage) => stage.startsWith('skeleton'));
  assert.deepEqual(stages, ['skeleton', ...Array(5).fill('skeleton-fix')]);
});
