import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// A small DOM sink for the actual card script; this tests data refresh, not visual layout.
function newspaper() {
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
    stat_data: { 世界: { 时间: 100 }, 新闻: { 快讯: { 经济: '原來的新聞' } } },
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
  const html = readFileSync(new URL('../src/news-card/card.html', import.meta.url), 'utf8');
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

test('報紙刷新自己樓層已保存的新聞與國策事件，無變動及其他變量不重繪', () => {
  const card = newspaper();
  assert.match(card.root.html, /原來的新聞/);
  assert.equal(card.draws(), 1);
  card.tick();
  card.data().stat_data.角色 = { 金幣: 999 };
  card.tick();
  assert.equal(card.draws(), 1);
  card.root.classList.add('open');
  card.nodes.get('paper')!.scrollTop = 240;
  card.data().stat_data.新闻.快讯.经济 = '變量保存後的新新聞';
  card.tick();
  assert.match(card.root.html, /變量保存後的新新聞/);
  assert.equal(card.root.classList.contains('open'), true);
  assert.equal(card.nodes.get('paper')!.scrollTop, 240);
  assert.deepEqual(card.messages.at(-1), ['national-focus:refresh-news', 3]);
  const requests = card.messages.length;
  card.data().国策.events.new = {
    id: 'new',
    title: '國策背景工作剛完成',
    description: '已保存的結果',
    countries: [],
    shownAt: 3,
    at: 100,
    public: true,
    importance: 'major',
    status: 'resolved',
  };
  card.tick();
  assert.match(card.root.html, /國策背景工作剛完成/);
  assert.equal(card.messages.length, requests, '只更新國策事件不重算角色卡新聞');
  const draws = card.draws();
  const reads = card.reads.length;
  card.close();
  card.tick();
  assert.equal(card.draws(), draws);
  assert.equal(card.reads.length, reads);
});

test('報紙無國策資料時仍等待本樓寫入，資料移除後清除舊內容', () => {
  const card = newspaper();
  const data = structuredClone(card.data());
  card.replace({ stat_data: {} });
  card.tick();
  assert.equal(card.root.hidden, true);
  assert.equal(card.root.html, '');
  data.stat_data.新闻.快讯.经济 = '稍後寫入';
  card.replace(data);
  card.tick();
  assert.equal(card.root.hidden, false);
  assert.match(card.root.html, /稍後寫入/);
  card.close();
});

test('報紙閒置及展開收合不讀取，其他樓層保存不觸發更新', () => {
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

test('MVU 保存前通知只安排有限補查，合併重複通知，卸載取消補查', () => {
  const card = newspaper();
  card.emit('mag_before_message_update', {});
  card.emit('mag_before_message_update', {});
  assert.equal(card.pending(), 3);
  card.advance(0);
  assert.equal(card.draws(), 1, 'MVU 尚未保存時不重繪');
  card.data().stat_data.新闻.快讯.经济 = 'MVU 稍後保存';
  card.advance(250);
  assert.match(card.root.html, /MVU 稍後保存/);
  card.advance(60_000);
  assert.equal(card.reads.length, 4, '初次讀取加三次補查');
  assert.equal(card.pending(), 0);
  card.emit('mag_before_message_update', {});
  card.close();
  card.advance(60_000);
  card.tick();
  card.emit('mag_before_message_update', {});
  assert.equal(card.reads.length, 4);
  assert.equal(card.pending(), 0);
});
