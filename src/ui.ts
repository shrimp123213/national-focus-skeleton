import { periodBar, periodNote, periodControl, anchorNotice, anchorBadge, historyBody } from './period-ui';
import { blockers, changeCountry, isHistoricalEvidence, pauseFocus, resultNames, startFocus } from './engine';
import { icon } from './icons';
import { coreBranch, layoutTree } from './layout';
import { mutexRoutes } from './reachability';
import {
  ConfigSchema,
  jobKinds,
  relationKindNames,
  type Config,
  type Country,
  type FocusNode,
  type JobKind,
} from './model';
import { mountTaskPanel, taskNames } from './task-panel';
import { mountHud } from './hud';
import type { State } from './model';
import { exportTrees, parseTreeFile, treeTemplate, type TreeImport } from './tree-io';
import type { FocusController } from './workflow';
import css from './style.css';
import { mountApiPanel } from './api-panel';
import { mountSourcePanel } from './source-panel';

const escape = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const statuses: Record<string, string> = {
  idle: '尚未开始',
  active: '进行中',
  paused: '已暂停',
  waiting: '等待条件',
  completed: '已完成',
  terminated: '已终止',
};
const jobNames = taskNames;
const jobStates: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  success: '完成',
  failed: '失败',
  cancelled: '已取消',
};
const checked = (value: boolean) => (value ? 'checked' : '');
/** Node card geometry on the tree canvas; layoutTree counts x in half-card steps (GRID_X / 2). */
const NODE_W = 188;
const NODE_H = 66;
const GRID_X = 228;
const GRID_Y = 122;
const ORIGIN_X = 28;
const ORIGIN_Y = 70;
const selected = (value: boolean) => (value ? 'selected' : '');
/** Mutex link between two cards that never runs through a card in the same column. */
function mutexPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const midA = a.y + NODE_H / 2;
  const midB = b.y + NODE_H / 2;
  if (b.x >= a.x + NODE_W) {
    if (a.y === b.y) {
      return `M${a.x + NODE_W} ${midA}H${b.x}`;
    }
    const bend = Math.max(24, (b.x - a.x - NODE_W) / 2);
    return `M${a.x + NODE_W} ${midA}C${a.x + NODE_W + bend} ${midA} ${b.x - bend} ${midB} ${b.x} ${midB}`;
  }
  // Same column: bracket along the right edge.
  const side = Math.max(a.x, b.x) + NODE_W + 22;
  return `M${a.x + NODE_W} ${midA}H${side}V${midB}H${b.x + NODE_W}`;
}

export function mountUI(
  controller: FocusController,
  doc: Document,
  preview?: {
    advance(days: number): Promise<void>;
    outcome(): Promise<void>;
    news(): Promise<void>;
    reset(): void;
    periodSample?(completed: boolean): Promise<void>;
    nextPeriod?(): Promise<void>;
  },
): () => void {
  const host = doc.createElement('div');
  host.lang = 'zh-Hans';
  host.id = 'national-focus-root';
  doc.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${css}</style><button class="orb" title="开启国策树" aria-label="开启国策树">${icon('eagle')}<span class="count" hidden></span></button><section class="shell" aria-label="国策树面板" hidden></section><div class="modal-backdrop" hidden></div>`;
  const shell = root.querySelector<HTMLElement>('.shell')!;
  const orb = root.querySelector<HTMLButtonElement>('.orb')!;
  const backdrop = root.querySelector<HTMLElement>('.modal-backdrop')!;
  let rendered: { state: State | null; config: Config; error: string } | undefined;
  let countryId = '';
  let nodeId = '';
  let query = '';
  let branch = '';
  const collapsed = new Set<string>();
  let positions = new Map<string, { x: number; y: number }>();
  let centeredCountry = '';
  let zoom = 0.85;
  let pan = { x: 45, y: 45 };
  let detailsOpen = false;
  let routesOpen = (doc.defaultView?.innerWidth ?? 1200) > 760;
  /** Phone layout: the control select and 更新局势 sit behind the nation bar's ⋯ button. */
  let nationMore = false;
  const openPops = new Set<string>();
  let open = controller.platform.demo;
  let modal = '';
  let previousFocus: HTMLElement | null = null;
  let draft = structuredClone(controller.config);
  let settingsTab = 'general';
  /** Country whose tree deletion awaits confirmation in the country manager. */
  let removing = '';
  /** Parsed tree file waiting for confirmation in the country manager. */
  let importing: { file: string; entries: TreeImport[]; withProgress: boolean; replace: boolean } | null =
    null;
  let treeNotice = '';
  /** Failed jobs the player has already seen in the task window. */
  const failuresSeen = new Set<string>();
  /** Focus whose route-locking start awaits confirmation in the drawer. */
  let lockConfirm = '';
  /** Event log filters. */
  let eventFilter: 'all' | 'ongoing' | 'resolved' | 'secret' = 'all';
  let eventCountry = '';
  let unsub = () => {};
  let treeSize = { width: 1600, height: 1000 };
  let orbDragged = false;
  let apiPanel: ReturnType<typeof mountApiPanel> | undefined;
  let sourcePanel: ReturnType<typeof mountSourcePanel> | undefined;
  let taskPanel: ReturnType<typeof mountTaskPanel> | undefined;
  let orbPointer: { x: number; y: number; left: number; top: number } | null = null;
  const view = doc.defaultView!;
  const ORB_KEY = 'national-focus.orb.v1';
  /** Stored orb position and window state; browser storage may be missing or blocked. */
  function loadOrb(): { left?: number; top?: number; collapsed?: boolean } {
    try {
      const raw = JSON.parse(view.localStorage.getItem(ORB_KEY) ?? '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }
  function saveOrb(): void {
    try {
      view.localStorage.setItem(ORB_KEY, JSON.stringify({ ...orbAt, collapsed: hudCollapsed }));
    } catch {
      // Keep the position for this page only.
    }
  }
  const stored = loadOrb();
  let orbAt: { left: number; top: number } | null =
    Number.isFinite(stored.left) && Number.isFinite(stored.top)
      ? { left: stored.left!, top: stored.top! }
      : null;
  let hudCollapsed = stored.collapsed === true;
  const orbSize = () => orb.offsetWidth || 60;
  /** Orb box in viewport coordinates, also while the orb is hidden behind the open panel. */
  function orbBox(): { left: number; top: number; size: number } {
    const size = orbSize();
    const width = doc.documentElement.clientWidth;
    const height = doc.documentElement.clientHeight;
    const at = orbAt ?? { left: width - 24 - size, top: height - 24 - size };
    return {
      left: Math.max(0, Math.min(width - size, at.left)),
      top: Math.max(0, Math.min(height - size, at.top)),
      size,
    };
  }
  function applyOrb(): void {
    if (!orbAt) {
      return;
    }
    const box = orbBox();
    Object.assign(orb.style, { right: 'auto', bottom: 'auto', left: `${box.left}px`, top: `${box.top}px` });
  }
  applyOrb();
  let dragHandle: HTMLElement | null = null;
  function beginDrag(event: PointerEvent, handle: HTMLElement): void {
    const box = orbBox();
    dragHandle = handle;
    orbPointer = { x: event.clientX, y: event.clientY, left: box.left, top: box.top };
    orbDragged = false;
    handle.setPointerCapture(event.pointerId);
  }
  function dragMove(event: PointerEvent): void {
    if (!orbPointer) {
      return;
    }
    const dx = event.clientX - orbPointer.x;
    const dy = event.clientY - orbPointer.y;
    if (Math.hypot(dx, dy) > 6) {
      orbDragged = true;
    }
    if (orbDragged) {
      orbAt = { left: orbPointer.left + dx, top: orbPointer.top + dy };
      orbAt = { left: orbBox().left, top: orbBox().top };
      applyOrb();
      hud.place();
    }
  }
  function dragEnd(cancelled: boolean): void {
    if (orbPointer && orbDragged) {
      saveOrb();
    }
    orbPointer = null;
    if (dragHandle !== orb) {
      // Only a drag that started on the orb must swallow the following click.
      orbDragged = false;
    } else if (cancelled) {
      orbDragged = true;
    }
    dragHandle = null;
  }
  orb.style.touchAction = 'none';
  orb.addEventListener('pointerdown', (event) => beginDrag(event, orb));
  const hud = mountHud({
    root,
    doc,
    controller,
    names: taskNames,
    message: (job) => jobMessage(job),
    anchor: orbBox,
    drag: beginDrag,
    openLog: () => showJobs(),
    collapsed: hudCollapsed,
    onCollapse: (value) => {
      hudCollapsed = value;
      saveOrb();
    },
  });
  for (const handle of [orb, hud.element.querySelector<HTMLElement>('.hud-head')!]) {
    handle.style.touchAction = 'none';
    handle.addEventListener('pointermove', dragMove);
    handle.addEventListener('pointerup', () => dragEnd(false));
    handle.addEventListener('pointercancel', () => dragEnd(true));
  }
  const onResize = () => applyOrb();
  view.addEventListener('resize', onResize);
  function jobMessage(job: { message: string }): string {
    return job.message;
  }

  function currentCountry(): Country | undefined {
    const state = controller.state;
    if (!state) {
      return undefined;
    }
    if (!state.countries[countryId]) {
      countryId = Object.keys(state.countries)[0] ?? '';
    }
    return state.countries[countryId];
  }
  async function action(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      controller.report(error);
    }
  }
  /** Open the drawer; on narrow screens the routes panel yields its space to the tree. */
  function openDetails(): void {
    detailsOpen = true;
    if ((shell.querySelector<HTMLElement>('.stage')?.clientWidth ?? 0) < 1200) {
      routesOpen = false;
    }
  }
  function branchStats(country: Country) {
    const names = [...new Set(Object.values(country.nodes).map((n) => n.branch))];
    return names.map((name) => {
      const members = Object.values(country.nodes).filter((n) => n.branch === name);
      return {
        name,
        total: members.length,
        done: members.filter((n) => country.progress[n.id].status === 'completed').length,
        active: members.some((n) => n.id === country.current),
      };
    });
  }
  function render(jobsOnly = false): void {
    shell.hidden = !open;
    orb.hidden = open;
    const busy = controller.jobs.filter((j) => ['running', 'queued'].includes(j.state)).length;
    const badge = root.querySelector<HTMLElement>('.count')!;
    badge.hidden = busy === 0;
    badge.textContent = String(busy);
    hud.suppress(open);
    hud.update();
    if (!open) {
      return;
    }
    const country = currentCountry();
    const state = controller.state;
    // Controller snapshots and saved config are replaced on change. Job notifications keep
    // those references, so they can update status without losing canvas focus or pointer capture.
    if (
      jobsOnly &&
      rendered?.state === state &&
      rendered.config === controller.config &&
      rendered.error === controller.error
    ) {
      const taskButton = shell.querySelector<HTMLElement>('.command [data-action="jobs"]');
      if (taskButton) {
        taskButton.outerHTML = renderTaskButton(busy);
      }
      const status = shell.querySelector<HTMLElement>('.status-jobs');
      if (status) {
        status.outerHTML = renderTaskSummary();
      }
      const note = shell.querySelector<HTMLElement>('.period-copy small');
      if (country && note) {
        const text = periodNote(country, controller.jobs);
        note.textContent = text;
        note.title = text;
      }
      updateTaskWindows();
      return;
    }
    const countries = state ? Object.values(state.countries) : [];
    if (country && centeredCountry && centeredCountry !== `${country.id}:${country.period.number}`) {
      query = '';
      branch = '';
      collapsed.clear();
    }
    if (country && !country.nodes[nodeId]) {
      nodeId = country.current || Object.keys(country.nodes)[0];
    }
    const controlLabel = (c: Country) =>
      !c.enabled ? '已停用' : c.calibration ? '待校准' : c.control === 'player' ? '玩家选策' : 'AI 演化';
    const tabs = countries
      .map(
        (c) =>
          `<button class="nation-tab ${c.id === countryId ? 'active' : ''} ${c.control}" data-country="${escape(c.id)}" title="${escape(c.name)}" aria-pressed="${c.id === countryId}"><span class="tab-crest">${icon(c.control === 'player' ? 'eagle' : 'crown')}</span><span class="tab-copy"><strong>${escape(c.name)}</strong><small>${controlLabel(c)}</small></span></button>`,
      )
      .join('');
    const command = `<header class="command"><div class="brand-mark" title="国策档案 · NATIONAL FOCUS ARCHIVE">${icon('eagle')}</div><div class="brand"><h1>国策档案</h1><small>NATIONAL FOCUS</small></div><nav class="nation-tabs" aria-label="国家">${tabs}<button class="nation-tab add" data-action="countries" title="管理国家" aria-label="管理国家">＋</button></nav><label class="nation-picker"><span class="sr">切换国家</span><select id="country-picker">${countries.map((c) => `<option value="${escape(c.id)}" ${selected(c.id === countryId)}>${escape(c.name)}</option>`).join('')}<option value="__manage">＋ 管理国家…</option></select></label><div class="command-spacer"></div>${controller.platform.demo ? '<span class="test-label" title="所有国名与内容均为介面示范">离线示范</span>' : ''}<div class="date-chip" title="故事内日序"><small>故事日</small><strong>${state ? state.day.toFixed(1) : '—'}</strong></div>${renderTaskButton(busy)}<button class="cmd-btn" data-action="settings" title="设定" aria-label="设定"><span class="cmd-icon">⚙</span><span class="cmd-text">设定</span></button><button class="cmd-btn close" data-action="close" aria-label="关闭面板">×</button></header>`;
    const error = controller.error
      ? `<div class="error-banner" role="alert"><span>${escape(controller.error)}</span><button data-action="refresh">重新读取</button></div>`
      : '';
    let body: string;
    if (country && state) {
      const current = country.current ? country.nodes[country.current] : undefined;
      const currentProgress = current ? country.progress[current.id] : undefined;
      const percent =
        current && currentProgress
          ? Math.min(100, Math.round((currentProgress.days / current.days) * 100))
          : 0;
      const agenda =
        current && currentProgress
          ? `<button class="agenda ${currentProgress.status}" data-action="open-current" title="查看主国策"><span class="agenda-icon">${icon(current.icon)}</span><span class="agenda-copy"><small>主国策 · ${statuses[currentProgress.status]}</small><strong>${escape(current.name)}</strong><span class="agenda-bar"><i style="width:${percent}%"></i></span><span class="agenda-meta"><span>${currentProgress.days.toFixed(1)} / ${current.days} 日</span><span>${currentProgress.status === 'waiting' ? '工期已满 · 等待成果' : `尚余 ${Math.max(0, current.days - currentProgress.days).toFixed(1)} 日`}</span></span></span></button>`
          : `<div class="agenda empty-agenda"><span class="agenda-icon">${icon('crown')}</span><span class="agenda-copy"><small>主国策</small><strong>${country.control === 'player' ? '尚未选定' : 'AI 评估中'}</strong><span class="agenda-meta"><span>${country.control === 'player' ? '在树上点选可开始的国策' : '下次局势更新时依情势选策'}</span></span></span></div>`;
      const gauge = (label: string, value: number, kind: string) =>
        `<div class="gauge ${kind}" role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><div class="gauge-head"><small>${label}</small><strong>${value}</strong></div><div class="gauge-track"><i style="width:${value}%"></i></div></div>`;
      const stats = branchStats(country);
      const total = Object.keys(country.nodes).length;
      const doneAll = stats.reduce((sum, b) => sum + b.done, 0);
      const routes = `<aside class="routes ${routesOpen ? 'open' : ''}" aria-label="路线导览"><div class="routes-head"><strong>路线</strong><small>${doneAll} / ${total} 完成</small><button class="ghost" data-action="routes" aria-label="收起路线面板">‹</button></div><div class="search-row"><label><span class="sr">搜寻国策</span><input id="focus-search" placeholder="搜寻国策名称或内容" value="${escape(query)}"></label><button data-action="search-next">下一项</button></div><ul class="route-list">${stats
        .map(
          (b) =>
            `<li class="${b.name === branch ? 'active' : ''} ${collapsed.has(b.name) ? 'folded' : ''}"><button class="route-jump" data-jump-branch="${escape(b.name)}"><span class="route-name">${b.active ? '<i class="route-live" title="主国策所在路线"></i>' : ''}${escape(b.name)}</span><span class="route-count">${b.done}/${b.total}</span><span class="route-bar"><i style="width:${Math.round((b.done / b.total) * 100)}%"></i></span></button><button class="route-fold" data-fold-branch="${escape(b.name)}" aria-label="${collapsed.has(b.name) ? '展开' : '收合'}${escape(b.name)}" aria-expanded="${!collapsed.has(b.name)}" title="${collapsed.has(b.name) ? '展开路线' : '收合路线'}">${collapsed.has(b.name) ? '＋' : '−'}</button></li>`,
        )
        .join(
          '',
        )}</ul><div class="route-actions"><button data-action="isolate">只看此路线</button><button data-action="expand-all">全部展开</button></div></aside>`;
      body = `<section class="nation-bar ${nationMore ? 'more-open' : ''}"><div class="nation-id"><span class="nation-crest">${icon(country.control === 'player' ? 'eagle' : 'crown')}</span><div class="nation-copy"><h2>${escape(country.name)}</h2><small class="control-tag">${controlLabel(country)} · 故事日 ${state.day.toFixed(1)}</small><p>${escape(country.description)}</p></div></div><div class="gauges">${gauge('稳定度', country.stability, 'stability')}${gauge('战争支持度', country.warSupport, 'war')}</div><button class="nation-more-btn" data-action="nation-more" aria-expanded="${nationMore}" aria-label="控制方式与更新局势" title="控制方式与更新局势">⋯</button>${agenda}<div class="nation-actions"><label class="control-select"><span class="sr">控制方式</span><select id="country-control"><option value="player" ${selected(country.control === 'player')}>玩家选策</option><option value="ai" ${selected(country.control === 'ai')}>AI 自主演化</option></select></label><button class="primary" data-action="update" title="依目前正文与 MVU 重新评估">更新局势</button></div></section>
      ${periodBar(country, controller.jobs)}<section class="stage ${detailsOpen ? 'with-drawer' : ''}"><div class="canvas" tabindex="0" aria-label="国策画布，可拖曳平移，滚轮或双指缩放"><div class="tree"></div></div>${routes}${routesOpen ? '' : `<button class="routes-tab" data-action="routes" aria-label="开启路线面板">路线 <small>${stats.length}</small></button>`}<div class="stage-tools"><details class="legend-pop" data-pop="legend" ${openPops.has('legend') ? 'open' : ''}><summary>图例</summary><ul class="legend-list"><li><i class="sw completed"></i>已完成</li><li><i class="sw active"></i>进行中</li><li><i class="sw waiting"></i>等待成果</li><li><i class="sw paused"></i>已暂停</li><li><i class="sw available"></i>可开始</li><li><i class="sw locked"></i>条件未满</li><li><i class="sw terminated"></i>已终止／路线锁定</li><li><i class="ln solid"></i>必要前置</li><li><i class="ln dashed"></i>择一前置</li><li><i class="ln cross"></i>跨路线依赖</li><li><i class="ln mutex"></i>互斥</li></ul></details><button data-action="locate-current" ${country.current ? '' : 'disabled'} title="定位主国策">◎ 主国策</button>${country.relations?.length || country.branches.some((b) => b.core) ? '<button data-action="relations" title="核心分支与国策之间的关系">⇄ 关系</button>' : ''}<div class="zoom-controls"><button data-action="zoom-out" aria-label="缩小">−</button><button data-action="fit" title="显示整棵树"><span class="zoom-value">${Math.round(zoom * 100)}%</span></button><button data-action="zoom-in" aria-label="放大">＋</button></div></div><div class="minimap" aria-hidden="true"><svg class="minimap-svg"></svg></div>${controller.platform.demo ? `<details class="demo-pop" data-pop="demo" ${openPops.has('demo') ? 'open' : ''}><summary>测试操作</summary><small>只改离线示范，不呼叫 API</small><button data-action="demo-days">故事时间 ＋7 日</button><button data-action="demo-outcome">完成联运勘查</button><button data-action="demo-news">发布示范事件</button>${preview?.periodSample ? '<button data-action="demo-period-crisis">载入分期：局势突变</button><button data-action="demo-period-complete">载入分期：议程完成</button><button data-action="demo-period-next">推进事件／演示换期</button>' : ''}<button data-action="demo-reset">重设示范</button></details>` : ''}<aside class="drawer ${detailsOpen ? 'open' : ''}" aria-label="国策详情" ${detailsOpen ? '' : 'aria-hidden="true"'}>${detailsOpen ? renderDetails(country, country.nodes[nodeId]) : ''}</aside></section>`;
    } else {
      body = `<section class="empty"><div class="empty-card">${icon('eagle')}<h2>${state ? '为这个世界选择方向' : '连接你的故事'}</h2><p>${state ? '先辨识本局国家，再勾选要启用的对象。国策内容会依你选择的世界书与剧情生成。' : '国策树需要一则已完成的正文，以及本楼可读取的 MVU 变数。你仍可先设定 API 与来源。'}</p><div class="row"><button class="primary" data-action="countries">选择启用国家</button><button data-action="settings">设定来源与 API</button></div></div></section>`;
    }
    shell.innerHTML = `${command}${error}${body}<footer class="statusline">${renderTaskSummary()}<span class="status-mid">${country && state ? `${Object.keys(country.nodes).length} 项国策` : ''}</span><button class="linkish" data-action="events">事件纪录</button></footer>`;
    if (country) {
      drawTree(country);
      bindCanvas();
      bindMinimap();
      if (centeredCountry !== `${country.id}:${country.period.number}`) {
        centeredCountry = `${country.id}:${country.period.number}`;
        locateNode(nodeId);
      }
    }
    if (modal === 'period-history' && country) {
      const body = backdrop.querySelector('.modal-body');
      if (body) {
        body.innerHTML = historyBody(country);
      }
    }
    rendered = { state, config: controller.config, error: controller.error };
    updateTaskWindows();
  }
  function updateTaskWindows(): void {
    if (modal === 'jobs') {
      showJobs();
    }
    if (modal === 'countries') {
      showCountries(false);
    }
    updateModalJobs();
  }
  function renderTaskButton(busy: number): string {
    const failures = unseenFailures().length;
    return `<button class="cmd-btn ${busy ? 'busy' : ''}" data-action="jobs" title="任务" aria-label="任务${busy ? `，${busy} 项进行中` : ''}${failures ? `，${failures} 项失败` : ''}"><span class="cmd-icon">${busy ? '<i class="spinner"></i>' : '☰'}</span><span class="cmd-text">任务${busy ? ` ${busy}` : ''}</span>${failures ? '<i class="alert-dot" aria-hidden="true"></i>' : ''}</button>`;
  }
  function renderTaskSummary(): string {
    const summary = taskSummary();
    return `<button class="linkish status-jobs ${summary.state}" data-action="jobs"><i class="status-dot ${summary.state}"></i>${escape(summary.text)}</button>`;
  }
  /** Failed jobs not yet seen in the task window. */
  function unseenFailures() {
    return controller.jobs.filter((job) => job.state === 'failed' && !failuresSeen.has(job.id));
  }
  /** The status line: what the background tasks are doing, or how the last one ended. */
  function taskSummary(): { text: string; state: string } {
    const active = controller.jobs.filter((job) => ['running', 'queued'].includes(job.state));
    if (active.length) {
      const job = active.find((item) => item.state === 'running') ?? active[0];
      const name = `${jobNames[job.kind as JobKind] ?? job.kind}${job.label ? `（${job.label}）` : ''}`;
      const more = active.length > 1 ? `，另有 ${active.length - 1} 项` : '';
      return { text: `${name}：${jobMessage(job)}${more}`, state: 'busy' };
    }
    const failed = unseenFailures().length;
    if (failed) {
      return { text: `${failed} 项任务失败，点此查看`, state: 'failed' };
    }
    const last = controller.jobs.find((job) => job.state === 'success');
    return last
      ? { text: `上次完成：${jobNames[last.kind as JobKind] ?? last.kind} · ${last.time}`, state: '' }
      : { text: '任务待命', state: '' };
  }
  function effectText(e: FocusNode['effects'][number]): string {
    const when = e.when?.length ? `若${e.when.map((r) => r.label).join('且')}：` : '';
    return when + effectBody(e);
  }
  function effectBody(e: FocusNode['effects'][number]): string {
    return e.kind === 'capability'
      ? `${e.active ? '建立／恢复' : '失效'}：${e.name}`
      : e.kind === 'commitment'
        ? `承诺：${e.name}`
        : `${e.kind === 'stability' ? '稳定度' : '战争支持度'} ${e.value >= 0 ? '+' : ''}${e.value}`;
  }
  function renderDetails(country: Country, node: FocusNode | undefined): string {
    if (!node) {
      return '<p class="muted">点选国策查看详情。</p>';
    }
    const progress = country.progress[node.id];
    const reasons = blockers(country, node);
    const isCurrent = country.current === node.id;
    const percent = Math.min(100, Math.round((progress.days / node.days) * 100));
    const list = (items: string[]) =>
      items.length
        ? `<ul>${items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`
        : '<p class="muted">无</p>';
    const route = country.branches.find((b) => b.name === node.branch);
    const stateClass =
      progress.status === 'idle' && reasons.length
        ? 'locked'
        : progress.status === 'idle'
          ? 'available'
          : progress.status;
    const stateLabel =
      stateClass === 'locked'
        ? '条件未满'
        : stateClass === 'available'
          ? '可开始'
          : statuses[progress.status];
    const conditions = [
      ...node.requirements.map((r) => ['启动', r.label]),
      ...node.sustain.map((r) => ['持续', r.label]),
      ...node.outcomes.map((r) => ['成果', r.label]),
    ];
    // Starting a route that locks on start closes the other routes for good: say so and confirm.
    const locking =
      !isCurrent &&
      node.mutex?.lock === 'start' &&
      !country.locks[node.mutex.group] &&
      progress.status === 'idle';
    const rivals = locking
      ? [...(mutexRoutes(Object.values(country.nodes)).get(node.mutex!.group) ?? [])]
          .filter(([route]) => route !== node.mutex!.route)
          .flatMap(([, route]) => route.heads.map((head) => head.name))
      : [];
    const startable = !(reasons.length || country.current || progress.status === 'completed');
    // 改选: pause the current focus and start this one in one step (it keeps its invested days).
    const switchable =
      !isCurrent && Boolean(country.current) && !reasons.length && progress.status !== 'completed';
    const running = country.current ? country.nodes[country.current] : undefined;
    const verb = switchable ? '改选' : '开始';
    const act = switchable ? 'switch' : 'start';
    const startButton = isCurrent
      ? '<button data-action="pause">暂停目前国策</button>'
      : locking && (startable || switchable)
        ? lockConfirm === node.id
          ? `<div class="lock-confirm" role="alert"><p>${verb}后会立即锁定路线，以下路线将无法再选：<strong>${rivals.map(escape).join('、')}</strong></p><div class="row"><button class="primary" data-action="${act}">确认${verb}</button><button data-action="lock-cancel">取消</button></div></div>`
          : `<button class="primary" data-action="lock-ask">${verb}并锁定路线</button>`
        : switchable
          ? '<button class="primary" data-action="switch">改选此国策</button>'
          : `<button class="primary" data-action="start" ${startable ? '' : 'disabled'}>${progress.status === 'paused' ? '恢复国策' : progress.status === 'completed' ? '国策已完成' : '开始此国策'}</button>`;
    const action =
      country.control === 'player'
        ? `<div class="drawer-action">${startButton}${switchable && running ? `<small>会暂停「${escape(running.name)}」（已投入 ${country.progress[running.id].days.toFixed(1)} 日，之后可恢复），${progress.status === 'paused' ? '恢复' : '开始'}此国策。</small>` : ''}${reasons.length ? `<ul class="blockers">${reasons.map((r) => `<li>${escape(r)}</li>`).join('')}</ul>` : ''}</div>`
        : `<div class="drawer-action"><small>AI 依情势选择后续国策；切换为「玩家选策」即可介入。</small></div>`;
    return `<header class="drawer-head ${stateClass}"><button class="ghost drawer-close" data-action="detail-close" aria-label="关闭详情">×</button><span class="drawer-emblem">${icon(node.icon)}</span><div><span class="drawer-branch">${escape(node.branch)}</span><h3>${escape(node.name)}</h3><span class="state-pill ${stateClass}">${stateLabel}</span><span class="days-pill">${node.days} 日</span></div></header>
      <div class="drawer-body">${anchorNotice(country, node)}${progress.started !== null ? `<div class="drawer-progress"><div class="row between"><small>有效工期</small><strong>${progress.days.toFixed(1)} / ${node.days} 日</strong></div><div class="bar"><i style="width:${percent}%"></i></div>${progress.evidence ? `<small>${escape(progress.evidence)}</small>` : ''}</div>` : ''}
      ${action}
      <p class="description">${escape(node.description)}</p>
      <section class="detail-section"><h4>前置国策</h4>${node.prerequisites.length ? `<div class="prereqs">${node.prerequisites.map((group) => `<div class="prereq-group">${group.map((id, i) => `${i ? '<span class="or">或</span>' : ''}<button class="chip ${country.progress[id].status === 'completed' ? 'done' : ''}" data-goto="${escape(id)}">${escape(country.nodes[id].name)}</button>`).join('')}</div>`).join('<span class="and">且</span>')}</div>` : '<p class="muted">此路线的起点</p>'}</section>
      <section class="detail-section"><h4>完成效果</h4>${list(
        node.effects.map(
          (e) =>
            effectText(e) +
            (e.when?.length && progress.status === 'completed'
              ? isHistoricalEvidence(progress.evidence)
                ? '（历史承接，实际效果未记录）'
                : progress.applied.includes(e.id)
                  ? '（已生效）'
                  : '（条件未成立，未生效）'
              : ''),
        ),
      )}</section>
      ${conditions.length ? `<section class="detail-section"><h4>条件</h4><ul class="conditions">${conditions.map(([kind, label]) => `<li><span class="cond-kind">${kind}</span>${escape(label)}</li>`).join('')}</ul></section>` : ''}
      ${node.impact === 'pivotal' ? `<section class="detail-section pivotal-note"><h4>重要国策</h4><p>完成时发布新闻${node.news ? `：「${escape(node.news.headline)}」` : ''}。</p></section>` : ''}
      ${node.mutex ? mutexNote(country, node) : ''}
      <section class="detail-section"><h4>投入与工期</h4>${list(node.investments)}${node.durationReason ? `<details class="fold"><summary>工期理由</summary><p class="reason">${escape(node.durationReason)}</p></details>` : ''}</section>
      ${route ? `<section class="detail-section"><h4>路线抉择 · ${escape(route.name)}</h4><p>${escape(route.purpose)}</p><dl class="route-facts"><dt>支持者</dt><dd>${escape(route.supporters)}</dd><dt>阻力</dt><dd>${escape(route.opposition)}</dd><dt>取舍</dt><dd>${escape(route.tradeoff)}</dd><dt>终点</dt><dd>${escape(route.destination)}</dd></dl></section>` : ''}
      ${node.reason ? `<details class="detail-section fold"><summary><h4>设计依据</h4></summary><p class="reason">${escape(node.reason)}</p></details>` : ''}</div>`;
  }
  /** Name the competing routes, so a mutex never looks like it has no counterpart. */
  function mutexNote(country: Country, node: FocusNode): string {
    const routes = mutexRoutes(Object.values(country.nodes)).get(node.mutex!.group)!;
    const own = routes.get(node.mutex!.route)!;
    const head = own.heads.includes(node);
    const others = [...routes].filter(([route]) => route !== node.mutex!.route);
    const chips = (list: FocusNode[]) =>
      list.map((n) => `<button class="chip" data-goto="${escape(n.id)}">${escape(n.name)}</button>`).join('');
    const lock =
      node.mutex!.lock === 'start' ? '开始路线起点时即作出不可撤回的承诺' : '完成路线起点后锁定其他路线';
    return `<section class="detail-section mutex-note"><h4>互斥路线</h4><p>${escape(node.mutex!.reason)}</p>${
      others.length
        ? `<p class="mutex-rivals"><small>${head ? '本国策是这条路线的起点，与以下路线互斥：' : `本国策属于「${escape(own.heads.map((n) => n.name).join('／'))}」开启的路线，与以下路线互斥：`}</small></p><div class="prereqs"><div class="prereq-group">${others.map(([, route]) => chips(route.heads)).join('<span class="or">／</span>')}</div></div><small>${lock}</small>`
        : '<small>这个互斥组没有其他路线，实际上不会锁定任何国策（旧版生成的资料）。</small>'
    }</section>`;
  }
  function nodeState(country: Country, node: FocusNode): string {
    const p = country.progress[node.id];
    if (p.status !== 'idle') {
      return p.status;
    }
    const lock = node.mutex ? country.locks[node.mutex.group] : undefined;
    if (lock && lock.route !== node.mutex!.route) {
      return 'sealed';
    }
    return blockers(country, node).length ? 'locked' : 'available';
  }
  function drawTree(country: Country): void {
    const tree = shell.querySelector<HTMLElement>('.tree')!;
    const nodes = Object.values(country.nodes);
    positions = new Map(
      layoutTree(nodes, coreBranch(country)).map((n) => [
        n.id,
        { x: (n.x * GRID_X) / 2 + ORIGIN_X, y: n.y * GRID_Y + ORIGIN_Y },
      ]),
    );
    const pos = (node: FocusNode) => positions.get(node.id)!;
    const summaries = new Map<string, { x: number; y: number }>();
    const spans = new Map<string, { left: number; right: number }>();
    for (const b of new Set(nodes.map((n) => n.branch))) {
      const members = nodes.filter((n) => n.branch === b);
      summaries.set(b, {
        x: Math.min(...members.map((n) => pos(n).x)),
        y: Math.min(...members.map((n) => pos(n).y)),
      });
      spans.set(b, {
        left: Math.min(...members.map((n) => pos(n).x)),
        right: Math.max(...members.map((n) => pos(n).x)) + NODE_W,
      });
    }
    const endpoint = (node: FocusNode) =>
      collapsed.has(node.branch) ? summaries.get(node.branch)! : pos(node);
    const drawn = nodes.filter((n) => !collapsed.has(n.branch));
    const points = [...drawn.map(pos), ...[...summaries].filter(([b]) => collapsed.has(b)).map(([, p]) => p)];
    treeSize = {
      width: Math.max(...points.map((p) => p.x)) + NODE_W + ORIGIN_X,
      height: Math.max(...points.map((p) => p.y)) + NODE_H + 48,
    };
    tree.style.width = `${treeSize.width}px`;
    tree.style.height = `${treeSize.height}px`;
    const states = new Map(nodes.map((n) => [n.id, nodeState(country, n)]));
    const lines: string[] = [];
    const edgeKeys = new Set<string>();
    // One marker per route: its topmost head, i.e. where the player commits to that route.
    const groups = mutexRoutes(nodes);
    const heads = new Set<string>();
    const mutexLines: string[] = [];
    for (const routes of groups.values()) {
      if (routes.size < 2) {
        continue;
      }
      const leaders: FocusNode[] = [];
      for (const route of routes.values()) {
        route.heads.forEach((head) => heads.add(head.id));
        const shown = route.heads.filter((head) => !collapsed.has(head.branch));
        if (shown.length) {
          leaders.push(
            shown.reduce((a, b) =>
              pos(a).y < pos(b).y || (pos(a).y === pos(b).y && pos(a).x < pos(b).x) ? a : b,
            ),
          );
        }
      }
      leaders.sort((a, b) => pos(a).x - pos(b).x || pos(a).y - pos(b).y);
      for (let i = 1; i < leaders.length; i++) {
        mutexLines.push(
          `<path class="connector mutex" d="${mutexPath(pos(leaders[i - 1]), pos(leaders[i]))}"/>`,
        );
      }
    }
    for (const node of nodes) {
      const target = endpoint(node);
      for (const parent of node.prerequisites.flat()) {
        const parentNode = country.nodes[parent];
        if (node.branch === parentNode.branch && collapsed.has(node.branch)) {
          continue;
        }
        const from = endpoint(parentNode);
        const edgeKey = `${from.x},${from.y}:${target.x},${target.y}`;
        if (edgeKeys.has(edgeKey)) {
          continue;
        }
        edgeKeys.add(edgeKey);
        const completed =
          !collapsed.has(node.branch) &&
          !collapsed.has(parentNode.branch) &&
          states.get(parent) === 'completed';
        const x1 = from.x + NODE_W / 2;
        const y1 = from.y + NODE_H;
        const x2 = target.x + NODE_W / 2;
        const y2 = target.y;
        const middle = y1 + Math.max(14, (y2 - y1) / 2);
        const radius = Math.min(10, Math.abs(x2 - x1) / 2, Math.abs(y2 - middle));
        const direction = x2 > x1 ? 1 : -1;
        const d =
          x1 === x2
            ? `M${x1} ${y1}V${y2}`
            : `M${x1} ${y1}V${middle - radius}Q${x1} ${middle} ${x1 + direction * radius} ${middle}H${x2 - direction * radius}Q${x2} ${middle} ${x2} ${middle + radius}V${y2}`;
        lines.push(
          `<path class="connector ${completed ? 'done' : ''} ${node.prerequisites.some((g) => g.length > 1 && g.includes(parent)) ? 'alternative' : ''} ${node.branch !== parentNode.branch ? 'cross-branch' : ''}" d="${d}"/>`,
        );
      }
    }
    lines.push(...mutexLines);
    const meta = (node: FocusNode, stateClass: string) => {
      const p = country.progress[node.id];
      return stateClass === 'completed'
        ? '✓ 已完成'
        : stateClass === 'active'
          ? `${p.days.toFixed(0)} / ${node.days} 日`
          : stateClass === 'waiting'
            ? '等待成果'
            : stateClass === 'paused'
              ? `Ⅱ ${p.days.toFixed(0)} / ${node.days} 日`
              : stateClass === 'sealed'
                ? '路线已锁定'
                : stateClass === 'terminated'
                  ? '已终止'
                  : `${node.days} 日`;
    };
    tree.innerHTML = `<svg class="connectors" width="${treeSize.width}" height="${treeSize.height}" aria-hidden="true">${lines.join('')}</svg>${[
      ...spans,
    ]
      .filter(([b]) => !collapsed.has(b))
      .map(
        ([label, span]) =>
          `<div class="branch-banner ${label === branch ? 'active' : ''}" style="left:${span.left}px;width:${span.right - span.left}px"><span>${escape(label)}</span></div>`,
      )
      .join('')}${[...summaries]
      .filter(([b]) => collapsed.has(b))
      .map(
        ([b, p]) =>
          `<button class="branch-summary" data-jump-branch="${escape(b)}" style="left:${p.x}px;top:${p.y}px;width:${NODE_W}px"><strong>${escape(b)}</strong><span>${nodes.filter((n) => n.branch === b).length} 项国策已收合 · 点选展开</span></button>`,
      )
      .join('')}${drawn
      .map((node) => {
        const p = country.progress[node.id];
        const stateClass = states.get(node.id)!;
        const position = pos(node);
        const dim =
          (query && !`${node.name} ${node.description}`.includes(query)) ||
          (branch && node.branch !== branch);
        const isCurrent = country.current === node.id;
        return `<button class="node ${stateClass} ${nodeId === node.id && detailsOpen ? 'selected' : ''} ${dim ? 'dim' : ''} ${isCurrent ? 'current' : ''}" data-node="${escape(node.id)}" style="left:${position.x}px;top:${position.y}px;width:${NODE_W}px;height:${NODE_H}px" aria-label="${escape(node.name)}，${escape(meta(node, stateClass))}"><span class="node-icon">${icon(node.icon)}</span><span class="node-text"><span class="node-name">${escape(node.name)}</span><span class="node-meta">${escape(meta(node, stateClass))}</span></span>${anchorBadge(country, node)}${heads.has(node.id) ? '<span class="node-flag" title="互斥路线的分歧点">⇋</span>' : ''}${node.impact === 'pivotal' ? '<span class="node-pivot" title="重要国策：完成时发布新闻">✦</span>' : ''}${p.started !== null && stateClass !== 'completed' ? `<span class="node-progress"><i style="width:${Math.min(100, (p.days / node.days) * 100)}%"></i></span>` : ''}</button>`;
      })
      .join('')}`;
    const minimap = shell.querySelector<SVGSVGElement>('.minimap-svg');
    if (minimap) {
      minimap.setAttribute('viewBox', `0 0 ${treeSize.width} ${treeSize.height}`);
      minimap.innerHTML = `${drawn
        .map((node) => {
          const p = pos(node);
          return `<rect class="mm ${states.get(node.id)} ${country.current === node.id ? 'current' : ''}" x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="10"/>`;
        })
        .join('')}${[...summaries]
        .filter(([b]) => collapsed.has(b))
        .map(
          ([, p]) =>
            `<rect class="mm folded" x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="10"/>`,
        )
        .join('')}<rect class="mm-view" x="0" y="0" width="0" height="0"/>`;
    }
    const searchButton = shell.querySelector<HTMLButtonElement>('[data-action="search-next"]');
    if (searchButton) {
      const count = query ? nodes.filter((n) => `${n.name} ${n.description}`.includes(query)).length : 0;
      searchButton.textContent = query ? `下一项 (${count})` : '下一项';
      searchButton.disabled = count === 0;
    }
    transform();
  }
  function locateNode(id: string): void {
    const country = currentCountry();
    let canvas = shell.querySelector<HTMLElement>('.canvas');
    const node = country?.nodes[id];
    if (!canvas || !node) {
      return;
    }
    if (collapsed.delete(node.branch)) {
      render();
      canvas = shell.querySelector<HTMLElement>('.canvas')!;
    }
    const p = positions.get(id)!;
    zoom = Math.max(zoom, 0.8);
    pan = {
      x: viewCenterX(canvas) - (p.x + NODE_W / 2) * zoom,
      y: canvas.clientHeight / 2 - (p.y + NODE_H / 2) * zoom,
    };
    transform();
  }
  /** Horizontal centre of the canvas area not covered by the routes panel or the drawer. */
  function viewCenterX(canvas: HTMLElement): number {
    const rect = canvas.getBoundingClientRect();
    const routes = shell.querySelector<HTMLElement>('.routes.open');
    const drawer = shell.querySelector<HTMLElement>('.drawer.open');
    const wide = rect.width > 760;
    const left = wide && routes ? routes.getBoundingClientRect().right - rect.left : 0;
    const right = wide && drawer ? rect.right - drawer.getBoundingClientRect().left : 0;
    return left + (rect.width - left - right) / 2;
  }
  function jumpBranch(value: string): void {
    branch = value;
    collapsed.delete(value);
    render();
    if (!value) {
      fit();
      return;
    }
    const country = currentCountry();
    const canvas = shell.querySelector<HTMLElement>('.canvas');
    if (!country || !canvas) {
      return;
    }
    const points = Object.values(country.nodes)
      .filter((n) => n.branch === value)
      .map((n) => positions.get(n.id)!);
    if (!points.length) {
      return;
    }
    const left = Math.min(...points.map((p) => p.x));
    const top = Math.min(...points.map((p) => p.y)) - 50;
    const width = Math.max(...points.map((p) => p.x)) - left + NODE_W;
    const height = Math.max(...points.map((p) => p.y)) - top + NODE_H;
    zoom = Math.max(
      0.05,
      Math.min(1, (canvas.clientWidth - 80) / width, (canvas.clientHeight - 60) / height),
    );
    pan = { x: viewCenterX(canvas) - (left + width / 2) * zoom, y: 30 - top * zoom };
    transform();
  }
  function transform(): void {
    const tree = shell.querySelector<HTMLElement>('.tree');
    if (tree) {
      tree.style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
    }
    const label = shell.querySelector('.zoom-value');
    if (label) {
      label.textContent = `${zoom < 0.1 ? (zoom * 100).toFixed(1) : Math.round(zoom * 100)}%`;
    }
    const canvas = shell.querySelector<HTMLElement>('.canvas');
    const view = shell.querySelector<SVGRectElement>('.mm-view');
    if (canvas && view) {
      view.setAttribute('x', String(-pan.x / zoom));
      view.setAttribute('y', String(-pan.y / zoom));
      view.setAttribute('width', String(canvas.clientWidth / zoom));
      view.setAttribute('height', String(canvas.clientHeight / zoom));
    }
  }
  function zoomAt(next: number, x: number, y: number): void {
    const clamped = Math.max(0.02, Math.min(2, next));
    pan = { x: x - ((x - pan.x) * clamped) / zoom, y: y - ((y - pan.y) * clamped) / zoom };
    zoom = clamped;
    transform();
  }
  function fit(): void {
    const canvas = shell.querySelector<HTMLElement>('.canvas');
    if (canvas) {
      zoom = Math.max(
        0.02,
        Math.min(1, (canvas.clientWidth - 60) / treeSize.width, (canvas.clientHeight - 40) / treeSize.height),
      );
      pan = { x: viewCenterX(canvas) - (treeSize.width * zoom) / 2, y: 20 };
      transform();
    }
  }
  function bindMinimap(): void {
    const map = shell.querySelector<HTMLElement>('.minimap');
    const canvas = shell.querySelector<HTMLElement>('.canvas');
    if (!map || !canvas) {
      return;
    }
    let dragging = false;
    const move = (event: PointerEvent) => {
      const rect = map.getBoundingClientRect();
      const scale = Math.max(treeSize.width / rect.width, treeSize.height / rect.height);
      // SVG uses preserveAspectRatio xMidYMid meet: account for the letterbox offset.
      const offsetX = (rect.width - treeSize.width / scale) / 2;
      const offsetY = (rect.height - treeSize.height / scale) / 2;
      const x = (event.clientX - rect.left - offsetX) * scale;
      const y = (event.clientY - rect.top - offsetY) * scale;
      pan = { x: canvas.clientWidth / 2 - x * zoom, y: canvas.clientHeight / 2 - y * zoom };
      transform();
    };
    map.addEventListener('pointerdown', (event) => {
      dragging = true;
      map.setPointerCapture(event.pointerId);
      move(event);
    });
    map.addEventListener('pointermove', (event) => dragging && move(event));
    map.addEventListener('pointerup', () => {
      dragging = false;
    });
    map.addEventListener('pointercancel', () => {
      dragging = false;
    });
  }
  function bindCanvas(): void {
    const canvas = shell.querySelector<HTMLElement>('.canvas')!;
    // Focus or scrollIntoView can scroll overflow:hidden layers; the view is driven by pan/zoom only.
    for (const layer of [canvas, shell.querySelector<HTMLElement>('.stage')]) {
      layer?.addEventListener('scroll', () => {
        layer.scrollLeft = 0;
        layer.scrollTop = 0;
      });
    }
    const pointers = new Map<number, { x: number; y: number }>();
    let moved = false;
    let startNode = '';
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        zoomAt(zoom * Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
      },
      { passive: false },
    );
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target as Element).closest('.branch-summary')) {
        return;
      }
      moved = pointers.size > 0;
      startNode = (event.target as Element).closest<HTMLElement>('[data-node]')?.dataset.node ?? '';
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      const old = pointers.get(event.pointerId);
      if (!old) {
        return;
      }
      const next = { x: event.clientX, y: event.clientY };
      if (Math.hypot(next.x - old.x, next.y - old.y) > 2) {
        moved = true;
      }
      if (pointers.size === 1) {
        pan.x += next.x - old.x;
        pan.y += next.y - old.y;
      } else {
        const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)![1];
        const beforeDistance = Math.hypot(old.x - other.x, old.y - other.y);
        const afterDistance = Math.hypot(next.x - other.x, next.y - other.y);
        const rect = canvas.getBoundingClientRect();
        if (beforeDistance > 1) {
          zoomAt(
            (zoom * afterDistance) / beforeDistance,
            (other.x + old.x) / 2 - rect.left,
            (other.y + old.y) / 2 - rect.top,
          );
          pan.x += (next.x - old.x) / 2;
          pan.y += (next.y - old.y) / 2;
        }
      }
      pointers.set(event.pointerId, next);
      transform();
    });
    canvas.addEventListener('pointerup', (event) => {
      if (!pointers.has(event.pointerId)) {
        return;
      }
      pointers.delete(event.pointerId);
      canvas.releasePointerCapture(event.pointerId);
      if (!moved && startNode) {
        nodeId = startNode;
        openDetails();
        render();
      }
    });
    canvas.addEventListener('pointercancel', (event) => {
      pointers.delete(event.pointerId);
    });
    canvas.addEventListener('keydown', (event) => {
      if ((event.target as Element).closest('[data-node]')) {
        return;
      }
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [40, 0],
        ArrowRight: [-40, 0],
        ArrowUp: [0, 40],
        ArrowDown: [0, -40],
      };
      if (delta[event.key]) {
        event.preventDefault();
        pan.x += delta[event.key][0];
        pan.y += delta[event.key][1];
        transform();
      }
    });
  }
  function openModal(name: string, title: string, body: string, footer = ''): void {
    if (!modal) {
      previousFocus = root.activeElement as HTMLElement;
    }
    apiPanel?.dispose();
    apiPanel = undefined;
    sourcePanel?.dispose();
    sourcePanel = undefined;
    taskPanel?.dispose();
    taskPanel = undefined;
    modal = name;
    backdrop.hidden = false;
    backdrop.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header class="modal-header"><h2 id="modal-title">${escape(title)}</h2><span class="modal-jobs" role="status" hidden></span><button data-modal="close" aria-label="关闭对话框">×</button></header><div class="modal-body">${body}<div class="modal-error" role="alert"></div></div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section>`;
    backdrop.querySelector<HTMLButtonElement>('button')?.focus();
    updateModalJobs();
  }
  /** Windows cover the status line, so they show running tasks in their own header. */
  function updateModalJobs(): void {
    const pill = backdrop.querySelector<HTMLElement>('.modal-jobs');
    if (!pill) {
      return;
    }
    const summary = taskSummary();
    pill.hidden = !summary.state || modal === 'jobs';
    pill.className = `modal-jobs ${summary.state}`;
    pill.innerHTML = `${summary.state === 'busy' ? '<i class="spinner"></i>' : '<i class="status-dot failed"></i>'}${escape(summary.text.replace('，点此查看', ''))}`;
  }
  function closeModal(): void {
    removing = '';
    importing = null;
    treeNotice = '';
    apiPanel?.dispose();
    apiPanel = undefined;
    sourcePanel?.dispose();
    sourcePanel = undefined;
    taskPanel?.dispose();
    taskPanel = undefined;
    backdrop.hidden = true;
    backdrop.innerHTML = '';
    modal = '';
    previousFocus?.focus();
  }
  function importPanel(): string {
    if (!importing) {
      return '';
    }
    const existing = importing.entries.filter((entry) => controller.state?.countries[entry.tree.id]);
    const withStatus = importing.entries.some((entry) => entry.status);
    return `<div class="import-panel"><h4>准备汇入：${escape(importing.file)}</h4><ul>${importing.entries
      .map(
        (entry) =>
          `<li><strong>${escape(entry.tree.name)}</strong> <code>${escape(entry.tree.id)}</code> · ${entry.tree.nodes.length} 项国策 · ${new Set(entry.tree.nodes.map((n) => n.branch)).size} 支分支${entry.status ? ' · 含进度' : ''}${controller.state?.countries[entry.tree.id] ? ' · <span class="warn">将取代现有国家</span>' : ''}</li>`,
      )
      .join(
        '',
      )}</ul><label class="check"><input type="checkbox" data-import-progress ${withStatus ? '' : 'disabled'} ${checked(importing.withProgress && withStatus)}>连同进度<small>保留档案中的进度、能力与锁定；汇入后需执行「更新局势」从目前故事日校准。事件不汇入。</small></label>${existing.length ? `<label class="check"><input type="checkbox" data-import-replace ${checked(importing.replace)}>取代同 id 的国家（${existing.map((e) => escape(e.tree.name)).join('、')}）<small>原有的国策树与进度会先删除。</small></label>` : ''}<div class="tree-io-actions"><button class="primary" data-tree="import-confirm" ${existing.length && !importing.replace ? 'disabled' : ''}>确认汇入</button><button data-tree="import-cancel">取消</button></div></div>`;
  }
  function download(name: string, text: string): void {
    const link = doc.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    link.download = name;
    doc.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  function showCountries(focus = true): void {
    const countries = controller.state ? Object.values(controller.state.countries) : [];
    const busyJobs = controller.jobs.some((j) => ['running', 'queued'].includes(j.state));
    const identifying = controller.jobs.some(
      (j) => j.kind === 'identify' && ['running', 'queued'].includes(j.state),
    );
    const selectedCandidates = [
      ...backdrop.querySelectorAll<HTMLInputElement>('[data-candidate]:checked'),
    ].map((e) => e.dataset.candidate);
    const created = countries.length
      ? `<h3>已建立的国家</h3>${countries
          .map(
            (c) =>
              `<div class="candidate country-row"><strong class="country-name">${escape(c.name)}</strong>${periodControl(c)}<label class="switch-label"><input type="checkbox" data-enable="${escape(c.id)}" ${checked(c.enabled)}>启用</label>${c.control === 'player' ? `<label class="switch-label" title="故事时间一次跳过很多天时，由 AI 替这个国家接著选下一项国策"><input type="checkbox" data-delegate="${escape(c.id)}" ${checked(c.skipDelegate)}>时间跳跃时由 AI 代选</label>` : '<small class="muted">AI 演化</small>'}<span class="row-spacer"></span>${
                removing === c.id
                  ? `<div class="remove-confirm" role="alert"><small>删除「${escape(c.name)}」的国策树、进度与只涉及此国的事件？会写入目前楼层；之后可从候选清单重新生成。</small><button class="danger" data-remove-confirm="${escape(c.id)}">确认删除</button><button data-remove-cancel>取消</button></div>`
                  : `<button data-tree-export="${escape(c.id)}">汇出</button><button class="danger" data-remove-country="${escape(c.id)}" ${busyJobs ? 'disabled title="有任务进行中，请等任务结束后再删除"' : ''}>删除国策树</button>`
              }</div>`,
          )
          .join(
            '',
          )}${countries.some((c) => !c.enabled) ? '<small class="muted">重新启用后，下一次局势更新会先校准现况；停用期间不累积工期。</small>' : ''}<div class="separator"></div>`
      : '';
    const body = `${created}<h3>新增国家</h3><p class="muted">先从本局资料辨识国家，再勾选要生成国策树的对象。</p><button data-modal="identify" ${identifying ? 'disabled' : ''}>${identifying ? '正在辨识…' : '从目前资料辨识国家'}</button>${controller.candidates.map((c) => `<label class="candidate"><input type="checkbox" data-candidate="${escape(c.id)}" ${checked(selectedCandidates.includes(c.id))}><span><strong>${escape(c.name)}</strong><p>${escape(c.description)}</p><small>${escape(c.evidence)}</small></span></label>`).join('')}${!controller.candidates.length ? '<p class="muted">尚无待启用的候选国家。</p>' : ''}<div class="separator"></div><details class="tree-io" ${importing || treeNotice ? 'open' : ''}><summary>国策树档案：汇入与汇出</summary><div class="tree-io-actions"><button data-tree="import" title="载入手写、submod 或其他聊天汇出的国策树">汇入国策树</button><button data-tree="export-all" ${countries.length ? '' : 'disabled'} title="含完整进度，可用来备份或回报问题">汇出全部</button><button data-tree="copy-all" ${countries.length ? '' : 'disabled'}>复制全部 JSON</button><button data-tree="template">下载范本</button><input type="file" accept=".json,application/json" data-tree-file hidden></div>${treeNotice ? `<p class="api-status">${escape(treeNotice)}</p>` : ''}${importPanel()}</details>`;
    const footer = `<button data-modal="close">返回</button><button class="primary" data-modal="enable" ${selectedCandidates.length ? '' : 'disabled'}>生成并启用选取国家</button>`;
    if (!focus && modal === 'countries') {
      const section = backdrop.querySelector('.modal-body');
      if (section) {
        section.innerHTML = `${body}<div class="modal-error" role="alert"></div>`;
      }
      const foot = backdrop.querySelector('.modal-footer');
      if (foot) {
        foot.innerHTML = footer;
      }
    } else {
      openModal('countries', '管理国家', body, footer);
    }
  }
  function showJobs(): void {
    for (const job of controller.jobs) {
      if (job.state === 'failed') {
        failuresSeen.add(job.id);
      }
    }
    const busy = controller.jobs.some((j) => ['running', 'queued'].includes(j.state));
    const message = (j: (typeof controller.jobs)[number]) => {
      const text = jobMessage(j);
      return text.length > 140
        ? `<details class="job-detail"><summary>${escape(text.slice(0, 120))}…</summary><p>${escape(text)}</p></details>`
        : `<small class="job-message">${escape(text)}</small>`;
    };
    const rows = controller.jobs
      .map(
        (j) =>
          `<div class="job-log"><div><strong class="${j.state}">${jobStates[j.state]}</strong><br><small>${escape(j.time)}</small>${j.inputCharacters !== undefined ? `<br><small>请求 ${j.inputCharacters.toLocaleString()} 字元</small>` : ''}</div><div>${escape(jobNames[j.kind as keyof typeof jobNames] ?? j.kind)}${j.label ? ` · ${escape(j.label)}` : ''}${j.route ? ` · ${escape(j.route)}` : ''}<br>${message(j)}</div><div class="job-buttons">${['running', 'queued'].includes(j.state) ? `<button data-cancel="${j.id}">取消</button>` : ''}${j.state === 'failed' ? `<button data-retry="${j.id}">重试</button>` : ''}${controller.logs.some((log) => log.jobId === j.id) ? `<button data-log="${j.id}">请求纪录</button>` : ''}</div></div>`,
      )
      .join('');
    const body = `<div class="job-actions"><button data-modal="run-reshape" title="剧情大幅改变时，修改尚未开始的国策">评估重大改树</button><button class="danger" data-modal="cancel-all" ${busy ? '' : 'disabled'}>取消全部任务</button></div>${rows || '<p class="muted">尚无任务纪录。正文与一般变数更新完成后，国策任务会在背景执行，不会锁住聊天；进度显示在悬浮球上方。</p>'}${controller.config.runLog ? '<p class="muted">执行纪录已开启：请求内容只保存在此页记忆体，重新整理即清除。</p>' : ''}`;
    if (modal === 'jobs') {
      backdrop.querySelector('.modal-body')!.innerHTML = body;
    } else {
      openModal('jobs', '任务', body, '<button data-modal="close">返回</button>');
    }
  }
  function showLog(jobId: string): void {
    const entries = controller.logs.filter((log) => log.jobId === jobId).reverse();
    const block = (label: string, text: string, rows = 8) =>
      text
        ? `<details class="log-part"><summary>${escape(label)}</summary><div class="field"><textarea aria-label="${escape(label)}" readonly rows="${rows}">${escape(text)}</textarea></div></details>`
        : '';
    openModal(
      'log',
      '请求纪录',
      `<p class="muted">只供除错，不含 API 金钥。</p>${entries
        .map(
          (log) =>
            `<details class="job-card request-log"><summary class="job-title">${log.error ? '失败' : '格式通过'} · ${escape(jobNames[log.kind as keyof typeof jobNames] ?? log.kind)}${log.stage ? ` · ${escape(log.stage)}` : ''} · ${escape(log.route)} · 第 ${log.attempt} 次 · ${(log.durationMs / 1000).toFixed(1)} 秒 · ${escape(log.time)}</summary>${log.error ? `<p class="modal-error">${escape(log.error)}</p>` : '<p class="muted">✓ 格式通过</p>'}${log.messages
              .map((message, index) =>
                block(
                  `#${index + 1} ${message.role} · ${message.content.length.toLocaleString()} 字元`,
                  message.content,
                  6,
                ),
              )
              .join(
                '',
              )}${block('推理内容', log.reasoning, 6)}${block(`模型回应 · ${log.output.length.toLocaleString()} 字元`, log.output)}</details>`,
        )
        .join('')}`,
      '<button data-modal="jobs">返回任务</button>',
    );
  }
  type NewsEvent = State['events'][string];
  const newsKicker = (event: NewsEvent) =>
    event.source.kind === 'focus'
      ? '国策事件'
      : event.importance === 'world'
        ? '世界新闻'
        : event.scope === 'front'
          ? '身边的消息'
          : '各国动态';
  function newsEffects(state: State, event: NewsEvent): string {
    const parts = event.changes
      .filter((change) => change.effects.length)
      .map(
        (change) =>
          `${state.countries[change.country]?.name ?? change.country}：${change.effects.map(effectText).join('、')}`,
      );
    return parts.length ? parts.join('；') : '无直接影响';
  }
  /** Skeleton edition: the core branch, the relations between focuses and independent branches. */
  function showRelations(): void {
    const country = controller.state?.countries[countryId];
    if (!country) {
      return;
    }
    const core = country.branches.find((b) => b.core);
    const relations = country.relations ?? [];
    const branchOf = (id: string) => country.nodes[id]?.branch ?? '';
    const reached = [
      ...new Set(
        relations
          .filter((r) => core && [branchOf(r.from), branchOf(r.to)].includes(core.name))
          .map((r) => (branchOf(r.from) === core!.name ? branchOf(r.to) : branchOf(r.from)))
          .filter((name) => name !== core?.name),
      ),
    ];
    const focus = (id: string) =>
      `<button class="chip" data-goto="${escape(id)}">${escape(country.nodes[id]?.name ?? id)}</button><small class="rel-branch">${escape(branchOf(id))}</small>`;
    const independent = country.branches.filter((b) => b.independent);
    openModal(
      'relations',
      `国策关系 · ${country.name}`,
      `<p class="muted">国策之间如何互相影响；每条关系下方列出实现它的规则。点国策名称可在树上定位。</p>
      ${core ? `<section class="rel-core"><h3>核心分支：${escape(core.name)}</h3>${core.coreReason ? `<p>${escape(core.coreReason)}</p>` : ''}<small>影响的其他分支：${reached.length ? reached.map(escape).join('、') : '无'}</small></section>` : ''}
      ${relations.length ? `<ul class="rel-list">${relations.map((r) => `<li class="rel-card"><span class="tag">${escape(relationKindNames[r.kind] ?? r.kind)}</span><div class="rel-pair">${focus(r.from)}<span class="rel-arrow" title="关联；实际方向见下方规则">↔</span>${focus(r.to)}</div><p>${escape(r.change)}</p>${r.via.length ? `<ul class="rel-via">${r.via.map((v) => `<li>${escape(v)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ul>` : '<p>这棵国策树没有记录关系。较旧版本生成的树、小型树与汇入的树可能没有关系表。</p>'}
      ${independent.length ? `<section class="rel-independent"><h3>独立推进的分支</h3><dl>${independent.map((b) => `<dt>${escape(b.name)}</dt><dd>${escape(b.independent ?? '')}</dd>`).join('')}</dl></section>` : ''}`,
      '<button data-modal="close">返回</button>',
    );
  }
  function showEvents(): void {
    const state = controller.state;
    const all = state ? Object.values(state.events).sort((a, b) => b.at - a.at) : [];
    const events = all.filter(
      (e) =>
        (!eventCountry || e.countries.includes(eventCountry)) &&
        (eventFilter === 'all' ||
          (eventFilter === 'ongoing' && e.status === 'ongoing') ||
          (eventFilter === 'resolved' && e.status === 'resolved') ||
          (eventFilter === 'secret' && !e.public)),
    );
    const filters: [typeof eventFilter, string][] = [
      ['all', '全部'],
      ['ongoing', '进行中'],
      ['resolved', '已结束'],
      ['secret', '未公开'],
    ];
    const names = (e: (typeof all)[number]) =>
      e.countries.map((id) => state?.countries[id]?.name ?? id).join('、');
    const toolbar = `<div class="event-filters">${filters.map(([id, label]) => `<button class="chip ${eventFilter === id ? 'active' : ''}" data-event-filter="${id}" aria-pressed="${eventFilter === id}">${label}</button>`).join('')}<select data-event-country aria-label="依国家筛选"><option value="">所有国家</option>${Object.values(
      state?.countries ?? {},
    )
      .map(
        (c) =>
          `<option value="${escape(c.id)}" ${selected(c.id === eventCountry)}>${escape(c.name)}</option>`,
      )
      .join('')}</select><small>${events.length} / ${all.length} 件</small></div>`;
    const cards = events
      .map(
        (e) =>
          `<article class="event-card"><span class="tag">日序 ${e.at.toFixed(1)} · ${newsKicker(e)} · ${escape(names(e))}${e.public ? '' : ' · 未公开'}${e.status === 'ongoing' ? ' · 仍在发展' : e.result ? ` · ${resultNames[e.result]}` : ''}</span><h3>${escape(e.headline || e.title)}</h3><p>${escape(e.description)}</p>${e.current ? `<p class="event-current"><b>现况</b> ${escape(e.current)}</p>` : ''}${e.steps?.length ? `<ul class="event-steps">${e.steps.map((st) => `<li class="${st.state}">${escape(st.text)}${st.when ? ` <small>${escape(st.when)}</small>` : ''}</li>`).join('')}</ul>` : ''}${e.timeline.length > 1 ? `<ol class="event-timeline">${e.timeline.map((t) => `<li><b>${t.at.toFixed(1)}</b> ${escape(t.text)}</li>`).join('')}</ol>` : ''}${e.changes.some((c) => c.effects.length) && state ? `<small class="event-effects">效果：${escape(newsEffects(state, e))}</small>` : ''}<small>${escape(e.evidence)}</small></article>`,
      )
      .join('');
    const body = `${all.length ? toolbar : ''}${cards || `<p class="muted">${all.length ? '没有符合筛选的事件。' : '目前没有事件。局势更新会记录各国发生的事，包括未公开的。'}</p>`}`;
    if (modal === 'events') {
      backdrop.querySelector('.modal-body')!.innerHTML =
        `${body}<div class="modal-error" role="alert"></div>`;
    } else {
      openModal('events', '国家事件纪录', body, '<button data-modal="close">返回</button>');
    }
  }
  function optionList(values: [string, string][], value: string): string {
    return values
      .map(
        ([id, label]) => `<option value="${escape(id)}" ${selected(id === value)}>${escape(label)}</option>`,
      )
      .join('');
  }
  const settingsFooter =
    '<button data-modal="close">取消</button><button class="primary" data-modal="save-settings">储存设定</button>';
  /** Unsaved changes in the settings window (general, task and source forms; size and pace). */
  function settingsDirty(): boolean {
    if (modal !== 'settings') {
      return false;
    }
    readSettingsDraft();
    const size = backdrop.querySelector<HTMLSelectElement>('[data-setting="size"]')?.value;
    const pace = backdrop.querySelector<HTMLSelectElement>('[data-setting="pace"]')?.value;
    const state = controller.state;
    const same = (a: unknown, b: unknown) => {
      try {
        return (
          JSON.stringify(ConfigSchema.parse(structuredClone(a))) ===
          JSON.stringify(ConfigSchema.parse(structuredClone(b)))
        );
      } catch {
        return false;
      }
    };
    return (
      Boolean(apiPanel?.dirty()) ||
      !same(draft, controller.config) ||
      Boolean(state && ((size && size !== state.settings.size) || (pace && pace !== state.settings.pace)))
    );
  }
  /** Close a window; the settings window asks first when it has unsaved changes. */
  function requestClose(): void {
    if (settingsDirty()) {
      const footer = backdrop.querySelector('.modal-footer');
      if (footer) {
        footer.innerHTML =
          '<span class="unsaved">有未储存的修改</span><button data-modal="keep-editing">继续编辑</button><button class="danger" data-modal="discard">放弃修改</button><button class="primary" data-modal="save-settings">储存并关闭</button>';
        footer.querySelector<HTMLButtonElement>('[data-modal="keep-editing"]')?.focus();
      }
      return;
    }
    closeModal();
  }
  function renderSettings(taskState?: { selected?: JobKind; status?: string }): void {
    const state = controller.state;
    const tabs = [
      ['general', '一般'],
      ['apis', 'API 连线'],
      ['jobs', '任务'],
      ['sources', '世界书与上下文'],
    ];
    openModal(
      'settings',
      '国策设定',
      `<div class="tabs">${tabs.map(([id, name]) => `<button data-settings-tab="${id}" class="${settingsTab === id ? 'active' : ''}">${name}</button>`).join('')}</div>
      <div class="settings-section" ${settingsTab !== 'general' ? 'hidden' : ''}><div class="form-grid"><label class="field">每期规模<select data-setting="size">${optionList(
        [
          ['standard', '标准 · 每期 10–16 项'],
          ['large', '大型 · 每期 16–24 项'],
        ],
        state?.settings.size ?? 'standard',
      )}</select><small>含前期承接节点，只影响新生成与下一期；数量是篇幅目标，不强制凑数。</small></label><label class="field">故事节奏<select data-setting="pace">${optionList(
        [
          ['fast', '快速'],
          ['standard', '标准'],
          ['long', '长期'],
        ],
        state?.settings.pace ?? 'standard',
      )}</select><small>每期从起点走到终点的目标时间：快速约 2–3 个月、标准约 3–6 个月、长期约 6–9 个月；新国策工期为 7–35 天（一至五周）。只影响新生成与下一期，不改写既有工期。</small></label><label class="check wide"><input data-config="newsPrompt" type="checkbox" ${checked(draft.newsPrompt)}>正文提示加入近期国际大事<small>最多 5 则，附在国策资料后，让正文以公告、传闻或对话自然带出。</small></label><label class="field wide">国策资料提供给正文的方式<select data-config="promptMode"><option value="worldbook" ${draft.promptMode === 'worldbook' ? 'selected' : ''}>世界书条目（预设）</option><option value="inject" ${draft.promptMode === 'inject' ? 'selected' : ''}>直接注入</option></select><small>在当前角色的主世界书建立「国策档案-」条目，以 EJS 读取当前楼层资料。未设定角色主世界书或缺少提示词模板扩展时暂用直接注入，不会自动新建世界书。</small></label><label class="field wide">各国详情条目<select data-config="countryEntries"><option value="constant" ${draft.countryEntries === 'constant' ? 'selected' : ''}>蓝灯：每次都送出（预设）</option><option value="keyword" ${draft.countryEntries === 'keyword' ? 'selected' : ''}>绿灯：提到国名或关键字才送出</option></select><small>蓝灯让正文每次都看得到各国近况；绿灯较省篇幅。只影响正文看到什么，不影响国策推进。</small></label><label class="check wide"><input data-config="runLog" type="checkbox" ${checked(draft.runLog)}>保留执行纪录<small>在「任务」视窗查看最近 20 次请求的提示词与回应，只存在此页记忆体，除错后建议关闭。</small></label></div></div>
      <div class="settings-section" ${settingsTab !== 'apis' ? 'hidden' : ''}><div id="api-panel"></div></div>
      <div class="settings-section" ${settingsTab !== 'jobs' ? 'hidden' : ''}><div id="task-panel"></div></div>
      <div class="settings-section" ${settingsTab !== 'sources' ? 'hidden' : ''}><div id="source-panel"></div></div>`,
      settingsFooter,
    );
    apiPanel = mountApiPanel(controller, backdrop.querySelector<HTMLElement>('#api-panel')!, (update) => {
      readSettingsDraft();
      draft = update(draft);
      // Connection names may have changed: redraw the task routing selects from the draft.
      taskPanel?.refresh();
    });
    taskPanel = mountTaskPanel(
      controller,
      backdrop.querySelector<HTMLElement>('#task-panel')!,
      () => draft,
      (next, remount) => {
        draft = next;
        controller.saveSettings(draft);
        if (remount) {
          // A preset can replace worldbook/context settings too: rebuild every tab from the saved config.
          const kept = taskPanel?.state();
          draft = structuredClone(controller.config);
          renderSettings(kept);
        }
      },
      taskState,
      {
        setMode(kind, key, custom) {
          sourcePanel?.setMode(kind, key, custom);
        },
        edit(kind) {
          sourcePanel?.focus(kind);
          switchSettingsTab('sources');
        },
      },
    );
    sourcePanel = mountSourcePanel(
      controller,
      backdrop.querySelector<HTMLElement>('#source-panel')!,
      () => draft,
      (sources) => {
        draft.sources = sources;
      },
    );
  }
  function switchSettingsTab(id: string): void {
    readSettingsDraft();
    settingsTab = id;
    // Keep the form mounted so unsaved general settings survive tab switches.
    for (const section of backdrop.querySelectorAll<HTMLElement>('.settings-section')) {
      section.hidden =
        [...backdrop.querySelectorAll('.settings-section')].indexOf(section) !==
        ['general', 'apis', 'jobs', 'sources'].indexOf(settingsTab);
    }
    for (const tab of backdrop.querySelectorAll('[data-settings-tab]')) {
      tab.classList.toggle('active', (tab as HTMLElement).dataset.settingsTab === settingsTab);
    }
    backdrop.querySelector('.modal-body')?.scrollTo(0, 0);
  }
  function readSettingsDraft(): void {
    if (!backdrop.querySelector('[data-config="runLog"]')) {
      return;
    }
    draft.runLog =
      backdrop.querySelector<HTMLInputElement>('[data-config="runLog"]')?.checked ?? draft.runLog;
    draft.newsPrompt =
      backdrop.querySelector<HTMLInputElement>('[data-config="newsPrompt"]')?.checked ?? draft.newsPrompt;
    const countryEntries = backdrop.querySelector<HTMLSelectElement>('[data-config="countryEntries"]')?.value;
    if (countryEntries === 'constant' || countryEntries === 'keyword') {
      draft.countryEntries = countryEntries;
    }
    const promptMode = backdrop.querySelector<HTMLSelectElement>('[data-config="promptMode"]')?.value;
    if (promptMode === 'worldbook' || promptMode === 'inject') {
      draft.promptMode = promptMode;
    }
    taskPanel?.read();
    sourcePanel?.read();
  }
  const clickHandler = (event: Event) => {
    const target = (event.target as Element).closest<HTMLElement>('button');
    if (!target) {
      return;
    }
    if (target === orb) {
      if (orbDragged && (event as MouseEvent).detail !== 0) {
        orbDragged = false;
        return;
      }
      open = true;
      render();
      return;
    }
    if (target.dataset.node && (event as MouseEvent).detail === 0) {
      nodeId = target.dataset.node;
      openDetails();
      render();
      return;
    }
    if (target.dataset.country) {
      countryId = target.dataset.country;
      detailsOpen = false;
      nodeId = '';
      query = '';
      branch = '';
      collapsed.clear();
      centeredCountry = '';
      pan = { x: 30, y: 35 };
      render();
      return;
    }
    if (target.dataset.goto) {
      if (modal === 'relations') {
        closeModal();
      }
      nodeId = target.dataset.goto;
      openDetails();
      render();
      locateNode(nodeId);
      return;
    }
    if (target.dataset.jumpBranch) {
      jumpBranch(target.dataset.jumpBranch);
      return;
    }
    if (target.dataset.foldBranch) {
      const value = target.dataset.foldBranch;
      if (collapsed.has(value)) {
        collapsed.delete(value);
      } else {
        collapsed.add(value);
      }
      render();
      return;
    }
    const name = target.dataset.action;
    if (name) {
      void action(async () => {
        switch (name) {
          case 'period-history': {
            const country = currentCountry();
            if (country) {
              openModal(
                'period-history',
                '往期摘要',
                historyBody(country),
                '<button data-modal="close">返回</button>',
              );
            }
            break;
          }
          case 'close':
            open = false;
            render();
            break;
          case 'detail-close':
            detailsOpen = false;
            render();
            break;
          case 'routes':
            routesOpen = !routesOpen;
            render();
            break;
          case 'nation-more':
            nationMore = !nationMore;
            render();
            break;
          case 'open-current': {
            const country = currentCountry();
            if (country?.current) {
              nodeId = country.current;
              openDetails();
              render();
              locateNode(nodeId);
            }
            break;
          }
          case 'settings':
            draft = structuredClone(controller.config);
            renderSettings();
            break;
          case 'countries':
            showCountries();
            break;
          case 'jobs':
            showJobs();
            break;
          case 'events':
            showEvents();
            break;
          case 'relations':
            showRelations();
            break;
          case 'refresh':
            await controller.refresh();
            break;
          case 'update':
            await controller.run('update');
            break;
          case 'lock-ask':
            lockConfirm = nodeId;
            render();
            break;
          case 'lock-cancel':
            lockConfirm = '';
            render();
            break;
          case 'start':
            lockConfirm = '';
            await controller.mutate((state) => startFocus(state, countryId, nodeId), true);
            break;
          case 'pause':
            await controller.mutate((state) => pauseFocus(state, countryId), true);
            break;
          case 'switch':
            lockConfirm = '';
            await controller.mutate(
              (state) => startFocus(pauseFocus(state, countryId), countryId, nodeId),
              true,
            );
            break;
          case 'fit':
            fit();
            break;
          case 'locate-current': {
            const country = currentCountry();
            if (country?.current) {
              nodeId = country.current;
              render();
              locateNode(nodeId);
            }
            break;
          }
          case 'search-next': {
            const country = currentCountry();
            const matches = Object.values(country?.nodes ?? {}).filter((n) =>
              `${n.name} ${n.description}`.includes(query),
            );
            if (matches.length) {
              nodeId = matches[(matches.findIndex((n) => n.id === nodeId) + 1) % matches.length].id;
              branch = '';
              openDetails();
              render();
              locateNode(nodeId);
            }
            break;
          }
          case 'isolate': {
            const country = currentCountry();
            if (country) {
              const chosen = branch || country.nodes[nodeId]?.branch;
              for (const b of new Set(Object.values(country.nodes).map((n) => n.branch))) {
                if (b !== chosen) {
                  collapsed.add(b);
                }
              }
              jumpBranch(chosen);
            }
            break;
          }
          case 'expand-all':
            collapsed.clear();
            branch = '';
            render();
            fit();
            break;
          case 'zoom-in':
          case 'zoom-out': {
            const canvas = shell.querySelector<HTMLElement>('.canvas')!;
            zoomAt(
              zoom * (name === 'zoom-in' ? 1.2 : 1 / 1.2),
              canvas.clientWidth / 2,
              canvas.clientHeight / 2,
            );
            break;
          }
          case 'demo-days':
            await preview?.advance(7);
            break;
          case 'demo-period-crisis':
            await preview?.periodSample?.(false);
            break;
          case 'demo-period-complete':
            await preview?.periodSample?.(true);
            break;
          case 'demo-period-next':
            await preview?.nextPeriod?.();
            break;
          case 'demo-outcome':
            await preview?.outcome();
            break;
          case 'demo-news':
            await preview?.news();
            showEvents();
            break;
          case 'demo-reset':
            preview?.reset();
            break;
        }
      });
    }
  };
  root.addEventListener('click', clickHandler);
  // <details> toggles do not bubble; keep popovers open across re-renders.
  root.addEventListener(
    'toggle',
    (event) => {
      const pop = (event.target as HTMLElement).dataset?.pop;
      if (pop) {
        if ((event.target as HTMLDetailsElement).open) {
          openPops.add(pop);
        } else {
          openPops.delete(pop);
        }
      }
    },
    true,
  );
  root.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    if (target.id === 'focus-search') {
      query = target.value;
      const country = currentCountry();
      if (country && controller.state) {
        drawTree(country);
      }
    }
  });
  root.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.treeFile !== undefined) {
      const file = input.files?.[0];
      input.value = '';
      if (file) {
        void file
          .text()
          .then((text) => {
            let raw: unknown;
            try {
              raw = JSON.parse(text);
            } catch {
              throw new Error('档案不是有效的 JSON');
            }
            importing = { file: file.name, entries: parseTreeFile(raw), withProgress: false, replace: false };
            treeNotice = '';
            showCountries(false);
          })
          .catch((error) => {
            const element = backdrop.querySelector('.modal-error');
            if (element) {
              element.textContent = `汇入失败：${error instanceof Error ? error.message : String(error)}`;
            }
          });
      }
      return;
    }
    if (input.dataset.importProgress !== undefined && importing) {
      importing.withProgress = input.checked;
      return;
    }
    if (input.dataset.importReplace !== undefined && importing) {
      importing.replace = input.checked;
      showCountries(false);
      return;
    }
    if (input.id === 'country-picker') {
      if (input.value === '__manage') {
        input.value = countryId;
        showCountries();
      } else {
        countryId = input.value;
        nodeId = '';
        query = '';
        branch = '';
        collapsed.clear();
        centeredCountry = '';
        detailsOpen = false;
        render();
      }
    }
    if (input.dataset.eventCountry !== undefined) {
      eventCountry = input.value;
      showEvents();
      return;
    }
    if (input.dataset.candidate !== undefined) {
      const enable = backdrop.querySelector<HTMLButtonElement>('[data-modal="enable"]');
      if (enable) {
        enable.disabled = !backdrop.querySelector('[data-candidate]:checked');
      }
      return;
    }
    if (input.id === 'country-control') {
      void action(() =>
        controller.mutate(
          (state) => changeCountry(state, countryId, { control: input.value as 'ai' | 'player' }),
          true,
        ),
      );
    }
    if (input.dataset.periodAuto) {
      void action(() =>
        controller.mutate((state) =>
          changeCountry(state, input.dataset.periodAuto!, { autoPeriod: input.checked }),
        ),
      );
      return;
    }
    for (const key of ['enable', 'delegate'] as const) {
      const id = input.dataset[key];
      if (id) {
        void action(() =>
          controller.mutate((state) => {
            return changeCountry(
              state,
              id,
              key === 'enable' ? { enabled: input.checked } : { skipDelegate: input.checked },
            );
          }, true),
        );
      }
    }
  });
  backdrop.addEventListener('click', (event) => {
    const target = (event.target as Element).closest<HTMLElement>('button');
    if (!target) {
      return;
    }
    void (async () => {
      try {
        if (target.dataset.treeExport) {
          const id = target.dataset.treeExport;
          download(
            `国策树-${controller.state!.countries[id].name}-${stamp()}.json`,
            exportTrees(controller.state!, [id]),
          );
          return;
        }
        switch (target.dataset.tree) {
          case 'import':
            backdrop.querySelector<HTMLInputElement>('[data-tree-file]')?.click();
            return;
          case 'export-all':
            download(`国策树-全部-${stamp()}.json`, exportTrees(controller.state!));
            return;
          case 'copy-all': {
            const text = exportTrees(controller.state!);
            try {
              await navigator.clipboard.writeText(text);
              treeNotice = `已复制 ${text.length.toLocaleString()} 字元的 JSON。`;
            } catch {
              throw new Error('浏览器不允许复制到剪贴簿，请改用「汇出全部」下载档案。');
            }
            showCountries(false);
            return;
          }
          case 'template':
            download('国策树范本.json', treeTemplate());
            return;
          case 'import-cancel':
            importing = null;
            showCountries(false);
            return;
          case 'import-confirm': {
            const pending = importing!;
            await controller.importTrees(pending.entries, {
              withProgress: pending.withProgress && pending.entries.some((entry) => entry.status),
              replace: pending.replace,
            });
            importing = null;
            treeNotice = `已汇入 ${pending.entries.map((entry) => `「${entry.tree.name}」`).join('、')}。${pending.withProgress ? '请执行「更新局势」校准进度。' : ''}`;
            countryId = pending.entries[0].tree.id;
            nodeId = '';
            centeredCountry = '';
            showCountries(false);
            return;
          }
        }
        if (target.dataset.removeCountry !== undefined) {
          removing = target.dataset.removeCountry;
          showCountries(false);
          return;
        }
        if (target.dataset.removeCancel !== undefined) {
          removing = '';
          showCountries(false);
          return;
        }
        if (target.dataset.removeConfirm) {
          const id = target.dataset.removeConfirm;
          removing = '';
          await controller.removeCountry(id);
          if (countryId === id) {
            countryId = '';
            nodeId = '';
            detailsOpen = false;
          }
          showCountries(false);
          return;
        }
        if (target.dataset.cancel) {
          controller.cancel(target.dataset.cancel);
          return;
        }
        if (target.dataset.log) {
          showLog(target.dataset.log);
          return;
        }
        if (target.dataset.settingsTab) {
          switchSettingsTab(target.dataset.settingsTab);
          return;
        }
        if (target.dataset.retry) {
          const job = controller.jobs.find((j) => j.id === target.dataset.retry);
          if (job) {
            await controller.run(job.kind as JobKind, job.candidate, job.periodWork);
          }
          return;
        }
        if (target.dataset.eventFilter) {
          eventFilter = target.dataset.eventFilter as typeof eventFilter;
          showEvents();
          return;
        }
        switch (target.dataset.modal) {
          case 'close':
            requestClose();
            break;
          case 'keep-editing': {
            const footer = backdrop.querySelector('.modal-footer');
            if (footer) {
              footer.innerHTML = settingsFooter;
            }
            break;
          }
          case 'discard':
            closeModal();
            break;
          case 'jobs':
            showJobs();
            break;
          case 'identify':
            await controller.run('identify');
            break;
          case 'enable': {
            const ids = [...backdrop.querySelectorAll<HTMLInputElement>('[data-candidate]:checked')].map(
              (e) => e.dataset.candidate,
            );
            const candidates = controller.candidates.filter((c) => ids.includes(c.id));
            if (!candidates.length) {
              throw new Error('请先勾选候选国家');
            }
            closeModal();
            await controller.enable(candidates);
            break;
          }
          case 'run-update':
            await controller.run('update');
            break;
          case 'run-reshape':
            await controller.run('reshape');
            break;
          case 'cancel-all':
            controller.cancelAll();
            break;
          case 'save-settings': {
            readSettingsDraft();
            const size = backdrop.querySelector<HTMLSelectElement>('[data-setting="size"]')!.value as
              | 'standard'
              | 'large';
            const pace = backdrop.querySelector<HTMLSelectElement>('[data-setting="pace"]')!.value as
              | 'fast'
              | 'standard'
              | 'long';
            try {
              // The API tab's preset edits first: they rename presets the task routes may use.
              apiPanel?.commit();
            } catch (error) {
              switchSettingsTab('apis');
              throw error;
            }
            // The retired task-level strict JSON switch: the API tab named it once; now clear it.
            for (const kind of jobKinds) {
              draft.jobs[kind].strictJson = false;
            }
            controller.saveSettings(draft);
            await controller.refresh();
            if (
              controller.state &&
              (controller.state.settings.size !== size || controller.state.settings.pace !== pace)
            ) {
              await controller.mutate((state) => {
                Object.assign(state.settings, { size, pace });
                state.revision++;
                return state;
              });
            }
            closeModal();
            break;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const element = backdrop.querySelector('.modal-error');
        if (element) {
          element.textContent = message;
        } else {
          controller.report(error);
        }
      }
    })();
  });
  root.addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent;
    if (key.key === 'Escape') {
      if (modal) {
        requestClose();
      } else if (detailsOpen) {
        detailsOpen = false;
        render();
      } else {
        open = false;
        render();
      }
    }
    if (key.key === 'Tab' && modal) {
      const focusable = [
        ...backdrop.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)',
        ),
      ].filter((e) => !e.closest('[hidden]'));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (key.shiftKey && root.activeElement === first) {
        key.preventDefault();
        last?.focus();
      }
      if (!key.shiftKey && root.activeElement === last) {
        key.preventDefault();
        first?.focus();
      }
    }
  });
  unsub = controller.subscribe(() => {
    render(true);
  });
  // The newspaper bar in the chat opens the panel or its event log.
  const stopNews =
    controller.platform.onNewsRequest?.((_messageId, action) => {
      if (modal) {
        closeModal();
      }
      open = true;
      render();
      if (action === 'events') {
        showEvents();
      }
    }) ?? (() => {});
  render();
  return () => {
    unsub();
    apiPanel?.dispose();
    apiPanel = undefined;
    sourcePanel?.dispose();
    sourcePanel = undefined;
    taskPanel?.dispose();
    taskPanel = undefined;
    hud.dispose();
    stopNews();
    view.removeEventListener('resize', onResize);
    host.remove();
  };
}
