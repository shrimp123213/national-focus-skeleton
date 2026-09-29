import { jobKinds, SourcesSchema, type Config, type JobKind, type SourceSettings } from './model';
import { entryExclusion, selectedEntry, tableEntry } from './sources';
import type { SourceEntry } from './platform';
import type { FocusController } from './workflow';

const escape = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const labels = { identify: '辨識國家', generate: '生成國策樹', update: '局勢更新', reshape: '重大改樹' };

export function mountSourcePanel(
  controller: FocusController,
  host: HTMLElement,
  getConfig: () => Config,
  onChange: (sources: SourceSettings) => void,
) {
  let settings = structuredClone(getConfig().sources);
  let target: 'default' | JobKind = 'default';
  let entries: SourceEntry[] = [];
  let books = { character: [] as string[], all: [] as string[] };
  let bookFilter = '';
  let entryFilter = '';
  let status = '';
  let preview = '';
  let previewJob: JobKind = 'generate';
  let disposed = false;
  let loading = false;
  let revision = 0;
  const chatId = controller.platform.chatId();

  const contextConfig = () =>
    target === 'default' ? settings.context : (settings.overrides[target]?.context ?? settings.context);
  const bookConfig = () =>
    target === 'default' ? settings.worldbook : (settings.overrides[target]?.worldbook ?? settings.worldbook);
  const customContext = () => target === 'default' || Boolean(settings.overrides[target]?.context);
  const customBooks = () => target === 'default' || Boolean(settings.overrides[target]?.worldbook);
  function read(): void {
    for (const input of host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      '[data-source-global]',
    )) {
      const key = input.dataset.sourceGlobal!;
      Object.assign(settings, {
        [key]:
          input.type === 'checkbox'
            ? (input as HTMLInputElement).checked
            : ['memoryRecallRecentCount', 'maxInputCharacters'].includes(key)
              ? Number(input.value)
              : key === 'variables'
                ? input.value
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                : input.value,
      });
    }
    if (customContext()) {
      const context = contextConfig();
      const count = host.querySelector<HTMLInputElement>('[data-source-count]');
      if (count) {
        context.contextTurnCount = Number(count.value);
      }
      for (const key of ['contextExtractRules', 'contextExcludeRules'] as const) {
        for (const row of host.querySelectorAll<HTMLElement>(`[data-rule-list="${key}"] [data-rule-row]`)) {
          const index = Number(row.dataset.ruleRow);
          context[key][index] = {
            start: row.querySelector<HTMLInputElement>('[data-boundary="start"]')!.value,
            end: row.querySelector<HTMLInputElement>('[data-boundary="end"]')!.value,
          };
        }
      }
    }
    const extraBooks = host.querySelector<HTMLTextAreaElement>('[data-manual-books]');
    if (extraBooks && customBooks()) {
      bookConfig().manualSelection = [
        ...new Set(
          extraBooks.value
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      ];
    }
    onChange(structuredClone(settings));
  }
  /** Give a task its own copy of the default worldbook or context, or drop it. */
  function setOverride(kind: JobKind, key: 'context' | 'worldbook', custom: boolean): void {
    const override = (settings.overrides[kind] ??= {});
    if (custom) {
      override[key] ??= structuredClone(settings[key]) as never;
    } else {
      delete override[key];
    }
    if (!override.context && !override.worldbook) {
      delete settings.overrides[kind];
    }
  }
  function entryList(selected: Record<string, number[]>): string {
    const query = entryFilter.toLowerCase();
    return [...new Set(entries.map((entry) => entry.book))]
      .map((book) => {
        const rows = entries
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => entry.book === book);
        const count = rows.filter(
          ({ entry }) => !entryExclusion(entry) && selectedEntry(entry, selected),
        ).length;
        return `<div class="source-group">${escape(book)} · 已選 ${count}／${rows.length}</div>${rows
          .map(({ entry, index }) => {
            const excluded = entryExclusion(entry);
            const automatic = !excluded && settings.autoIncludeTables && tableEntry(entry);
            const text = `${entry.book} ${entry.name}`.toLowerCase();
            return `<label class="source-entry ${entry.enabled ? '' : 'source-disabled'}" data-filter-text="${escape(text)}" ${text.includes(query) ? '' : 'hidden'}><input type="checkbox" data-source-entry="${index}" ${automatic || (!excluded && selectedEntry(entry, selected)) ? 'checked' : ''} ${excluded || automatic ? 'disabled' : ''}><span>${escape(entry.name || `條目 ${entry.uid}`)}<small>${escape(excluded || (automatic ? '資料庫表格 · 自動納入' : entry.strategy?.type === 'constant' ? '常駐' : '關鍵字觸發'))} · ${entry.content.length.toLocaleString()} 字元${entry.enabled ? '' : ' · 酒館停用'}</small></span></label>`;
          })
          .join('')}`;
      })
      .join('');
  }
  function render(): void {
    const context = contextConfig();
    const selection = bookConfig();
    const ruleEditor = (key: 'contextExtractRules' | 'contextExcludeRules', name: string) =>
      `<h4>${name}</h4><div data-rule-list="${key}">${context[key].map((rule, index) => `<div class="source-rule" data-rule-row="${index}"><input aria-label="開始詞" data-boundary="start" placeholder="開始詞，如 &lt;content" value="${escape(rule.start)}"><input aria-label="結束詞" data-boundary="end" placeholder="結束詞，如 &lt;/content&gt;" value="${escape(rule.end)}"><button data-source-action="delete-rule" data-rule-kind="${key}" data-rule-index="${index}">刪除</button></div>`).join('')}</div><button data-source-action="add-rule" data-rule-kind="${key}">＋ 新增${name}</button>`;
    const customized = jobKinds.filter((kind) => settings.overrides[kind]);
    const scope =
      target === 'default'
        ? `<div class="source-scope"><span>正在編輯：<b>預設</b>（所有任務）</span>${customized.map((kind) => `<button data-source-action="target" data-target="${kind}">編輯「${labels[kind]}」專用</button>`).join('')}</div><small class="muted">要讓某項任務使用不同的世界書或上下文，到「任務」分頁把該任務的「世界書與上下文」改成「此任務自訂」。</small>`
        : `<div class="source-scope custom"><span>正在編輯：<b>${labels[target]}</b> 專用</span><label>世界書<select data-source-mode="worldbook"><option value="inherit">沿用預設</option><option value="custom" ${customBooks() ? 'selected' : ''}>此任務自訂</option></select></label><label>上下文<select data-source-mode="context"><option value="inherit">沿用預設</option><option value="custom" ${customContext() ? 'selected' : ''}>此任務自訂</option></select></label><button data-source-action="target" data-target="default">回到預設</button></div>`;
    host.innerHTML = `<h3>世界書與上下文</h3><p class="muted">只讀取所選來源。常駐條目直接納入；綠燈條目須命中整理後的上下文／補充提示詞，最多遞迴掃描 10 輪，不自動加入全域世界書。</p>
      ${scope}
      <fieldset ${customBooks() ? '' : 'disabled'}><legend>劇情世界書（對應 $1）</legend><label class="field">來源<select data-book-source><option value="character" ${selection.source === 'character' ? 'selected' : ''}>目前角色綁定</option><option value="manual" ${selection.source === 'manual' ? 'selected' : ''}>手動選擇世界書</option></select></label><small>目前角色綁定：${escape(books.character.join('、') || '尚未載入／未綁定')}</small>
      ${selection.source === 'manual' ? `<label class="field">篩選世界書<input data-book-filter value="${escape(bookFilter)}" placeholder="世界書名稱"></label><div class="source-list">${books.all.map((book) => `<label class="check source-book" ${book.toLowerCase().includes(bookFilter.toLowerCase()) ? '' : 'hidden'} data-filter-text="${escape(book.toLowerCase())}"><input type="checkbox" data-source-book="${escape(book)}" ${selection.manualSelection.includes(book) ? 'checked' : ''}>${escape(book)}</label>`).join('')}</div><label class="field">手動選書（每行一項；空白就是不選書）<textarea data-manual-books>${escape(selection.manualSelection.join('\n'))}</textarea></label>` : ''}
      <div class="api-actions"><button data-source-action="load">載入／刷新世界書與條目</button><button data-source-action="all">全選啟用條目</button><button data-source-action="none">全不選</button></div><p class="muted">全不選會保存為空清單，不會回退成全選。酒館停用條目可以個別勾選，不改動酒館設定。規則／MVU／工作流托管與紀要專用條目不納入劇情掃描。</p>
      <label class="check"><input type="checkbox" data-source-global="autoIncludeTables" ${settings.autoIncludeTables ? 'checked' : ''}>資料庫表格條目一律納入<small>開啟後 TavernDB-ACU 表格匯出（紀要、主角資訊、托管條目除外）不受勾選限制，也不看酒館啟用狀態；關閉時與一般條目相同，全不選即排除。</small></label>
      <label class="field">篩選條目／世界書<input data-entry-filter value="${escape(entryFilter)}"></label><div class="source-list" data-entry-list>${entryList(selection.enabledEntries) || `<p>${loading ? '讀取中…' : '尚未載入條目。'}</p>`}</div></fieldset>
      <fieldset ${customContext() ? '' : 'disabled'}><legend>預設上下文（對應 $7）</legend><label class="field">最近 N 則 AI 回覆<input data-source-count type="number" min="0" max="100" value="${context.contextTurnCount}"><small>N 包含當前回覆；0 只保留當前樓。使用目前 Swipe，排除使用者與系統訊息。</small></label>
      <details><summary>提取與排除規則說明</summary><p>先提取，再排除。每條規則匹配最後一組完整邊界，不分大小寫；開始詞支援 &lt;tp、&lt;content 等未閉合開標籤前綴，保留邊界本身。多條提取結果依規則順序合併；全部未命中時沿用原文，預覽會標示。排除規則每條只移除最後一組，也套用於合併後的世界書內容。</p></details>${ruleEditor('contextExtractRules', '提取規則')}${ruleEditor('contextExcludeRules', '排除規則')}</fieldset>
      <fieldset><legend>其他來源（對應 $2／$5／$U／$C，預設關閉）</legend><div class="source-toggles"><label class="check"><input type="checkbox" data-source-global="managedEntries" ${settings.managedEntries ? 'checked' : ''}>工作流托管條目（$2）<small>角色綁定世界書中的 WorkflowHelper-* 條目，只取酒館已啟用者，按相同掃描規則觸發。</small></label><label class="check"><input type="checkbox" data-source-global="summaryIndex" ${settings.summaryIndex ? 'checked' : ''}>紀要索引（$5）<small>預設世界書的 TavernDB-ACU-CustomExport-纪要索引；沒有時改讀資料庫插件的紀要表或總體大綱。</small></label><label class="check"><input type="checkbox" data-source-global="persona" ${settings.persona ? 'checked' : ''}>使用者設定與主角資料（$U）<small>酒館 persona 描述，加上角色世界書的「主角信息」匯出條目。</small></label><label class="check"><input type="checkbox" data-source-global="characterDescription" ${settings.characterDescription ? 'checked' : ''}>角色描述（$C）<small>目前角色卡的 description，經巨集／EJS 處理。</small></label></div><p class="muted">在任務的提示詞段寫入這些佔位符時，即使此處未開啟也會讀取，並只在提示詞段送出。</p></fieldset>
      <fieldset><legend>記憶回溯（對應 $6）與其他來源</legend><label class="field">最近 N 條 AM 紀要<input data-source-global="memoryRecallRecentCount" type="number" min="0" max="1000" value="${settings.memoryRecallRecentCount}"><small>從預設世界書讀取 CustomExport-纪要-N／舊總結條目，按 AM 編碼選取最近 N 條，附加包裹上下文；0 關閉。獨立於劇情條目勾選。</small></label><label class="check"><input data-source-global="includeLatestUser" type="checkbox" ${settings.includeLatestUser ? 'checked' : ''}>加入最近使用者輸入（對應 $8，預設關閉）</label><div class="form-grid"><label class="field">故事時間路徑<input data-source-global="timePath" value="${escape(settings.timePath)}"><small>相對 stat_data；支援復興紀元格式。</small></label><label class="field">玩家所在地路徑<input data-source-global="locationPath" value="${escape(settings.locationPath)}"><small>相對 stat_data。快訊條依此判斷玩家身在哪一國，那一國未公開的消息會以內部密報顯示。</small></label><label class="field">角色卡新聞路徑<input data-source-global="newsPath" value="${escape(settings.newsPath)}"><small>相對 stat_data。快訊條的「本報各版」讀取這裡，只讀不寫。</small></label><label class="field">完整請求字元上限<input data-source-global="maxInputCharacters" type="number" min="1000" max="2000000" value="${settings.maxInputCharacters}"><small>含系統提示、Schema、國策狀態及來源。超限停止，不截斷、不重試；字元不是 Token。</small></label><label class="field wide">額外 MVU 路徑（每行一項，預設不送）<textarea data-source-global="variables">${escape(settings.variables.join('\n'))}</textarea><small>故事時間仍會在本機讀取，不需要把整個「世界」物件送給 API。</small></label><label class="field wide">補充來源需求<textarea data-source-global="extra">${escape(settings.extra)}</textarea></label></div></fieldset>
      <div class="api-actions"><label>預覽任務<select data-source-preview-job>${jobKinds.map((kind) => `<option value="${kind}" ${kind === previewJob ? 'selected' : ''}>${labels[kind]}</option>`).join('')}</select></label><button data-source-action="preview">預覽將送出的來源（不呼叫 API）</button></div><p class="api-status" role="status">${escape(status)}</p>${preview ? `<label class="field" data-source-preview>來源預覽<textarea readonly rows="15">${escape(preview)}</textarea></label>` : ''}`;
  }
  async function loadEntries() {
    const version = ++revision;
    const selection = structuredClone(bookConfig());
    loading = true;
    status = '讀取世界書…';
    render();
    try {
      const [catalog, rows] = await Promise.all([
        controller.platform.worldbooks(),
        controller.platform.sources(selection),
      ]);
      if (disposed || revision !== version || controller.platform.chatId() !== chatId) {
        return;
      }
      read();
      books = catalog;
      entries = rows;
      // Workflow Assistant sanitises saved selections: drop UIDs that no longer exist in the book.
      let removed = 0;
      const enabled = bookConfig().enabledEntries;
      for (const book of new Set(rows.map((entry) => entry.book))) {
        const ids = enabled[book];
        if (ids) {
          const present = new Set(rows.filter((entry) => entry.book === book).map((entry) => entry.uid));
          const kept = ids.filter((uid) => present.has(uid));
          removed += ids.length - kept.length;
          enabled[book] = kept;
        }
      }
      status = `已載入 ${rows.length} 個條目${removed ? `，移除 ${removed} 個已不存在的勾選` : ''}。未手動調整的世界書沿用酒館啟用狀態。`;
      onChange(structuredClone(settings));
    } finally {
      if (revision === version) {
        loading = false;
      }
    }
    render();
  }
  const click = (event: Event) => {
    const button = (event.target as Element).closest<HTMLElement>('[data-source-action]');
    if (!button) {
      return;
    }
    void (async () => {
      try {
        read();
        revision++;
        preview = '';
        if (controller.platform.chatId() !== chatId) {
          throw new Error('聊天已切換，請重新開啟世界書與上下文設定');
        }
        const context = contextConfig();
        const key = button.dataset.ruleKind as 'contextExtractRules' | 'contextExcludeRules';
        switch (button.dataset.sourceAction) {
          case 'add-rule':
            context[key].push({ start: '', end: '' });
            break;
          case 'delete-rule':
            context[key].splice(Number(button.dataset.ruleIndex), 1);
            break;
          case 'load':
            await loadEntries();
            return;
          case 'all':
          case 'none':
            if (!entries.length) {
              throw new Error('請先載入世界書條目，再使用全選／全不選。');
            }
            for (const book of new Set(entries.map((entry) => entry.book))) {
              bookConfig().enabledEntries[book] =
                button.dataset.sourceAction === 'all'
                  ? entries
                      .filter((entry) => entry.book === book && entry.enabled && !entryExclusion(entry))
                      .map((entry) => entry.uid)
                  : [];
            }
            break;
          case 'target':
            target = button.dataset.target as typeof target;
            entries = [];
            status = '';
            await loadEntries();
            return;
          case 'preview': {
            const version = ++revision;
            const config = structuredClone(getConfig());
            config.sources = SourcesSchema.parse(settings);
            const snapshot = await controller.platform.read(config, previewJob);
            if (disposed || version !== revision || controller.platform.chatId() !== chatId) {
              return;
            }
            const report = snapshot.sourceReport;
            const body = JSON.stringify(snapshot.context, null, 2);
            preview = report
              ? [
                  `來源共 ${report.characters.toLocaleString()} 字元（含自訂或修改過的提示詞段）。這裡不含內建提示詞、Schema 與國策狀態；完整請求會在任務送出前再次檢查 ${report.limit.toLocaleString()} 字元上限。`,
                  ...report.blocks.map(
                    (block) =>
                      `${block.placeholder ? `${block.placeholder} ` : ''}${block.name}: ${block.placement === 'off' ? '未開啟' : `${block.characters.toLocaleString()} 字元${block.placement === 'segment' ? '（由提示詞段送出）' : ''}`}`,
                  ),
                  ...report.segments.map(
                    (segment) =>
                      `提示詞段「${segment.name}」${segment.role}${segment.kind === 'data' ? ' · 任務資料（JSON 於執行時填入）' : segment.kind === 'custom' ? '' : ' · 內建'} · ${segment.characters.toLocaleString()} 字元`,
                  ),
                  ...report.notes,
                  ...report.history.map(
                    (row) =>
                      `AI 樓 ${row.id}: ${row.before.toLocaleString()} → ${row.after.toLocaleString()} 字元${row.extractionMissed ? '【提取未命中，保留原文】' : ''}`,
                  ),
                  ...report.entries.map(
                    (row) =>
                      `${row.book}:${row.uid} ${row.name} · ${row.status} · ${row.characters.toLocaleString()} 字元`,
                  ),
                  '\n實際來源內容（JSON 部分）：',
                  body.slice(0, 50000),
                  body.length > 50000 ? '\n【畫面僅顯示前 50,000 字元；實際來源未截斷】' : '',
                  ...(snapshot.prompts ?? [])
                    .filter((message) => message.kind !== 'data')
                    .map(
                      (message, index) =>
                        `\n提示詞段 #${index + 1}「${message.name || '未命名段'}」（${message.role}）：\n${message.content.slice(0, 20000)}${message.content.length > 20000 ? '\n【僅顯示前 20,000 字元】' : ''}`,
                    ),
                ].join('\n')
              : body;
            status =
              report && report.characters > report.limit
                ? '來源本身已超過請求上限；請先縮小資料範圍。'
                : '預覽完成，未呼叫 API。';
            break;
          }
        }
        onChange(structuredClone(settings));
      } catch (error) {
        status = error instanceof Error ? error.message : String(error);
      }
      if (!disposed) {
        render();
      }
    })();
  };
  const change = (event: Event) => {
    const input = event.target as HTMLInputElement;
    let reload = false;
    read();
    revision++;
    preview = '';
    host.querySelector('[data-source-preview]')?.remove();
    if (input.dataset.sourceMode && target !== 'default') {
      setOverride(target, input.dataset.sourceMode as 'context' | 'worldbook', input.value === 'custom');
      entries = [];
      reload = true;
    } else if (input.matches('[data-book-source]')) {
      bookConfig().source = input.value as 'character' | 'manual';
      entries = [];
      reload = true;
    } else if (input.matches('[data-manual-books]')) {
      entries = [];
      reload = true;
    } else if (input.dataset.sourceBook !== undefined) {
      const book = input.dataset.sourceBook;
      bookConfig().manualSelection = input.checked
        ? [...new Set([...bookConfig().manualSelection, book])]
        : bookConfig().manualSelection.filter((name) => name !== book);
      entries = [];
      reload = true;
    } else if (input.dataset.sourceEntry !== undefined) {
      const entry = entries[Number(input.dataset.sourceEntry)];
      const selected =
        bookConfig().enabledEntries[entry.book] ??
        entries
          .filter((row) => row.book === entry.book && row.enabled && !entryExclusion(row))
          .map((row) => row.uid);
      bookConfig().enabledEntries[entry.book] = input.checked
        ? [...new Set([...selected, entry.uid])]
        : selected.filter((id) => id !== entry.uid);
    } else if (input.matches('[data-source-preview-job]')) {
      previewJob = input.value as JobKind;
    } else if (input.dataset.sourceGlobal === 'autoIncludeTables') {
      // Re-render so table entries show whether they are included automatically.
    } else {
      // Text-field blur must not replace the button the user is about to click.
      return;
    }
    onChange(structuredClone(settings));
    render();
    if (reload) {
      // Workflow Assistant refreshes the entry list whenever the book selection changes.
      void loadEntries().catch((error) => {
        status = `無法載入條目：${error instanceof Error ? error.message : String(error)}`;
        render();
      });
    }
  };
  const filter = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const isBook = input.matches('[data-book-filter]');
    if (!isBook && !input.matches('[data-entry-filter]')) {
      return;
    }
    if (isBook) {
      bookFilter = input.value;
    } else {
      entryFilter = input.value;
    }
    for (const row of host.querySelectorAll<HTMLElement>(isBook ? '.source-book' : '.source-entry')) {
      row.hidden = !row.dataset.filterText!.includes(input.value.toLowerCase());
    }
  };
  host.addEventListener('click', click);
  host.addEventListener('change', change);
  host.addEventListener('input', filter);
  render();
  void loadEntries().catch((error) => {
    if (!disposed) {
      loading = false;
      status = `無法載入世界書：${error instanceof Error ? error.message : String(error)}`;
      read();
      render();
    }
  });
  const reload = () =>
    void loadEntries().catch((error) => {
      if (!disposed) {
        status = `無法載入條目：${error instanceof Error ? error.message : String(error)}`;
        render();
      }
    });
  return {
    read,
    /** Called from the task editor: switch a task between the defaults and its own copy. */
    setMode(kind: JobKind, key: 'context' | 'worldbook', custom: boolean) {
      read();
      setOverride(kind, key, custom);
      onChange(structuredClone(settings));
      if (target === kind || target === 'default') {
        entries = target === kind ? [] : entries;
        render();
        if (target === kind) {
          reload();
        }
      }
    },
    /** Show one task's settings (or the defaults when it has none). */
    focus(kind: JobKind) {
      read();
      const next = settings.overrides[kind] ? kind : 'default';
      if (next !== target) {
        target = next;
        entries = [];
        status = '';
        render();
        reload();
      }
    },
    dispose() {
      disposed = true;
      revision++;
      host.removeEventListener('click', click);
      host.removeEventListener('change', change);
      host.removeEventListener('input', filter);
    },
  };
}
