import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeBranchReferences } from '../src/branch-references';
import { GeneratedTreeSchema, validateTopology } from '../src/generation';
import { CandidatesSchema, ProposalSchema, defaultConfig, type FocusNode } from '../src/model';
import { assertCapabilityOrder } from '../src/reachability';
import { repairReply } from '../src/repair';
import { applyTaskPreset, importTaskPresets } from '../src/task-presets';

/** The v5 preset spells out output shapes; its examples must stay valid against the real schemas. */
const file = new URL('../presets/織界國策-任務預設-v5-格式強化版.json', import.meta.url);
const raw = JSON.parse(readFileSync(file, 'utf8'));
const preset = raw.presets[0];
type Item = { id: string; kind: string; content: string; enabled: boolean };
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
  const [example] = examples('generate');
  assert.equal(example.stage, 'generate');
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
    assert.equal(order.at(-1), 'nf-tail');
  }
});
