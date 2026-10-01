import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeBranchReferences } from '../src/branch-references';
import { createState, installCountry } from '../src/engine';
import { GeneratedTreeSchema, validateTopology } from '../src/generation';
import { layoutTree } from '../src/layout';
import { CandidatesSchema, ProposalSchema, TreeSchema, defaultConfig, type FocusNode } from '../src/model';
import { PeriodReplySchema, periodAnchor, transitionPeriod } from '../src/periods';
import { assertCapabilityOrder } from '../src/reachability';
import { repairReply } from '../src/repair';
import { DEFAULT_GUIDE } from '../src/prompts';
import { replacePlaceholders } from '../src/sources';
import { applyTaskPreset, importTaskPresets } from '../src/task-presets';
import YAML from 'yaml';

/** The latest weaver preset spells out output shapes; its examples must stay valid against the real schemas. */
const file = new URL('../presets/織界國策-任務預設-v5.4-格式強化版.json', import.meta.url);
const raw = JSON.parse(readFileSync(file, 'utf8'));
const preset = raw.presets[0];
type Item = { id: string; kind: string; role: string; content: string; enabled: boolean };
const prompts = (job: string): Item[] => preset.jobs[job].prompts;
const segment = (job: string, id: string) => prompts(job).find((item) => item.id === id)!;
const examples = (job: string) =>
  [...segment(job, 'nf-format').content.matchAll(/<范例 stage="([a-z]+)">\n([\s\S]*?)\n<\/范例>/g)].map(
    ([, stage, text]) => ({ stage, value: JSON.parse(text) as unknown }),
  );

test('weaver preset imports and applies as a task preset', () => {
  const { config, names } = importTaskPresets(defaultConfig(), raw);
  assert.deepEqual(names, [preset.name]);
  const applied = applyTaskPreset(config, preset.name);
  assert.equal(applied.jobs.generate.prompts.length, prompts('generate').length);
});

test('weaver preset generate example passes the tree schema, topology and capability order', () => {
  const [example] = examples('generate').filter((item) => item.stage === 'generate');
  const tree = normalizeBranchReferences(GeneratedTreeSchema.parse(repairReply(example.value, 'generate')));
  validateTopology(tree.nodes, 'standard');
  assertCapabilityOrder(tree.nodes as FocusNode[], [], []);
});

test('weaver preset update, reshape and identify examples pass their schemas', () => {
  const update = examples('update');
  assert.equal(update.length, 2);
  for (const { value } of update) {
    assert.deepEqual(ProposalSchema.parse(value).edits, []);
  }
  const [reshape] = examples('reshape');
  assert.equal(ProposalSchema.parse(reshape.value).edits.length, 1);
  CandidatesSchema.parse(examples('identify')[0].value);
});

test('weaver preset chains reset macros first and read only variables they set', () => {
  for (const job of ['identify', 'generate', 'update', 'reshape']) {
    const chain = prompts(job);
    assert.equal(chain[0].id, 'nf-reset');
    assert.ok(chain[0].enabled);
    const reset = new Set([...chain[0].content.matchAll(/\{\{setvar::([^:]+)::/g)].map((m) => m[1]));
    for (const item of chain) {
      for (const [, name] of item.content.matchAll(/\{\{getvar::([^}]+)\}\}/g)) {
        assert.ok(reset.has(name), `${job}/${item.id} 读取未重置的变量 ${name}`);
      }
    }
    // Placeholders ($1 $7 $U …) are replaced in every non-data segment; the format text must not contain them.
    assert.doesNotMatch(segment(job, 'nf-format').content, /\$(?:[125678]|U|C)/);
    const order = chain.map((item) => item.id);
    assert.ok(order.indexOf('data') < order.indexOf('nf-format'));
    // Gemini 3.7f/3.8f take no assistant prefill: the chain ends with the 卡COT as a user message.
    const last = chain.filter((item) => item.enabled).at(-1)!;
    assert.equal(last.id, 'nf-cot-lock');
    assert.equal(last.role, 'user');
    assert.equal(last.content, '{{getvar::国策_卡COT}}');
    // Model switches as in 世界后台引擎: Gemini on, DeepSeek off. Only Gemini fills the 卡COT; DeepSeek
    // ends the 开始编织 message with its thinking cue instead.
    const gemini = segment(job, 'nf-model-gemini');
    const deepseek = segment(job, 'nf-model-deepseek');
    assert.ok(gemini.enabled);
    assert.ok(!deepseek.enabled);
    for (const model of [gemini, deepseek]) {
      assert.match(model.content, /\{\{setvar::国策_思考位置::/);
      assert.ok(order.indexOf(model.id) < order.indexOf('nf-cot'));
    }
    assert.match(gemini.content, /\{\{setvar::国策_卡COT::[^}]*START THINKING/);
    assert.doesNotMatch(deepseek.content, /国策_卡COT/);
    assert.match(deepseek.content, /\{\{setvar::国策_尾部::[^}]*begin▁of▁thinking/);
    assert.match(segment(job, 'nf-tail').content, /\{\{getvar::国策_尾部\}\}$/);
  }
});

test('weaver preset period example passes the real period transition after the generate example', () => {
  const generated = examples('generate');
  const tree = normalizeBranchReferences(
    GeneratedTreeSchema.parse(
      repairReply(generated.find((item) => item.stage === 'generate')!.value, 'generate'),
    ),
  );
  const state = installCountry(
    createState(100),
    TreeSchema.parse({ ...tree, nodes: layoutTree(tree.nodes) }),
    100,
  );
  // The example assumes the last focus of the generate example is done and carried as the anchor.
  const country = state.countries[tree.id];
  country.progress.n_cabinet = {
    ...country.progress.n_cabinet,
    status: 'completed',
    started: 40,
    completed: 90,
  };
  country.capabilities.cabinet = { id: 'cabinet', name: '内阁', active: true, reason: '国策完成' };
  assert.equal(periodAnchor(country), 'n_cabinet');
  const reply = PeriodReplySchema.parse(
    repairReply(generated.find((item) => item.stage === 'period')!.value, 'period'),
  );
  const next = transitionPeriod(
    state,
    { country: tree.id, cause: 'completed', reason: '本期目的已完成', invalidateActive: false },
    reply,
  );
  const nodes = Object.keys(next.countries[tree.id].nodes);
  assert.deepEqual(nodes.sort(), ['n_cabinet', ...reply.tree.nodes.map((node) => node.id)].sort());
  assert.equal(next.countries[tree.id].period.number, 2);
});

/**
 * A small EJS subset (`<%_ _%>`, `<%- %>`, `<%= %>`) with EJS whitespace slurping, enough to run the
 * world state segment the way ST-Prompt-Template does.
 */
function renderEjs(template: string, scope: Record<string, unknown>): string {
  const source = template.replace(/[ \t]*<%_/g, '<%_').replace(/_%>[ \t]*\r?\n?/g, '_%>');
  const escape = (value: unknown) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  let code = 'let out = "";\n';
  let last = 0;
  for (const match of source.matchAll(/<%([_=-]?)([\s\S]*?)_?%>/g)) {
    code += `out += ${JSON.stringify(source.slice(last, match.index))};\n`;
    const [, kind, body] = match;
    code +=
      kind === '=' ? `out += escape(${body});\n` : kind === '-' ? `out += String(${body});\n` : `${body}\n`;
    last = match.index! + match[0].length;
  }
  code += `out += ${JSON.stringify(source.slice(last))};\nreturn out;`;
  return new Function(...Object.keys(scope), 'escape', code)(...Object.values(scope), escape);
}

test('weaver preset world state reads the engine variables and sends nothing without them', () => {
  const ids = ['generate', 'update', 'reshape'].map((job) => {
    const world = segment(job, 'nf-world');
    assert.ok(world.enabled);
    const order = prompts(job).map((item) => item.id);
    assert.ok(order.indexOf('nf-background') < order.indexOf('nf-world'));
    assert.ok(order.indexOf('nf-world') < order.indexOf('data'));
    return world.content;
  });
  assert.equal(new Set(ids).size, 1);
  assert.ok(!prompts('identify').some((item) => item.id === 'nf-world'));
  const template = ids[0];
  // Placeholders are replaced before EJS runs; the script must survive that unchanged.
  assert.equal(replacePlaceholders(template, { $1: 'x', $7: 'y', $U: 'z', $C: 'w' }), template);
  assert.doesNotMatch(template, /\{\{/);

  const empty = renderEjs(template, { getvar: () => undefined, YAML });
  assert.equal(empty.trim(), '');

  const variables: Record<string, unknown> = {
    addon_data: {
      世界: {
        甲界: {
          降临: true,
          刊报日期: '圣历-1023年-03月-01日',
          时代快讯: {
            世界时代阶段: { 时代阶段: '王权末期' },
            岁月史书: { 正史: { 古纪: { 描述: '旧史' } } },
          },
          世界剧情态势: {
            时局动态: {
              世界背景事件: { 北境战事: { 叙事指导: { 宏观层: '䷿·未济' }, 事件脉络: { d1: '开战' } } },
            },
            团体动态: { 世界背景团体: { 银盾商会: { 当前动态: '扩张', _内部: '只读' } } },
          },
          世界经济简报: { 世界经济气候: { 整体周期相位: '衰退' }, 投机市场: { 市场整体情绪: '恐慌' } },
        },
        乙界: { 降临: false, 刊报日期: '异界日', 世界剧情态势: { 时局动态: { 传闻: { 怪谈: {} } } } },
      },
    },
    post_process_tags: {
      世界状态摘要_world: {
        甲界: '<世界状态摘要 world="甲界">\n<宏观格局>王权衰落</宏观格局>\n</世界状态摘要>',
        乙界: '乙界摘要',
      },
    },
  };
  const text = renderEjs(template, { getvar: (key: string) => variables[key], YAML });
  assert.match(text, /^VOID: 以下是世界后台引擎/);
  assert.match(text, /<世界状态摘要 world="甲界">\n<宏观格局>王权衰落<\/宏观格局>\n<\/世界状态摘要>/);
  for (const kept of [
    '<世界状态 world="甲界">',
    '圣历-1023年-03月-01日',
    '王权末期',
    '北境战事',
    '开战',
    '银盾商会',
    '衰退',
  ]) {
    assert.ok(text.includes(kept), kept);
  }
  for (const dropped of ['乙界', '叙事指导', '未济', '岁月史书', '投机市场', '降临', '_内部']) {
    assert.ok(!text.includes(dropped), dropped);
  }
  assert.equal(text.match(/<世界局势>/g)?.length, 1);
});

test('weaver preset world state keeps recent history in full, needs a landed world and flags singularities', () => {
  const template = segment('update', 'nf-world').content;
  const render = (variables: Record<string, unknown>) =>
    renderEjs(template, { getvar: (key: string) => variables[key], YAML });
  // 30 eras of ~200 characters: the newest ones fit the 3,000 budget in full, the rest become titles.
  const records: Record<string, Record<string, string>> = {};
  for (let i = 1; i <= 30; i++) {
    records[`第${i}纪`] = {
      前时代称谓: `时代${i}`,
      后时代称谓: `时代${i + 1}`,
      演变起止: `约${31 - i}百年前`,
      描述: '变'.repeat(150),
      历史影响: '响'.repeat(40),
      关键转折: '不送出的转折',
    };
  }
  const point = (on: boolean, source: string, story: string) => ({
    降临: on,
    分歧源头: source,
    事件记录: { [`${story}纪段`]: { 纪段起止: '近年', 描述: story, 历史影响: '支线影响' } },
  });
  const world = (active = '') => ({
    addon_data: {
      世界: {
        甲界: {
          降临: true,
          时代快讯: {
            岁月史书: {
              正史: records,
              特异点: {
                镜像王朝: point(active === '镜像王朝', '第20纪', '镜中分裂'),
                旧梦: point(active === '旧梦', '第3纪', '旧梦复辟'),
              },
            },
          },
        },
      },
    },
  });
  const text = render(world());
  const full = [...text.matchAll(/^ {2}第(\d+)纪:$/gm)].map((m) => Number(m[1]));
  assert.ok(full.length >= 10 && full.length < 30, `full ${full.length}`);
  assert.deepEqual(
    full,
    Array.from({ length: full.length }, (_, i) => 31 - full.length + i),
  );
  assert.match(text, /早期正史:\n {2}- 第1纪（时代1 → 时代2，约30百年前）/);
  assert.match(text, new RegExp(`- 第${30 - full.length}纪（`));
  assert.ok(!text.includes(`第${30 - full.length}纪:`));
  // Singularities that are not on are not read at all.
  for (const dropped of ['关键转折', '不送出的转折', '特异点', '镜像王朝', '镜中分裂', '旧梦', '分歧源头']) {
    assert.ok(!text.includes(dropped), dropped);
  }
  // The landed singularity is read in full and flagged; the others stay out.
  const singular = render(world('镜像王朝'));
  assert.match(singular, /注意：目前正处于特异点「甲界·镜像王朝」/);
  for (const kept of ['当前特异点:', '镜像王朝:', '分歧源头: 第20纪', '镜中分裂', '支线影响']) {
    assert.ok(singular.includes(kept), kept);
  }
  assert.ok(!singular.includes('旧梦'));
  // No landed world: nothing is sent, not even summaries of other worlds.
  const idle = world();
  idle.addon_data.世界.甲界.降临 = false;
  assert.equal(render({ ...idle, post_process_tags: { 世界状态摘要_world: { 甲界: '摘要' } } }).trim(), '');
});

test('weaver preset and built-in rules require simplified Chinese output', () => {
  for (const job of ['identify', 'generate', 'update', 'reshape']) {
    for (const id of ['nf-core', 'nf-cot', 'nf-format']) {
      const text = segment(job, id).content;
      assert.match(text, /简体中文/, `${job}/${id}`);
      assert.doesNotMatch(text, /跟随<前文剧情>/, `${job}/${id}`);
    }
  }
  assert.match(DEFAULT_GUIDE, /一律使用简体中文/);
});
