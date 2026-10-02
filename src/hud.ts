import type { JobStatus } from './platform';
import type { FocusController } from './workflow';

const escape = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** How long a finished task stays in the window (ms). Failures stay longer so they can be read. */
const linger: Record<JobStatus['state'], number> = {
  queued: Infinity,
  running: Infinity,
  success: 6000,
  cancelled: 6000,
  failed: 20000,
};
const symbols: Record<JobStatus['state'], string> = {
  queued: '<i class="hud-sym wait">…</i>',
  // v0.15.4: static marks; the running time already shows the task is alive.
  running: '<i class="hud-sym run">●</i>',
  success: '<i class="hud-sym ok">✓</i>',
  failed: '<i class="hud-sym bad">!</i>',
  cancelled: '<i class="hud-sym off">–</i>',
};
const HUD_WIDTH = 320;
const GAP = 10;
const EDGE = 8;

export type HudOptions = {
  root: ShadowRoot;
  doc: Document;
  controller: FocusController;
  names: Record<string, string>;
  /** Message shown for a job. */
  message: (job: JobStatus) => string;
  /** Orb box in viewport coordinates. */
  anchor: () => { left: number; top: number; size: number };
  /** Begin dragging the orb from a pointer on the window header. */
  drag: (event: PointerEvent, handle: HTMLElement) => void;
  openLog: () => void;
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
};

/** Minutes and seconds, e.g. 1:05; shared with the panel's status line. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Small progress window after Workflow Assistant's task HUD. It sits above the floating orb
 * (not in a corner, so both scripts can run together) and follows the orb when it is dragged.
 */
export function mountHud(options: HudOptions) {
  const { root, doc, controller } = options;
  const hud = doc.createElement('section');
  hud.className = 'hud';
  hud.hidden = true;
  hud.setAttribute('role', 'status');
  hud.setAttribute('aria-label', '国策任务进度');
  hud.innerHTML = `<header class="hud-head" title="拖动可移动悬浮球与本窗口"><i class="status-dot"></i><strong>国策任务</strong><span class="hud-count"></span><span class="hud-actions"><button data-hud="stop" class="danger" title="取消全部执行中与排队的任务">停止</button><button data-hud="log" title="开启任务记录">记录</button><button data-hud="collapse" class="icon" aria-label="收合"></button><button data-hud="dismiss" class="icon" aria-label="关闭已完成项目" title="关闭已完成项目">×</button></span></header><div class="hud-bar"><i></i></div><ul class="hud-list"></ul>`;
  root.append(hud);
  const head = hud.querySelector<HTMLElement>('.hud-head')!;
  const count = hud.querySelector<HTMLElement>('.hud-count')!;
  const dot = hud.querySelector<HTMLElement>('.status-dot')!;
  const bar = hud.querySelector<HTMLElement>('.hud-bar')!;
  const fill = bar.querySelector<HTMLElement>('i')!;
  const list = hud.querySelector<HTMLElement>('.hud-list')!;
  const button = (name: string) => hud.querySelector<HTMLButtonElement>(`[data-hud="${name}"]`)!;
  const dismissed = new Set<string>();
  let collapsed = options.collapsed;
  /** The panel shows task status in its own status line while it is open. */
  let suppressed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Jobs and states of the drawn list; the list is redrawn only when they change. */
  let drawn = '';
  let drawnIds = new Set<string>();
  const view = doc.defaultView!;

  function visibleJobs(now: number): JobStatus[] {
    return controller.jobs.filter((job) => {
      if (dismissed.has(job.id)) {
        return false;
      }
      if (job.state === 'queued' || job.state === 'running') {
        return true;
      }
      // Jobs without a finish time come from before this window existed: never show them.
      return job.finished !== undefined && now - job.finished < linger[job.state];
    });
  }

  function place(): void {
    if (hud.hidden) {
      return;
    }
    const width = doc.documentElement.clientWidth;
    const height = doc.documentElement.clientHeight;
    const orb = options.anchor();
    const boxWidth = Math.min(HUD_WIDTH, width - EDGE * 2);
    hud.style.width = `${boxWidth}px`;
    // Align to the orb edge on the side of the screen it sits on.
    const left = orb.left + orb.size / 2 > width / 2 ? orb.left + orb.size - boxWidth : orb.left;
    hud.style.left = `${Math.max(EDGE, Math.min(width - boxWidth - EDGE, left))}px`;
    const above = orb.top - GAP - EDGE;
    const below = height - (orb.top + orb.size + GAP) - EDGE;
    if (above >= Math.min(hud.scrollHeight, 220) || above >= below) {
      hud.style.top = 'auto';
      hud.style.bottom = `${height - orb.top + GAP}px`;
      hud.style.maxHeight = `${Math.max(80, above)}px`;
      hud.dataset.side = 'above';
    } else {
      hud.style.bottom = 'auto';
      hud.style.top = `${orb.top + orb.size + GAP}px`;
      hud.style.maxHeight = `${Math.max(80, below)}px`;
      hud.dataset.side = 'below';
    }
  }

  function update(): void {
    const now = Date.now();
    const jobs = visibleJobs(now);
    if (!jobs.length || suppressed) {
      hud.hidden = true;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      return;
    }
    const running = jobs.filter((job) => job.state === 'running').length;
    const queued = jobs.filter((job) => job.state === 'queued').length;
    const failed = jobs.filter((job) => job.state === 'failed').length;
    const active = running + queued;
    const finished = jobs.length - active;
    count.textContent = active
      ? [running && `${running} 执行中`, queued && `${queued} 排队`].filter(Boolean).join(' · ')
      : failed
        ? `${failed} 项失败`
        : '已完成';
    dot.className = `status-dot ${active ? 'busy' : failed ? 'failed' : 'done'}`;
    button('stop').hidden = !active;
    button('dismiss').hidden = Boolean(active);
    const collapse = button('collapse');
    collapse.textContent = collapsed ? '▴' : '▾';
    collapse.setAttribute('aria-label', collapsed ? '展开' : '收合');
    collapse.title = collapsed ? '展开清单' : '收合清单';
    hud.classList.toggle('collapsed', collapsed);
    // Progress of a batch only; a single task shows its time instead (no moving bar).
    bar.hidden = jobs.length < 2;
    fill.style.width = `${Math.round((finished / jobs.length) * 100)}%`;
    list.hidden = collapsed;
    const time = (job: JobStatus) =>
      job.state === 'running' && job.started
        ? elapsed(now - job.started)
        : job.started && job.finished
          ? elapsed(job.finished - job.started)
          : '';
    const detail = (job: JobStatus) => {
      const text = options.message(job);
      return `${text}${job.route && job.state === 'success' ? ` · ${job.route}` : ''}`;
    };
    const signature = jobs.map((job) => `${job.id}:${job.state}`).join('|');
    if (signature !== drawn) {
      // Redraw when tasks come, go or change state; only new rows slide in.
      list.innerHTML = jobs
        .map((job) => {
          const name = options.names[job.kind] ?? job.kind;
          return `<li class="hud-item ${job.state} ${drawnIds.has(job.id) ? '' : 'enter'}" data-job="${escape(job.id)}">${symbols[job.state]}<div class="hud-text"><b>${escape(name)}${job.label ? ` · ${escape(job.label)}` : ''}</b><small title="${escape(detail(job))}">${escape(detail(job))}</small></div><time>${time(job)}</time>${job.state !== 'queued' && job.state !== 'running' ? `<button class="icon" data-hud-dismiss="${escape(job.id)}" aria-label="关闭此项">×</button>` : ''}</li>`;
        })
        .join('');
      drawn = signature;
      drawnIds = new Set(jobs.map((job) => job.id));
    } else {
      // Every second: change only the texts, so nothing moves.
      for (const job of jobs) {
        const row = list.querySelector<HTMLElement>(`[data-job="${CSS.escape(job.id)}"]`);
        if (!row) {
          continue;
        }
        const clock = row.querySelector('time')!;
        const value = time(job);
        if (clock.textContent !== value) {
          clock.textContent = value;
        }
        const small = row.querySelector('small')!;
        const text = detail(job);
        if (small.textContent !== text) {
          small.textContent = text;
          small.title = text;
        }
      }
    }
    const wasHidden = hud.hidden;
    hud.hidden = false;
    place();
    if (wasHidden) {
      hud.classList.remove('enter');
      void hud.offsetWidth;
      hud.classList.add('enter');
    }
    if (timer === undefined) {
      timer = setInterval(update, 1000);
    }
  }

  const click = (event: Event) => {
    const target = (event.target as Element).closest<HTMLElement>('button');
    if (!target) {
      return;
    }
    if (target.dataset.hudDismiss) {
      dismissed.add(target.dataset.hudDismiss);
      update();
      return;
    }
    switch (target.dataset.hud) {
      case 'stop':
        controller.cancelAll();
        break;
      case 'log':
        options.openLog();
        break;
      case 'collapse':
        collapsed = !collapsed;
        options.onCollapse(collapsed);
        update();
        break;
      case 'dismiss':
        for (const job of controller.jobs) {
          if (job.state !== 'queued' && job.state !== 'running') {
            dismissed.add(job.id);
          }
        }
        update();
        break;
    }
  };
  const pointerdown = (event: PointerEvent) => {
    if ((event.target as Element).closest('button') || event.button !== 0) {
      return;
    }
    options.drag(event, head);
  };
  hud.addEventListener('click', click);
  head.addEventListener('pointerdown', pointerdown);
  view.addEventListener('resize', place);
  return {
    update,
    place,
    suppress(value: boolean) {
      if (suppressed !== value) {
        suppressed = value;
        update();
      }
    },
    element: hud,
    dispose() {
      if (timer !== undefined) {
        clearInterval(timer);
      }
      view.removeEventListener('resize', place);
      hud.remove();
    },
  };
}
