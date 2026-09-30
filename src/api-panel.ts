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
 * Owns the API editor so saving connections never needs an MVU write. Edits to the selected
 * preset are a draft saved by the panel's own 保存预设 button (the window stays open, as in
 * Workflow Assistant) or by the window's 储存设定 (`commit`); choosing, adding, deleting and
 * starring presets apply at once.
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
      throw new Error('聊天已切换，请重新开启 API 设定');
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
      name: `连线 ${controller.config.apis.length + 1}`,
      url: '',
      model: '',
      proxy: '',
    });
    savedDraft = structuredClone(draft);
    deepSeekBefore = null;
    models = [];
    requestVersion++;
    busy = false;
    status = '按「保存预设」建立新预设，并设为目前聊天使用。';
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
      ? 'API 金钥另存于酒馆扩充设定（随帐号保存，并以 IndexedDB 备份），不会写入楼层变量、剧情或汇出档。'
      : location === 'memory'
        ? '离线测试页：保存只留在本页记忆体，重新整理即清除。'
        : '找不到酒馆扩充设定，金钥暂存于此浏览器的 localStorage（未加密）；不写入楼层变量或剧情。';
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
    host.innerHTML = `<h3>API 预设</h3><p class="muted">切换目前聊天的预设；★ 为未指定聊天使用的全域预设。各项任务可另外指定主要与备援连线。修改内容按下方「保存预设」保存，不会关闭视窗；页尾「储存设定」也会一并保存。</p>
      ${legacyStrict.length ? `<p class="notice">旧版设定中「${legacyStrict.map((kind) => taskNames[kind]).join('」「')}」在任务设定开启了严格 JSON。此选项已改到这里：请在这些任务使用的 API 预设勾选「严格 JSON 回应」。储存设定后不再提示。</p>` : ''}
      <div class="api-actions"><label class="field api-picker">目前 API 预设<select data-api-select>${original === null ? '<option value="" selected>新增预设（尚未保存）</option>' : ''}${controller.config.apis.map((api) => `<option value="${escape(api.name)}" ${api.name === original ? 'selected' : ''}>${api.name === controller.config.defaultApi ? '★ ' : ''}${escape(api.name)}</option>`).join('')}</select></label><button data-api-action="default" ${original === null ? 'disabled' : ''} title="设为全域预设">${original === controller.config.defaultApi ? '★ 全域预设' : '☆ 设为全域预设'}</button><button data-api-action="new">＋ 新增</button><button data-api-action="delete" ${original === null || controller.config.apis.length === 1 ? 'disabled' : ''}>删除</button></div>
      ${pending ? `<div class="api-actions confirm-row"><span>「${escape(savedDraft.name)}」有未储存的修改。</span><button class="primary" data-api-action="switch-save">储存后${pending.name === null ? '新增' : '切换'}</button><button class="danger" data-api-action="switch-discard">放弃修改</button><button data-api-action="switch-cancel">取消</button></div>` : ''}
      ${deletePending ? '<div class="api-actions"><span>删除此预设？引用它的任务将改为跟随目前预设。</span><button data-api-action="confirm-delete">确认删除</button><button data-api-action="cancel-delete">取消</button></div>' : ''}
      <div class="form-grid api-editor">
      ${field('name', '预设名称')}${field('url', '端点（基础 URL）', 'url', 'placeholder="https://example.com/v1"')}
      ${field('apiKey', 'API 金钥', 'password', 'autocomplete="off"')}${field('proxy', '酒馆代理预设名称（选填）')}
      ${field('model', '模型名称（可手动输入）')}<label class="field">模型列表<select data-api-model ${models.length ? '' : 'disabled'}><option value="">${models.length ? '选择模型，或保留手动名称' : '请先载入模型'}</option>${models.map((name) => `<option value="${escape(name)}" ${name === draft.model ? 'selected' : ''}>${escape(name)}</option>`).join('')}</select></label>
      <div class="wide api-actions"><button data-api-action="models" ${busy ? 'disabled' : ''}>${busy ? '载入中…' : '载入模型'}</button><small>使用上方 URL 与金钥取得清单；未列出的模型可手动输入。</small></div>
      ${field('maxTokens', '最大回复长度（Token）', 'number', 'min="1" step="1"')}${field('temperature', 'Temperature', 'number', 'min="0" max="2" step="0.05"')}
      <label class="check wide"><input type="checkbox" data-api-strict ${deep.strict ? 'checked' : ''}>严格 JSON 回应<small>要求模型只回传 JSON：加入 response_format: json_object、strict 后处理，并排除 top_p 与 reasoning_effort。关闭只移除 response_format。需指定 URL；供应商不支援时请关闭。所有使用此预设的任务都套用。</small></label>
      <div class="wide api-actions"><button data-api-action="deepseek">${deepSeekBefore ? '还原 DeepSeek 套用前设定' : '一键 DeepSeek 结构化输出'}</button><label class="check"><input type="checkbox" data-api-deep="cot" ${deep.cot ? 'checked' : ''}>DeepSeek 开启 COT</label><small>一键套用会开启严格 JSON、关闭 thinking；COT 控制 thinking 与 include_reasoning。</small></div>
      <label class="field">Prompt 后处理<select data-api-field="customPromptPostProcessing"><option value="none" ${draft.customPromptPostProcessing === 'none' ? 'selected' : ''}>none</option><option value="strict" ${draft.customPromptPostProcessing === 'strict' ? 'selected' : ''}>strict（DeepSeek 建议）</option></select></label>
      <label class="field">推理强度<select data-api-field="reasoningEffort">${['auto', 'min', 'low', 'medium', 'high', 'max'].map((value) => `<option ${draft.reasoningEffort === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
      <label class="check wide"><input data-api-field="includeReasoning" type="checkbox" ${draft.includeReasoning ? 'checked' : ''}>包含推理（include_reasoning）</label>
      <label class="check wide"><input data-api-field="stream" type="checkbox" ${draft.stream ? 'checked' : ''}>流式传输（stream）<small>边收边组合，完成后仍整份验证。用于有 Cloudflare 约 100 秒限制（错误码 524）或支援假流式的反向代理；一般直连不需要开启。</small></label>
      ${textarea('bodyParams', '附加主体参数', 'YAML object，合并到模型请求体。', 'response_format:\n  type: json_object\nthinking:\n  type: disabled')}
      ${textarea('excludeBodyParams', '排除主体参数', '逗号、换行或 YAML 列表，从请求体移除指定栏位。', 'top_p, reasoning_effort')}
      ${textarea('requestHeaders', '附加请求标头', '每行 Header: Value（YAML）；会加入自订 API 请求。', 'X-Custom-Header: value')}
      </div><p class="muted">URL、模型与代理皆空白时沿用酒馆目前连线。进阶参数需指定 URL 与模型。预设输出 60,000 Token、Temperature 0.85。</p><p class="muted">${secretNotice()}</p>
      <div class="api-actions api-save"><button data-api-action="discard">放弃修改</button><button class="primary" data-api-action="save">${original === null ? '保存并选用新预设' : '保存预设'}</button><p class="api-status" role="status">${escape(status)}</p></div>`;
  }
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('[data-api-action]');
    if (!button) {
      return;
    }
    void (async () => {
      try {
        read();
        switch (button.dataset.apiAction) {
          case 'save': {
            const name = draft.name.trim();
            status = commit() ? `已保存「${name}」。` : '没有需要保存的修改。';
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
            status = '正在载入模型…';
            render();
            try {
              const list = await controller.platform.models(request);
              if (disposed || version !== requestVersion || controller.platform.chatId() !== chatId) {
                return;
              }
              read();
              if (draft.url !== request.url || draft.apiKey !== request.apiKey) {
                models = [];
                status = '连线资料已改变，请重新载入模型。';
              } else {
                models = list;
                status = list.length
                  ? `已载入 ${list.length} 个模型。`
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
              status = `载入模型失败：${redactApiError(error, [request, draft])}`;
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
      if (input.matches('[data-api-select]')) {
        const name = input.value;
        if (dirty()) {
          // Keep the edits visible until the user decides; the select shows the old preset.
          pending = { name };
        } else {
          choose(name);
        }
      } else if (input.matches('[data-api-strict]')) {
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
        const select = host.querySelector<HTMLSelectElement>('[data-api-model]')!;
        select.value = models.includes(draft.model) ? draft.model : '';
        return;
      } else {
        return;
      }
    } catch (error) {
      status = redactApiError(error, [draft, ...controller.config.apis]);
    }
    render();
  };
  host.addEventListener('click', click);
  host.addEventListener('change', change);
  render();
  return {
    dirty,
    commit,
    dispose() {
      disposed = true;
      requestVersion++;
      host.removeEventListener('click', click);
      host.removeEventListener('change', change);
    },
  };
}
