import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_GUIDE } from '../src/prompts';
import { INTEGRATION_VERSION } from '../src/integration';
import { GUIDANCE_TAG, parseWorldGuidance } from '../src/world-proposal';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
/** The Workflow Assistant preset that lets the world task write national-focus guidance. */
const file = new URL(
  `../presets/国策档案-v${version.replace(/-skeleton$/, '')}-预设-工作流整合.json`,
  import.meta.url,
);
const preset = JSON.parse(readFileSync(file, 'utf8'));
type Group = { name: string; role: string; content: string; enabled: boolean };
const task = preset.tasks.find((item: { name: string }) => item.name === '世界时局与经济简报');
const groups: Group[] = task.promptGroups;
const group = (name: string) => groups.find((item) => item.name === name)!;
const gate = '<%_ if (String(`{{replica:val}}`).trim() === "阿斯塔利亚") { _%>';

test('integration preset keeps structured JSON output and extracts the guidance tag only', () => {
  assert.equal(task.structuredOutputMode, 'addon_json_patch');
  assert.ok(task.extractInjectTags.includes(GUIDANCE_TAG));
  assert.ok(task.extractInjectTags.includes('世界状态摘要@world'));
  assert.equal(task.extractInjectTags.includes('国策提案'), false);
  assert.equal(JSON.stringify(preset).includes('国策提案'), false, '旧的 JSON 提案已全部移除');
});

test('integration segments sit in order and only reach the world that owns national focus', () => {
  const names = groups.map((item) => item.name);
  assert.equal(names.indexOf('国策推演规则（国策整合）'), names.indexOf('变量规则结束') - 1);
  assert.equal(names.indexOf('国策档案（国策整合）'), names.indexOf('背景信息') + 1);
  assert.ok(group('国策推演规则（国策整合）').content.startsWith(gate));
  const cot = group('COT').content;
  assert.equal(cot.split(gate).length, 3);
  assert.ok(cot.indexOf('Step4.1A') < cot.indexOf('- Step4.2：综合推演'));
  assert.ok(cot.indexOf('Step10：国策指引') < cot.indexOf('</analysis_format>'));
  assert.ok(group('deepseek尾部').content.includes(gate));
  const data = group('国策档案（国策整合）').content;
  assert.match(data, /nfReplica === "阿斯塔利亚"/);
  assert.match(data, /mode: 'request', requestId/);
  assert.ok(data.includes(`api.version !== ${INTEGRATION_VERSION}`), '预设与脚本使用同一版整合 API');
  assert.equal(/nf\.(schema|history|nonce)/.test(data), false);
});

test('integration rules ask for plain-text guidance instead of the proposal law', () => {
  const rules = group('国策推演规则（国策整合）').content;
  assert.equal(rules.includes(DEFAULT_GUIDE.trim()), false);
  assert.equal(rules.includes('<国策输出格式>'), false);
  assert.ok(rules.includes('不写 JSON'));
  assert.ok(rules.includes('control=player'), '玩家国不建议选策');
  const [, example] = /<国策指引范例>\n([\s\S]*?)\n<\/国策指引范例>/.exec(rules)!;
  assert.match(parseWorldGuidance(example), /^【奥古斯提姆帝国】/);
  const tail = group('deepseek尾部').content;
  assert.ok(tail.includes(`<${GUIDANCE_TAG}>…</${GUIDANCE_TAG}>`));
});
