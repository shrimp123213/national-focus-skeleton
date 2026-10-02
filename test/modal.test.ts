import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Exercise the real modal functions without exposing test-only runtime APIs.
const source = ts.createSourceFile('ui.ts', readFileSync('src/ui.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const methods: string[] = [];
function collect(node: ts.Node): void {
  if (
    ts.isFunctionDeclaration(node) &&
    ['openModal', 'updateModalJobs', 'closeModal'].includes(node.name?.text ?? '')
  ) {
    methods.push(node.getText(source));
  }
  ts.forEachChild(node, collect);
}
collect(source);
assert.equal(methods.length, 3);

// A narrow DOM sink, like newspaper.test.ts: class selection follows document order.
// It checks visibility and content ownership, not browser layout or visual acceptance.
class Element {
  hidden = false;
  className = '';
  children: Element[] = [];
  private html = '';
  focus() {}
  get innerHTML(): string {
    return this.html;
  }
  set innerHTML(value: string) {
    this.html = value;
    this.children = [...value.matchAll(/<(section|span)\b([^>]*)>/g)].map((match) => {
      const child = new Element();
      child.className = /class="([^"]*)"/.exec(match[2])?.[1] ?? '';
      child.hidden = /\bhidden\b/.test(match[2]);
      return child;
    });
  }
  querySelector(selector: string): Element | undefined {
    return this.children.find((child) => child.className.split(' ').includes(selector.slice(1)));
  }
}

function modalHarness() {
  const backdrop = new Element();
  const context = {
    backdrop,
    root: { activeElement: new Element() },
    escape: (text: string) => text,
    summary: { state: '', text: '' },
  };
  const code = ts.transpileModule(
    `
    let modal = '', previousFocus = null;
    let apiPanel, sourcePanel, taskPanel, hintObserver;
    let removing = '', importing = null, treeNotice = '';
    const taskSummary = () => summary;
    ${methods.join('\n')}
    globalThis.actions = { openModal, updateModalJobs, closeModal };
  `,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  runInNewContext(code, context);
  return {
    ...context,
    actions: (
      context as typeof context & {
        actions: {
          openModal(name: string, title: string, body: string, footer: string): void;
          updateModalJobs(): void;
          closeModal(): void;
        };
      }
    ).actions,
  };
}

test('任务窗口打开及任务状态刷新后仍显示完整对话框，可以关闭并重新打开', () => {
  const { backdrop, summary, actions } = modalHarness();
  for (const state of ['', 'busy', 'failed']) {
    summary.state = state;
    summary.text = '任务状态';
    actions.openModal('jobs', '任务', '<p>请求任务</p>', '<button data-modal="close">返回</button>');
    const dialog = backdrop.querySelector('.modal');
    assert.ok(dialog, '任务状态更新不得覆盖对话框的 class');
    assert.equal(dialog.hidden, false, '任务对话框不能被当作状态提示隐藏');
    assert.equal(dialog.innerHTML, '', '状态内容只能写入标题提示，不得替换整个窗口');
    actions.updateModalJobs();
    assert.equal(backdrop.querySelector('.modal'), dialog);
    assert.equal(dialog.hidden, false);
    actions.closeModal();
    assert.equal(backdrop.hidden, true);
    assert.equal(backdrop.innerHTML, '');
  }
});

test('其他窗口的任务状态提示正常更新，不影响窗口主体', () => {
  const { backdrop, summary, actions } = modalHarness();
  actions.openModal('log', '请求记录', '<p>回应</p>', '<button data-modal="close">返回</button>');
  const dialog = backdrop.querySelector('.modal')!;
  summary.state = 'busy';
  summary.text = '正在生成';
  actions.updateModalJobs();
  assert.equal(backdrop.querySelector('.modal'), dialog);
  assert.equal(dialog.hidden, false);
  const status = backdrop.children.find((child) => child !== dialog && child.className.includes('busy'));
  assert.ok(status);
  assert.equal(status.hidden, false);
  assert.match(status.innerHTML, /正在生成/);
  summary.state = '';
  actions.updateModalJobs();
  assert.equal(status.hidden, true);
  assert.equal(dialog.hidden, false);
});
