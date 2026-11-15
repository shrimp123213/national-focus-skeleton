import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createState, installCountry } from '../src/engine';
import { demoTree } from '../src/demo-tree';
import { GeneratedTreeSchema } from '../src/generation';
import { StateSchema, type Politics } from '../src/model';
import { assignColors } from '../src/politics';
import { promptView, worldSummary } from '../src/prompt-view';
import { countryTree, exportTrees, importTrees, parseTreeFile } from '../src/tree-io';

const politics = (): Politics => ({
  ruling: 'crown',
  factions: [
    { id: 'crown', name: '王党', appeal: '王权高于一切', leader: '女王', stance: 'hardline', support: 40 },
    { id: 'nobles', name: '旧贵族', appeal: '恢复领主特权', stance: 'extreme', support: 30, color: 0 },
    { id: 'guilds', name: '商会派', appeal: '开放商路', stance: 'moderate', support: 20 },
    { id: 'cabinet', name: '内阁派', appeal: '由议会组阁', stance: 'moderate', support: 10 },
  ],
  members: [
    { id: 'hohen', name: '霍亨家族', kind: 'family', weight: 'heavy', faction: 'nobles', note: '北境大领主' },
    {
      id: 'academy',
      name: '星辉学塔',
      kind: 'institution',
      weight: 'heavy',
      faction: null,
      note: '不涉政争',
    },
    { id: 'mint', name: '银秤家族', kind: 'family', weight: 'medium', faction: 'guilds', note: '银行世家' },
  ],
  succession: '女王指定继承人，由枢密院确认',
});
const install = (value: unknown = politics()) =>
  installCountry(createState(0), { ...demoTree(), politics: value }, 0);
const pending = { ruling: 'cabinet', reason: '议会罢免首相，内阁派组阁', at: 0 };

test('有效政局可安装：没有色位的派系依序取第一个空位，色位互不重复并存入状态', () => {
  const input = politics();
  const state = install(input);
  const stored = state.countries.augustium.politics!;
  assert.deepEqual(
    stored.factions.map((faction) => faction.color),
    [1, 0, 2, 3],
  );
  assert.deepEqual(
    stored.factions.map(({ color: _color, ...faction }) => faction),
    input.factions.map(({ color: _color, ...faction }) => faction),
  );
  assert.deepEqual(stored.members, input.members);
  assert.equal(stored.succession, input.succession);
  assert.equal(input.factions[0].color, undefined, '不改写输入');
  assert.deepEqual(StateSchema.parse(structuredClone(state)), state);
  // A faction created later takes the slot a removed faction left.
  const [crown, nobles, , cabinet] = stored.factions;
  const next = assignColors([crown, nobles, cabinet, { ...input.factions[2], id: 'rebels' }]);
  assert.deepEqual(
    next.map((faction) => faction.color),
    [1, 0, 3, 2],
  );
});

const rejected: [string, (value: Politics) => void, RegExp | null][] = [
  [
    '支持度合计不是 100',
    (p) => {
      p.factions[3].support = 20;
    },
    /派系支持度合计须为 100，目前为 110/,
  ],
  [
    '支持度不是整数',
    (p) => {
      p.factions[2].support = 19.5;
      p.factions[3].support = 10.5;
    },
    null,
  ],
  [
    '支持度超出 0–100',
    (p) => {
      p.factions[1].support = 80;
      p.factions[2].support = -30;
    },
    null,
  ],
  [
    '超过 8 个派系',
    (p) => {
      p.factions = Array.from({ length: 9 }, (_, i) => ({
        id: `f${i}`,
        name: `派系${i}`,
        appeal: '诉求',
        stance: 'moderate' as const,
        support: i ? 1 : 92,
      }));
      p.ruling = 'f0';
      p.members = [];
    },
    null,
  ],
  [
    '派系 ID 重复',
    (p) => {
      p.factions[3].id = 'guilds';
    },
    /派系 ID 重复/,
  ],
  [
    '成员 ID 重复',
    (p) => {
      p.members[2].id = 'hohen';
    },
    /成员 ID 重复/,
  ],
  [
    '执政派系不存在',
    (p) => {
      p.ruling = 'rebels';
    },
    /执政派系 rebels 不在 factions 中/,
  ],
  [
    '成员支持不存在的派系',
    (p) => {
      p.members[0].faction = 'rebels';
    },
    /成员「霍亨家族」支持的派系 rebels 不存在；未表态请填 null/,
  ],
  [
    '色位重复',
    (p) => {
      p.factions[0].color = 0;
    },
    /派系色位重复/,
  ],
  [
    '色位超出 0–7',
    (p) => {
      p.factions[0].color = 8;
    },
    null,
  ],
  [
    '待决更替的派系不存在',
    (p) => {
      p.pending = { ...pending, ruling: 'rebels' };
    },
    /待决更替的派系 rebels 不存在/,
  ],
  [
    '未知栏位',
    (p) => {
      Object.assign(p.factions[0], { ideology: 'royalism' });
    },
    null,
  ],
];
for (const [name, corrupt, message] of rejected) {
  test(`政局验证退回：${name}`, () => {
    const value = politics();
    corrupt(value);
    // Rules the schema covers fail as schema issues under `politics`; the rest name the rule.
    assert.throws(
      () => install(value),
      message ??
        ((error: unknown) =>
          error instanceof z.ZodError && error.issues.every((i) => i.path[0] === 'politics')),
    );
  });
}

test('执政派系支持度为 0 仍可安装：只有生成时才要求大于 0', () => {
  const value = politics();
  value.factions[0].support = 0;
  value.factions[1].support = 70;
  assert.equal(install(value).countries.augustium.politics!.factions[0].support, 0);
});

test('只有一个派系仍可安装：至少两个派系只在生成时要求', () => {
  const value = politics();
  value.factions = [{ ...value.factions[0], support: 100 }];
  value.members = [];
  assert.deepEqual(
    install(value).countries.augustium.politics!.factions.map((faction) => faction.id),
    ['crown'],
  );
});

test('没有政局的树照常安装、汇出与汇入，不出现 politics 栏位', () => {
  const state = installCountry(createState(0), demoTree(), 0);
  assert.equal('politics' in state.countries.augustium, false);
  assert.equal('politics' in countryTree(state.countries.augustium), false);
  const restored = importTrees(createState(0), parseTreeFile(JSON.parse(exportTrees(state))), {
    withProgress: true,
    replace: false,
  });
  assert.equal('politics' in restored.countries.augustium, false);
});

test('汇出再汇入保留政局（色位与待决），手写树的政局在汇入时分配色位，不合规则的政局不能汇入', () => {
  const state = install({ ...politics(), pending });
  const file = JSON.parse(exportTrees(state));
  assert.deepEqual(file.countries[0].tree.politics, state.countries.augustium.politics);
  for (const withProgress of [false, true]) {
    const restored = importTrees(createState(0), parseTreeFile(file), { withProgress, replace: false });
    assert.deepEqual(restored.countries.augustium.politics, state.countries.augustium.politics);
  }
  const handmade = {
    id: 'handmade',
    name: '手写国',
    nodes: [{ id: 'a', name: '起点', branch: '主线', description: '开始', days: 30, prerequisites: [] }],
    politics: politics(),
  };
  const imported = importTrees(createState(0), parseTreeFile(handmade), {
    withProgress: false,
    replace: false,
  });
  assert.deepEqual(
    imported.countries.handmade.politics!.factions.map((faction) => faction.color),
    [1, 0, 2, 3],
  );
  const broken = politics();
  broken.factions[3].support = 5;
  assert.throws(
    () =>
      importTrees(createState(0), parseTreeFile({ ...handmade, politics: broken }), {
        withProgress: false,
        replace: false,
      }),
    /派系支持度合计须为 100，目前为 95/,
  );
});

test('生成与换期的回复格式不含政局', () => {
  assert.equal('politics' in GeneratedTreeSchema.shape, false);
  assert.equal(
    JSON.stringify(z.toJSONSchema(GeneratedTreeSchema, { io: 'input' })).includes('politics'),
    false,
  );
});

const lines = [
  '执政派系：王党（强硬）；主要派系（支持度）：王党 40%、旧贵族 30%、商会派 20%',
  '重要成员：霍亨家族（支持旧贵族）、星辉学塔（未表态）',
];
const pendingLine = '待决更替：政权已易手给内阁派，国策树尚未更新。原因：议会罢免首相，内阁派组阁';

test('正文与世界任务摘要：列出执政派系与作风、支持度前三与重要成员；没有待决时不提更替', () => {
  const state = install();
  for (const summary of [promptView(state).countries.augustium.text, worldSummary(state)]) {
    for (const line of lines) {
      assert.ok(summary.includes(`\n${line}\n`), line);
    }
    assert.equal(summary.includes('内阁派'), false, '第四大派系不列出');
    assert.equal(summary.includes('银秤家族'), false, '分量不是重的成员不列出');
    assert.equal(summary.includes('待决更替'), false);
  }
});

test('正文与世界任务摘要：有待决更替时写出易手的派系、原因与国策树尚未更新', () => {
  const state = install({ ...politics(), pending });
  for (const summary of [promptView(state).countries.augustium.text, worldSummary(state)]) {
    assert.ok(summary.includes(`\n${lines[1]}\n${pendingLine}\n`));
  }
});

test('政局只多出摘要中的政局几行；没有政局的国家与概况不受影响', () => {
  const plain = installCountry(createState(0), demoTree(), 0);
  const state = install({ ...politics(), pending });
  const strip = (text: string) =>
    text
      .split('\n')
      .filter((line) => !/^(执政派系|重要成员|待决更替)：/.test(line))
      .join('\n');
  assert.equal(strip(promptView(state).countries.augustium.text), promptView(plain).countries.augustium.text);
  assert.equal(strip(worldSummary(state)), worldSummary(plain));
  assert.equal(promptView(state).overview, promptView(plain).overview);
});
