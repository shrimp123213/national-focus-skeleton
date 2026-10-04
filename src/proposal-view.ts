import type { Proposal, State } from './model';
import type { ProposalReason, ProposalReceptionState, WorldEvidence } from './world-proposal';

/**
 * What a world proposal would change, read for review (v0.16). It compares the saved state with the
 * engine's trial run (`preview`) and the proposal's dated steps; it never decides acceptance.
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

/** Plain sentences for every reason code, written for the player, not the implementation. */
export const reasonText: Record<ProposalReason, string> = {
  waiting_workflow: '世界推演还没有结果。工作流完成后，提案会出现在这里。',
  workflow_unknown: '读不到工作流的执行纪录，无法确认提案来自哪一次推演。',
  member_mismatch: '找不到唯一的阿斯塔利亚世界任务，无法确认提案来源。',
  missing_proposal: '这次世界推演没有附上国策提案。',
  invalid_proposal: '提案的格式无法解读。',
  nonce_mismatch: '提案不属于目前这一次请求。',
  invalid_rules: '提案违反国策规则，无法套用。',
  until_mismatch: '提案推进到的时间与这一楼的故事时间不一致。',
  world_failed: '世界推演回报失败。',
  world_skipped: '世界推演本轮被跳过。',
  world_patch_failed: '世界资料写入时出现问题。',
  preview_changed: '审阅期间国策或提案已有变动，请重新审阅。',
  user_rejected: '你已驳回这份提案。',
  save_failed: '保存国策时失败，提案没有套用。',
  overwritten: '接收后被其他脚本覆写，国策已回到接收前的状态。可以再接收一次。',
  update_started: '已改用国策自己的局势更新，这份提案不再适用。',
  request_expired: '这份提案已被更新的请求取代。',
  source_changed: '这一楼的来源资料已改变。',
  not_latest: '已经有更新的一楼，这份提案已过期。',
  not_assistant: '来源不是有效的 AI 回复。',
  invalid_time: '读不到这一楼的故事时间。',
  mvu_busy: '正文或变量仍在更新，请稍候。',
  update_busy: '国策正在进行自己的局势更新。',
  mvu_unavailable: '没有检测到 MVU。',
  missing_stat_data: '这一楼没有 MVU 变量。',
  missing_state: '这一楼还没有国策存档。',
  invalid_state: '国策存档的格式无效。',
  read_failed: '读取这一楼的资料时失败。',
  unsupported: '目前的环境不支持世界整合。',
  disposed: '国策面板已关闭。',
  preview: '这是预览，没有登记请求。',
  invalid_request: '世界任务没有提供有效的请求编号。',
};

export function letterReason(reception: ProposalReceptionState): string {
  return reception.reason ? reasonText[reception.reason] : '';
}

/** The world side of the review, as short lines; none of them is proof that the write succeeded. */
export function evidenceLines(evidence: WorldEvidence | undefined): { text: string; tone: 'ok' | 'warn' | 'unknown' }[] {
  if (!evidence) {
    return [{ text: '没有世界执行纪录', tone: 'unknown' }];
  }
  const lines: { text: string; tone: 'ok' | 'warn' | 'unknown' }[] = [];
  lines.push(
    evidence.skipped
      ? { text: `世界任务本轮跳过${evidence.skipReason ? `：${evidence.skipReason}` : ''}`, tone: 'warn' }
      : evidence.success
        ? { text: '世界任务回报执行完成', tone: 'ok' }
        : { text: '世界任务回报失败', tone: 'warn' },
  );
  lines.push(
    evidence.changed === null
      ? { text: '无法比较世界资料是否变动', tone: 'unknown' }
      : evidence.changed
        ? { text: '世界资料已变动', tone: 'ok' }
        : { text: '世界资料没有变动（若本轮没有世界变化，这是正常的）', tone: 'unknown' },
  );
  const patch = evidence.patch;
  if (!patch.known) {
    lines.push({ text: '读不到写入日志', tone: 'unknown' });
  } else {
    const repairs = patch.issues.filter((issue) => issue.kind === 'heal');
    const problems = patch.issues.length - repairs.length + patch.failedFragments.length;
    lines.push(
      problems
        ? { text: `写入日志有 ${problems} 个问题`, tone: 'warn' }
        : {
            text: `写入日志没有问题${patch.operationCount !== null ? `（${patch.operationCount} 项写入）` : ''}`,
            tone: 'ok',
          },
    );
    for (const issue of patch.issues) {
      lines.push({
        text: `${issue.kind === 'heal' ? '已自动修正' : '写入问题'}：${issue.message}（${issue.path}）`,
        tone: issue.kind === 'heal' ? 'unknown' : 'warn',
      });
    }
    for (const fragment of patch.failedFragments) {
      lines.push({ text: `第 ${fragment.index} 项无法处理：${fragment.message}`, tone: 'warn' });
    }
    if (patch.unassigned) {
      lines.push({ text: `另有 ${patch.unassigned} 个无法归属世界的日志问题`, tone: 'unknown' });
    }
  }
  return lines;
}
