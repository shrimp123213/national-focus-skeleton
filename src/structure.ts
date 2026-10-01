/**
 * Structure lots (v0.14.21): the script draws a tree type, a naming style and detail lots for each
 * generated tree or period, so countries do not all grow the same shape. Lots are leanings the model
 * interprets for the country, never checked; a tree is not rejected for leaving a lot.
 */
export type TreeType = 'build' | 'choice' | 'crisis' | 'reform' | 'chess' | 'dual';
export type Lot = { category: string; key: string; name: string; text: string };
export type Structure = { type: Lot; naming: Lot; lots: Lot[] };

type Option = { key: string; name: string; text: string; types?: TreeType[] };

export const treeTypes: Record<TreeType, { name: string; text: string; naming: string[] }> = {
  build: {
    name: '发展型',
    text: '建设与制度逐步累积：核心分支承载本期主要目的，共同开局后分岔成互斥路线，汇流到本期终点；侧翼处理并行事务；多数国策产出能力或承诺，后项以前项成果为条件。',
    naming: ['official', 'official', 'mixed'],
  },
  choice: {
    name: '抉择型',
    text: '叙事决策树：每个国策都是一次政治转折（立场、对象或手段的取舍），层层二选一，各大路线走向不同的结局；通常没有侧翼；走到任一结局即完成本期主要目的。',
    naming: ['idiom', 'idiom', 'quote', 'mixed'],
  },
  crisis: {
    name: '危机型',
    text: '开局即危机：首项是迫在眉睫的灾变或威胁（常需剧情取得的外部成果），前段是止血与求生的急务，撑过去后才分岔成不同的应对方式，结局可能是妥协、铁腕或勉强维持；可有一条处理次生灾害的短侧翼。',
    naming: ['slogan', 'slogan', 'mixed'],
  },
  reform: {
    name: '改革型',
    text: '长主干分阶段推进（试行、推广、定制），推广阶段因反对派出现分岔（强推、妥协或变形），汇流后再落实；侧翼处理舆论与反对派，其成果可作为某条路线的条件。',
    naming: ['official', 'official', 'mixed'],
  },
  chess: {
    name: '棋局型',
    text: '对外选边：开局后很快分成三条路线，各对应一个外部势力或外交立场，各自走到自己的结局；路线之间互相牵制（某条路线需要侧翼或其他路线的早期成果）。',
    naming: ['mixed', 'idiom', 'official'],
  },
  dual: {
    name: '双轨型',
    text: '核心与一条同等分量的强侧翼并行，两边交替提供条件（跨分支前置），本期终点同时需要两条轨道的成果；核心内只有一组小互斥。',
    naming: ['official', 'mixed'],
  },
};

export const namings: Record<string, { name: string; text: string }> = {
  official: { name: '公文式', text: '国策名称用公文式短语，例如「设立内阁」「修筑边境堡垒」。' },
  idiom: {
    name: '四字意象式',
    text: '国策名称以四字意象为主（可有少量三或五字），例如「刚柔并济」「破冰而行」「后会无期」。',
  },
  slogan: {
    name: '口号式',
    text: '国策名称用短促的口号或宣告，例如「寸土不让」「按下按钮」「大坝溃堤！」。',
  },
  quote: { name: '引语式', text: '关键国策取自人物、典籍或民谣的一句短语，其余用简短意象；仍守 4–12 字。' },
  mixed: { name: '混合式', text: '关键抉择与结局用四字意象或口号，其余国策用公文式短语。' },
};

const all: TreeType[] = ['build', 'choice', 'crisis', 'reform', 'chess', 'dual'];
/** Detail lot categories; the skeleton ones are always drawn, three of the others per tree. */
export const categories: { key: string; name: string; skeleton: boolean; options: Option[] }[] = [
  {
    key: 'opening',
    name: '开局',
    skeleton: true,
    options: [
      { key: 'single', name: '单项开局', text: '由一项国策开局。' },
      { key: 'double', name: '两项连续开局', text: '开局是两项连续的国策，再进入分岔。' },
      {
        key: 'parallel_and',
        name: '双起点并行后汇合',
        text: '两个起点并行，都完成（「且」前置）后汇合。',
        types: ['build', 'crisis', 'reform', 'dual'],
      },
      {
        key: 'parallel_or',
        name: '双起点择一',
        text: '两个起点择一完成（「或」前置）即可往下。',
        types: ['build', 'choice', 'chess'],
      },
      {
        key: 'crisis_open',
        name: '危机开局',
        text: '首项是危机应对，需要剧情取得的外部成果（outcomes）。',
        types: ['crisis', 'reform'],
      },
      {
        key: 'choice_open',
        name: '抉择开局',
        text: '首项之后立刻是一组互斥二选一。',
        types: ['choice', 'chess'],
      },
      {
        key: 'inherit',
        name: '承接开局',
        text: '开局以现行制度、既有能力或前期成果为条件。',
        types: ['build', 'reform', 'dual'],
      },
      { key: 'probe', name: '试探开局', text: '先一项 7 天的短国策试探局势，再进入主题。' },
    ],
  },
  {
    key: 'fork',
    name: '分岔位置',
    skeleton: true,
    options: [
      { key: 'immediate', name: '开局后立刻分岔', text: '开局国策之后立刻分岔。' },
      { key: 'second', name: '第 2 层分岔', text: '主干两项后分岔。' },
      {
        key: 'third',
        name: '第 3 层分岔',
        text: '主干较长，三项之后才分岔。',
        types: ['build', 'reform', 'crisis', 'dual'],
      },
      {
        key: 'merge_then_fork',
        name: '先汇合再分岔',
        text: '两条前段先汇合于一项，之后才分岔。',
        types: ['build', 'crisis', 'reform'],
      },
      {
        key: 'twice',
        name: '分岔两次',
        text: '分岔后，路线中途再各自分岔一次。',
        types: ['build', 'choice', 'chess'],
      },
    ],
  },
  {
    key: 'routes',
    name: '路线数',
    skeleton: true,
    options: [
      { key: 'two', name: '2 条路线', text: '核心分岔成 2 条互斥路线。' },
      {
        key: 'three',
        name: '3 条路线',
        text: '核心分岔成 3 条互斥路线。',
        types: ['build', 'crisis', 'reform', 'chess'],
      },
      {
        key: 'two_plus',
        name: '2 条＋1 条高门槛路线',
        text: '2 条一般路线，另有 1 条需要稳定度或战争支持度门槛的第三路线。',
        types: ['build', 'reform', 'crisis'],
      },
    ],
  },
  {
    key: 'ending',
    name: '终局',
    skeleton: true,
    options: [
      {
        key: 'converge',
        name: '汇流单一终点',
        text: '各路线以「或」前置汇流到同一个本期终点。',
        types: ['build', 'reform', 'dual'],
      },
      {
        key: 'separate',
        name: '各自终点',
        text: '各路线不汇流，各自走到自己的结局。',
        types: ['choice', 'crisis', 'chess'],
      },
      {
        key: 'converge_extend',
        name: '汇流后延伸',
        text: '汇流后再延伸 1–2 项落实，才是本期终点。',
        types: ['build', 'reform', 'dual'],
      },
      {
        key: 'gated',
        name: '终点需门槛',
        text: '本期终点需要稳定度或战争支持度门槛。',
        types: ['build', 'crisis', 'reform', 'dual'],
      },
      {
        key: 'twin',
        name: '双终点',
        text: '两个互斥的终点：一个是达成，一个是妥协。',
        types: ['choice', 'crisis'],
      },
      {
        key: 'ongoing',
        name: '终点持续执行',
        text: '本期终点完成后仍须持续执行（execution=ongoing）。',
        types: ['build', 'reform'],
      },
      {
        key: 'many',
        name: '多个阶段成果收尾',
        text: '以多个并列的阶段成果收尾，没有单一终点。',
        types: ['choice', 'chess'],
      },
    ],
  },
  {
    key: 'wings',
    name: '侧翼',
    skeleton: true,
    options: [
      { key: 'none', name: '无侧翼', text: '没有侧翼，只有核心分支。', types: ['choice', 'chess', 'crisis'] },
      {
        key: 'chain',
        name: '短直链',
        text: '侧翼是一条 2–3 项的短直链。',
        types: ['build', 'crisis', 'reform', 'chess'],
      },
      { key: 'split', name: '侧翼一分二', text: '侧翼在第二项分成两个可选项。', types: ['build', 'reform'] },
      { key: 'twin_root', name: '侧翼两起点汇合', text: '侧翼有两个起点，汇合于一项。', types: ['build'] },
      {
        key: 'unlocked',
        name: '由核心路线解锁',
        text: '侧翼的起点需要核心某条路线的国策。',
        types: ['build', 'reform'],
      },
      {
        key: 'feeds',
        name: '侧翼成果供核心',
        text: '侧翼的成果是核心某项国策的条件（跨分支前置）。',
        types: ['build', 'crisis', 'reform', 'chess', 'dual'],
      },
      {
        key: 'exclusive',
        name: '侧翼与路线互斥',
        text: '侧翼某项与核心某条路线互斥（同一互斥组）。',
        types: ['build'],
      },
      {
        key: 'early',
        name: '侧翼集中在前期',
        text: '侧翼全部是开局阶段就能做的短国策。',
        types: ['build', 'crisis'],
      },
    ],
  },
  {
    key: 'length',
    name: '路线长度',
    skeleton: false,
    options: [
      { key: 'equal', name: '等长', text: '各路线长度相同。' },
      { key: 'long_short', name: '一长一短', text: '一条路线明显较短、一条较长。' },
      { key: 'stairs', name: '阶梯', text: '三条路线分别是 2、3、4 项。' },
      { key: 'risky_short', name: '短路线高风险', text: '较短的路线带维持条件（sustain）或外部成果，较险。' },
      { key: 'wait_mid', name: '路线中途等成果', text: '一条路线中途有一项需要剧情取得的外部成果。' },
    ],
  },
  {
    key: 'inner',
    name: '路线内部',
    skeleton: false,
    options: [
      { key: 'straight', name: '直线', text: '各路线是直线推进。' },
      {
        key: 'mini_fork_merge',
        name: '中段小分岔再汇合',
        text: '某条路线中段分成两项都要完成（「且」）后再汇合。',
      },
      { key: 'mid_choice', name: '中段择一', text: '某条路线中段有两个可选项，择一完成（「或」，非互斥）。' },
      { key: 'twin_ending', name: '末端两个收尾', text: '某条路线末端有两个可选的收尾国策。' },
      { key: 'skip', name: '可跳过一项', text: '某项可由「或」前置跳过前一项。' },
      { key: 'needs_wing', name: '需要侧翼成果', text: '某条路线有一项需要侧翼的成果。' },
    ],
  },
  {
    key: 'interact',
    name: '路线交互',
    skeleton: false,
    options: [
      { key: 'none', name: '互不相干', text: '各路线互不相干。' },
      {
        key: 'late_lock',
        name: '完成才锁定',
        text: '路线互斥在完成时才锁（lock=complete），允许先试探另一条路线的开头。',
      },
      { key: 'shared_relay', name: '共享中继点', text: '两条路线中段共同依赖一项不属于互斥组的国策。' },
      { key: 'switch', name: '中途转向', text: '某项以另一条路线的早期国策为「或」前置，可中途转向。' },
      {
        key: 'affect_wing',
        name: '路线影响侧翼',
        text: '选定的路线会改变侧翼某项的条件或收益（relations 或条件）。',
      },
    ],
  },
  {
    key: 'mutex',
    name: '互斥规则',
    skeleton: false,
    options: [
      { key: 'lock_start', name: '开始即锁', text: '互斥在开始时就锁定其他路线（lock=start）。' },
      { key: 'lock_complete', name: '完成才锁', text: '互斥在完成时才锁定（lock=complete）。' },
      { key: 'nested', name: '路线内再一组小互斥', text: '某条路线内部再有一组二选一的小互斥。' },
    ],
  },
  {
    key: 'tempo',
    name: '节奏',
    skeleton: false,
    options: [
      { key: 'front_fast', name: '前快后慢', text: '前段多为 7–14 天，后段 28–35 天。' },
      { key: 'front_slow', name: '前慢后快', text: '前段工期长，后段 7–14 天收束。' },
      { key: 'even', name: '均匀', text: '工期大致均匀。' },
      { key: 'asymmetric', name: '路线一快一慢', text: '一条路线工期短，一条长。' },
      { key: 'bottleneck', name: '中段瓶颈', text: '中段有一项 35 天的瓶颈国策。' },
    ],
  },
  {
    key: 'pivotal',
    name: '重要国策位置',
    skeleton: false,
    options: [
      { key: 'end', name: '终点', text: '重要国策（pivotal）放在终点。' },
      { key: 'fork', name: '分岔点', text: '重要国策放在分岔点。' },
      { key: 'mid', name: '路线中段', text: '重要国策放在路线中段。' },
      { key: 'opening', name: '开局', text: '开局国策就是重要国策。' },
      { key: 'wing_end', name: '侧翼终点', text: '侧翼的最后一项是重要国策。' },
    ],
  },
  {
    key: 'gates',
    name: '条件门槛',
    skeleton: false,
    options: [
      { key: 'few', name: '少门槛', text: '少用 requirements 与 sustain。' },
      { key: 'stability_route', name: '稳定度门槛', text: '稳定度门槛集中在一条路线。' },
      { key: 'war_route', name: '战争支持度门槛', text: '战争支持度门槛放在军事取向的路线。' },
      { key: 'outcomes_end', name: '终点前等成果', text: '外部成果集中在终点前一项。' },
      { key: 'capability_chain', name: '能力链', text: '前一项产出的能力是后一项的条件，环环相扣。' },
    ],
  },
];

/** Options that fit the tree type, the size and the lots drawn so far. */
function fits(
  category: string,
  option: Option,
  type: TreeType,
  large: boolean,
  drawn: Map<string, string>,
): boolean {
  if (option.types && !option.types.includes(type)) {
    return false;
  }
  const routes = drawn.get('routes');
  const noWings = drawn.get('wings') === 'none';
  if (category === 'length' && option.key === 'stairs' && routes !== 'three') return false;
  if (category === 'length' && option.key === 'long_short' && routes === 'three') return false;
  if (noWings && ['needs_wing', 'affect_wing', 'wing_end'].includes(option.key)) return false;
  // A standard tree cannot hold three routes that also split again.
  if (!large && routes === 'three' && ['twice', 'nested', 'mini_fork_merge'].includes(option.key))
    return false;
  if (category === 'routes' && type === 'chess' && option.key !== 'three') return false;
  if (category === 'routes' && type === 'choice' && option.key !== 'two') return false;
  if (category === 'opening' && type === 'crisis' && option.key !== 'crisis_open') return false;
  if (category === 'wings' && type === 'dual' && option.key !== 'feeds') return false;
  if (category === 'mutex' && type === 'choice' && option.key !== 'nested') return false;
  return true;
}

/** Lots store the category name; these categories make a tree's skeleton. */
const skeletonNames = ['opening', 'fork', 'routes', 'ending'].map(
  (key) => categories.find((category) => category.key === key)!.name,
);
/** Type and skeleton lots: two trees with the same signature look alike. */
export function signature(structure: Structure): string {
  return [
    structure.type.key,
    ...skeletonNames.map((name) => structure.lots.find((lot) => lot.category === name)?.key ?? '-'),
  ].join('|');
}

/**
 * Draw a structure: a tree type, a naming style, the skeleton lots and three detail lots, avoiding
 * the signatures of other countries. `random` returns [0, 1) (Math.random by default).
 */
export function drawStructure(options: {
  large: boolean;
  taken?: Iterable<string>;
  random?: () => number;
}): Structure {
  const random = options.random ?? Math.random;
  const taken = new Set(options.taken ?? []);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  let best: Structure | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    const type = pick(all);
    const drawn = new Map<string, string>();
    const lots: Lot[] = [];
    const take = (category: (typeof categories)[number]) => {
      const choices = category.options.filter((option) =>
        fits(category.key, option, type, options.large, drawn),
      );
      if (!choices.length) return;
      const option = pick(choices);
      drawn.set(category.key, option.key);
      lots.push({ category: category.name, key: option.key, name: option.name, text: option.text });
    };
    // Routes and wings first, so the lots that depend on them see them.
    for (const key of ['routes', 'wings', 'opening', 'fork', 'ending']) {
      take(categories.find((category) => category.key === key)!);
    }
    const details = categories.filter((category) => !category.skeleton);
    for (let i = 0; i < 3 && details.length; i++) {
      take(details.splice(Math.floor(random() * details.length), 1)[0]);
    }
    const namingKey = pick(treeTypes[type].naming);
    const structure: Structure = {
      type: { category: '树型', key: type, name: treeTypes[type].name, text: treeTypes[type].text },
      naming: {
        category: '命名',
        key: namingKey,
        name: namings[namingKey].name,
        text: namings[namingKey].text,
      },
      lots: lots.sort(
        (a, b) =>
          categories.findIndex((category) => category.name === a.category) -
          categories.findIndex((category) => category.name === b.category),
      ),
    };
    best ??= structure;
    if (!taken.has(signature(structure))) {
      return structure;
    }
  }
  return best!;
}

/** Branch and wing targets per tree type (targets only, like the core-and-wings shape). */
export function typeShape(type: TreeType | undefined, large: boolean) {
  switch (type) {
    case 'choice':
      return { branches: '1', wings: { count: '0', nodes: '0' }, routes: '2（每条路线内再二选一）' };
    case 'crisis':
      return {
        branches: '1–2',
        wings: { count: '0–1', nodes: large ? '2–4' : '2–3' },
        routes: large ? '2–3' : '2',
      };
    case 'reform':
      return { branches: '2', wings: { count: '1', nodes: large ? '2–4' : '2–3' }, routes: '2' };
    case 'chess':
      return { branches: '1–2', wings: { count: '0–1', nodes: '2–3' }, routes: '3' };
    case 'dual':
      return {
        branches: '2',
        wings: { count: '1（强侧翼，与核心同等分量）', nodes: large ? '5–8' : '4–6' },
        routes: '2',
      };
    default:
      return undefined;
  }
}

/** The structure as sent to the model. */
export function structureData(structure: Structure) {
  return {
    note: '结构签是倾向，不是硬性规则：依国情诠释，并在 analysis 逐支写出如何落实；确实不合国情时说明理由并调整。',
    type: { name: structure.type.name, text: structure.type.text },
    naming: { name: structure.naming.name, text: structure.naming.text },
    lots: structure.lots.map((lot) => ({ category: lot.category, name: lot.name, text: lot.text })),
  };
}
