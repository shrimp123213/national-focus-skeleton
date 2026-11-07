import type { Proposal, State } from './model';

/**
 * What a situation update changed in each nation (v0.16 world letter, v0.18 task window). It compares
 * the state before and after the update with the proposal's dated steps.
 */
export type LetterEntry = {
  day: number;
  kind: 'start' | 'complete' | 'event' | 'update' | 'fact' | 'transition';
  title: string;
  note?: string;
};
export type LetterCountry = {
  id: string;
  name: string;
  stability: [number, number];
  warSupport: [number, number];
  focus: [string, string];
  gained: string[];
  lost: string[];
  entries: LetterEntry[];
};

export function letterDigest(state: State, preview: State, proposal: Proposal): LetterCountry[] {
  const out: LetterCountry[] = [];
  for (const after of Object.values(preview.countries)) {
    const before = state.countries[after.id];
    if (!before || !after.enabled) {
      continue;
    }
    const entries: LetterEntry[] = [];
    for (const [id, progress] of Object.entries(after.progress)) {
      const was = before.progress[id];
      const name = after.nodes[id]?.name ?? id;
      if (progress.started !== null && (!was || was.started === null)) {
        entries.push({ day: progress.started, kind: 'start', title: `开始「${name}」` });
      }
      if (progress.status === 'completed' && was?.status !== 'completed' && progress.completed !== null) {
        const by = progress.by;
        entries.push({
          day: progress.completed,
          kind: 'complete',
          title: `完成「${name}」`,
          note: by ? `${by.mode === 'achieved' ? '由事件达成' : '由事件促成'}：${by.title}` : undefined,
        });
      }
    }
    for (const event of Object.values(preview.events)) {
      if (!event.countries.includes(after.id)) {
        continue;
      }
      const old = state.events[event.id];
      if (!old) {
        entries.push({
          day: event.at,
          kind: 'event',
          title: event.headline || event.title,
          note: event.public ? undefined : '未公开',
        });
        continue;
      }
      for (const item of event.timeline.slice(old.timeline.length)) {
        entries.push({ day: item.at, kind: 'update', title: `${old.headline || old.title}：${item.text}` });
      }
    }
    for (const step of proposal.steps) {
      for (const fact of step.facts) {
        if (fact.country === after.id) {
          entries.push({ day: step.at, kind: 'fact', title: fact.evidence, note: fact.value ? undefined : '不成立' });
        }
      }
    }
    for (const transition of proposal.transitions) {
      if (transition.country === after.id) {
        entries.push({
          day: proposal.until,
          kind: 'transition',
          title: transition.cause === 'completed' ? '本期议程完成，进入下一期' : '局势变化，本期议程改换',
          note: transition.reason,
        });
      }
    }
    entries.sort((a, b) => a.day - b.day || order[a.kind] - order[b.kind]);
    const capability = (s: typeof before) =>
      new Map(Object.values(s.capabilities).filter((c) => c.active).map((c) => [c.id, c.name]));
    const had = capability(before);
    const has = capability(after);
    out.push({
      id: after.id,
      name: after.name,
      stability: [before.stability, after.stability],
      warSupport: [before.warSupport, after.warSupport],
      focus: [before.nodes[before.current]?.name ?? '', after.nodes[after.current]?.name ?? ''],
      gained: [...has].filter(([id]) => !had.has(id)).map(([, name]) => name),
      lost: [...had].filter(([id]) => !has.has(id)).map(([, name]) => name),
      entries,
    });
  }
  // Countries with the most to review first; ties keep the archive order.
  return out.sort((a, b) => weight(b) - weight(a));
}

const order: Record<LetterEntry['kind'], number> = {
  complete: 0,
  start: 1,
  event: 2,
  update: 3,
  fact: 4,
  transition: 5,
};
function weight(country: LetterCountry): number {
  const moved =
    Number(country.stability[0] !== country.stability[1]) + Number(country.warSupport[0] !== country.warSupport[1]);
  return country.entries.length + moved + country.gained.length + country.lost.length;
}
