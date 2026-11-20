import { demoTree } from './demo-tree';
export { demoTree } from './demo-tree';
import { applyProposal, changeCountry, createState, installCountry, stampNews, startFocus } from './engine';
import { defaultConfig, type Config, type Effect, type FocusNode, type State, type JobKind } from './model';
import { buildSourceContext } from './sources';
import {
  stamp,
  storyDay,
  type GenerateResult,
  type Platform,
  type PromptMessage,
  type Snapshot,
} from './platform';
import { makeSampleState, advancePeriodSample, type Scenario } from './demo-period';

/**
 * Offline sample factions for the preview page (v0.18.0): the empire's politics, route backers,
 * support conditions and faction effects. Authored for the interface, not worldbook canon.
 */
function withFactions(tree: ReturnType<typeof demoTree>) {
  const backers: Record<string, string[]> = {
    focus_0_2: ['crown'],
    focus_0_6: ['nobles'],
    focus_0_10: ['cabinet', 'trade'],
    focus_1_9: ['trade'],
    focus_1_10: ['cabinet'],
  };
  const requirements: Record<string, FocusNode['requirements']> = {
    focus_0_3: [{ kind: 'support', faction: 'crown', minimum: 45, label: '皇权派支持度达到 45' }],
    focus_0_7: [
      { kind: 'support', faction: 'nobles', minimum: 40, negate: true, label: '旧贵族支持度低于 40' },
    ],
  };
  const effects: Record<string, Effect[]> = {
    // The main focus at the start: after it completes, its conditional effect shows as not applied.
    focus_1_1: [
      { id: 'trade_up', kind: 'support', faction: 'trade', value: 5 },
      {
        id: 'trade_more',
        kind: 'support',
        faction: 'trade',
        value: 5,
        when: [{ kind: 'support', faction: 'trade', minimum: 30, label: '商贸派支持度达到 30' }],
      },
    ],
    focus_0_2: [
      { id: 'crown_up', kind: 'support', faction: 'crown', value: 10 },
      { id: 'nobles_down', kind: 'support', faction: 'nobles', value: -5 },
    ],
    focus_0_6: [
      { id: 'nobles_up', kind: 'support', faction: 'nobles', value: 10 },
      { id: 'bolyu_turns', kind: 'member', member: 'bolyu', faction: 'nobles' },
    ],
    focus_0_9: [
      {
        id: 'provinces',
        kind: 'faction',
        key: 'provinces',
        name: '行省自治派',
        appeal: '七省各自征税与募兵。',
        stance: 'moderate',
        support: 10,
      },
    ],
    focus_0_10: [
      { id: 'cabinet_up', kind: 'support', faction: 'cabinet', value: 15 },
      { id: 'crown_down', kind: 'support', faction: 'crown', value: -10 },
      { id: 'schmidt_turns', kind: 'member', member: 'schmidt', faction: 'cabinet' },
    ],
    focus_0_13: [{ id: 'trade_joins', kind: 'merge', source: 'trade', target: 'cabinet' }],
  };
  return {
    ...tree,
    nodes: tree.nodes.map((node) => ({
      ...node,
      mutex: node.mutex && backers[node.id] ? { ...node.mutex, backers: backers[node.id] } : node.mutex,
      requirements: [...node.requirements, ...(requirements[node.id] ?? [])],
      effects: [...node.effects, ...(effects[node.id] ?? [])],
    })),
    politics: {
      ruling: 'crown',
      succession: '皇位世袭；内阁经选举产生，枢密院可弹劾内阁。',
      factions: (
        [
          ['crown', '皇权派', 'hardline', 40, '女皇', '帝国由女皇与枢密院直辖，议会只备咨询。'],
          ['nobles', '旧贵族', 'hardline', 30, '霍亨伯格家主', '恢复各大家族的封地特权与世袭席位。'],
          ['trade', '商贸派', 'moderate', 20, '施密特家主', '以商路与关税养国，反对代价高昂的战争。'],
          ['cabinet', '内阁派', 'moderate', 10, '', '由选举官员组成的内阁向议会负责。'],
        ] as const
      ).map(([id, name, stance, support, leader, appeal]) => ({
        id,
        name,
        stance,
        support,
        appeal,
        ...(leader ? { leader } : {}),
      })),
      members: (
        [
          ['privy', '枢密院', 'institution', 'heavy', 'crown', '女皇的直属机构'],
          ['bolyu', '波流家族', 'family', 'medium', 'crown', '皇室姻亲'],
          ['hohen', '霍亨伯格家族', 'family', 'heavy', 'nobles', '北方最大的封地'],
          ['raven', '雷文家族', 'family', 'medium', 'nobles', '世袭上院议席'],
          ['gordon', '戈登家族', 'family', 'light', 'nobles', '没落的边境领主'],
          ['schmidt', '施密特家族', 'family', 'heavy', 'trade', '掌握内河商路'],
          ['wyndham', '温德姆家族', 'family', 'medium', 'cabinet', '议会党团的出资者'],
          ['officials', '内阁选举官员', 'institution', 'light', 'cabinet', '经选举进入内阁的文官'],
          ['scholars', '时钟塔学者', 'institution', 'medium', null, '尚未表明支持哪一方'],
        ] as const
      ).map(([id, name, kind, weight, faction, note]) => ({ id, name, kind, weight, faction, note })),
    },
  };
}

/**
 * Offline reply to the 补上政局 request: any sample country without politics gets these factions.
 * Authored for the interface, not worldbook canon.
 */
const demoPolitics = {
  reason: '离线示范：示范资料写有掌握联合议会的统合派、把持各邦议席的自治派，以及主张开战的边军。',
  politics: {
    ruling: 'union',
    succession: '盟主由各邦议会推举，任期六年。',
    factions: [
      {
        id: 'union',
        name: '统合派',
        appeal: '扩大盟主与联合议会的权力。',
        leader: '盟主',
        stance: 'moderate',
        support: 45,
      },
      { id: 'states', name: '自治派', appeal: '各邦自行征税与募兵。', stance: 'hardline', support: 35 },
      { id: 'border', name: '边军派', appeal: '以武力收回失地。', stance: 'extreme', support: 20 },
    ],
    members: [
      {
        id: 'assembly',
        name: '联合议会',
        kind: 'institution',
        weight: 'heavy',
        faction: 'union',
        note: '盟主的根基',
      },
      {
        id: 'houses',
        name: '各邦世家',
        kind: 'family',
        weight: 'medium',
        faction: 'states',
        note: '把持地方议席',
      },
      {
        id: 'garrison',
        name: '边境守备军',
        kind: 'army',
        weight: 'medium',
        faction: 'border',
        note: '驻守边境的老兵',
      },
      { id: 'harbor', name: '港口商会', kind: 'guild', weight: 'light', faction: null, note: '尚未表态' },
    ],
  },
};

/** `factions` gives the empire sample factions (the preview page); tests keep the plain tree. */
export function demoState(start = 100, factions = false): State {
  let state = installCountry(createState(start), factions ? withFactions(demoTree()) : demoTree(), start);
  state = installCountry(state, demoTree('north', '北境联邦'), start);
  state = installCountry(state, demoTree('coast', '苍海同盟'), start);
  state.countries.north.control = 'ai';
  state.countries.coast.control = 'ai';
  state = startFocus(state, 'augustium', 'focus_1_1');
  // The sample starts its AI countries on a main focus, as a played chat does.
  state = applyProposal(state, {
    id: 'demo_initial',
    until: start + 14,
    reason: '示范进度',
    steps: [
      {
        at: start,
        facts: [],
        events: [],
        selections: [
          { country: 'north', node: 'regional_1', reason: '示范：北境先整顿地方' },
          { country: 'coast', node: 'regional_9', reason: '示范：苍海先经营海路' },
        ],
      },
    ],
  });
  return state;
}
/** The card's source time text for a story day, for example 复兴纪元488年-03月-15日-星期六-09:00. */
function eraText(day: number): string {
  const date = new Date(Math.round(((day - 719528) * 86400000) / 60000) * 60000);
  const two = (value: number) => String(value).padStart(2, '0');
  return `复兴纪元${date.getUTCFullYear()}年-${two(date.getUTCMonth() + 1)}月-${two(date.getUTCDate())}日-星期${'日一二三四五六'[date.getUTCDay()]}-${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`;
}
export class DemoPlatform implements Platform {
  readonly demo = true;
  private readonly calendar: boolean;
  private readonly factions: boolean;
  private readonly start: number;
  /**
   * `calendar` starts the story on a date and gives the card's era text as the source time, so the
   * preview shows times as a real chat does. Tests keep the plain day count. `factions` gives the
   * empire sample factions (v0.18.0); tests keep the plain tree.
   */
  constructor({ calendar = false, factions = false } = {}) {
    this.calendar = calendar;
    this.factions = factions;
    this.start = calendar ? storyDay('488-03-01 09:00') : 100;
    this.state = demoState(this.start, factions);
  }
  chatId(): string {
    return 'demo';
  }
  async models(): Promise<string[]> {
    throw new Error('离线测试页不连接 API；请在酒馆中载入模型。');
  }
  private state: State;
  private revision = 0;
  private config = defaultConfig();
  private changes = new Set<() => void>();
  private scenario: Scenario = 'crisis';
  async periodSample(completed: boolean): Promise<void> {
    this.scenario = completed ? 'complete' : 'crisis';
    this.state = makeSampleState(this.scenario, this.start);
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
    const time = this.calendar ? eraText(this.state.day) : undefined;
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
          variables: { 世界: { 时间: time ?? this.state.day } },
          renderEntry: async (text) => text,
        })
      : undefined;
    return {
      identity: 'demo',
      messageId: this.revision,
      turn: 8,
      day: this.state.day,
      state: { ...structuredClone(this.state), ...(time ? { time } : {}) },
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
  async generate(messages: PromptMessage[]): Promise<GenerateResult> {
    // The preview can try the 补上政局 button offline; every other request needs a real API.
    if (messages.some((message) => message.content.includes('"stage":"politics"'))) {
      return { content: JSON.stringify(demoPolitics) };
    }
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
  /**
   * Offline sample of a change of government that waits for the player (v0.18.0). Automatic
   * periods go off, as they are when an update records such a change.
   */
  async pendingSample(): Promise<void> {
    const politics = this.state.countries.augustium?.politics;
    const next =
      politics?.factions.find((f) => f.id === 'cabinet' && f.id !== politics.ruling && f.support > 0) ??
      politics?.factions.find((f) => f.id !== politics.ruling && f.support > 0);
    if (!next) {
      throw new Error('示范帝国没有可以接掌的派系；请先「重设示范」');
    }
    const state = changeCountry(this.state, 'augustium', { autoPeriod: false });
    state.countries.augustium.politics!.pending = {
      ruling: next.id,
      reason: '议会逼宫后女皇退居离宫，内阁受命摄政。',
      at: state.day,
    };
    this.state = state;
    this.revision++;
    for (const change of this.changes) {
      change();
    }
  }
  reset(): void {
    this.state = demoState(this.start, this.factions);
    this.revision++;
    for (const change of this.changes) {
      change();
    }
  }
}
