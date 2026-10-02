import { ApiSchema, jobKinds, type Config } from './model';
import {
  applyDeepSeek,
  currentApiName,
  deepSeekOptions,
  deleteApiPreset,
  redactApiError,
  saveApiPreset,
  setStrictJson,
  type ApiPreset,
} from './api-config';
import { taskNames } from './task-panel';
import type { FocusController } from './workflow';

const escape = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
type Update = (config: Config) => Config;

/**
 * Owns the API editor so saving connections never needs an MVU write. v0.15.1: presets are a list
 * on the left and the edited preset a card on the right. Its edits are a draft saved by the card's
 * own 保存此预设 (the window stays open, so several presets can be added in a row, as in Workflow
 * Assistant) or by the window's 保存设置 (`commit`); choosing, adding, copying, deleting and
 * starring presets apply at once. Choosing a preset also makes the current chat use it.
 */
export function mountApiPanel(
  controller: FocusController,
  host: HTMLElement,
  onSaved: (update: Update) => void,
): { dispose(): void; dirty(): boolean; commit(): boolean } {
  const chatId = controller.platform.chatId();
  let original: string | null = currentApiName(controller.config, chatId);
  let draft = structuredClone(controller.config.apis.find((api) => api.name === original)!);
  let savedDraft = structuredClone(draft);
  let models: string[] = [];
  let status = '';
  let busy = false;
  let requestVersion = 0;
  let deletePending = false;
  let deepSeekBefore: ApiPreset | null = null;
  let disposed = false;
  /** A preset switch (or 新增) waiting for the user to keep or drop unsaved edits. */
  let pending: { name: string | null } | null = null;
  /** Offer 再新增一个 right after a save. */
  let justSaved = false;
  let advancedOpen = false;
  let search = '';
  // Before v0.13.3 each task had its own strict JSON switch; name the tasks that had it on.
  const legacyStrict = jobKinds.filter((kind) => controller.config.jobs[kind].strictJson);

  function read(): void {
    for (const field of host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      '[data-api-field]',
    )) {
      const key = field.dataset.apiField!;
      Object.assign(draft, {
        [key]:
          key === 'includeReasoning' || key === 'stream'
            ? (field as HTMLInputElement).checked
            : ['maxTokens', 'temperature'].includes(key)
              ? Number(field.value)
              : field.value,
      });
    }
  }
  function save(update: Update): void {
    if (controller.platform.chatId() !== chatId) {
      throw new Error('聊天已切换，请重新开启 API 设置');
    }
    controller.saveSettings(update(controller.config));
    onSaved(update);
  }
  function dirty(): boolean {
    read();
    return original === null || JSON.stringify(draft) !== JSON.stringify(savedDraft);
  }
  /** Save the edited preset (the window footer calls this before saving the rest). */
  /** Save the edited preset; true when something was saved. */
  function commit(): boolean {
    if (!dirty()) {
      return false;
    }
    const edited = structuredClone(draft);
    const old = original;
    save((config) => saveApiPreset(config, old, edited, chatId));
    load(edited.name.trim());
    return true;
  }
  function blank(): void {
    original = null;
    deletePending = false;
    draft = ApiSchema.parse({
      name: `连接 ${controller.config.apis.length + 1}`,
      url: '',
      model: '',
      proxy: '',
    });
    savedDraft = structuredClone(draft);
    deepSeekBefore = null;
    models = [];
    requestVersion++;
    busy = false;
    status = '按「保存并选用」建立新预设，并设为目前聊天使用。';
  }
  function choose(name: string): void {
    save((config) => ({
      ...structuredClone(config),
      apiBindings: { ...config.apiBindings, [chatId]: name },
    }));
    load(name);
    status = `目前聊天使用「${name}」。`;
  }
  function load(name: string): void {
    original = name;
    draft = structuredClone(controller.config.apis.find((api) => api.name === name)!);
    savedDraft = structuredClone(draft);
    models = [];
    busy = false;
    requestVersion++;
    deletePending = false;
    deepSeekBefore = null;
  }
  function secretNotice(): string {
    const location = controller.platform.secretLocation?.();
    return location === 'tavern'
      ? 'API 金钥另存于酒馆扩展设置（随账号保存，并以 IndexedDB 备份），不会写入楼层变量、剧情或导出档。'
      : location === 'memory'
        ? '离线测试页：保存只留在本页记忆体，重新整理即清除。'
        : '找不到酒馆扩展设置，金钥暂存于此浏览器的 localStorage（未加密）；不写入楼层变量或剧情。';
  }
  function render(): void {
    const field = (key: keyof ApiPreset, label: string, type = 'text', extra = '') =>
      `<label class="field">${label}<input data-api-field="${key}" type="${type}" value="${escape(draft[key])}" ${extra}></label>`;
    const textarea = (key: keyof ApiPreset, label: string, hint: string, placeholder: string) =>
      `<label class="field wide">${label}<small>${hint}</small><textarea data-api-field="${key}" rows="3" placeholder="${escape(placeholder)}">${escape(draft[key])}</textarea></label>`;
    let deep = { strict: false, cot: false };
    try {
      deep = deepSeekOptions(draft);
    } catch {
      // Keep invalid YAML visible for correction without losing the draft.
    }
    const edited = original === null || JSON.stringify(draft) !== JSON.stringify(savedDraft);
    const presets = controller.config.apis;
    const matches = (api: ApiPreset) =>
      !search || `${api.name} ${api.model} ${api.url}`.toLowerCase().includes(search.toLowerCase());
    const item = (api: ApiPreset) =>
      `<button class="api-item ${api.name === original ? 'on' : ''}" data-api-action="pick" data-api-pick="${escape(api.name)}" ${api.name === original ? 'aria-current="true"' : ''} ${matches(api) ? '' : 'hidden'}><b>${api.name === controller.config.defaultApi ? '★ ' : ''}${escape(api.name)}${api.name === original && edited ? '<i class="dirty-dot" title="有修改尚未保存"></i>' : ''}</b><small>${escape(api.model || api.url || '跟随酒馆连接')}</small></button>`;
    const list = `<aside class="api-list" aria-label="API 预设"><div class="api-list-head">API 预设 · ${presets.length}</div>${presets.length > 8 ? `<input class="api-search" data-api-search placeholder="搜索名称或模型" value="${escape(search)}" aria-label="搜索 API 预设">` : ''}<div class="api-list-scroll">${original === null ? `<button class="api-item on" aria-current="true"><b>${escape(draft.name)}<i class="dirty-dot" title="尚未保存"></i></b><small>新增预设（尚未保存）</small></button>` : ''}${presets.map(item).join('')}</div><button class="api-add" data-api-action="new">＋ 新增预设</button></aside>`;
    const saved = justSaved ? ' <button class="linkish" data-api-action="new">＋ 再新增一个</button>' : '';
    host.innerHTML = `${legacyStrict.length ? `<p class="notice">旧版设置中「${legacyStrict.map((kind) => taskNames[kind]).join('」「')}」在任务设置开启了严格 JSON。此选项已改到这里：请在这些任务使用的 API 预设勾选「严格 JSON 回应」。保存设置后不再提示。</p>` : ''}
      <div class="api-layout">${list}<section class="api-card">
      <header class="api-card-head"><small>${original === null ? '新增预设' : '编辑预设 · 目前聊天使用'}</small><b>${escape(savedDraft.name)}</b><span class="api-card-tools"><button data-api-action="default" ${original === null ? 'disabled' : ''} title="未指定预设的聊天使用这个预设">${original === controller.config.defaultApi ? '★ 全域预设' : '☆ 设为全域'}</button><button data-api-action="copy" title="复制成新的预设，再修改">复制</button><button class="danger" data-api-action="delete" ${original === null || presets.length === 1 ? 'disabled' : ''}>删除</button></span></header>
      ${pending ? `<div class="api-actions confirm-row"><span>「${escape(savedDraft.name)}」有未保存的修改。</span><button class="primary" data-api-action="switch-save">保存后${pending.name === null ? '新增' : '切换'}</button><button class="danger" data-api-action="switch-discard">放弃修改</button><button data-api-action="switch-cancel">取消</button></div>` : ''}
      ${deletePending ? '<div class="api-actions confirm-row"><span>删除此预设？引用它的任务将改为跟随目前预设。</span><button class="danger" data-api-action="confirm-delete">确认删除</button><button data-api-action="cancel-delete">取消</button></div>' : ''}
      <div class="api-card-body"><div class="form-grid api-editor">
      ${field('name', '预设名称')}${field('url', '端点（基础 URL）', 'url', 'placeholder="https://example.com/v1"')}
      ${field('apiKey', 'API 金钥', 'password', 'autocomplete="off"')}${field('proxy', '酒馆代理预设名称（选填）')}
      <div class="field">模型<div class="inline-field"><input data-api-field="model" type="text" value="${escape(draft.model)}" placeholder="输入模型名称，或加载清单后选择" aria-label="模型"><button data-api-action="models" ${busy ? 'disabled' : ''} title="用上方 URL 与金钥取得模型清单">${busy ? '加载中…' : '加载模型'}</button></div>${models.length ? `<select data-api-model aria-label="模型清单"><option value="">从 ${models.length} 个模型中选择</option>${models.map((name) => `<option value="${escape(name)}" ${name === draft.model ? 'selected' : ''}>${escape(name)}</option>`).join('')}</select>` : ''}</div>
      ${field('maxTokens', '最大回复长度（Token）', 'number', 'min="1" step="1"')}${field('temperature', 'Temperature', 'number', 'min="0" max="2" step="0.05"')}
      <details class="wide api-advanced" ${advancedOpen ? 'open' : ''}><summary>进阶参数<small>严格 JSON · DeepSeek · 推理 · 流式 · 主体参数与标头</small></summary><div class="form-grid">
      <label class="check wide"><input type="checkbox" data-api-strict ${deep.strict ? 'checked' : ''}>严格 JSON 回应<small>要求模型只返回 JSON：加入 response_format: json_object、strict 后处理，并排除 top_p 与 reasoning_effort。关闭只移除 response_format。需指定 URL；供应商不支持时请关闭。所有使用此预设的任务都套用。</small></label>
      <div class="wide api-actions"><button data-api-action="deepseek">${deepSeekBefore ? '还原 DeepSeek 套用前设置' : '一键 DeepSeek 结构化输出'}</button><label class="check"><input type="checkbox" data-api-deep="cot" ${deep.cot ? 'checked' : ''}>DeepSeek 开启 COT</label><small>一键套用会开启严格 JSON、关闭 thinking；COT 控制 thinking 与 include_reasoning。</small></div>
      <label class="field">Prompt 后处理<select data-api-field="customPromptPostProcessing"><option value="none" ${draft.customPromptPostProcessing === 'none' ? 'selected' : ''}>none</option><option value="strict" ${draft.customPromptPostProcessing === 'strict' ? 'selected' : ''}>strict（DeepSeek 建议）</option></select></label>
      <label class="field">推理强度<select data-api-field="reasoningEffort">${['auto', 'min', 'low', 'medium', 'high', 'max'].map((value) => `<option ${draft.reasoningEffort === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
      <label class="check wide"><input data-api-field="includeReasoning" type="checkbox" ${draft.includeReasoning ? 'checked' : ''}>包含推理（include_reasoning）</label>
      <label class="check wide"><input data-api-field="stream" type="checkbox" ${draft.stream ? 'checked' : ''}>流式传输（stream）<small>边收边组合，完成后仍整份验证。用于有 Cloudflare 约 100 秒限制（错误码 524）或支持假流式的反向代理；一般直连不需要开启。</small></label>
      ${textarea('bodyParams', '附加主体参数', 'YAML object，合并到模型请求体。', 'response_format:\n  type: json_object\nthinking:\n  type: disabled')}
      ${textarea('excludeBodyParams', '排除主体参数', '逗号、换行或 YAML 列表，从请求体移除指定栏位。', 'top_p, reasoning_effort')}
      ${textarea('requestHeaders', '附加请求标头', '每行 Header: Value（YAML）；会加入自定义 API 请求。', 'X-Custom-Header: value')}
      </div></details>
      </div><p class="muted">URL、模型与代理皆空白时沿用酒馆目前连接。进阶参数需指定 URL 与模型。预设输出 60,000 Token、Temperature 0.85。</p><p class="muted">${secretNotice()}</p></div>
      <footer class="api-card-foot"><p class="api-status" role="status">${escape(status)}${saved}</p><button data-api-action="discard">放弃修改</button><button class="primary" data-api-action="save">${original === null ? '保存并选用' : '保存此预设'}</button></footer>
      </section></div>`;
  }
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-api-action]');
    if (button && button.dataset.apiPick !== undefined) {
      button.dataset.apiAction = 'pick';
    }
    if (!button) {
      return;
    }
    void (async () => {
      try {
        read();
        justSaved = false;
        switch (button.dataset.apiAction) {
          case 'save': {
            const name = draft.name.trim();
            const saved = commit();
            status = saved ? `已保存「${name}」。` : '没有需要保存的修改。';
            justSaved = saved;
            break;
          }
          case 'copy': {
            // 另存为: the copy keeps the edits shown now; the original preset stays as saved.
            const names = new Set(controller.config.apis.map((api) => api.name));
            let name = `${draft.name.trim()} 副本`;
            for (let i = 2; names.has(name); i++) {
              name = `${draft.name.trim()} 副本 ${i}`;
            }
            original = null;
            deletePending = false;
            draft = { ...structuredClone(draft), name };
            savedDraft = structuredClone(draft);
            status = `已复制为「${name}」，修改后按「保存并选用」建立。`;
            break;
          }
          case 'pick': {
            const name = button.dataset.apiPick!;
            if (name === original) {
              break;
            }
            if (dirty()) {
              pending = { name };
            } else {
              choose(name);
            }
            break;
          }
          case 'discard':
            deletePending = false;
            draft = structuredClone(savedDraft);
            deepSeekBefore = null;
            requestVersion++;
            busy = false;
            models = [];
            status = original === null ? '已取消新增。' : '已放弃尚未保存的修改。';
            if (original === null) {
              load(currentApiName(controller.config, chatId));
            }
            break;
          case 'new':
            if (dirty()) {
              pending = { name: null };
            } else {
              blank();
            }
            break;
          case 'switch-save':
          case 'switch-discard':
          case 'switch-cancel': {
            const next = pending;
            pending = null;
            if (!next || button.dataset.apiAction === 'switch-cancel') {
              break;
            }
            if (button.dataset.apiAction === 'switch-save') {
              commit();
            }
            if (next.name === null) {
              blank();
            } else {
              choose(next.name);
            }
            break;
          }
          case 'default': {
            const name = original!;
            save((config) => ({ ...structuredClone(config), defaultApi: name }));
            status = `已将「${name}」设为全域预设。`;
            break;
          }
          case 'delete':
            deletePending = true;
            break;
          case 'cancel-delete':
            deletePending = false;
            break;
          case 'confirm-delete': {
            const name = original!;
            save((config) => deleteApiPreset(config, name));
            load(currentApiName(controller.config, chatId));
            status = 'API 预设已删除。';
            break;
          }
          case 'deepseek':
            if (deepSeekBefore) {
              const previous = deepSeekBefore;
              for (const key of [
                'bodyParams',
                'excludeBodyParams',
                'customPromptPostProcessing',
                'includeReasoning',
                'reasoningEffort',
              ] as const) {
                Object.assign(draft, { [key]: previous[key] });
              }
              deepSeekBefore = null;
            } else {
              const next = applyDeepSeek(draft, true, false);
              deepSeekBefore = structuredClone(draft);
              draft = next;
            }
            break;
          case 'models': {
            const version = ++requestVersion;
            const request = structuredClone(draft);
            busy = true;
            status = '正在加载模型…';
            render();
            try {
              const list = await controller.platform.models(request);
              if (disposed || version !== requestVersion || controller.platform.chatId() !== chatId) {
                return;
              }
              read();
              if (draft.url !== request.url || draft.apiKey !== request.apiKey) {
                models = [];
                status = '连接资料已改变，请重新加载模型。';
              } else {
                models = list;
                status = list.length
                  ? `已加载 ${list.length} 个模型。`
                  : '未取得模型清单；请确认端点与凭证，或手动输入模型。';
                if (!draft.model && list.length) {
                  draft.model = list[0];
                }
              }
            } catch (error) {
              if (disposed || version !== requestVersion) {
                return;
              }
              read();
              models = [];
              status = `加载模型失败：${redactApiError(error, [request, draft])}`;
            }
            busy = false;
            break;
          }
        }
      } catch (error) {
        status = redactApiError(error, [draft, ...controller.config.apis]);
      }
      if (!disposed) {
        render();
      }
    })();
  };
  const change = (event: Event) => {
    const input = event.target as HTMLInputElement;
    try {
      read();
      if (input.matches('[data-api-strict]')) {
        draft = setStrictJson(draft, input.checked);
      } else if (input.matches('[data-api-model]')) {
        if (input.value) {
          draft.model = input.value;
        }
      } else if (input.matches('[data-api-deep]')) {
        const strict = host.querySelector<HTMLInputElement>('[data-api-strict]')!.checked;
        const cot = host.querySelector<HTMLInputElement>('[data-api-deep="cot"]')!.checked;
        draft = applyDeepSeek(draft, strict, cot);
      } else if (input.dataset.apiField === 'model') {
        const select = host.querySelector<HTMLSelectElement>('[data-api-model]');
        if (select) {
          select.value = models.includes(draft.model) ? draft.model : '';
        }
        return;
      } else {
        return;
      }
    } catch (error) {
      status = redactApiError(error, [draft, ...controller.config.apis]);
    }
    render();
  };
  const input = (event: Event) => {
    const field = event.target as HTMLInputElement;
    if (!field.matches('[data-api-search]')) {
      return;
    }
    search = field.value;
    for (const button of host.querySelectorAll<HTMLElement>('[data-api-pick]')) {
      const api = controller.config.apis.find((item) => item.name === button.dataset.apiPick);
      button.hidden =
        !!api && !`${api.name} ${api.model} ${api.url}`.toLowerCase().includes(search.toLowerCase());
    }
  };
  const toggle = (event: Event) => {
    if ((event.target as Element).matches('.api-advanced')) {
      advancedOpen = (event.target as HTMLDetailsElement).open;
    }
  };
  host.addEventListener('click', click);
  host.addEventListener('change', change);
  host.addEventListener('input', input);
  host.addEventListener('toggle', toggle, true);
  render();
  return {
    dirty,
    commit,
    dispose() {
      disposed = true;
      requestVersion++;
      host.removeEventListener('click', click);
      host.removeEventListener('change', change);
      host.removeEventListener('input', input);
      host.removeEventListener('toggle', toggle, true);
    },
  };
}
