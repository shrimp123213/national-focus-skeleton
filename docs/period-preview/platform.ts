import { DemoPlatform } from '../../src/demo';
import { applyProposal, createState, installCountry, validateGraph } from '../../src/engine';
import { layoutTree } from '../../src/layout';
import { EventSchema, StateSchema, type Country, type FocusNode, type State } from '../../src/model';
import type { Snapshot } from '../../src/platform';
import fixtures from './fixtures.json';

export type Scenario = keyof typeof fixtures;
export type PeriodInfo = {
  number: number;
  title: string;
  auto: boolean;
  anchor: string;
  history: { time: string; summary: string }[];
  note: string;
};
const countryId = 'augustium';
type FixtureNode = {
  id: string; title: string; icon: string; requires: string[][]; description: string;
  effect: string; mutex?: string; condition?: string;
};
const icons: Record<string, FocusNode['icon']> = {
  scroll: 'science', ship: 'trade', shield: 'army', scale: 'diplomacy', grain: 'industry', cross: 'diplomacy', star: 'crown',
};

function branchFor(id: string): string {
  if (['A03','A04','A08','A09','B07','B10','C03','C07','C10'].includes(id)) {
    return '糧運與民生';
  }
  if (['A05','A06','A07','A10','A11','B03','B04','B05','B06','B08','B09','C02','C05','C06','C09'].includes(id)) {
    return '對外安排';
  }
  return '國家議程';
}

function makeNodes(rows: FixtureNode[]): FocusNode[] {
  return layoutTree(rows.map((raw): FocusNode => {
    const other = raw.mutex ?? '';
    const group = other ? [raw.id, other].sort().join('_') : '';
    return {
      id: raw.id, name: raw.title, branch: branchFor(raw.id), description: raw.description,
      reason: '分期 UI 樣品的虛構劇情，非世界書既有事實。', icon: icons[raw.icon], x: 0, y: 0,
      days: raw.id === 'A04' ? 30 : 21,
      durationReason: '樣品用協商與行政工期；正式生成仍依世界情境決定。',
      prerequisites: raw.requires, requirements: [], sustain: [],
      outcomes: raw.condition ? [{kind:'fact',id:`outcome_${raw.id}`,label:raw.condition}] : [],
      investments: ['協商、行政與執行人力'],
      effects: [{id:'policy',kind:'capability',key:`policy_${raw.id}`,name:raw.effect,active:true}],
      mutex: other ? {group,route:raw.id,lock:'start',reason:'採取不同的國家政策安排'} : null,
      impact: 'normal', execution: 'once', news: null,
    };
  }));
}

function treeDefinition(rows: FixtureNode[], name: string) {
  const nodes = makeNodes(rows);
  return {
    id:countryId, name:'奧古斯提姆帝國', description:name, stability:68, warSupport:42,
    evidence:'分期 UI 樣品', analysis:'以最新議程承接國家發展。', relations:[],
    capabilities:[], historical:[], nodes,
    branches:[...new Set(nodes.map(n=>n.branch))].map((branch,index)=>({
      id:`agenda_${index}`, name:branch, purpose:`本期的${branch}安排`, supporters:'相關行政部門與利益群體',
      opposition:'資源分配及權責爭議', tradeoff:'政策收益伴隨新的責任與成本', destination:'建立當期可執行的安排',
    })),
  };
}

export function makeSampleState(scenario: Scenario): State {
  const sample = fixtures[scenario];
  const definition = treeDefinition(sample.first, '北境的帳，帝國的糧');
  const completed = sample.first.filter(n=>n.status==='done');
  let state = installCountry(createState(100), {
    ...definition,
    historical:completed.map(n=>({node:n.id,evidence:'樣品已發生的政策成果'})),
    capabilities:completed.map(n=>({id:`policy_${n.id}`,name:n.effect,active:true,reason:'樣品既有成果'})),
  },100);
  const country = state.countries[countryId];
  for (const row of sample.first) {
    if (row.status === 'active') {
      country.current = row.id;
      country.progress[row.id] = {...country.progress[row.id],status:'active',days:18,started:82,investments:['已投入港務協調人力'],evidence:'港口與糧倉名冊已核定，內陸配額協調中。'};
    }
  }
  const event = sample.events[0];
  state.events[event.id] = EventSchema.parse({
    id:event.id, at:100, countries:[countryId], title:event.title, description:event.description,
    current:event.description, evidence:'樣品事件紀錄', origin:'story', public:true, changes:[],
    scope:'front', importance:'major', status:'ongoing', settle:'依實際局勢確認運作成果',
    steps:event.steps.map((text,i)=>({text,state:i===0?'done':i===1?'active':'pending'})),
    timeline:[{at:100,text:event.description}],
    source:{kind:'update',country:countryId,node:scenario==='crisis'?'A04':'A05'},
  });
  state = StateSchema.parse(state);
  return state;
}

/** All period metadata lives in this disposable preview, outside the production state schema. */
export class PeriodPreview extends DemoPlatform {
  scenario: Scenario = 'crisis';
  info: PeriodInfo = {number:1,title:'北境的帳，帝國的糧',auto:true,anchor:'',history:[],note:'當前議程：北境信用爭議與糧運安排。'};
  private sampleState = makeSampleState(this.scenario);
  private serial = 0;
  private updates = 0;
  private listeners = new Set<()=>void>();
  private otherSwitches = new Map<string,boolean>();

  override chatId(): string {
    return 'period-preview';
  }
  override async read(): Promise<Snapshot> {
    return {identity:'period-preview',fingerprint:String(this.serial),turn:this.serial,day:this.sampleState.day,state:structuredClone(this.sampleState),context:{note:'現有 UI 分期樣品，不連接 API'}};
  }
  override async commit(snapshot: Snapshot, state: State): Promise<void> {
    if (snapshot.fingerprint !== String(this.serial)) {
      throw new Error('STALE:樣品已更新');
    }
    this.sampleState = StateSchema.parse(state);
    this.serial++;
  }
  override onChange(callback: ()=>void): ()=>void {
    this.listeners.add(callback);
    return ()=>this.listeners.delete(callback);
  }
  private changed(): void {
    this.serial++;
    for (const listener of this.listeners) {
      listener();
    }
  }
  period(id: string): PeriodInfo | undefined {
    return id===countryId && this.sampleState.countries[id] ? this.info : undefined;
  }
  auto(id: string): boolean {
    return id===countryId ? this.info.auto : (this.otherSwitches.get(id) ?? false);
  }
  setAuto(id: string, value: boolean): void {
    if (id===countryId) {
      this.info.auto=value;
    } else {
      this.otherSwitches.set(id,value);
    }
    this.changed();
  }
  choose(scenario: Scenario): void {
    this.scenario=scenario;
    this.reset();
  }
  override reset(): void {
    const auto=this.info.auto;
    this.info={number:1,title:'北境的帳，帝國的糧',auto,anchor:'',history:[],note:'當前議程：北境信用爭議與糧運安排。'};
    this.sampleState=makeSampleState(this.scenario);
    this.updates=0;
    this.changed();
  }
  override async advance(days: number): Promise<void> {
    this.sampleState=applyProposal(this.sampleState,{id:`sample_days_${this.serial}`,until:this.sampleState.day+days,reason:'離線樣品故事時間推進',steps:[]});
    this.changed();
  }
  override async outcome(): Promise<void> {
    await this.updatePeriod();
  }
  override async news(): Promise<void> {
    await this.updatePeriod();
  }
  async updatePeriod(): Promise<void> {
    const country=this.sampleState.countries[countryId];
    if (!country) {
      throw new Error('樣品國家已移除，請重設示範。');
    }
    this.updates++;
    const event=fixtures[this.scenario].events[Math.min(this.updates,2)];
    const existing=this.sampleState.events[event.id];
    if (existing) {
      existing.current=event.description;
      existing.timeline.push({at:this.sampleState.day,text:event.description});
      existing.steps=event.steps.map((text,i)=>({text,state:i===0?'done':i===1?'active':'pending'}));
      existing.touchedAt=this.serial;
    }
    if (!country.enabled || !this.info.auto) {
      this.info.note='世界事件已更新；此國關閉換期或已停用，保留當前樹。';
      this.changed();
      return;
    }
    if (this.info.number===2) {
      this.info.note='原事件持續更新；本期議程仍適用，維持當前國策樹。';
      this.changed();
      return;
    }
    const title=this.scenario==='crisis'?'災厄越過國境':'秩序之後的遠見';
    const template=installCountry(createState(this.sampleState.day),treeDefinition(fixtures[this.scenario].second,title),this.sampleState.day).countries[countryId];
    const anchor=this.scenario==='crisis'?'A04':'A12';
    if (country.current && country.current!==anchor) {
      this.info.note='你已改選其他主國策。此固定樣稿沒有該路線的下一期，請重設對應情境再演示。';
      this.changed();
      return;
    }
    if (!country.nodes[anchor]) {
      throw new Error('這棵樹已被替換，請重設樣品後再演示換期。');
    }
    const expected=fixtures[this.scenario].first;
    if (Object.keys(country.nodes).length!==expected.length || expected.some(row=>country.nodes[row.id]?.name!==row.title)) {
      this.info.note='目前是另行匯入或修改的樹，固定情境不會覆蓋它；請重設樣品後再演示。';
      this.changed();
      return;
    }
    // Retain the actual node and progress. Only obsolete graph prerequisites/layout are replaced.
    template.nodes[anchor]={...structuredClone(country.nodes[anchor]),prerequisites:[],x:template.nodes[anchor].x,y:template.nodes[anchor].y};
    template.progress[anchor]=structuredClone(country.progress[anchor]);
    validateGraph(template.nodes);
    const nextCountry: Country={...country,nodes:template.nodes,progress:template.progress,branches:template.branches,relations:[],description:title,treeRevision:country.treeRevision+1,current:country.current===anchor?anchor:'',locks:{...country.locks}};
    this.sampleState=StateSchema.parse({...this.sampleState,revision:this.sampleState.revision+1,countries:{...this.sampleState.countries,[countryId]:nextCountry}});
    const summary=this.scenario==='crisis' && country.progress[anchor].status==='completed'
      ? fixtures.crisis.summary.replace('糧運統籌仍在進行','糧運統籌規程已生效')
      : fixtures[this.scenario].summary;
    this.info={...this.info,number:2,title,anchor,history:[{time:'復興紀元 490 年 10 月 — 491 年 1 月',summary}],note:this.scenario==='crisis'?'跨境災害改變主要議程，已承接原糧運國策。':'本期主要目的已達成，以已完成國策承接後續議程。'};
    this.changed();
  }
}
