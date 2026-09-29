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
  return `<label class="switch-label period-toggle" title="關閉後保留當前樹，事件仍繼續推進"><input type="checkbox" data-period-auto="${escape(country.id)}" ${country.autoPeriod ? 'checked' : ''}>自動換期</label>`;
}
export function periodBar(country: Country, jobs: JobStatus[]): string {
  const generating = jobs.some(
    (job) => job.periodWork?.transition.country === country.id && ['queued', 'running'].includes(job.state),
  );
  const note = generating
    ? '下一期生成中；事件繼續更新，成功後才換樹'
    : country.autoPeriod
      ? country.agenda || '本期目的完成或局勢不再適配時自動換期'
      : '保留當前國策樹；事件仍繼續更新';
  return `<section class="period-strip" aria-label="當前期別"><div class="period-copy"><strong>第 ${country.period.number} 期 · ${escape(country.periodTitle)}</strong><small role="status" title="${escape(note)}">${escape(note)}</small></div>${periodControl(country)}<button data-action="period-history">往期摘要${country.period.history.length ? ` · ${country.period.history.length}` : ''}</button></section>`;
}
export function anchorBadge(country: Country, node: FocusNode): string {
  return country.period.anchor === node.id ? '<span class="period-anchor-badge">前期承接</span>' : '';
}
export function anchorNotice(country: Country, node: FocusNode): string {
  return country.period.anchor === node.id
    ? '<div class="period-anchor-note"><strong>前期承接</strong><span>保留原國策的狀態、工期及已生效成果，相關事件繼續更新。</span></div>'
    : '';
}
export function historyBody(country: Country): string {
  return `<p class="muted">${escape(country.name)} · 往期只保留時間與摘要</p>${
    country.period.history.length
      ? [...country.period.history]
          .reverse()
          .map(
            (h) =>
              `<article class="period-history"><time>${time(h.start)} — ${time(h.end)}</time><p>${escape(h.summary)}</p></article>`,
          )
          .join('')
      : '<p class="muted">尚未換期。</p>'
  }`;
}
