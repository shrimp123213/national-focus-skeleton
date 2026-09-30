import {
  ConfigSchema,
  jobKinds,
  PromptItemSchema,
  type Config,
  type JobKind,
  type PromptItem,
} from './model';
import { defaultPromptText, isModified, newPromptId, promptText } from './prompts';
import { currentApiName } from './api-config';
import { placeholders } from './sources';
import {
  applyTaskPreset,
  deleteTaskPreset,
  exportTaskPresets,
  importTaskPresets,
  saveTaskPreset,
} from './task-presets';
import type { FocusController } from './workflow';

const escape = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const taskNames: Record<JobKind, string> = {
  identify: '辨識國家',
  generate: '生成國策樹',
  update: '局勢更新',
  reshape: '重大改樹',
};
const taskHints: Record<JobKind, string> = {
  identify: '從世界書與正文列出候選國家。手動執行。',
  generate: '為勾選的國家生成國策樹，全部通過驗證才保存。',
  update: '正文完成後依排程推進各國局勢、選策與事件。',
  reshape: '劇情大幅改變時修改尚未開始的國策。',
};
const kindLabels: Record<PromptItem['kind'], string> = {
  guide: '內建',
  task: '內建',
  data: '資料',
  custom: '自訂',
};
const selectedAttr = (value: boolean) => (value ? 'selected' : '');
/** The settings window links the task editor to the 世界書與上下文 tab through these. */
export type TaskSourceHooks = {
  /** Switch a task between the default sources and its own copy. */
  setMode(kind: JobKind, key: 'worldbook' | 'context', custom: boolean): void;
  /** Open the 世界書與上下文 tab on this task's own settings. */
  edit(kind: JobKind): void;
};

/**
 * The 任務 settings tab, after Workflow Assistant: task presets at the top, one editor per
 * task with API routing, run settings and an ordered, editable prompt chain.
 */
export function mountTaskPanel(
  controller: FocusController,
  host: HTMLElement,
  getDraft: () => Config,
  persist: (next: Config, remount: boolean) => void,
  initial: { selected?: JobKind; status?: string } = {},
  hooks?: TaskSourceHooks,
) {
  let selected: JobKind = initial.selected ?? 'update';
  const expanded = new Set<string>();
  const previews = new Map<JobKind, string>();
  let status = initial.status ?? '';
  let confirmDelete = false;
  let disposed = false;

  const options = (values: [string, string][], value: string) =>
    values
      .map(
        ([id, label]) =>
          `<option value="${escape(id)}" ${selectedAttr(id === value)}>${escape(label)}</option>`,
      )
      .join('');

  /** When this task last ran on the current floor's save, from the schedule record and recent jobs. */
  function lastRun(kind: JobKind): string {
    const job = controller.jobs.find(
      (item) => item.kind === kind && !['running', 'queued'].includes(item.state),
    );
    const running = controller.jobs.some(
      (item) => item.kind === kind && ['running', 'queued'].includes(item.state),
    );
    const saved = controller.state?.schedules[kind];
    const text = running
      ? '執行中'
      : job
        ? `上次：${job.state === 'success' ? '成功' : job.state === 'failed' ? '失敗' : '已取消'} · ${job.time}`
        : saved
          ? `上次成功：第 ${saved.turn} 則正文 · 故事日 ${Math.floor(saved.day)}`
          : '尚未執行';
    return `<small class="last-run">${escape(text)}</small>`;
  }
  const promptCount = (items: PromptItem[]) =>
    `${items.length} 段 · 送出 ${items.filter((item) => item.enabled || item.kind === 'data').length} 段`;
  function promptCard(kind: JobKind, item: PromptItem, index: number, count: number): string {
    const key = `${kind}:${item.id}`;
    const open = expanded.has(key);
    const text = promptText(item, kind);
    const modified = isModified(item);
    const badge =
      item.kind === 'custom' ? '自訂' : modified ? `${kindLabels[item.kind]}·已修改` : kindLabels[item.kind];
    return `<div class="prompt-card ${item.enabled || item.kind === 'data' ? '' : 'off'} ${open ? 'open' : ''}" data-prompt-row data-id="${escape(item.id)}" data-kind="${item.kind}">
      <div class="prompt-head"><button class="prompt-toggle" data-task-action="toggle" aria-expanded="${open}"><span class="chev">▸</span><span class="pname">${escape(item.name || '未命名段')}</span><span class="role-tag">${item.role}</span><span class="kind-tag ${item.kind} ${modified ? 'modified' : ''}">${badge}</span><span class="pchars">${text.length.toLocaleString()} 字</span></button>
      <label class="switch" title="${item.kind === 'data' ? '任務資料必須送出' : '啟用本段'}"><input type="checkbox" data-p="enabled" ${item.enabled || item.kind === 'data' ? 'checked' : ''} ${item.kind === 'data' ? 'disabled' : ''}><span>啟用</span></label>
      <button class="icon" data-task-action="up" ${index === 0 ? 'disabled' : ''} aria-label="上移" title="上移">↑</button><button class="icon" data-task-action="down" ${index === count - 1 ? 'disabled' : ''} aria-label="下移" title="下移">↓</button></div>
      <div class="prompt-body" ${open ? '' : 'hidden'}><div class="prompt-fields"><input data-p="name" value="${escape(item.name)}" placeholder="段落名稱" aria-label="段落名稱"><select data-p="role" aria-label="角色">${options(
        [
          ['system', 'system'],
          ['user', 'user'],
          ['assistant', 'assistant'],
        ],
        item.role,
      )}</select>${modified ? '<button data-task-action="restore">還原預設內容</button>' : ''}${item.kind === 'custom' ? '<button class="danger" data-task-action="delete">刪除</button>' : ''}</div>
      <textarea data-p="content" rows="${Math.min(18, Math.max(4, text.split('\n').length + 1))}" aria-label="段落內容">${escape(text)}</textarea>
      </div></div>`;
  }

  function generationNote(): string {
    return '<p class="muted wide">分期版每國一次生成當期內容，換期時同次產生新樹與舊期摘要。每期規模在「一般」設定；本任務的 API、重試與逾時也用於換期。</p>';
  }
  /** Compare the recommended model with the primary connection's model. */
  function modelNote(kind: JobKind, config: Config): string {
    const job = config.jobs[kind];
    if (!job.recommendedModel) {
      return '';
    }
    const name = job.api || currentApiName(config, controller.platform.chatId());
    const model = config.apis.find((api) => api.name === name)?.model ?? '';
    const same = Boolean(model) && model.toLowerCase().includes(job.recommendedModel.toLowerCase());
    return `<small class="block-note ${same ? '' : 'model-hint'}">建議模型：${escape(job.recommendedModel)}；${model ? `主要連線「${escape(name)}」目前是 ${escape(model)}。` : `主要連線「${escape(name)}」沿用酒館目前的模型，請自行確認。`}</small>`;
  }
  function sourcesBlock(kind: JobKind, config: Config): string {
    if (!hooks) {
      return '';
    }
    const override = config.sources.overrides[kind];
    const mode = (key: 'worldbook' | 'context') =>
      `<select data-source-mode="${key}">${options(
        [
          ['inherit', '沿用預設'],
          ['custom', '此任務自訂'],
        ],
        override?.[key] ? 'custom' : 'inherit',
      )}</select>`;
    const custom = Boolean(override?.worldbook || override?.context);
    return `<details class="task-block" open><summary>世界書與上下文</summary><div class="source-modes"><label class="field">劇情世界書與條目${mode('worldbook')}</label><label class="field">上下文與提取規則${mode('context')}</label><button data-task-action="edit-sources">${custom ? '編輯此任務的設定' : '檢視預設設定'}</button></div><small class="block-note">改成「此任務自訂」時，會先複製目前的預設，再到「世界書與上下文」分頁修改；改回「沿用預設」會刪除此任務的自訂設定。</small></details>`;
  }

  function editor(kind: JobKind, config: Config): string {
    const job = config.jobs[kind];
    const apis: [string, string][] = [
      ['', '跟隨目前聊天預設'],
      ...config.apis.map((a) => [a.name, a.name] as [string, string]),
    ];
    const fallbackRows = job.fallback
      .map(
        (name, index) =>
          `<div class="route-row" data-fb-row><label class="field">備援 ${index + 1}<select data-fb-name>${options(
            config.apis.map((a) => [a.name, a.name] as [string, string]),
            name,
          )}</select></label><label class="field cap">此連線同時請求數<input type="number" min="0" max="16" data-fb-cap value="${job.fallbackMaxConcurrencies[index] ?? 0}"></label><button class="danger" data-task-action="fb-del" data-index="${index}">刪除</button></div>`,
      )
      .join('');
    return `<section class="task-editor" data-task-editor="${kind}" ${kind === selected ? '' : 'hidden'}>
      <div class="task-head"><h3>${taskNames[kind]}</h3><small>${taskHints[kind]}</small><span class="spacer"></span>${lastRun(kind)}${kind === 'generate' ? '' : `<button data-task-action="run-now" title="用目前儲存的設定立即執行一次">立即執行</button>`}</div>
      <details class="task-block" open><summary>API 路由</summary>
        <div class="route-row"><label class="field">主要連線<select data-t="api">${options(apis, job.api)}</select></label><label class="field cap">此連線同時請求數<input type="number" min="0" max="16" data-t="primaryMaxConcurrency" value="${job.primaryMaxConcurrency}"></label></div>
        <div data-fallbacks>${fallbackRows}</div>
        <button data-task-action="fb-add" ${config.apis.length ? '' : 'disabled'}>＋ 新增備援</button>
        <small class="block-note">失敗時依序改用備援。「此連線同時請求數」只限制這項任務在該連線上同時送出的請求，0 為不限；主要連線滿載時直接改用有空位的備援。生成國策樹與換期只受此處限制；其他任務另受「一般 › 其他任務同時執行數」限制。</small>
        <div data-model-note>${modelNote(kind, config)}</div>
      </details>
      <details class="task-block" open><summary>執行設定</summary><div class="form-grid">
        ${
          kind === 'generate'
            ? '<div class="field"><span>觸發方式</span><p class="static">在「管理國家」勾選國家並按「生成並啟用」時執行。</p></div>'
            : `<label class="field">觸發方式<select data-t="schedule">${options(
                [
                  ['reply', '每則正文完成後'],
                  ['rounds', '每 N 則正文'],
                  ['days', '每 N 故事日'],
                  ['manual', '只手動執行'],
                ],
                job.schedule,
              )}</select></label>`
        }
        <label class="field" data-interval ${kind !== 'generate' && ['rounds', 'days'].includes(job.schedule) ? '' : 'hidden'}>${job.schedule === 'days' ? '間隔（故事日）' : '間隔（則正文）'}<input type="number" min="1" max="1000" data-t="interval" value="${job.interval}"></label>
        <small class="wide" data-days-note ${kind !== 'generate' && job.schedule === 'days' ? '' : 'hidden'}>故事日取自「世界書與上下文 › 故事時間路徑」。讀不到時間時，國策進度無法計算，所有任務（包括此項）都不執行，面板顯示原因與路徑；時間恢復後，下一則正文照常判斷間隔。</small>
        ${kind === 'generate' ? generationNote() : ''}
        <label class="field">每條連線重試次數<input type="number" min="0" max="10" data-t="retries" value="${job.retries}"><small>失敗原因會回饋給模型再試（0–10）。</small></label>
        <label class="field">逾時秒數<input type="number" min="10" max="600" data-t="timeout" value="${job.timeout}"></label>
        <label class="field wide">建議模型<input data-t="recommendedModel" maxlength="200" value="${escape(job.recommendedModel)}" placeholder="例如 deepseek-chat；只是備註，不影響連線"><small>隨任務預設保存，分享預設時讓對方知道這組提示詞適合哪個模型。</small></label>
      </div></details>
      ${sourcesBlock(kind, config)}
      <section class="task-block prompts-block"><div class="prompt-toolbar"><h4>提示詞串</h4><small>${promptCount(job.prompts)}</small><span class="spacer"></span><button data-task-action="expand-all">全部展開</button><button data-task-action="collapse-all">全部收合</button><button data-task-action="preview">預覽完整提示詞串</button></div>
        <p class="muted">依順序送出。內建段改動後不再跟隨新版預設，按「還原預設內容」或清空即可恢復；「任務資料」的 {{data}} 會換成本次任務的 JSON，不能停用。自訂段可以使用下方的佔位符與酒館巨集。</p>
        <details class="legend"><summary>佔位符說明</summary><ul>${Object.entries(placeholders)
          .map(([code, label]) => `<li><code>${code}</code> ${label}</li>`)
          .join(
            '',
          )}</ul><p class="muted">$1 以 &lt;worldbook_context&gt; 包裹、$2 以 &lt;worldbook_extra&gt; 包裹；$7 為提取後 AI 正文。先替換佔位符，再執行酒館巨集、正則與 EJS。$2／$5／$U／$C 在「世界書與上下文」未開啟時，只在提示詞段使用時讀取。</p></details>
        <div class="prompt-list" data-prompts="${kind}">${job.prompts.map((item, index) => promptCard(kind, item, index, job.prompts.length)).join('')}</div>
        <button data-task-action="add-prompt">＋ 提示詞段</button>
        ${previews.has(kind) ? `<label class="field prompt-preview">完整提示詞串預覽（未呼叫 API）<textarea readonly rows="16">${escape(previews.get(kind))}</textarea></label>` : ''}
      </section>
    </section>`;
  }

  function render(): void {
    const config = getDraft();
    const presets = config.taskPresets;
    host.innerHTML = `<section class="preset-bar"><div class="preset-title"><h3>任務預設</h3><small>保存四項任務的提示詞串、排程、重試、每批國策數與建議模型，以及世界書與上下文；不含 API 連線與金鑰。預設操作會一併保存目前的任務設定。</small></div>
      <div class="preset-row"><select data-preset-select aria-label="任務預設"><option value="">${presets.length ? '選擇預設以套用…' : '尚無任務預設'}</option>${presets
        .map(
          (preset) =>
            `<option value="${escape(preset.name)}" ${selectedAttr(preset.name === config.activeTaskPreset)}>${escape(preset.name)}</option>`,
        )
        .join(
          '',
        )}</select><input data-preset-name placeholder="預設名稱" value="${escape(config.activeTaskPreset)}" aria-label="預設名稱"><button class="primary" data-preset="save">保存</button><button data-preset="saveas">另存新預設</button><button data-preset="import">匯入</button><button data-preset="export">匯出</button>${
        confirmDelete
          ? `<button class="danger" data-preset="confirm-delete">確認刪除「${escape(config.activeTaskPreset)}」</button><button data-preset="cancel-delete">取消</button>`
          : `<button class="danger" data-preset="delete" ${config.activeTaskPreset ? '' : 'disabled'}>刪除</button>`
      }<input type="file" accept=".json,application/json" data-preset-file hidden></div>
      <p class="api-status" role="status">${escape(status)}</p></section>
      <nav class="task-tabs" aria-label="任務">${jobKinds
        .map((kind) => {
          const job = config.jobs[kind];
          const custom = job.prompts.filter((item) => item.kind === 'custom').length;
          const modified = job.prompts.some(isModified);
          return `<button class="task-tab ${kind === selected ? 'active' : ''}" data-task-tab="${kind}" aria-pressed="${kind === selected}"><strong>${taskNames[kind]}</strong><small>${kind === 'generate' ? '勾選國家時' : { reply: '每則正文', rounds: `每 ${job.interval} 則`, days: `每 ${job.interval} 日`, manual: '手動' }[job.schedule]}${custom ? ` · ${custom} 自訂段` : ''}${modified ? ' · 已改內建' : ''}</small></button>`;
        })
        .join('')}</nav>
      ${jobKinds.map((kind) => editor(kind, config)).join('')}`;
  }

  /** Write the form back into the draft config. */
  function read(): void {
    const config = getDraft();
    for (const section of host.querySelectorAll<HTMLElement>('[data-task-editor]')) {
      const kind = section.dataset.taskEditor as JobKind;
      const job = config.jobs[kind];
      const field = <T extends HTMLElement>(key: string) => section.querySelector<T>(`[data-t="${key}"]`)!;
      job.api = field<HTMLSelectElement>('api').value;
      job.primaryMaxConcurrency = Number(field<HTMLInputElement>('primaryMaxConcurrency').value) || 0;
      const rows = [...section.querySelectorAll<HTMLElement>('[data-fb-row]')].map((row) => ({
        name: row.querySelector<HTMLSelectElement>('[data-fb-name]')!.value,
        cap: Number(row.querySelector<HTMLInputElement>('[data-fb-cap]')!.value) || 0,
      }));
      job.fallback = rows.map((row) => row.name);
      job.fallbackMaxConcurrencies = rows.map((row) => row.cap);
      if (kind !== 'generate') {
        job.schedule = field<HTMLSelectElement>('schedule').value as typeof job.schedule;
      } else {
        job.schedule = 'manual';
      }
      job.interval = Number(field<HTMLInputElement>('interval').value);
      job.retries = Number(field<HTMLInputElement>('retries').value);
      job.timeout = Number(field<HTMLInputElement>('timeout').value);
      job.recommendedModel = field<HTMLInputElement>('recommendedModel').value.trim();
      job.prompts = [...section.querySelectorAll<HTMLElement>('[data-prompt-row]')].map((row) => {
        const kindOf = row.dataset.kind as PromptItem['kind'];
        const value = (key: string) =>
          row.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-p="${key}"]`)!;
        const content = value('content').value;
        return PromptItemSchema.parse({
          id: row.dataset.id,
          kind: kindOf,
          name: value('name').value,
          role: value('role').value,
          // Built-in text equal to the default keeps following future defaults.
          content:
            kindOf !== 'custom' && content.trim() === defaultPromptText(kindOf, kind).trim() ? '' : content,
          enabled: kindOf === 'data' ? true : (value('enabled') as HTMLInputElement).checked,
        });
      });
    }
  }

  function renderPrompts(kind: JobKind): void {
    const job = getDraft().jobs[kind];
    const list = host.querySelector<HTMLElement>(`[data-prompts="${kind}"]`);
    if (list) {
      list.innerHTML = job.prompts
        .map((item, index) => promptCard(kind, item, index, job.prompts.length))
        .join('');
    }
    const count = host.querySelector<HTMLElement>(`[data-task-editor="${kind}"] .prompt-toolbar small`);
    if (count) {
      count.textContent = promptCount(job.prompts);
    }
  }
  function download(name: string, text: string): void {
    const doc = host.ownerDocument;
    const link = doc.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    link.download = name;
    doc.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  function commit(next: Config, message: string, remount = false): void {
    status = message;
    confirmDelete = false;
    persist(ConfigSchema.parse(next), remount);
    if (!remount) {
      render();
    }
  }

  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLElement>('button');
    if (!button || disposed) {
      return;
    }
    const tab = button.dataset.taskTab as JobKind | undefined;
    if (tab) {
      read();
      selected = tab;
      for (const section of host.querySelectorAll<HTMLElement>('[data-task-editor]')) {
        section.hidden = section.dataset.taskEditor !== tab;
      }
      for (const item of host.querySelectorAll<HTMLElement>('[data-task-tab]')) {
        item.classList.toggle('active', item.dataset.taskTab === tab);
        item.setAttribute('aria-pressed', String(item.dataset.taskTab === tab));
      }
      return;
    }
    const preset = button.dataset.preset;
    if (preset) {
      void (async () => {
        try {
          read();
          const config = getDraft();
          const nameInput = host.querySelector<HTMLInputElement>('[data-preset-name]')!.value.trim();
          switch (preset) {
            case 'save': {
              const name = nameInput || config.activeTaskPreset;
              commit(saveTaskPreset(config, name), `已保存任務預設「${name}」。`);
              break;
            }
            case 'saveas':
              if (config.taskPresets.some((item) => item.name === nameInput)) {
                throw new Error(`任務預設「${nameInput}」已存在，請換一個名稱，或按「保存」覆蓋。`);
              }
              commit(saveTaskPreset(config, nameInput), `已另存任務預設「${nameInput}」。`);
              break;
            case 'delete':
              confirmDelete = true;
              render();
              break;
            case 'cancel-delete':
              confirmDelete = false;
              render();
              break;
            case 'confirm-delete': {
              const name = config.activeTaskPreset;
              commit(deleteTaskPreset(config, name), `已刪除任務預設「${name}」；目前任務設定不變。`);
              break;
            }
            case 'import':
              host.querySelector<HTMLInputElement>('[data-preset-file]')!.click();
              break;
            case 'export':
              download(
                `國策任務預設-${(config.activeTaskPreset || '全部').replace(/[\\/:*?"<>|]/g, '_')}.json`,
                exportTaskPresets(config, config.activeTaskPreset || undefined),
              );
              status = config.activeTaskPreset
                ? `已匯出「${config.activeTaskPreset}」。`
                : '已匯出全部任務預設。';
              render();
              break;
          }
        } catch (error) {
          status = error instanceof Error ? error.message : String(error);
          render();
        }
      })();
      return;
    }
    const action = button.dataset.taskAction;
    const section = button.closest<HTMLElement>('[data-task-editor]');
    if (!action || !section) {
      return;
    }
    const kind = section.dataset.taskEditor as JobKind;
    const row = button.closest<HTMLElement>('[data-prompt-row]');
    const id = row?.dataset.id ?? '';
    if (action === 'toggle' && row) {
      const key = `${kind}:${id}`;
      const open = !expanded.has(key);
      if (open) {
        expanded.add(key);
      } else {
        expanded.delete(key);
      }
      row.classList.toggle('open', open);
      row.querySelector<HTMLElement>('.prompt-body')!.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      return;
    }
    read();
    const job = getDraft().jobs[kind];
    const index = job.prompts.findIndex((item) => item.id === id);
    switch (action) {
      case 'edit-sources':
        hooks?.edit(kind);
        return;
      case 'run-now':
        status = `已開始執行「${taskNames[kind]}」；進度見面板底部的狀態列與「任務」。未儲存的修改不會用在這次執行。`;
        void controller.run(kind);
        render();
        return;
      case 'expand-all':
      case 'collapse-all':
        for (const item of job.prompts) {
          if (action === 'expand-all') {
            expanded.add(`${kind}:${item.id}`);
          } else {
            expanded.delete(`${kind}:${item.id}`);
          }
        }
        renderPrompts(kind);
        return;
      case 'add-prompt': {
        const item = PromptItemSchema.parse({
          id: newPromptId(),
          kind: 'custom',
          name: `自訂段 ${job.prompts.filter((p) => p.kind === 'custom').length + 1}`,
          role: 'system',
        });
        job.prompts.push(item);
        expanded.add(`${kind}:${item.id}`);
        break;
      }
      case 'delete':
        job.prompts.splice(index, 1);
        break;
      case 'up':
      case 'down': {
        const target = index + (action === 'up' ? -1 : 1);
        if (index >= 0 && target >= 0 && target < job.prompts.length) {
          [job.prompts[index], job.prompts[target]] = [job.prompts[target], job.prompts[index]];
        }
        break;
      }
      case 'restore':
        job.prompts[index] = { ...job.prompts[index], content: '' };
        break;
      case 'fb-add': {
        const config = getDraft();
        const used = new Set([job.api, ...job.fallback]);
        const next = config.apis.find((api) => !used.has(api.name)) ?? config.apis[0];
        job.fallback.push(next.name);
        job.fallbackMaxConcurrencies.push(0);
        render();
        return;
      }
      case 'fb-del': {
        const at = Number(button.dataset.index);
        job.fallback.splice(at, 1);
        job.fallbackMaxConcurrencies.splice(at, 1);
        render();
        return;
      }
      case 'preview': {
        previews.set(kind, '正在組裝提示詞串…');
        render();
        void (async () => {
          try {
            const messages = await controller.preview(kind, ConfigSchema.parse(structuredClone(getDraft())));
            const total = messages.reduce((sum, message) => sum + message.content.length, 0);
            previews.set(
              kind,
              [
                `共 ${messages.length} 則訊息，${total.toLocaleString()} 字元（字元不是 Token）。${kind === 'generate' ? '候選國家以示例代入。' : ''}`,
                ...messages.map(
                  (message, i) =>
                    `\n━━ #${i + 1} ${message.role}${message.name ? ` · ${message.name}` : ''} · ${message.content.length.toLocaleString()} 字元 ━━\n${message.content.length > 30000 ? `${message.content.slice(0, 30000)}\n【畫面只顯示前 30,000 字元，實際未截斷】` : message.content}`,
                ),
              ].join('\n'),
            );
          } catch (error) {
            previews.set(kind, `無法預覽：${error instanceof Error ? error.message : String(error)}`);
          }
          if (!disposed) {
            render();
          }
        })();
        return;
      }
    }
    renderPrompts(kind);
  };
  const change = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.matches('[data-preset-select]')) {
      if (!input.value) {
        return;
      }
      try {
        read();
        commit(applyTaskPreset(getDraft(), input.value), `已套用任務預設「${input.value}」並保存。`, true);
      } catch (error) {
        status = error instanceof Error ? error.message : String(error);
        render();
      }
      return;
    }
    if (input.matches('[data-preset-file]')) {
      const file = input.files?.[0];
      input.value = '';
      if (!file) {
        return;
      }
      void file
        .text()
        .then((text) => {
          read();
          const result = importTaskPresets(getDraft(), JSON.parse(text));
          commit(
            result.config,
            `已匯入 ${result.names.map((name) => `「${name}」`).join('、')}；選擇後即可套用。`,
          );
        })
        .catch((error) => {
          status = `匯入失敗：${error instanceof Error ? error.message : String(error)}`;
          render();
        });
      return;
    }
    if (input.dataset.t === 'schedule') {
      const section = input.closest<HTMLElement>('[data-task-editor]')!;
      const interval = section.querySelector<HTMLElement>('[data-interval]')!;
      interval.hidden = !['rounds', 'days'].includes(input.value);
      interval.firstChild!.textContent = input.value === 'days' ? '間隔（故事日）' : '間隔（則正文）';
      section.querySelector<HTMLElement>('[data-days-note]')!.hidden = input.value !== 'days';
      return;
    }
    if (input.dataset.sourceMode && hooks) {
      const kind = input.closest<HTMLElement>('[data-task-editor]')!.dataset.taskEditor as JobKind;
      read();
      hooks.setMode(kind, input.dataset.sourceMode as 'worldbook' | 'context', input.value === 'custom');
      render();
      return;
    }
    if (input.dataset.t === 'api' || input.dataset.t === 'recommendedModel') {
      // Update only the note: a full redraw on blur would swallow the click that caused it.
      const section = input.closest<HTMLElement>('[data-task-editor]')!;
      read();
      section.querySelector<HTMLElement>('[data-model-note]')!.innerHTML = modelNote(
        section.dataset.taskEditor as JobKind,
        getDraft(),
      );
      return;
    }
    const row = input.closest<HTMLElement>('[data-prompt-row]');
    if (row && input.dataset.p === 'enabled') {
      row.classList.toggle('off', !input.checked);
      read();
      const kind = row.closest<HTMLElement>('[data-task-editor]')!.dataset.taskEditor as JobKind;
      const count = host.querySelector<HTMLElement>(`[data-task-editor="${kind}"] .prompt-toolbar small`);
      if (count) {
        count.textContent = promptCount(getDraft().jobs[kind].prompts);
      }
    }
    if (row && input.dataset.p === 'name') {
      row.querySelector('.pname')!.textContent = input.value || '未命名段';
    }
    if (row && input.dataset.p === 'role') {
      row.querySelector('.role-tag')!.textContent = input.value;
    }
  };
  host.addEventListener('click', click);
  host.addEventListener('change', change);
  render();
  return {
    read,
    state: () => ({ selected, status }),
    /** Redraw from the draft; the caller has already read the form. */
    refresh() {
      render();
    },
    dispose() {
      disposed = true;
      host.removeEventListener('click', click);
      host.removeEventListener('change', change);
    },
  };
}
