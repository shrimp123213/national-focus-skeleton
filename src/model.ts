import { z } from 'zod';
import { migratePrompts, normalizePrompts } from './prompts';

export const Id = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/)
  .refine((v) => !['constructor', 'prototype', '__proto__'].includes(v));
/**
 * Country keys are the country's name as written in the worldbook, so the floor
 * variable, the chat worldbook entry and the story all use one name. Older English IDs stay valid.
 * No dots, brackets, quotes or spaces: the key is also a variable path segment.
 */
export const countryKeyPattern = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_\-·・]{0,79}$/u;
export const CountryId = z
  .string()
  .regex(countryKeyPattern)
  .refine((v) => !['constructor', 'prototype', '__proto__'].includes(v))
  .describe('国家 ID：照抄 state 或 candidate 中的国家 ID（国名原文），不翻译、不改字形');
/** Event IDs may embed a country ID (`focus_国家_国策`), so they follow the country key rule. */
export const EventId = z
  .string()
  .regex(countryKeyPattern)
  .refine((v) => !['constructor', 'prototype', '__proto__'].includes(v));
const Text = z.string().min(1).max(8000);
const Day = z.number().finite().nonnegative();
/** negate=true means the fact or capability must NOT hold (skeleton edition, handoff doc section 32). */
const Negate = z.boolean().optional().describe('true＝必须「没有」这个能力或事实；省略为 false');
export const RequirementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fact'), id: Id, label: Text, negate: Negate }).strict(),
  z.object({ kind: z.literal('capability'), id: Id, label: Text, negate: Negate }).strict(),
  z
    .object({ kind: z.enum(['stability', 'warSupport']), minimum: z.number().min(0).max(100), label: Text })
    .strict(),
]);
/** Conditions checked when the effect would apply; unmet means the effect is skipped for good. */
const When = z
  .array(RequirementSchema)
  .optional()
  .describe('条件式效果：完成时这些条件都成立才生效；省略为无条件');
export const EffectSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: Id,
      kind: z.enum(['stability', 'warSupport']),
      value: z.number().min(-100).max(100),
      when: When,
    })
    .strict(),
  z
    .object({ id: Id, kind: z.literal('capability'), key: Id, name: Text, active: z.boolean(), when: When })
    .strict(),
  z.object({ id: Id, kind: z.literal('commitment'), key: Id, name: Text, when: When }).strict(),
]);
export const NodeSchema = z
  .object({
    id: Id,
    name: Text,
    branch: Text.describe('所属分支的 name，须逐字对应 branches[].name；不要填分支 ID'),
    description: Text,
    reason: Text,
    icon: z.enum(['crown', 'industry', 'army', 'trade', 'science', 'diplomacy']),
    x: z.number().int().min(0).max(1000),
    y: z.number().int().min(0).max(1000),
    days: z
      .number()
      .positive()
      .max(36500)
      .describe('工期（故事日）：生成时只用 7、14、21、28、35（一至五周）'),
    durationReason: Text,
    prerequisites: z
      .array(z.array(Id).min(1))
      .max(100)
      .describe('AND of OR groups：[[a,b],[c]] 表示完成 a 或 b，且完成 c'),
    requirements: z
      .array(RequirementSchema)
      .describe('开始本国策前必须已成立的条件；不可引用本国策自己的 effects'),
    sustain: z.array(RequirementSchema).describe('推进期间必须持续成立的条件；不可引用本国策自己的 effects'),
    outcomes: z
      .array(RequirementSchema)
      .describe(
        '工期满后、正式完成前必须由剧情取得的外部成果（例如他国同意、勘查完成）。这是完成条件，不是本国策的产出；产出只写在 effects',
      ),
    investments: z.array(Text).describe('投入的人力、物资或机构，简短名词'),
    effects: z.array(EffectSchema).describe('本国策完成时产生的能力、承诺或数值变动'),
    mutex: z
      .object({ group: Id, route: Id, lock: z.enum(['complete', 'start']), reason: Text })
      .strict()
      .nullable(),
    impact: z
      .enum(['normal', 'pivotal'])
      .default('normal')
      .describe('pivotal＝重要国策：影响重大、值得公告的国策，完成时发布新闻事件'),
    /**
     * v0.13: `ongoing` means the decision is made on completion but the work goes on (a survey, a
     * long construction); completion opens one execution event that the update task carries on.
     * Optional so older trees stay valid; absent means `once`.
     */
    execution: z
      .enum(['once', 'ongoing'])
      .optional()
      .describe('ongoing＝完成后仍需持续执行（工程、长期改革），完成时自动建立执行事件；省略为 once'),
    news: z
      .object({
        headline: Text.describe('像报纸头条的一句话'),
        body: Text.describe('新闻内文，写出世界如何看待此事'),
        option: z
          .object({ label: Text.describe('唯一选项的按钮文字'), text: z.string().default('') })
          .strict(),
      })
      .strict()
      .nullable()
      .default(null)
      .describe('重要国策完成时的新闻；pivotal 必填，normal 为 null'),
  })
  .strict();
export const CapabilitySchema = z.object({ id: Id, name: Text, active: z.boolean(), reason: Text }).strict();
export const BranchSchema = z
  .object({
    id: Id,
    name: Text,
    purpose: Text,
    supporters: Text,
    opposition: Text,
    tradeoff: Text,
    destination: Text,
    /** Skeleton edition: the branch holding the country's main strategic problem (exactly one). */
    core: z.boolean().optional(),
    coreReason: z.string().optional(),
    /** Skeleton edition: why this branch can advance on its own in this tree's period and issues. */
    independent: z.string().optional(),
  })
  .strict();
export const relationKinds = [
  'exchange',
  'synergy',
  'opportunity',
  'context',
  'deferred',
  'replacement',
] as const;
export const relationKindNames: Record<(typeof relationKinds)[number], string> = {
  exchange: '利益交换',
  synergy: '政策配合',
  opportunity: '机会成本',
  context: '情境差异',
  deferred: '延后兑现',
  replacement: '制度替代',
};
/**
 * How one focus changes another branch's options, gains, costs or timing (skeleton edition).
 * `via` is filled by the script from the actual rules, so the player sees what implements it.
 */
export const RelationSchema = z
  .object({
    from: Id,
    to: Id,
    kind: z.enum(relationKinds),
    change: Text.describe('选了 from 之后，to 的哪些选项、收益、代价或时机会改变'),
    via: z.array(z.string()).default([]),
  })
  .strict();
export type Relation = z.infer<typeof RelationSchema>;
/**
 * Generated focuses last whole weeks, one to five (v0.14.16), so a period fits the days, weeks and
 * occasional months a role-play advances by. Imported trees keep their own durations.
 */
export const focusDays = [7, 14, 21, 28, 35] as const;
/** Target story days from a period's start to its end along the longest prerequisite chain. */
export const periodDays = {
  fast: [60, 90],
  standard: [90, 180],
  long: [180, 270],
} as const;
/**
 * Core-and-wings trees (v0.14.17): one core branch holds the period's main aim (a shared opening,
 * two or three exclusive routes, one end), short wings beside it hold side matters. Targets only.
 */
export const treeShape = {
  standard: { branches: [2, 3], core: [7, 10], routes: [2, 3], wings: [1, 2], wingNodes: [2, 3] },
  large: { branches: [3, 4], core: [10, 15], routes: [2, 3], wings: [2, 3], wingNodes: [2, 4] },
} as const;
/** Story days for the walked core path (opening, one route, end): about two thirds of the period. */
export const corePathDays = { fast: 60, standard: 120, long: 180 } as const;
/** Whole-tree focus counts, alternative routes included (v0.10.0: fewer, deeper branches). */
export const sizeLimits = {
  small: [10, 16],
  standard: [10, 16],
  large: [16, 24],
  epic: [16, 24],
} as const;
export const TreeSchema = z
  .object({
    id: CountryId,
    name: Text,
    description: Text,
    stability: z.number().min(0).max(100),
    warSupport: z.number().min(0).max(100),
    evidence: Text,
    /** Skeleton edition: words the story uses for this country; they trigger its chat worldbook entry. */
    keywords: z.array(z.string().min(1).max(24)).max(8).optional(),
    analysis: z.string().default(''),
    periodTitle: z.string().max(80).default('当前议程'),
    agenda: z.string().max(800).default(''),
    longTerm: z
      .array(z.object({ id: Id, text: z.string().min(1).max(200) }).strict())
      .max(4)
      .default([]),
    autoPeriod: z.boolean().optional(),
    branches: z.array(BranchSchema).default([]),
    /** Optional so trees without relations stay readable by v0.11.1. */
    relations: z.array(RelationSchema).optional(),
    capabilities: z.array(CapabilitySchema),
    historical: z.array(z.object({ node: Id, evidence: Text }).strict()),
    nodes: z.array(NodeSchema).min(1).max(300),
  })
  .strict();
const ProgressSchema = z.object({
  status: z.enum(['idle', 'active', 'paused', 'waiting', 'completed', 'terminated']),
  days: Day,
  started: Day.nullable(),
  completed: Day.nullable(),
  evidence: z.string(),
  investments: z.array(z.string()),
  applied: z.array(z.string()),
  public: z.boolean(),
});
const LotSchema = z.object({ category: z.string(), key: z.string(), name: z.string(), text: z.string() });
/** Structure lots of the current period (v0.14.21): a tree type, a naming style and detail lots. */
export const StructureSchema = z.object({ type: LotSchema, naming: LotSchema, lots: z.array(LotSchema) });
export const CountrySchema = TreeSchema.omit({ nodes: true, historical: true, capabilities: true }).extend({
  enabled: z.boolean(),
  control: z.enum(['player', 'ai']),
  skipDelegate: z.boolean(),
  calibration: z.boolean(),
  treeRevision: z.number().int().nonnegative(),
  cursor: Day,
  current: z.string(),
  autoPeriod: z.boolean().default(true),
  period: z
    .object({
      number: z.number().int().positive().default(1),
      started: Day.nullable().default(null),
      anchor: z.string().default(''),
      history: z
        .array(z.object({ start: Day, end: Day, summary: z.string().min(1).max(1200) }).strict())
        .default([]),
    })
    .default({ number: 1, started: null, anchor: '', history: [] }),
  nodes: z.record(Id, NodeSchema),
  progress: z.record(Id, ProgressSchema),
  locks: z.record(Id, z.object({ route: Id, reason: Text })),
  capabilities: z.record(Id, CapabilitySchema),
  commitments: z.record(Id, z.string()),
  facts: z.record(Id, z.object({ value: z.boolean(), evidence: Text })),
  shape: StructureSchema.optional(),
});
export const EventOptionSchema = z
  .object({
    label: Text.describe('唯一选项的按钮文字，例如「这下有得忙了」'),
    text: z.string().default('').describe('选项说明；效果写在 changes，可以没有效果'),
  })
  .strict();
/** One planned or finished step of an event, fully replaced on each update (v0.13). */
export const EventStepSchema = z
  .object({
    text: Text,
    state: z
      .enum(['done', 'active', 'pending', 'planned'])
      .describe('done 已完成、active 进行中、pending 待办、planned 预定'),
    when: z.string().max(40).optional().describe('故事时间，例如「6 月初」；可省略'),
  })
  .strict();
export const EventResultSchema = z
  .enum(['achieved', 'abandoned', 'failed'])
  .describe('结束方式：achieved 达成、abandoned 终止、failed 失败');
const EventChangesSchema = z.array(z.object({ country: CountryId, effects: z.array(EffectSchema) }).strict());
export const EventSchema = z
  .object({
    id: EventId,
    at: Day,
    countries: z.array(CountryId).min(1),
    title: Text,
    description: Text,
    evidence: Text,
    origin: z.enum(['story', 'background']),
    public: z.boolean(),
    changes: EventChangesSchema,
    scope: z
      .enum(['front', 'back'])
      .default('back')
      .describe('front＝与目前正文或玩家国直接相关；back＝镜头外的世界动态'),
    importance: z.enum(['minor', 'major', 'world']).default('minor'),
    headline: z.string().default('').describe('新闻头条；空白时使用 title'),
    status: z
      .enum(['ongoing', 'resolved'])
      .default('resolved')
      .describe('ongoing＝之后还会推进；resolved＝已结束'),
    settle: z.string().default('').describe('ongoing 事件的结算条件'),
    option: EventOptionSchema.default({ label: '知道了', text: '' }),
    timeline: z.array(z.object({ at: Day, text: Text }).strict()).default([]),
    /** v0.13: one sentence on where things stand now (results, what is left, what blocks it). */
    current: z.string().max(400).optional(),
    /** v0.13: the plan and its progress; the progress ring counts done steps. */
    steps: z.array(EventStepSchema).max(12).optional(),
    /** v0.13: how a finished event ended. */
    result: EventResultSchema.optional(),
    /**
     * `focus` news and execution events are made by the script; an update event may name the focus
     * it carries out (`country` and `node`).
     */
    source: z
      .object({
        kind: z.enum(['update', 'focus']),
        country: CountryId.optional(),
        node: Id.optional(),
        name: z.string().optional(),
      })
      .strict()
      .default({ kind: 'update' }),
    /** AI floor where this news was (last) published; set by the platform, never by the model. */
    shownAt: z.number().int().nullable().default(null),
    /** v0.13: AI floor where its latest progress was published; set by the platform. */
    touchedAt: z.number().int().nullable().optional(),
  })
  .strict();
export const EventUpdateSchema = z
  .object({
    id: EventId.describe('要推进的既有 ongoing 事件 id'),
    text: Text.describe('本期进展'),
    status: z.enum(['ongoing', 'resolved']).optional(),
    headline: z.string().optional().describe('本期进展的新闻头条'),
    public: z.boolean().optional(),
    current: z.string().max(400).optional().describe('整句取代现况：已确认成果、尚待达成、目前阻力'),
    steps: z.array(EventStepSchema).max(12).optional().describe('整份取代步骤清单'),
    changes: EventChangesSchema.optional().describe('这次进展产生的能力、承诺或数值变化；只套用一次'),
    result: EventResultSchema.optional().describe('填写即表示事件结束'),
    report: z.boolean().optional().describe('true＝这次进展值得当作新闻报导；一般进展省略'),
  })
  .strict();
export const SettingsSchema = z.object({
  /** Unused since v0.12.7 (the fog was removed); kept so v0.11.1 can still read these saves. */
  fog: z.boolean(),
  observing: z.array(CountryId),
  size: z
    .enum(['small', 'standard', 'large', 'epic'])
    .transform((size) => (size === 'small' ? 'standard' : size === 'epic' ? 'large' : size)),
  pace: z.enum(['fast', 'standard', 'long']),
});
export const StateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  day: Day,
  settings: SettingsSchema,
  countries: z.record(CountryId, CountrySchema),
  events: z.record(EventId, EventSchema),
  receipts: z.array(z.string()),
  schedules: z.record(z.string(), z.object({ turn: z.number(), day: Day })),
});
export const ProposalSchema = z
  .object({
    id: Id,
    until: Day,
    reason: Text,
    steps: z
      .array(
        z
          .object({
            at: Day,
            facts: z.array(
              z
                .object({
                  country: CountryId,
                  id: Id,
                  value: z.boolean(),
                  evidence: Text,
                  origin: z.enum(['story', 'background']),
                })
                .strict(),
            ),
            events: z.array(
              EventSchema.omit({ shownAt: true, touchedAt: true, source: true, result: true }).extend({
                focus: z
                  .object({ country: CountryId, node: Id })
                  .strict()
                  .optional()
                  .describe('这个事件承接执行的国策；一项国策最多一个事件'),
              }),
            ),
            selections: z.array(z.object({ country: CountryId, node: Id, reason: Text }).strict()),
            publications: z
              .array(z.object({ country: CountryId, node: Id, evidence: Text }).strict())
              .default([]),
            eventUpdates: z.array(EventUpdateSchema).default([]),
          })
          .strict(),
      )
      .max(500),
    edits: z
      .array(
        z
          .object({ country: CountryId, remove: z.array(Id), nodes: z.array(NodeSchema), reason: Text })
          .strict(),
      )
      .default([]),
    calibrations: z.array(CountryId).default([]),
    transitions: z
      .array(
        z
          .object({
            country: CountryId,
            cause: z.enum(['completed', 'incompatible']),
            reason: z.string().min(1).max(800),
            invalidateActive: z.boolean().default(false),
          })
          .strict(),
      )
      .default([])
      .describe('本期主要目的已完成或已不适配时直接换期；无需换期填空，禁止为关闭 autoPeriod 的国家换期'),
  })
  .strict();
export const CandidatesSchema = z
  .object({
    countries: z
      .array(z.object({ id: CountryId, name: Text, description: Text, evidence: Text }).strict())
      .max(100),
  })
  .strict();
export type State = z.infer<typeof StateSchema>;
export type Country = z.infer<typeof CountrySchema>;
export type FocusNode = z.infer<typeof NodeSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type Proposal = z.infer<typeof ProposalSchema>;
export type Candidate = z.infer<typeof CandidatesSchema>['countries'][number];

export const jobKinds = ['identify', 'generate', 'update', 'reshape'] as const;
export type JobKind = (typeof jobKinds)[number];
export const defaultMaxTokens = 60000;
export const defaultTemperature = 0.85;
export const ApiSchema = z.object({
  name: Text,
  url: z.string(),
  model: z.string(),
  proxy: z.string(),
  apiKey: z.string().default(''),
  maxTokens: z.number().int().min(1).default(defaultMaxTokens),
  temperature: z.number().min(0).max(2).default(defaultTemperature),
  /** Before v0.13.3: focuses per segmented request (now on the generate task; kept as its fallback). */
  segmentMax: z.number().int().min(0).max(300).default(25),
  bodyParams: z.string().default(''),
  excludeBodyParams: z.string().default(''),
  requestHeaders: z.string().default(''),
  customPromptPostProcessing: z.enum(['none', 'strict']).default('none'),
  includeReasoning: z.boolean().default(false),
  reasoningEffort: z.enum(['auto', 'min', 'low', 'medium', 'high', 'max']).default('medium'),
  /**
   * Stream the reply. The result is still validated as one whole reply; streaming only keeps the
   * connection busy, so proxies with a short idle limit (Cloudflare 524 after ~100 s) or a
   * "fake streaming" mode do not cut long requests.
   */
  stream: z.boolean().default(false),
});
export const promptRoles = ['system', 'user', 'assistant'] as const;
export type PromptRole = (typeof promptRoles)[number];
/** One message in a task's prompt chain (Workflow Assistant prompt group). */
export const PromptItemSchema = z.object({
  id: z.string().default(''),
  /** guide/task/data are built in; custom items are player-written. */
  kind: z.enum(['guide', 'task', 'data', 'custom']).default('custom'),
  name: z.string().default(''),
  role: z.enum(promptRoles).default('system'),
  /** Built-in items: empty means "use the current default text". */
  content: z.string().default(''),
  enabled: z.boolean().default(true),
});
export type PromptItem = z.infer<typeof PromptItemSchema>;
export const JobConfigSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== 'object' || Array.isArray((input as { prompts?: unknown }).prompts)) {
      return input;
    }
    const { prompt: _prompt, segments: _segments, ...rest } = input as Record<string, unknown>;
    return { ...rest, prompts: migratePrompts(input as { prompt?: unknown; segments?: unknown }) };
  },
  z.object({
    api: z.string(),
    fallback: z.array(z.string()),
    retries: z.number().int().min(0).max(10),
    timeout: z.number().min(10).max(600),
    schedule: z.enum(['reply', 'rounds', 'days', 'manual']),
    interval: z.number().int().min(1).max(1000),
    /**
     * Retired in v0.13.3: strict JSON is set once, on the API preset. Kept only so the settings
     * window can tell users who had it on; the request path ignores it.
     */
    strictJson: z.boolean().default(false),
    /** Generate only: focuses per fill request. Unset = the older API preset value. */
    segmentMax: z.number().int().min(0).max(300).optional(),
    /** A note shown in the task editor and kept in task presets, e.g. which model suits the prompts. */
    recommendedModel: z.string().max(200).default(''),
    /** 0 means no limit, matching Workflow Assistant route caps. */
    primaryMaxConcurrency: z.number().int().min(0).max(16).default(0),
    fallbackMaxConcurrencies: z.array(z.number().int().min(0).max(16)).default([]),
    prompts: z
      .array(PromptItemSchema)
      .max(60)
      .transform((items) => normalizePrompts(items)),
  }),
);
export type JobConfig = z.infer<typeof JobConfigSchema>;
export const ContextRulesSchema = z.object({
  contextTurnCount: z.number().int().min(0).max(100).default(3),
  contextExtractRules: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
  contextExcludeRules: z.array(z.object({ start: z.string(), end: z.string() })).default([]),
});
export const WorldbookSourceSchema = z.object({
  source: z.enum(['character', 'manual']).default('character'),
  manualSelection: z.array(z.string()).default([]),
  enabledEntries: z.record(z.string(), z.array(z.number().int())).default({}),
});
export const SourcesSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== 'object' || 'version' in input) {
      return input;
    }
    const old = input as Record<string, unknown>;
    const books = Array.isArray(old.worldbooks)
      ? old.worldbooks.filter((v): v is string => typeof v === 'string')
      : [];
    const enabledEntries: Record<string, number[]> = {};
    for (const value of Array.isArray(old.entries) ? old.entries : []) {
      if (typeof value !== 'string') {
        continue;
      }
      const index = value.lastIndexOf(':');
      const book = value.slice(0, index);
      const uid = Number(value.slice(index + 1));
      if (index > 0 && Number.isInteger(uid)) {
        (enabledEntries[book] ??= []).push(uid);
      }
    }
    const selectedBooks = [...new Set([...books, ...Object.keys(enabledEntries)])];
    if (Object.keys(enabledEntries).length) {
      for (const book of selectedBooks) {
        enabledEntries[book] ??= [];
      }
    }
    return {
      ...old,
      version: 2,
      context: { contextTurnCount: Math.min(Number(old.history ?? 3), 3) },
      worldbook: {
        source: selectedBooks.length ? 'manual' : 'character',
        manualSelection: selectedBooks,
        enabledEntries,
      },
      variables:
        Array.isArray(old.variables) && JSON.stringify(old.variables) !== '["世界"]' ? old.variables : [],
    };
  },
  z
    .object({
      version: z.literal(2).default(2),
      context: ContextRulesSchema.default(() => ContextRulesSchema.parse({})),
      worldbook: WorldbookSourceSchema.default(() => WorldbookSourceSchema.parse({})),
      /**
       * Before v0.13.3 two switches turned task overrides on. Now an override applies whenever it
       * exists; an override saved while its switch was off is dropped on load (see the transform).
       */
      taskContextOverridesEnabled: z.boolean().default(true),
      taskWorldbookOverridesEnabled: z.boolean().default(true),
      overrides: z
        .partialRecord(
          z.enum(jobKinds),
          z.object({
            context: ContextRulesSchema.optional(),
            worldbook: WorldbookSourceSchema.optional(),
          }),
        )
        .default({}),
      memoryRecallRecentCount: z.number().int().min(0).max(1000).default(10),
      includeLatestUser: z.boolean().default(false),
      /** Workflow Assistant always includes database table exports in $1; opt in here. */
      autoIncludeTables: z.boolean().default(false),
      /** $2 WorkflowHelper-* managed entries. */
      managedEntries: z.boolean().default(false),
      /** $5 chronicle index or outline table. */
      summaryIndex: z.boolean().default(false),
      /** $U persona description and protagonist data. */
      persona: z.boolean().default(false),
      /** $C current character description. */
      characterDescription: z.boolean().default(false),
      maxInputCharacters: z.number().int().min(1000).max(2000000).default(120000),
      variables: z.array(z.string()).default([]),
      extra: z.string().default(''),
      timePath: z.string().min(1).default('世界.时间'),
      /** v0.13: the player's location (大陆方位-区域-势力-…), for the countries the player is inside. */
      locationPath: z.string().min(1).default('世界.地点'),
      /** v0.13: the card's own news (MVU), shown in the newspaper's 本报各版. */
      newsPath: z.string().min(1).default('新闻'),
    })
    .transform((settings) => {
      for (const kind of jobKinds) {
        const override = settings.overrides[kind];
        if (!override) {
          continue;
        }
        if (!settings.taskContextOverridesEnabled) {
          delete override.context;
        }
        if (!settings.taskWorldbookOverridesEnabled) {
          delete override.worldbook;
        }
        if (!override.context && !override.worldbook) {
          delete settings.overrides[kind];
        }
      }
      settings.taskContextOverridesEnabled = true;
      settings.taskWorldbookOverridesEnabled = true;
      return settings;
    }),
);
export type SourceSettings = z.infer<typeof SourcesSchema>;
export type ContextRules = z.infer<typeof ContextRulesSchema>;
export type WorldbookSource = z.infer<typeof WorldbookSourceSchema>;
export const TaskSnapshotSchema = z.object({
  retries: z.number().int().min(0).max(10),
  timeout: z.number().min(10).max(600),
  schedule: z.enum(['reply', 'rounds', 'days', 'manual']),
  interval: z.number().int().min(1).max(1000),
  segmentMax: z.number().int().min(0).max(300).optional(),
  recommendedModel: z.string().max(200).default(''),
  prompts: z.array(PromptItemSchema).max(60),
});
export const TaskPresetSchema = z.object({
  name: z.string().min(1),
  savedAt: z.number().default(() => Date.now()),
  jobs: z.partialRecord(z.enum(jobKinds), TaskSnapshotSchema),
  sources: z.unknown().optional(),
});
export type TaskPreset = z.infer<typeof TaskPresetSchema>;
export const ConfigSchema = z.object({
  apis: z.array(ApiSchema).min(1),
  defaultApi: z.string().default(''),
  apiBindings: z.record(z.string(), z.string()).default({}),
  /** Keep recent request messages and model output in memory for debugging. */
  runLog: z.boolean().default(false),
  /** Add the recent-news digest to the story prompt. */
  newsPrompt: z.boolean().default(true),
  /**
   * How the story model receives the country data: character primary worldbook entries that read the floor's
   * `国策.prompt` through ST-Prompt-Template (Workflow Assistant / addon-mvu style), or one injected
   * message. Without ST-Prompt-Template the worldbook mode falls back to injection.
   */
  promptMode: z.enum(['worldbook', 'inject']).default('worldbook'),
  /** Country detail entries: always sent (blue, like the Workflow Assistant world state) or on keywords (green). */
  countryEntries: z.enum(['constant', 'keyword']).default('constant'),
  /** Workflow Assistant task presets: task settings and sources, without API routes. */
  taskPresets: z.array(z.lazy(() => TaskPresetSchema)).default([]),
  activeTaskPreset: z.string().default(''),
  jobs: z.object({
    identify: JobConfigSchema,
    generate: JobConfigSchema,
    update: JobConfigSchema,
    reshape: JobConfigSchema,
  }),
  sources: SourcesSchema,
});
export type Config = z.infer<typeof ConfigSchema>;
export function defaultConfig(): Config {
  const job = {
    api: '',
    fallback: [],
    retries: 1,
    timeout: 180,
    schedule: 'manual' as const,
    interval: 1,
  };
  return ConfigSchema.parse({
    apis: [{ name: '目前连线', url: '', model: '', proxy: '' }],
    defaultApi: '目前连线',
    jobs: {
      identify: { ...job },
      generate: { ...job, timeout: 600 },
      update: { ...job, schedule: 'reply' },
      reshape: { ...job },
    },
    sources: { version: 2 },
  });
}
