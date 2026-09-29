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
 * preset are a draft saved by the panel's own 保存預設 button (the window stays open, as in
 * Workflow Assistant) or by the window's 儲存設定 (`commit`); choosing, adding, deleting and
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
      throw new Error('聊天已切換，請重新開啟 API 設定');
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
      name: `連線 ${controller.config.apis.length + 1}`,
      url: '',
      model: '',
      proxy: '',
    });
    savedDraft = structuredClone(draft);
    deepSeekBefore = null;
    models = [];
    requestVersion++;
    busy = false;
    status = '按「保存預設」建立新預設，並設為目前聊天使用。';
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
      ? 'API 金鑰另存於酒館擴充設定（隨帳號保存，並以 IndexedDB 備份），不會寫入樓層變量、劇情或匯出檔。'
      : location === 'memory'
        ? '離線測試頁：保存只留在本頁記憶體，重新整理即清除。'
        : '找不到酒館擴充設定，金鑰暫存於此瀏覽器的 localStorage（未加密）；不寫入樓層變量或劇情。';
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
    host.innerHTML = `<h3>API 預設</h3><p class="muted">切換目前聊天的預設；★ 為未指定聊天使用的全域預設。各項任務可另外指定主要與備援連線。修改內容按下方「保存預設」保存，不會關閉視窗；頁尾「儲存設定」也會一併保存。</p>
      ${legacyStrict.length ? `<p class="notice">舊版設定中「${legacyStrict.map((kind) => taskNames[kind]).join('」「')}」在任務設定開啟了嚴格 JSON。此選項已改到這裡：請在這些任務使用的 API 預設勾選「嚴格 JSON 回應」。儲存設定後不再提示。</p>` : ''}
      <div class="api-actions"><label class="field api-picker">目前 API 預設<select data-api-select>${original === null ? '<option value="" selected>新增預設（尚未保存）</option>' : ''}${controller.config.apis.map((api) => `<option value="${escape(api.name)}" ${api.name === original ? 'selected' : ''}>${api.name === controller.config.defaultApi ? '★ ' : ''}${escape(api.name)}</option>`).join('')}</select></label><button data-api-action="default" ${original === null ? 'disabled' : ''} title="設為全域預設">${original === controller.config.defaultApi ? '★ 全域預設' : '☆ 設為全域預設'}</button><button data-api-action="new">＋ 新增</button><button data-api-action="delete" ${original === null || controller.config.apis.length === 1 ? 'disabled' : ''}>刪除</button></div>
      ${pending ? `<div class="api-actions confirm-row"><span>「${escape(savedDraft.name)}」有未儲存的修改。</span><button class="primary" data-api-action="switch-save">儲存後${pending.name === null ? '新增' : '切換'}</button><button class="danger" data-api-action="switch-discard">放棄修改</button><button data-api-action="switch-cancel">取消</button></div>` : ''}
      ${deletePending ? '<div class="api-actions"><span>刪除此預設？引用它的任務將改為跟隨目前預設。</span><button data-api-action="confirm-delete">確認刪除</button><button data-api-action="cancel-delete">取消</button></div>' : ''}
      <div class="form-grid api-editor">
      ${field('name', '預設名稱')}${field('url', '端點（基礎 URL）', 'url', 'placeholder="https://example.com/v1"')}
      ${field('apiKey', 'API 金鑰', 'password', 'autocomplete="off"')}${field('proxy', '酒館代理預設名稱（選填）')}
      ${field('model', '模型名稱（可手動輸入）')}<label class="field">模型列表<select data-api-model ${models.length ? '' : 'disabled'}><option value="">${models.length ? '選擇模型，或保留手動名稱' : '請先載入模型'}</option>${models.map((name) => `<option value="${escape(name)}" ${name === draft.model ? 'selected' : ''}>${escape(name)}</option>`).join('')}</select></label>
      <div class="wide api-actions"><button data-api-action="models" ${busy ? 'disabled' : ''}>${busy ? '載入中…' : '載入模型'}</button><small>使用上方 URL 與金鑰取得清單；未列出的模型可手動輸入。</small></div>
      ${field('maxTokens', '最大回覆長度（Token）', 'number', 'min="1" step="1"')}${field('temperature', 'Temperature', 'number', 'min="0" max="2" step="0.05"')}
      <label class="check wide"><input type="checkbox" data-api-strict ${deep.strict ? 'checked' : ''}>嚴格 JSON 回應<small>要求模型只回傳 JSON：加入 response_format: json_object、strict 後處理，並排除 top_p 與 reasoning_effort。關閉只移除 response_format。需指定 URL；供應商不支援時請關閉。所有使用此預設的任務都套用。</small></label>
      <div class="wide api-actions"><button data-api-action="deepseek">${deepSeekBefore ? '還原 DeepSeek 套用前設定' : '一鍵 DeepSeek 結構化輸出'}</button><label class="check"><input type="checkbox" data-api-deep="cot" ${deep.cot ? 'checked' : ''}>DeepSeek 開啟 COT</label><small>一鍵套用會開啟嚴格 JSON、關閉 thinking；COT 控制 thinking 與 include_reasoning。</small></div>
      <label class="field">Prompt 後處理<select data-api-field="customPromptPostProcessing"><option value="none" ${draft.customPromptPostProcessing === 'none' ? 'selected' : ''}>none</option><option value="strict" ${draft.customPromptPostProcessing === 'strict' ? 'selected' : ''}>strict（DeepSeek 建議）</option></select></label>
      <label class="field">推理強度<select data-api-field="reasoningEffort">${['auto', 'min', 'low', 'medium', 'high', 'max'].map((value) => `<option ${draft.reasoningEffort === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
      <label class="check wide"><input data-api-field="includeReasoning" type="checkbox" ${draft.includeReasoning ? 'checked' : ''}>包含推理（include_reasoning）</label>
      <label class="check wide"><input data-api-field="stream" type="checkbox" ${draft.stream ? 'checked' : ''}>流式傳輸（stream）<small>邊收邊組合，完成後仍整份驗證。用於有 Cloudflare 約 100 秒限制（錯誤碼 524）或支援假流式的反向代理；一般直連不需要開啟。</small></label>
      ${textarea('bodyParams', '附加主體參數', 'YAML object，合併到模型請求體。', 'response_format:\n  type: json_object\nthinking:\n  type: disabled')}
      ${textarea('excludeBodyParams', '排除主體參數', '逗號、換行或 YAML 列表，從請求體移除指定欄位。', 'top_p, reasoning_effort')}
      ${textarea('requestHeaders', '附加請求標頭', '每行 Header: Value（YAML）；會加入自訂 API 請求。', 'X-Custom-Header: value')}
      </div><p class="muted">URL、模型與代理皆空白時沿用酒館目前連線。進階參數需指定 URL 與模型。預設輸出 60,000 Token、Temperature 0.85。</p><p class="muted">${secretNotice()}</p>
      <div class="api-actions api-save"><button data-api-action="discard">放棄修改</button><button class="primary" data-api-action="save">${original === null ? '保存並選用新預設' : '保存預設'}</button><p class="api-status" role="status">${escape(status)}</p></div>`;
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
            status = commit() ? `已保存「${name}」。` : '沒有需要保存的修改。';
            break;
          }
          case 'discard':
            deletePending = false;
            draft = structuredClone(savedDraft);
            deepSeekBefore = null;
            requestVersion++;
            busy = false;
            models = [];
            status = original === null ? '已取消新增。' : '已放棄尚未保存的修改。';
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
            status = `已將「${name}」設為全域預設。`;
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
            status = 'API 預設已刪除。';
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
            status = '正在載入模型…';
            render();
            try {
              const list = await controller.platform.models(request);
              if (disposed || version !== requestVersion || controller.platform.chatId() !== chatId) {
                return;
              }
              read();
              if (draft.url !== request.url || draft.apiKey !== request.apiKey) {
                models = [];
                status = '連線資料已改變，請重新載入模型。';
              } else {
                models = list;
                status = list.length
                  ? `已載入 ${list.length} 個模型。`
                  : '未取得模型清單；請確認端點與憑證，或手動輸入模型。';
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
              status = `載入模型失敗：${redactApiError(error, [request, draft])}`;
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
