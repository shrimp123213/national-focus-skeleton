import { conditionMet } from './engine';
import { icon } from './icons';
import {
  factionStanceNames,
  memberKindNames,
  memberWeightNames,
  type Country,
  type Effect,
  type Politics,
  type Requirement,
} from './model';
import { generatingPeriod } from './period-ui';
import type { JobStatus } from './platform';
import { isFactionEffect, type FactionEffect } from './politics';

type Faction = Politics['factions'][number];
type Member = Politics['members'][number];
type Progress = Country['progress'][string];

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** The ruling faction first, then the others by support from high to low. Ties keep the stored order. */
export function factionOrder(politics: Politics): Faction[] {
  const ruling = politics.factions.filter((faction) => faction.id === politics.ruling);
  const others = politics.factions
    .filter((faction) => faction.id !== politics.ruling)
    .sort((a, b) => b.support - a.support);
  return [...ruling, ...others];
}

/**
 * Pie slices in percent of a full turn, in faction order. The flat track under the ruling gauge uses
 * the same slices. A faction at 0 has no slice.
 */
export function pieSlices(politics: Politics): { faction: Faction; from: number; to: number }[] {
  let at = 0;
  return factionOrder(politics).flatMap((faction) => {
    const from = at;
    at += faction.support;
    return faction.support > 0 ? [{ faction, from, to: at }] : [];
  });
}

/** The point at radius `r` and `percent` of a turn, clockwise from the top. */
export function polar(r: number, percent: number): [number, number] {
  const angle = (percent / 100) * Math.PI * 2 - Math.PI / 2;
  return [r * Math.cos(angle), r * Math.sin(angle)];
}

const fixed = (value: number) => value.toFixed(2);
/** A clockwise SVG arc at radius `r` from `from` to `to` percent of a turn. */
export function arcPath(r: number, from: number, to: number): string {
  const [x0, y0] = polar(r, from);
  const [x1, y1] = polar(r, to);
  return `M${fixed(x0)} ${fixed(y0)}A${r} ${r} 0 ${to - from > 50 ? 1 : 0} 1 ${fixed(x1)} ${fixed(y1)}`;
}

/** The factions a route relies on, in the written order. Dissolved factions are ignored. */
export function routeBackers(politics: Politics | undefined, backers: string[] | undefined): Faction[] {
  return (backers ?? []).flatMap((id) => politics?.factions.find((faction) => faction.id === id) ?? []);
}

/** Members of one faction, or the undecided ones for `null`; heavy members first. */
export function factionMembers(politics: Politics, faction: string | null): Member[] {
  const weight = ['heavy', 'medium', 'light'];
  return politics.members
    .filter((member) => member.faction === faction)
    .sort((a, b) => weight.indexOf(a.weight) - weight.indexOf(b.weight));
}

/**
 * A faction effect of a completed focus that did not apply. A bypassed focus applies no effects
 * and keeps its own note.
 */
export function factionEffectSkipped(effect: Effect, progress: Progress): boolean {
  return (
    isFactionEffect(effect) &&
    progress.status === 'completed' &&
    progress.by?.mode !== 'bypassed' &&
    !progress.applied.includes(effect.id)
  );
}

/** The stored colour slot. A faction without one gets a neutral ink; the order never picks a colour. */
export function factionInk(faction: Faction): string {
  return faction.color === undefined ? 'var(--faint)' : `var(--f${faction.color})`;
}
const ink = factionInk;
/** A faction colour always appears as a shield, so it never reads as a status dot. */
export function pip(faction: Faction, size = ''): string {
  return `<svg class="pip ${size}" viewBox="0 0 10 12" style="--c:${ink(faction)}" aria-hidden="true"><path d="M.5.5h9v5.6c0 3.4-4.5 5.4-4.5 5.4S.5 9.5.5 6.1z"/></svg>`;
}
const crownMark =
  '<svg class="crown-mark" viewBox="0 0 15 11" role="img" aria-label="执政"><path d="M1 3.2l3.3 2.6L7.5.8l3.2 5L14 3.2l-1.4 6.6H2.4z" fill="currentColor"/></svg>';
const stance = (faction: Faction) =>
  `<span class="stance ${faction.stance}">${factionStanceNames[faction.stance]}</span>`;
const shares = (politics: Politics) =>
  factionOrder(politics).map((faction) => `${faction.name} ${faction.support}%`);
/** A faction by its shield and name; one that no longer exists shows its ID only. */
function named(politics: Politics | undefined, id: string): string {
  const faction = politics?.factions.find((item) => item.id === id);
  return faction ? `${pip(faction)}<b>${escape(faction.name)}</b>` : `<b>${escape(id)}</b>`;
}

/** The ruling faction as one more gauge in the nation bar; its track is the pie laid flat. */
export function politicsGauge(country: Country, open: boolean): string {
  const politics = country.politics;
  const ruling = politics?.factions.find((faction) => faction.id === politics.ruling);
  if (!politics || !ruling) {
    return '';
  }
  const track = pieSlices(politics)
    .map(({ faction, from, to }) => `<i style="flex:${to - from};--c:${ink(faction)}"></i>`)
    .join('');
  return `<button class="gauge pol-gauge" data-action="politics" aria-expanded="${open}" title="${escape(shares(politics).join(' · '))}" aria-label="执政派系：${escape(ruling.name)}，查看政局"><span class="gauge-head"><small>执政</small><span class="pol-name">${pip(ruling)}<span>${escape(ruling.name)}</span></span>${stance(ruling)}</span><span class="pol-track">${track}</span></button>`;
}

function pie(politics: Politics): string {
  const R = 62;
  const slices = pieSlices(politics)
    .map(({ faction, from, to }) => {
      const attributes = `class="slice" data-faction="${escape(faction.id)}" style="--c:${ink(faction)}"`;
      const tip = `<title>${escape(faction.name)} ${faction.support}%</title>`;
      const shape =
        to - from >= 100
          ? `<circle ${attributes} r="${R}">${tip}</circle>`
          : `<path ${attributes} d="${arcPath(R, from, to)}L0 0Z">${tip}</path>`;
      // The ruling faction has a gold rim; the faction waiting to rule has a dashed one.
      const inset = Math.min(0.6, (to - from) / 4);
      const rim =
        faction.id === politics.ruling ? 'rim' : faction.id === politics.pending?.ruling ? 'rim next' : '';
      const [x, y] = polar(R + 24, (from + to) / 2);
      return `${shape}${rim ? `<path class="${rim}" d="${arcPath(R + 6, from + inset, to - inset)}"/>` : ''}${
        faction.support >= 6 ? `<text x="${fixed(x)}" y="${fixed(y)}">${faction.support}</text>` : ''
      }`;
    })
    .join('');
  const ticks = Array.from({ length: 20 }, (_, i) => {
    const [x0, y0] = polar(R + 9.5, i * 5);
    const [x1, y1] = polar(R + (i % 2 ? 11.5 : 13), i * 5);
    return `<line class="tick" x1="${fixed(x0)}" y1="${fixed(y0)}" x2="${fixed(x1)}" y2="${fixed(y1)}"/>`;
  }).join('');
  return `<svg class="pie" viewBox="-98 -98 196 196" role="img" aria-label="${escape(shares(politics).join('，'))}"><circle class="ring" r="${R + 9.5}"/>${ticks}${slices}</svg>`;
}

/** Weight shows as emphasis only: heavy has a gold rule, medium a hairline, light none. */
const memberChip = (member: Member) =>
  `<span class="member ${member.weight}" title="${escape(`${memberKindNames[member.kind]} · 分量${memberWeightNames[member.weight]} · ${member.note}`)}">${escape(member.name)}</span>`;

/** The politics drawer: the pie, then every faction in the pie's order, then the undecided members. */
export function politicsDrawer(country: Country): string {
  const politics = country.politics;
  const ruling = politics?.factions.find((faction) => faction.id === politics.ruling);
  if (!politics || !ruling) {
    return '';
  }
  const rows = factionOrder(politics)
    .map((faction) => {
      const leader = faction.leader
        ? `<span class="leader"><small>代表</small>${escape(faction.leader)}</span>`
        : '';
      const people = leader + factionMembers(politics, faction.id).map(memberChip).join('');
      return `<article class="faction" data-faction="${escape(faction.id)}">${pip(faction, 'lg')}<div class="faction-head"><strong>${escape(faction.name)}</strong>${faction.id === politics.ruling ? crownMark : ''}${faction.id === politics.pending?.ruling ? '<span class="next-tag">待接掌</span>' : ''}${stance(faction)}</div><div class="faction-num">${faction.support}<small>%</small></div><div class="faction-body"><p>${escape(faction.appeal)}</p>${people ? `<div class="members">${people}</div>` : ''}</div></article>`;
    })
    .join('');
  const undecided = factionMembers(politics, null);
  return `<header class="drawer-head politics" style="--c:${ink(ruling)}"><button class="ghost drawer-close" data-action="detail-close" aria-label="关闭政局">×</button><span class="drawer-emblem">${icon(country.control === 'player' ? 'eagle' : 'crown')}</span><div><span class="drawer-branch">政局</span><h3>${escape(country.name)}</h3><p>${escape(politics.succession)}</p></div></header>
      <div class="drawer-body"><div class="pol-top">${pie(politics)}<div class="pol-ruler"><small>执政</small><strong>${escape(ruling.name)}</strong>${stance(ruling)}<span class="big">${ruling.support}<small>%</small></span></div></div>${rows}${
        undecided.length
          ? `<div class="unaligned"><h4>未表态</h4><div class="members">${undecided.map(memberChip).join('')}</div></div>`
          : ''
      }</div>`;
}

/**
 * A change of government that waits for the player (spec 五「待决」). The hint and the calibration
 * reason stay visible at every width. While the period job runs, both buttons give way to its state.
 */
export function pendingBar(country: Country, jobs: JobStatus[]): string {
  const politics = country.politics;
  const pending = politics?.pending;
  const next = politics?.factions.find((faction) => faction.id === pending?.ruling);
  const was = politics?.factions.find((faction) => faction.id === politics.ruling);
  if (!pending || !next || !was) {
    return '';
  }
  const generating = generatingPeriod(country, jobs);
  const blocked = '先执行「更新局势」完成校准，才能换期';
  const hint = generating
    ? ''
    : country.calibration
      ? `<small class="pending-hint blocked">${blocked}</small>`
      : '<small class="pending-hint">换期会生成新一期国策树，进行中的国策不承接</small>';
  const actions = generating
    ? '<span class="pending-busy"><i class="spinner"></i>新一期生成中</span>'
    : `<button class="primary" data-action="pending-approve" ${country.calibration ? `disabled title="${blocked}"` : 'title="生成新一期国策树，新执政派系随新树生效"'}>换期</button><button data-action="pending-dismiss" title="清除这项待决，执政派系不变">放弃</button>`;
  return `<section class="pending-bar" style="--c:${ink(next)}" role="status" aria-label="待决的执政更替">${pip(next, 'xl')}<div class="pending-copy"><div class="pending-title"><span>政权易手</span><span class="was">${pip(was)} ${escape(was.name)}</span><span class="arrow">→</span><span>${pip(next)} ${escape(next.name)}</span>${stance(next)}</div><p title="${escape(pending.reason)}">${escape(pending.reason)}</p></div>${hint}<div class="pending-actions">${actions}</div></section>`;
}

/** The backers of a route head, hung from its name plate like seals under a charter. */
export function nodeBackers(backers: Faction[]): string {
  return backers.length
    ? `<span class="node-backers" title="倚重：${escape(backers.map((faction) => faction.name).join('、'))}">${backers.map((faction) => pip(faction)).join('')}</span>`
    : '';
}

/** The 倚重 line of a mutex route in the focus drawer. */
export function backersLine(backers: Faction[]): string {
  return backers.length
    ? `<div class="backers-line"><small>倚重</small>${backers.map((faction) => `<span class="fx" data-faction="${escape(faction.id)}">${pip(faction)}<b>${escape(faction.name)}</b></span>`).join('')}</div>`
    : '';
}

/** A support condition with the support now; a missing faction counts as 0 (spec 五). */
export function supportCondition(country: Country, rule: Extract<Requirement, { kind: 'support' }>): string {
  const faction = country.politics?.factions.find((item) => item.id === rule.faction);
  const what = faction
    ? `<span class="fx">${pip(faction)}<b>${escape(faction.name)}</b> 支持度 ${rule.negate ? '&lt;' : '≥'} ${rule.minimum}</span>`
    : `<span>${escape(rule.label)}</span>`;
  return `<li title="${escape(rule.label)}"><span class="cond-kind">派系</span>${what}<span class="req-now ${conditionMet(country, rule) ? 'met' : ''}">目前 ${faction?.support ?? 0}</span></li>`;
}

/** A faction effect with shields; support changes show as a signed delta. */
export function factionEffect(effect: FactionEffect, politics: Politics | undefined): string {
  switch (effect.kind) {
    case 'support':
      return `<span class="fx">${named(politics, effect.faction)} 支持度</span> <span class="delta ${effect.value > 0 ? 'up' : 'down'}">${effect.value > 0 ? '+' : '−'}${Math.abs(effect.value)}</span>`;
    case 'member': {
      const member = politics?.members.find((item) => item.id === effect.member)?.name ?? effect.member;
      return effect.faction
        ? `<span class="fx"><b>${escape(member)}</b> 改投</span> <span class="fx">${named(politics, effect.faction)}</span>`
        : `<span class="fx"><b>${escape(member)}</b> 转为未表态</span>`;
    }
    case 'merge':
      return `<span class="fx">${named(politics, effect.source)}</span> 并入 <span class="fx">${named(politics, effect.target)}</span>`;
    case 'faction': {
      const faction = politics?.factions.find((item) => item.id === effect.key);
      const name = `${faction ? pip(faction) : ''}<b>${escape(effect.name)}</b>`;
      return effect.support === undefined
        ? `<span class="fx">更新派系 ${name}</span>`
        : `<span class="fx">建立派系 ${name}</span> <span class="delta up">${effect.support}%</span>`;
    }
  }
}
