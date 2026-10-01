import type { Country, FocusNode } from './model';
import type { JobStatus } from './platform';

const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const time = (day: number): string => {
  const date = new Date((day - 719528) * 86400000);
  return day < 366
    ? `故事日 ${day.toFixed(1)}`
    : `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
};
export function periodControl(country: Country): string {
  return `<label class="switch-label period-toggle" title="关闭后保留当前树，事件仍继续推进"><input type="checkbox" data-period-auto="${escape(country.id)}" ${country.autoPeriod ? 'checked' : ''}>自动换期</label>`;
}
export function periodNote(country: Country, jobs: JobStatus[]): string {
  const generating = jobs.some(
    (job) => job.periodWork?.transition.country === country.id && ['queued', 'running'].includes(job.state),
  );
  return generating
    ? '下一期生成中；事件继续更新，成功后才换树'
    : country.autoPeriod
      ? country.agenda || '本期目的完成或局势不再适配时自动换期'
      : '保留当前国策树；事件仍继续更新';
}
export function periodBar(country: Country, jobs: JobStatus[]): string {
  const note = periodNote(country, jobs);
  // Structure lots of this period (v0.14.21); trees made before have none.
  const lots = country.shape
    ? [country.shape.type, country.shape.naming, ...country.shape.lots].map(
        (lot) => `${lot.category}：${lot.name}`,
      )
    : [];
  const shape = country.shape
    ? `<span class="period-shape" title="${escape(lots.join('\n'))}">${escape(country.shape.type.name)} · ${escape(country.shape.naming.name)}</span>`
    : '';
  return `<section class="period-strip" aria-label="当前期别"><div class="period-copy"><strong>第 ${country.period.number} 期 · ${escape(country.periodTitle)}${shape}</strong><small role="status" title="${escape(note)}">${escape(note)}</small></div>${periodControl(country)}<button data-action="period-history">往期摘要${country.period.history.length ? ` · ${country.period.history.length}` : ''}</button></section>`;
}
export function anchorBadge(country: Country, node: FocusNode): string {
  return country.period.anchor === node.id ? '<span class="period-anchor-badge">前期承接</span>' : '';
}
export function anchorNotice(country: Country, node: FocusNode): string {
  return country.period.anchor === node.id
    ? '<div class="period-anchor-note"><strong>前期承接</strong><span>保留原国策的状态、工期及已生效成果，相关事件继续更新。</span></div>'
    : '';
}
export function historyBody(country: Country): string {
  return `<p class="muted">${escape(country.name)} · 往期只保留时间与摘要</p>${
    country.period.history.length
      ? [...country.period.history]
          .reverse()
          .map(
            (h) =>
              `<article class="period-history"><time>${time(h.start)} — ${time(h.end)}</time><p>${escape(h.summary)}</p></article>`,
          )
          .join('')
      : '<p class="muted">尚未换期。</p>'
  }`;
}
