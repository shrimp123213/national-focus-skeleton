import { eventText, eventUpdatedAt, newsDigest } from './engine';
import type { Country, State } from './model';

/**
 * The country data for the story model, saved with every floor at `国策.prompt`. It is the true
 * state (v0.12.7 removed the fog, which let the story foreshadow what had already happened);
 * unpublished focuses and events are marked, and the story decides who knows them. Chat worldbook
 * entries only read it with ST-Prompt-Template (`getvar('国策.prompt…')`), so a swipe or an older
 * floor always shows its own state, like the addon-mvu world state.
 */
export type PromptView = {
  overview: string;
  countries: Record<string, { name: string; keys: string[]; text: string }>;
};

export const promptHeader =
  '以下是已确认的各国实际状态，供后续正文承接。国家在背景推进自己的议程，影响只需依角色的处境与可知范围自然呈现；远方的政策可以暂时不进入正文。标示「未公开」的国策与事件只有该国高层、当事方与知情者知道，角色是否知情依其身分与处境判断。已完成的国策与已发生的事件不可写成尚在酝酿。国策描述是推动时的计划与预期，实际结果以完成状态、现行制度、承诺与消息的最新进展为准。稳定度与战争支持度只是辅助指标，局势应依具体制度、事件与矛盾理解：稳定度高不代表没有地方冲突，战争支持度高也不代表全民好战。不要改写已显示正文，不要替玩家完成正在参与的行动。一般变数更新不得修改楼层变量最外层的「国策」（与 stat_data 并列），也不得在 stat_data 内建立「国策」；国策资料由国策脚本保存。未列出的私人国策不代表不存在。';

/**
 * Like the Workflow Assistant world state: matters still in motion are given in full (the current
 * focus, every step of an ongoing event), history is complete but brief (every completed focus by
 * name, every institution in force), and only the recent and the turning points keep their text.
 */
const limits = { description: 160, detailed: 4, resolvedEvents: 2, progress: 3 } as const;

function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}
function ago(state: State, day: number | null): string {
  if (day === null) {
    return '开局前';
  }
  const days = Math.max(0, Math.floor(state.day - day));
  return days === 0 ? '今日' : `${days} 天前`;
}
function progressText(country: Country): string {
  const node = country.current ? country.nodes[country.current] : undefined;
  if (!node) {
    return '';
  }
  const progress = country.progress[node.id];
  const status =
    progress.status === 'waiting' ? '，工期已满，等待成果' : progress.status === 'paused' ? '，暂停中' : '';
  return `${node.name}（第 ${Math.min(Math.floor(progress.days), node.days)}／${node.days} 天${status}${progress.public ? '' : '，未公开'}）`;
}
function completedOf(country: Country) {
  return Object.entries(country.progress)
    .filter(([id, progress]) => progress.status === 'completed' && country.nodes[id])
    .map(([id, progress]) => ({ node: country.nodes[id], day: progress.completed, known: progress.public }))
    .sort((a, b) => (b.day ?? -Infinity) - (a.day ?? -Infinity));
}

/** Routes a mutex choice has locked, named by the first focus taken on each. */
function chosenRoutes(country: Country): string[] {
  return Object.entries(country.locks).map(([group, lock]) => {
    const taken = Object.values(country.nodes)
      .filter((node) => node.mutex?.group === group && node.mutex.route === lock.route)
      .filter((node) =>
        ['completed', 'active', 'waiting', 'paused'].includes(country.progress[node.id]?.status),
      )
      .sort((a, b) => (country.progress[a.id].started ?? 0) - (country.progress[b.id].started ?? 0));
    return taken[0] ? `${taken[0].branch}：${taken[0].name}路线` : lock.reason;
  });
}
const stepMarks = { done: '已完成', active: '进行中', pending: '待办', planned: '预定' } as const;
/**
 * An ongoing event like a Workflow Assistant 事件脉络: how it began, where it stands (`current`
 * and its plan), and the latest progress; older progress is only counted, so a long project does
 * not grow the prompt without end.
 */
function eventHistory(state: State, event: State['events'][string]): string {
  const when = (day: number) => ago(state, day);
  const timeline = [...event.timeline].sort((a, b) => a.at - b.at);
  const recent = timeline.slice(-limits.progress);
  const older = timeline.length - recent.length;
  const lines = [
    `- ${event.headline || event.title}（始于${when(event.at)}，仍在发展${event.public ? '' : '，未公开'}）：${event.description.replace(/\s+/g, ' ').trim()}`,
  ];
  if (event.current) {
    lines.push(`  现况：${event.current}`);
  }
  if (event.steps?.length) {
    const done = event.steps.filter((step) => step.state === 'done').length;
    lines.push(
      `  步骤（${done}／${event.steps.length}）：${event.steps.map((step) => `${step.text}［${stepMarks[step.state]}${step.when ? `，${step.when}` : ''}］`).join('；')}`,
    );
  }
  if (older) {
    lines.push(`  - 更早 ${older} 则进展从略`);
  }
  lines.push(...recent.map((step) => `  - ${when(step.at)}：${step.text}`));
  return lines.join('\n');
}

export function promptView(state: State, news = true): PromptView {
  const countries = Object.values(state.countries).filter((country) => country.enabled);
  // Unresolved matters first, then the most recently updated.
  const events = Object.values(state.events).sort(
    (a, b) =>
      Number(b.status === 'ongoing') - Number(a.status === 'ongoing') ||
      eventUpdatedAt(b) - eventUpdatedAt(a),
  );
  const lines = countries.map((country) => {
    const current = progressText(country);
    const [latest] = completedOf(country);
    return `- ${country.name}：稳定度 ${Math.round(country.stability)}／战争支持度 ${Math.round(country.warSupport)}｜推进中：${current || '无'}${latest ? `｜最近完成：${latest.node.name}（${ago(state, latest.day)}${latest.known ? '' : '，未公开'}）` : ''}`;
  });
  const digest = news ? newsDigest(state) : '';
  const overview =
    countries.length || digest
      ? [
          promptHeader,
          countries.length ? `【各国动向】（故事日 ${Math.floor(state.day)}）\n${lines.join('\n')}` : '',
          digest,
        ]
          .filter(Boolean)
          .join('\n\n')
      : '';
  return {
    overview,
    countries: Object.fromEntries(
      countries.map((country) => {
        const sections: string[] = [
          `【${country.name}】`,
          `第 ${country.period.number} 期：${country.periodTitle}。${country.agenda}`,
        ];
        const lastPeriod = country.period.history.at(-1);
        if (lastPeriod) {
          sections.push(`前期（故事日 ${lastPeriod.start}–${lastPeriod.end}）：${lastPeriod.summary}`);
        }
        if (country.longTerm.length) {
          sections.push(`长期方向：${country.longTerm.map((goal) => goal.text).join('；')}`);
        }
        const current = country.current ? country.nodes[country.current] : undefined;
        if (current) {
          sections.push(`推进中：${progressText(country)}：${clip(current.description, limits.description)}`);
        }
        const completed = completedOf(country);
        const routes = chosenRoutes(country);
        if (routes.length) {
          sections.push(`已选定路线：${routes.join('、')}`);
        }
        if (completed.length) {
          const recent = new Set(completed.slice(0, limits.detailed).map(({ node }) => node.id));
          const detailed = completed.filter(({ node }) => recent.has(node.id) || node.impact === 'pivotal');
          sections.push(
            `重要与近期完成：\n${detailed
              .map(
                ({ node, day, known }) =>
                  `- ${node.name}（${ago(state, day)}${node.impact === 'pivotal' ? '，重要国策' : ''}${known ? '' : '，未公开'}）：${clip(node.description, limits.description)}`,
              )
              .join('\n')}`,
          );
          const branchOrder = (name: string) => {
            const index = country.branches.findIndex((branch) => branch.name === name);
            return index < 0 ? Infinity : index;
          };
          const byBranch = new Map<string, string[]>();
          for (const { node, known } of [...completed].reverse()) {
            byBranch.set(node.branch, [
              ...(byBranch.get(node.branch) ?? []),
              `${node.name}${known ? '' : '（未公开）'}`,
            ]);
          }
          sections.push(
            `已完成国策（共 ${completed.length} 项，依分支、由早到晚）：\n${[...byBranch]
              .sort(([a], [b]) => branchOrder(a) - branchOrder(b))
              .map(([branch, names]) => `- ${branch}：${names.join('、')}`)
              .join('\n')}`,
          );
        }
        const capabilities = Object.values(country.capabilities)
          .filter((capability) => capability.active)
          .map((capability) => capability.name);
        if (capabilities.length) {
          sections.push(`现行制度与成果：${capabilities.join('、')}`);
        }
        const commitments = Object.values(country.commitments);
        if (commitments.length) {
          sections.push(`承诺：${commitments.join('、')}`);
        }
        const own = events.filter((event) => event.countries.includes(country.id));
        const ongoing = own.filter((event) => event.status === 'ongoing');
        const resolved = own.filter((event) => event.status !== 'ongoing').slice(0, limits.resolvedEvents);
        if (ongoing.length || resolved.length) {
          sections.push(
            `相关事件：\n${[
              ...ongoing.map((event) => eventHistory(state, event)),
              ...resolved.map((event) => `- ${eventText(event, (day) => ago(state, day))}`),
            ].join('\n')}`,
          );
        }
        if (sections.length === 1) {
          sections.push('目前没有推进中或已完成的国策。');
        }
        const keys = [...new Set([country.name, ...(country.keywords ?? [])])];
        return [country.id, { name: country.name, keys, text: sections.join('\n') }];
      }),
    ),
  };
}

/** The same content as one message, for chats without ST-Prompt-Template or floors saved before v0.12.6. */
export function promptText(view: PromptView): string {
  const details = Object.values(view.countries).map((country) => country.text);
  return view.overview
    ? `${view.overview}${details.length ? `\n\n<国策动态>\n${details.join('\n\n')}\n</国策动态>` : ''}`
    : '';
}

/** Chat worldbook entries that render `国策.prompt` of the floor being answered. */
export const bookPrefix = '国策档案-';

/** Migrate only our old fixed name segments, leaving country IDs and player metadata intact. */
function currentBookName(name: string): string | null {
  if (name.startsWith(bookPrefix)) {
    return name;
  }
  const legacyPrefix = '國策檔案-';
  if (!name.startsWith(legacyPrefix)) {
    return null;
  }
  const suffix = name.slice(legacyPrefix.length);
  const fixed: Record<string, string> = {
    世界概況: '世界概况',
    '國家動態-包裹-上': '国家动态-包裹-上',
    '國家動態-包裹-下': '国家动态-包裹-下',
  };
  return bookPrefix + (fixed[suffix] ?? (suffix.startsWith('國家-') ? `国家-${suffix.slice(3)}` : suffix));
}
export const bookOrder = { overview: 99990, open: 99991, country: 99992, close: 99993 } as const;
export type BookEntry = {
  name: string;
  constant: boolean;
  keys: string[];
  content: string;
  order: number;
};
export function bookEntries(view: PromptView, constant = true): BookEntry[] {
  const read = (path: string) => `<%- getvar('国策.prompt.${path}', { defaults: '' }) %>`;
  const ids = Object.keys(view.countries);
  if (!view.overview) {
    return [];
  }
  return [
    {
      name: `${bookPrefix}世界概况`,
      constant: true,
      keys: [],
      content: read('overview'),
      order: bookOrder.overview,
    },
    {
      name: `${bookPrefix}国家动态-包裹-上`,
      constant: true,
      keys: [],
      content: '<国策动态>',
      order: bookOrder.open,
    },
    ...ids.map((id) => ({
      name: `${bookPrefix}国家-${id}`,
      constant,
      keys: view.countries[id].keys,
      content: read(`countries.${id}.text`),
      order: bookOrder.country,
    })),
    {
      name: `${bookPrefix}国家动态-包裹-下`,
      constant: true,
      keys: [],
      content: '</国策动态>',
      order: bookOrder.close,
    },
  ];
}

/** Minimal view of a Tavern Helper worldbook entry. */
export type WorldbookEntryLike = {
  uid?: number;
  name: string;
  enabled?: boolean;
  strategy: { type: 'constant' | 'selective' | 'vectorized'; keys: (string | RegExp)[] };
  position?: Record<string, unknown>;
  content: string;
  recursion?: { prevent_incoming: boolean; prevent_outgoing: boolean; delay_until?: number | null };
  [key: string]: unknown;
};

/**
 * The worldbook after reconciling this script's entries: new entries get the default placement;
 * existing ones keep the player's position, order and enabled state and any extra keys they added.
 * Returns null when nothing changes, so a floor switch does not rewrite the worldbook.
 */
export function reconcileBook(
  existing: WorldbookEntryLike[],
  wanted: BookEntry[],
): WorldbookEntryLike[] | null {
  const byName = new Map(wanted.map((entry) => [entry.name, entry]));
  let changed = false;
  const kept: WorldbookEntryLike[] = [];
  for (const entry of existing) {
    const name = currentBookName(entry.name);
    if (name === null) {
      kept.push(entry);
      continue;
    }
    const target = byName.get(name);
    if (!target) {
      changed = true;
      continue;
    }
    byName.delete(name);
    const type = target.constant ? 'constant' : 'selective';
    const keys = entry.strategy.keys.map(String);
    const missing = target.keys.filter((key) => !keys.includes(key));
    if (
      entry.name !== target.name ||
      entry.content !== target.content ||
      entry.strategy.type !== type ||
      missing.length
    ) {
      changed = true;
      kept.push({
        ...entry,
        name: target.name,
        content: target.content,
        strategy: { ...entry.strategy, type, keys: [...entry.strategy.keys, ...missing] },
      });
    } else {
      kept.push(entry);
    }
  }
  for (const target of byName.values()) {
    changed = true;
    kept.push({
      name: target.name,
      enabled: true,
      strategy: { type: target.constant ? 'constant' : 'selective', keys: target.keys },
      position: { type: 'after_character_definition', role: 'system', depth: 4, order: target.order },
      content: target.content,
      recursion: { prevent_incoming: true, prevent_outgoing: true, delay_until: null },
    });
  }
  return changed ? kept : null;
}
