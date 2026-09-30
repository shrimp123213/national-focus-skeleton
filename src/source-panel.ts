import { jobKinds, SourcesSchema, type Config, type JobKind, type SourceSettings } from './model';
import { entryExclusion, selectedEntry, tableEntry } from './sources';
import type { SourceEntry } from './platform';
import type { FocusController } from './workflow';

const escape = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const labels = { identify: '辨识国家', generate: '生成国策树', update: '局势更新', reshape: '重大改树' };

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
        return `<div class="source-group">${escape(book)} · 已选 ${count}／${rows.length}</div>${rows
          .map(({ entry, index }) => {
            const excluded = entryExclusion(entry);
            const automatic = !excluded && settings.autoIncludeTables && tableEntry(entry);
            const text = `${entry.book} ${entry.name}`.toLowerCase();
            return `<label class="source-entry ${entry.enabled ? '' : 'source-disabled'}" data-filter-text="${escape(text)}" ${text.includes(query) ? '' : 'hidden'}><input type="checkbox" data-source-entry="${index}" ${automatic || (!excluded && selectedEntry(entry, selected)) ? 'checked' : ''} ${excluded || automatic ? 'disabled' : ''}><span>${escape(entry.name || `条目 ${entry.uid}`)}<small>${escape(excluded || (automatic ? '资料库表格 · 自动纳入' : entry.strategy?.type === 'constant' ? '常驻' : '关键字触发'))} · ${entry.content.length.toLocaleString()} 字元${entry.enabled ? '' : ' · 酒馆停用'}</small></span></label>`;
          })
          .join('')}`;
      })
      .join('');
  }
  function render(): void {
    const context = contextConfig();
    const selection = bookConfig();
    const ruleEditor = (key: 'contextExtractRules' | 'contextExcludeRules', name: string) =>
      `<h4>${name}</h4><div data-rule-list="${key}">${context[key].map((rule, index) => `<div class="source-rule" data-rule-row="${index}"><input aria-label="开始词" data-boundary="start" placeholder="开始词，如 &lt;content" value="${escape(rule.start)}"><input aria-label="结束词" data-boundary="end" placeholder="结束词，如 &lt;/content&gt;" value="${escape(rule.end)}"><button data-source-action="delete-rule" data-rule-kind="${key}" data-rule-index="${index}">删除</button></div>`).join('')}</div><button data-source-action="add-rule" data-rule-kind="${key}">＋ 新增${name}</button>`;
    const customized = jobKinds.filter((kind) => settings.overrides[kind]);
    const scope =
      target === 'default'
        ? `<div class="source-scope"><span>正在编辑：<b>预设</b>（所有任务）</span>${customized.map((kind) => `<button data-source-action="target" data-target="${kind}">编辑「${labels[kind]}」专用</button>`).join('')}</div><small class="muted">要让某项任务使用不同的世界书或上下文，到「任务」分页把该任务的「世界书与上下文」改成「此任务自订」。</small>`
        : `<div class="source-scope custom"><span>正在编辑：<b>${labels[target]}</b> 专用</span><label>世界书<select data-source-mode="worldbook"><option value="inherit">沿用预设</option><option value="custom" ${customBooks() ? 'selected' : ''}>此任务自订</option></select></label><label>上下文<select data-source-mode="context"><option value="inherit">沿用预设</option><option value="custom" ${customContext() ? 'selected' : ''}>此任务自订</option></select></label><button data-source-action="target" data-target="default">回到预设</button></div>`;
    host.innerHTML = `<h3>世界书与上下文</h3><p class="muted">只读取所选来源。常驻条目直接纳入；绿灯条目须命中整理后的上下文／补充提示词，最多递回扫描 10 轮，不自动加入全域世界书。</p>
      ${scope}
      <fieldset ${customBooks() ? '' : 'disabled'}><legend>剧情世界书（对应 $1）</legend><label class="field">来源<select data-book-source><option value="character" ${selection.source === 'character' ? 'selected' : ''}>目前角色绑定</option><option value="manual" ${selection.source === 'manual' ? 'selected' : ''}>手动选择世界书</option></select></label><small>目前角色绑定：${escape(books.character.join('、') || '尚未载入／未绑定')}</small>
      ${selection.source === 'manual' ? `<label class="field">筛选世界书<input data-book-filter value="${escape(bookFilter)}" placeholder="世界书名称"></label><div class="source-list">${books.all.map((book) => `<label class="check source-book" ${book.toLowerCase().includes(bookFilter.toLowerCase()) ? '' : 'hidden'} data-filter-text="${escape(book.toLowerCase())}"><input type="checkbox" data-source-book="${escape(book)}" ${selection.manualSelection.includes(book) ? 'checked' : ''}>${escape(book)}</label>`).join('')}</div><label class="field">手动选书（每行一项；空白就是不选书）<textarea data-manual-books>${escape(selection.manualSelection.join('\n'))}</textarea></label>` : ''}
      <div class="api-actions"><button data-source-action="load">载入／刷新世界书与条目</button><button data-source-action="all">全选启用条目</button><button data-source-action="none">全不选</button></div><p class="muted">全不选会保存为空清单，不会回退成全选。酒馆停用条目可以个别勾选，不改动酒馆设定。规则／MVU／工作流托管与纪要专用条目不纳入剧情扫描。</p>
      <label class="check"><input type="checkbox" data-source-global="autoIncludeTables" ${settings.autoIncludeTables ? 'checked' : ''}>资料库表格条目一律纳入<small>开启后 TavernDB-ACU 表格汇出（纪要、主角资讯、托管条目除外）不受勾选限制，也不看酒馆启用状态；关闭时与一般条目相同，全不选即排除。</small></label>
      <label class="field">筛选条目／世界书<input data-entry-filter value="${escape(entryFilter)}"></label><div class="source-list" data-entry-list>${entryList(selection.enabledEntries) || `<p>${loading ? '读取中…' : '尚未载入条目。'}</p>`}</div></fieldset>
      <fieldset ${customContext() ? '' : 'disabled'}><legend>预设上下文（对应 $7）</legend><label class="field">最近 N 则 AI 回复<input data-source-count type="number" min="0" max="100" value="${context.contextTurnCount}"><small>N 包含当前回复；0 只保留当前楼。使用目前 Swipe，排除使用者与系统讯息。</small></label>
      <details><summary>提取与排除规则说明</summary><p>先提取，再排除。每条规则匹配最后一组完整边界，不分大小写；开始词支援 &lt;tp、&lt;content 等未闭合开标签前缀，保留边界本身。多条提取结果依规则顺序合并；全部未命中时沿用原文，预览会标示。排除规则每条只移除最后一组，也套用于合并后的世界书内容。</p></details>${ruleEditor('contextExtractRules', '提取规则')}${ruleEditor('contextExcludeRules', '排除规则')}</fieldset>
      <fieldset><legend>其他来源（对应 $2／$5／$U／$C，预设关闭）</legend><div class="source-toggles"><label class="check"><input type="checkbox" data-source-global="managedEntries" ${settings.managedEntries ? 'checked' : ''}>工作流托管条目（$2）<small>角色绑定世界书中的 WorkflowHelper-* 条目，只取酒馆已启用者，按相同扫描规则触发。</small></label><label class="check"><input type="checkbox" data-source-global="summaryIndex" ${settings.summaryIndex ? 'checked' : ''}>纪要索引（$5）<small>预设世界书的 TavernDB-ACU-CustomExport-纪要索引；没有时改读资料库插件的纪要表或总体大纲。</small></label><label class="check"><input type="checkbox" data-source-global="persona" ${settings.persona ? 'checked' : ''}>使用者设定与主角资料（$U）<small>酒馆 persona 描述，加上角色世界书的「主角信息」汇出条目。</small></label><label class="check"><input type="checkbox" data-source-global="characterDescription" ${settings.characterDescription ? 'checked' : ''}>角色描述（$C）<small>目前角色卡的 description，经巨集／EJS 处理。</small></label></div><p class="muted">在任务的提示词段写入这些占位符时，即使此处未开启也会读取，并只在提示词段送出。</p></fieldset>
      <fieldset><legend>记忆回溯（对应 $6）与其他来源</legend><label class="field">最近 N 条 AM 纪要<input data-source-global="memoryRecallRecentCount" type="number" min="0" max="1000" value="${settings.memoryRecallRecentCount}"><small>从预设世界书读取 CustomExport-纪要-N／旧总结条目，按 AM 编码选取最近 N 条，附加包裹上下文；0 关闭。独立于剧情条目勾选。</small></label><label class="check"><input data-source-global="includeLatestUser" type="checkbox" ${settings.includeLatestUser ? 'checked' : ''}>加入最近使用者输入（对应 $8，预设关闭）</label><div class="form-grid"><label class="field">故事时间路径<input data-source-global="timePath" value="${escape(settings.timePath)}"><small>相对 stat_data；支援复兴纪元格式。</small></label><label class="field">玩家所在地路径<input data-source-global="locationPath" value="${escape(settings.locationPath)}"><small>相对 stat_data。快讯条依此判断玩家身在哪一国，那一国未公开的消息会以内部密报显示。</small></label><label class="field">角色卡新闻路径<input data-source-global="newsPath" value="${escape(settings.newsPath)}"><small>相对 stat_data。快讯条的「本报各版」读取这里，只读不写。</small></label><label class="field">完整请求字元上限<input data-source-global="maxInputCharacters" type="number" min="1000" max="2000000" value="${settings.maxInputCharacters}"><small>含系统提示、Schema、国策状态及来源。超限停止，不截断、不重试；字元不是 Token。</small></label><label class="field wide">额外 MVU 路径（每行一项，预设不送）<textarea data-source-global="variables">${escape(settings.variables.join('\n'))}</textarea><small>故事时间仍会在本机读取，不需要把整个「世界」物件送给 API。</small></label><label class="field wide">补充来源需求<textarea data-source-global="extra">${escape(settings.extra)}</textarea></label></div></fieldset>
      <div class="api-actions"><label>预览任务<select data-source-preview-job>${jobKinds.map((kind) => `<option value="${kind}" ${kind === previewJob ? 'selected' : ''}>${labels[kind]}</option>`).join('')}</select></label><button data-source-action="preview">预览将送出的来源（不呼叫 API）</button></div><p class="api-status" role="status">${escape(status)}</p>${preview ? `<label class="field" data-source-preview>来源预览<textarea readonly rows="15">${escape(preview)}</textarea></label>` : ''}`;
  }
  async function loadEntries() {
    const version = ++revision;
    const selection = structuredClone(bookConfig());
    loading = true;
    status = '读取世界书…';
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
      status = `已载入 ${rows.length} 个条目${removed ? `，移除 ${removed} 个已不存在的勾选` : ''}。未手动调整的世界书沿用酒馆启用状态。`;
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
          throw new Error('聊天已切换，请重新开启世界书与上下文设定');
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
              throw new Error('请先载入世界书条目，再使用全选／全不选。');
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
                  `来源共 ${report.characters.toLocaleString()} 字元（含自订或修改过的提示词段）。这里不含内建提示词、Schema 与国策状态；完整请求会在任务送出前再次检查 ${report.limit.toLocaleString()} 字元上限。`,
                  ...report.blocks.map(
                    (block) =>
                      `${block.placeholder ? `${block.placeholder} ` : ''}${block.name}: ${block.placement === 'off' ? '未开启' : `${block.characters.toLocaleString()} 字元${block.placement === 'segment' ? '（由提示词段送出）' : ''}`}`,
                  ),
                  ...report.segments.map(
                    (segment) =>
                      `提示词段「${segment.name}」${segment.role}${segment.kind === 'data' ? ' · 任务资料（JSON 于执行时填入）' : segment.kind === 'custom' ? '' : ' · 内建'} · ${segment.characters.toLocaleString()} 字元`,
                  ),
                  ...report.notes,
                  ...report.history.map(
                    (row) =>
                      `AI 楼 ${row.id}: ${row.before.toLocaleString()} → ${row.after.toLocaleString()} 字元${row.extractionMissed ? '【提取未命中，保留原文】' : ''}`,
                  ),
                  ...report.entries.map(
                    (row) =>
                      `${row.book}:${row.uid} ${row.name} · ${row.status} · ${row.characters.toLocaleString()} 字元`,
                  ),
                  '\n实际来源内容（JSON 部分）：',
                  body.slice(0, 50000),
                  body.length > 50000 ? '\n【画面仅显示前 50,000 字元；实际来源未截断】' : '',
                  ...(snapshot.prompts ?? [])
                    .filter((message) => message.kind !== 'data')
                    .map(
                      (message, index) =>
                        `\n提示词段 #${index + 1}「${message.name || '未命名段'}」（${message.role}）：\n${message.content.slice(0, 20000)}${message.content.length > 20000 ? '\n【仅显示前 20,000 字元】' : ''}`,
                    ),
                ].join('\n')
              : body;
            status =
              report && report.characters > report.limit
                ? '来源本身已超过请求上限；请先缩小资料范围。'
                : '预览完成，未呼叫 API。';
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
        status = `无法载入条目：${error instanceof Error ? error.message : String(error)}`;
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
      status = `无法载入世界书：${error instanceof Error ? error.message : String(error)}`;
      read();
      render();
    }
  });
  const reload = () =>
    void loadEntries().catch((error) => {
      if (!disposed) {
        status = `无法载入条目：${error instanceof Error ? error.message : String(error)}`;
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
