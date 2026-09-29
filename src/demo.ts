import { demoTree } from './demo-tree';
export { demoTree } from './demo-tree';
import { applyProposal, createState, installCountry, stampNews, startFocus } from './engine';
import { defaultConfig, type Config, type State, type JobKind } from './model';
import { buildSourceContext } from './sources';
import { stamp, type GenerateResult, type Platform, type Snapshot } from './platform';
import { makeSampleState, advancePeriodSample, type Scenario } from './demo-period';

export function demoState(): State {
  let state = installCountry(createState(100), demoTree(), 100);
  state = installCountry(state, demoTree('north', '北境聯邦'), 100);
  state = installCountry(state, demoTree('coast', '蒼海同盟'), 100);
  state.countries.north.control = 'ai';
  state.countries.coast.control = 'ai';
  state = startFocus(state, 'augustium', 'focus_1_1');
  state = applyProposal(state, { id: 'demo_initial', until: 114, reason: '示範進度', steps: [] });
  return state;
}
export class DemoPlatform implements Platform {
  readonly demo = true;
  chatId(): string {
    return 'demo';
  }
  async models(): Promise<string[]> {
    throw new Error('離線測試頁不連接 API；請在酒館中載入模型。');
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
              message: '<think>離線示範思考</think><content>七省聯運計畫的勘查隊抵達帝國邊境。</content>',
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
      context: sources?.context ?? { note: '離線 UI 示範，無 API 連線' },
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
    const base = { at, evidence: '離線示範', changes: [], public: true };
    this.state = this.publish(
      applyProposal(this.state, {
        id: `demo_news_${this.revision}`,
        until: at,
        reason: '測試新聞',
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
                title: '北境關隘的對峙',
                headline: '北境聯邦封閉雪松關，帝國邊防軍連夜北調',
                description:
                  '北境聯邦以越冬物資短缺為由封閉雪松關，禁止帝國商隊通行。帝國邊防軍兩個大隊已向關外集結，雙方都聲稱只是例行防務。',
                origin: 'background',
                scope: 'front',
                importance: 'major',
                status: 'ongoing',
                settle: '任一方撤軍，或雙方簽訂通行協議',
                option: { label: '讓外交官先去談', text: '示範選項：暫無直接效果。' },
                changes: [{ country: 'north', effects: [{ id: 'tension', kind: 'warSupport', value: 5 }] }],
              },
              {
                ...base,
                id: `demo_tide_${this.revision}`,
                countries: ['coast'],
                title: '潮汐異象',
                headline: '蒼海同盟外海出現異常潮汐，三座港口暫停夜航',
                description:
                  '連續三夜的異常潮汐沖毀了燈塔的基座。同盟議會已派船匠前往修繕，商會則開始囤積航運保險。',
                origin: 'background',
                scope: 'back',
                importance: 'world',
                status: 'resolved',
                option: { label: '願海神平息怒火', text: '' },
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
    throw new Error('此頁為離線 UI 測試。真實國家辨識與 AI 生成請匯入酒館腳本後使用。');
  }
  secretLocation(): string {
    return 'memory';
  }
  async sources() {
    return [
      {
        book: '示範世界書',
        uid: 1,
        name: '七省與帝國（僅供 UI）',
        enabled: true,
        content: '示範內容',
        strategy: { type: 'constant', keys: [] },
      },
    ];
  }
  async worldbooks() {
    return { character: ['示範世界書'], all: ['示範世界書'] };
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
        reason: '測試頁時間推進',
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
      reason: '測試勘查成果',
      steps: [
        {
          at: this.state.day,
          facts: [
            {
              country: 'augustium',
              id: 'survey',
              value: true,
              evidence: 'UI 測試操作完成勘查',
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
