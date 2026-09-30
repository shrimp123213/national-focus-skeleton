import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// A small DOM sink for the actual card script; this tests data refresh, not visual layout.
function newspaper(transformHtml: (html: string) => string = (html) => html) {
  const nodes = new Map<string, Element>();
  let draws = 0;
  class Element {
    hidden = true;
    open = false;
    scrollTop = 0;
    textContent = '';
    onclick: unknown = null;
    dataset = {};
    handlers = new Map<string, (event: any) => void>();
    classes = new Set<string>();
    style = { setProperty() {} };
    classList = {
      contains: (name: string) => this.classes.has(name),
      add: (name: string) => this.classes.add(name),
      remove: (name: string) => this.classes.delete(name),
      toggle: (name: string, enabled = !this.classes.has(name)) => {
        if (enabled) {
          this.classes.add(name);
        } else {
          this.classes.delete(name);
        }
      },
    };
    html = '';
    constructor(readonly id: string) {}
    set innerHTML(html: string) {
      draws++;
      this.html = html;
      nodes.clear();
      nodes.set('nb', this);
      for (const match of html.matchAll(/id="([^"]+)"/g)) {
        nodes.set(match[1], new Element(match[1]));
      }
    }
    querySelector() {
      return null;
    }
    querySelectorAll(selector: string) {
      if (selector === 'details[id]') {
        return [...nodes.values()].filter((node) => node.id.startsWith('f-'));
      }
      if (selector === '.full[id]') {
        return [...nodes.values()].filter((node) => node.classes.has('full'));
      }
      return [];
    }
    addEventListener(event: string, callback: (event: any) => void) {
      this.handlers.set(event, callback);
    }
  }
  const root = new Element('nb');
  nodes.set('nb', root);
  let saved: Record<string, any> = {
    stat_data: { 世界: { 时间: 100 }, 新闻: { 快讯: { 经济: '原来的新闻' } } },
    国策: { countries: {}, events: {}, 快讯: { newsPath: '新闻', changed: ['快讯/经济'], updated: {} } },
  };
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const callback of listeners.get(event) ?? []) {
      callback(...args);
    }
  };
  const advance = (delay: number) => {
    const until = now + delay;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) {
        break;
      }
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = until;
  };
  let unload: (() => void) | undefined;
  const messages: unknown[][] = [];
  const reads: number[] = [];
  const html = transformHtml(readFileSync(new URL('../src/news-card/card.html', import.meta.url), 'utf8'));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  runInNewContext(script, {
    document: { getElementById: (id: string) => nodes.get(id) },
    window: {
      top: { innerHeight: 900 },
      addEventListener: (_: string, callback: () => void) => {
        unload = callback;
      },
    },
    getCurrentMessageId: () => 3,
    getVariables: (options: { type: string; message_id?: number }) => {
      if (options.type === 'global') {
        return {};
      }
      assert.equal(options.message_id, 3);
      reads.push(3);
      return structuredClone(saved);
    },
    eventEmit: (...args: unknown[]) => {
      messages.push(args);
    },
    eventOn: (event: string, callback: (...args: any[]) => void) => {
      const group = listeners.get(event) ?? new Set();
      group.add(callback);
      listeners.set(event, group);
      return { stop: () => group.delete(callback) };
    },
    localStorage: { getItem: () => null },
    setTimeout: (callback: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    console: {
      warn: (...args: unknown[]) => {
        assert.fail(String(args));
      },
    },
  });
  return {
    root,
    nodes,
    messages,
    reads,
    tick: () => emit('national-focus:news-saved', 3),
    emit,
    advance,
    pending: () => timers.size,
    close: () => unload?.(),
    draws: () => draws,
    data: () => saved,
    replace: (value: Record<string, any>) => {
      saved = value;
    },
  };
}

test('报纸经酒馆额外 HTML 实体解码后仍能启动并安全显示新闻', () => {
  // messageFormatting decodes &amp; inside Markdown code blocks before the helper reads
  // their text into an iframe. Reproduce the resulting extra entity decode on the card.
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    '#39': "'",
  };
  const card = newspaper((html) =>
    html.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => entities[entity]),
  );
  assert.equal(card.root.hidden, false, '空 events 也须显示报纸');
  card.data().stat_data.新闻.快讯.经济 = `<img src=x onerror="alert('x')"> & 新闻`;
  card.tick();
  assert.ok(card.root.html.includes('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp; 新闻'));
  assert.ok(!card.root.html.includes('<img src=x'));
  card.close();
});

test('报纸刷新自己楼层已保存的新闻与国策事件，无变动及其他变量不重绘', () => {
  const card = newspaper();
  assert.match(card.root.html, /原来的新闻/);
  assert.equal(card.draws(), 1);
  card.tick();
  card.data().stat_data.角色 = { 金币: 999 };
  card.tick();
  assert.equal(card.draws(), 1);
  card.root.classList.add('open');
  card.nodes.get('paper')!.scrollTop = 240;
  card.data().stat_data.新闻.快讯.经济 = '变量保存后的新新闻';
  card.tick();
  assert.match(card.root.html, /变量保存后的新新闻/);
  assert.equal(card.root.classList.contains('open'), true);
  assert.equal(card.nodes.get('paper')!.scrollTop, 240);
  assert.deepEqual(card.messages.at(-1), ['national-focus:refresh-news', 3]);
  const requests = card.messages.length;
  card.data().国策.events.new = {
    id: 'new',
    title: '国策背景工作刚完成',
    description: '已保存的结果',
    countries: [],
    shownAt: 3,
    at: 100,
    public: true,
    importance: 'major',
    status: 'resolved',
  };
  card.tick();
  assert.match(card.root.html, /国策背景工作刚完成/);
  assert.equal(card.messages.length, requests, '只更新国策事件不重算角色卡新闻');
  const draws = card.draws();
  const reads = card.reads.length;
  card.close();
  card.tick();
  assert.equal(card.draws(), draws);
  assert.equal(card.reads.length, reads);
});

test('报纸无国策资料时仍等待本楼写入，资料移除后清除旧内容', () => {
  const card = newspaper();
  const data = structuredClone(card.data());
  card.replace({ stat_data: {} });
  card.tick();
  assert.equal(card.root.hidden, true);
  assert.equal(card.root.html, '');
  data.stat_data.新闻.快讯.经济 = '稍后写入';
  card.replace(data);
  card.tick();
  assert.equal(card.root.hidden, false);
  assert.match(card.root.html, /稍后写入/);
  card.close();
});

test('报纸闲置及展开收合不读取，其他楼层保存不触发更新', () => {
  const card = newspaper();
  const reads = card.reads.length;
  card.advance(60_000);
  card.emit('national-focus:news-saved', 99);
  const strip = card.nodes.get('strip')!;
  const click = strip.handlers.get('click')!;
  click({ target: { closest: () => null } });
  assert.equal(card.root.classList.contains('open'), true);
  click({ target: { closest: () => null } });
  assert.equal(card.root.classList.contains('open'), false);
  assert.equal(card.reads.length, reads);
  assert.equal(card.pending(), 0);
  card.close();
});

test('MVU 保存前通知只安排有限补查，合并重复通知，卸载取消补查', () => {
  const card = newspaper();
  card.emit('mag_before_message_update', {});
  card.emit('mag_before_message_update', {});
  assert.equal(card.pending(), 3);
  card.advance(0);
  assert.equal(card.draws(), 1, 'MVU 尚未保存时不重绘');
  card.data().stat_data.新闻.快讯.经济 = 'MVU 稍后保存';
  card.advance(250);
  assert.match(card.root.html, /MVU 稍后保存/);
  card.advance(60_000);
  assert.equal(card.reads.length, 4, '初次读取加三次补查');
  assert.equal(card.pending(), 0);
  card.emit('mag_before_message_update', {});
  card.close();
  card.advance(60_000);
  card.tick();
  card.emit('mag_before_message_update', {});
  assert.equal(card.reads.length, 4);
  assert.equal(card.pending(), 0);
});
