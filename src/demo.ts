import { demoTree } from './demo-tree';
export { demoTree } from './demo-tree';
import { applyProposal, createState, installCountry, stampNews, startFocus } from './engine';
import { defaultConfig, type Config, type State, type JobKind } from './model';
import { buildSourceContext } from './sources';
import { stamp, type GenerateResult, type Platform, type Snapshot } from './platform';
import { makeSampleState, advancePeriodSample, type Scenario } from './demo-period';

export function demoState(): State {
  let state = installCountry(createState(100), demoTree(), 100);
  state = installCountry(state, demoTree('north', '北境联邦'), 100);
  state = installCountry(state, demoTree('coast', '苍海同盟'), 100);
  state.countries.north.control = 'ai';
  state.countries.coast.control = 'ai';
  state = startFocus(state, 'augustium', 'focus_1_1');
  state = applyProposal(state, { id: 'demo_initial', until: 114, reason: '示范进度', steps: [] });
  return state;
}
export class DemoPlatform implements Platform {
  readonly demo = true;
  chatId(): string {
    return 'demo';
  }
  async models(): Promise<string[]> {
    throw new Error('离线测试页不连接 API；请在酒馆中载入模型。');
  }
  private state = demoState();
  private revision = 0;
  private config = defaultConfig();
  private changes = new Set<() => void>();
  private scenario: Scenario = 'crisis';
  async periodSample(completed: boolean): Promise<void> {
    this.scenario = completed ? 'complete' : 'crisis';
    this.state = makeSampleState(this.scenario);
    this.revision++;
    for (const change of this.changes) {
      change();
    }
  }
  async nextPeriod(): Promise<void> {
    this.state = advancePeriodSample(this.state, this.scenario);
    this.revision++;
    for (const change of this.changes) {
      change();
    }
  }
  async read(config = this.config, job?: JobKind): Promise<Snapshot> {
    const sources = job
      ? await buildSourceContext({
          config,
          job,
          currentId: 8,
          messages: [
            {
              message_id: 8,
              role: 'assistant',
              message: '<think>离线示范思考</think><content>七省联运计划的勘查队抵达帝国边境。</content>',
            },
          ],
          entries: await this.sources(),
          memoryEntries: [],
          variables: { 世界: { 时间: this.state.day } },
          renderEntry: async (text) => text,
        })
      : undefined;
    return {
      identity: 'demo',
      messageId: this.revision,
      turn: 8,
      day: this.state.day,
      state: structuredClone(this.state),
      context: sources?.context ?? { note: '离线 UI 示范，无 API 连线' },
      prompts: sources?.prompts,
      sourceReport: sources?.report,
    };
  }
  async commit(snapshot: Snapshot, state: State): Promise<void> {
    this.state = this.publish(structuredClone(state));
    this.revision++;
  }
  /** Stand-in for an AI floor: each saved revision publishes its news on "floor" = revision. */
  private publish(state: State): State {
    stampNews(state, this.revision);
    return state;
  }
  async news(): Promise<void> {
    const at = this.state.day;
    const base = { at, evidence: '离线示范', changes: [], public: true };
    this.state = this.publish(
      applyProposal(this.state, {
        id: `demo_news_${this.revision}`,
        until: at,
        reason: '测试新闻',
        steps: [
          {
            at,
            facts: [],
            selections: [],
            events: [
              {
                ...base,
                id: `demo_border_${this.revision}`,
                countries: ['augustium', 'north'],
                title: '北境关隘的对峙',
                headline: '北境联邦封闭雪松关，帝国边防军连夜北调',
                description:
                  '北境联邦以越冬物资短缺为由封闭雪松关，禁止帝国商队通行。帝国边防军两个大队已向关外集结，双方都声称只是例行防务。',
                origin: 'background',
                scope: 'front',
                importance: 'major',
                status: 'ongoing',
                settle: '任一方撤军，或双方签订通行协议',
                option: { label: '让外交官先去谈', text: '示范选项：暂无直接效果。' },
                changes: [{ country: 'north', effects: [{ id: 'tension', kind: 'warSupport', value: 5 }] }],
              },
              {
                ...base,
                id: `demo_tide_${this.revision}`,
                countries: ['coast'],
                title: '潮汐异象',
                headline: '苍海同盟外海出现异常潮汐，三座港口暂停夜航',
                description:
                  '连续三夜的异常潮汐冲毁了灯塔的基座。同盟议会已派船匠前往修缮，商会则开始囤积航运保险。',
                origin: 'background',
                scope: 'back',
                importance: 'world',
                status: 'resolved',
                option: { label: '愿海神平息怒火', text: '' },
              },
            ],
          },
        ],
      }),
    );
    this.revision++;
    for (const change of this.changes) {
      change();
    }
  }
  async generate(..._args: Parameters<Platform['generate']>): Promise<GenerateResult> {
    throw new Error('此页为离线 UI 测试。真实国家辨识与 AI 生成请汇入酒馆脚本后使用。');
  }
  secretLocation(): string {
    return 'memory';
  }
  async sources() {
    return [
      {
        book: '示范世界书',
        uid: 1,
        name: '七省与帝国（仅供 UI）',
        enabled: true,
        content: '示范内容',
        strategy: { type: 'constant', keys: [] },
      },
    ];
  }
  async worldbooks() {
    return { character: ['示范世界书'], all: ['示范世界书'] };
  }
  loadConfig(): Config {
    return this.config;
  }
  saveConfig(config: Config): void {
    this.config = config;
  }
  onReady(): () => void {
    return () => {};
  }
  onChange(callback: () => void): () => void {
    this.changes.add(callback);
    return () => this.changes.delete(callback);
  }
  inject(): void {
    /* Preview never injects prompts into a chat. */
  }
  async advance(days: number): Promise<void> {
    this.state = this.publish(
      applyProposal(this.state, {
        id: `demo_${this.revision}`,
        until: this.state.day + days,
        reason: '测试页时间推进',
        steps: [],
      }),
    );
    this.revision++;
    for (const change of this.changes) {
      change();
    }
  }
  async outcome(): Promise<void> {
    this.state = applyProposal(this.state, {
      id: `demo_event_${this.revision}`,
      until: this.state.day,
      reason: '测试勘查成果',
      steps: [
        {
          at: this.state.day,
          facts: [
            {
              country: 'augustium',
              id: 'survey',
              value: true,
              evidence: 'UI 测试操作完成勘查',
              origin: 'story',
            },
          ],
          events: [],
          selections: [],
        },
      ],
    });
    this.revision++;
    for (const change of this.changes) {
      change();
    }
  }
  reset(): void {
    this.state = demoState();
    this.revision++;
    for (const change of this.changes) {
      change();
    }
  }
}
