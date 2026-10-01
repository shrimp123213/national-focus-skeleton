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
import { applyTaskPreset, importTaskPresets } from '../src/task-presets';

/** The v5 preset spells out output shapes; its examples must stay valid against the real schemas. */
const file = new URL('../presets/織界國策-任務預設-v5-格式強化版.json', import.meta.url);
const raw = JSON.parse(readFileSync(file, 'utf8'));
const preset = raw.presets[0];
type Item = { id: string; kind: string; role: string; content: string; enabled: boolean };
const prompts = (job: string): Item[] => preset.jobs[job].prompts;
const segment = (job: string, id: string) => prompts(job).find((item) => item.id === id)!;
const examples = (job: string) =>
  [...segment(job, 'nf-format').content.matchAll(/<范例 stage="([a-z]+)">\n([\s\S]*?)\n<\/范例>/g)].map(
    ([, stage, text]) => ({ stage, value: JSON.parse(text) as unknown }),
  );

test('v5 preset imports and applies as a task preset', () => {
  const { config, names } = importTaskPresets(defaultConfig(), raw);
  assert.deepEqual(names, [preset.name]);
  const applied = applyTaskPreset(config, preset.name);
  assert.equal(applied.jobs.generate.prompts.length, prompts('generate').length);
});

test('v5 generate example passes the tree schema, topology and capability order', () => {
  const [example] = examples('generate').filter((item) => item.stage === 'generate');
  const tree = normalizeBranchReferences(GeneratedTreeSchema.parse(repairReply(example.value, 'generate')));
  validateTopology(tree.nodes, 'standard');
  assertCapabilityOrder(tree.nodes as FocusNode[], [], []);
});

test('v5 update, reshape and identify examples pass their schemas', () => {
  const update = examples('update');
  assert.equal(update.length, 2);
  for (const { value } of update) {
    assert.deepEqual(ProposalSchema.parse(value).edits, []);
  }
  const [reshape] = examples('reshape');
  assert.equal(ProposalSchema.parse(reshape.value).edits.length, 1);
  CandidatesSchema.parse(examples('identify')[0].value);
});

test('v5 chains reset macros first and read only variables they set', () => {
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
    // Model switches as in 世界后台引擎: Gemini on, DeepSeek off; both set the thinking text and the 卡COT.
    for (const [id, enabled] of [
      ['nf-model-gemini', true],
      ['nf-model-deepseek', false],
    ] as const) {
      const model = segment(job, id);
      assert.equal(model.enabled, enabled);
      assert.match(model.content, /\{\{setvar::国策_思考位置::/);
      assert.match(model.content, /\{\{setvar::国策_卡COT::/);
      assert.ok(order.indexOf(id) < order.indexOf('nf-cot'));
    }
  }
});

test('v5 period example passes the real period transition after the generate example', () => {
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
