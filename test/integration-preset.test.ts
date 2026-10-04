import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProposalSchema } from '../src/model';
import { DEFAULT_GUIDE } from '../src/prompts';

/** The Workflow Assistant preset that lets the world task propose national-focus updates. */
const file = new URL('../presets/工作流助手-世界后台引擎-国策整合版.json', import.meta.url);
const preset = JSON.parse(readFileSync(file, 'utf8'));
type Group = { name: string; role: string; content: string; enabled: boolean };
const task = preset.tasks.find((item: { name: string }) => item.name === '世界时局与经济简报');
const groups: Group[] = task.promptGroups;
const group = (name: string) => groups.find((item) => item.name === name)!;
const gate = "<%_ if (String(`{{replica:val}}`).trim() === \"阿斯塔利亚\") { _%>";

test('integration preset keeps structured JSON output and extracts the proposal tag', () => {
  assert.equal(task.structuredOutputMode, 'addon_json_patch');
  assert.ok(task.extractInjectTags.includes('国策提案'));
  assert.ok(task.extractInjectTags.includes('世界状态摘要@world'));
});

test('integration segments sit in order and only reach the world that owns national focus', () => {
  const names = groups.map((item) => item.name);
  assert.equal(names.indexOf('国策推演规则（国策整合）'), names.indexOf('变量规则结束') - 1);
  assert.equal(names.indexOf('国策档案（国策整合）'), names.indexOf('背景信息') + 1);
  assert.ok(group('国策推演规则（国策整合）').content.startsWith(gate));
  const cot = group('COT').content;
  assert.equal(cot.split(gate).length, 3);
  assert.ok(cot.indexOf('Step4.1A') < cot.indexOf('- Step4.2：综合推演'));
  assert.ok(cot.indexOf('Step10') < cot.indexOf('</analysis_format>'));
  assert.ok(group('deepseek尾部').content.includes(gate));
  const data = group('国策档案（国策整合）').content;
  assert.match(data, /nfReplica === "阿斯塔利亚"/);
  assert.match(data, /mode: 'request', requestId/);
});

test('integration rules carry the script law and valid update examples', () => {
  const rules = group('国策推演规则（国策整合）').content;
  assert.ok(rules.includes(DEFAULT_GUIDE.trim()));
  const examples = [...rules.matchAll(/<范例 stage="update">\n([\s\S]*?)\n<\/范例>/g)];
  assert.equal(examples.length, 2);
  for (const [, text] of examples) {
    ProposalSchema.parse(JSON.parse(text));
  }
});
