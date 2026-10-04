import type { Country, FocusNode } from '../../src/model';
import type { Platform } from '../../src/platform';
import { PeriodPreview } from './platform';

const escape = (value: string): string => value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function periodPlatform(platform: Platform): PeriodPreview {
  if (!(platform instanceof PeriodPreview)) {
    throw new Error('分期樣品只能使用離線平台');
  }
  return platform;
}
export function periodControl(platform: Platform, country: Country): string {
  const sample=periodPlatform(platform);
  return `<label class="switch-label period-toggle" title="關閉後保留這棵樹，事件繼續推進"><input type="checkbox" data-period-auto="${escape(country.id)}" ${sample.auto(country.id)?'checked':''}>自動換期</label>`;
}
export function periodBar(platform: Platform, country: Country): string {
  const sample=periodPlatform(platform), info=sample.period(country.id);
  if (!info) {
    return '';
  }
  return `<section class="period-strip" aria-label="當前期別"><div class="period-copy"><strong>第 ${info.number} 期 · ${escape(info.title)}</strong><small role="status">${escape(info.note)}</small></div>${periodControl(platform,country)}<button data-action="period-history">往期摘要${info.history.length?` · ${info.history.length}`:''}</button></section>`;
}
export function anchorNotice(platform: Platform, country: Country, node: FocusNode): string {
  if (periodPlatform(platform).period(country.id)?.anchor!==node.id) {
    return '';
  }
  const progress=country.progress[node.id];
  return `<div class="period-anchor-note"><strong>前期承接</strong><span>${progress.status==='completed'?'保留已完成狀態與既有成果，不重複結算。':`保留原國策及其 ${progress.days.toFixed(0)}／${node.days} 日進度，相關事件繼續更新。`}</span></div>`;
}
export function anchorBadge(platform: Platform, country: Country, node: FocusNode): string {
  return periodPlatform(platform).period(country.id)?.anchor===node.id ? '<span class="period-anchor-badge">前期承接</span>' : '';
}
export function historyBody(platform: Platform, country: Country): string {
  const history=periodPlatform(platform).period(country.id)?.history ?? [];
  return `<p class="muted">${escape(country.name)}</p>${history.length ? history.map(h=>`<article class="period-history"><time>${escape(h.time)}</time><p>${escape(h.summary)}</p></article>`).join('') : '<p class="muted">尚未換期。往期只保留時間與一段摘要。</p>'}`;
}
