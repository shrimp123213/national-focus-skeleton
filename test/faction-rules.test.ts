import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProposal,
  blockers,
  conditionMet,
  createState,
  installCountry,
  startFocus,
} from '../src/engine';
import {
  CountrySchema,
  StateSchema,
  type Effect,
  type Politics,
  type Requirement,
  type State,
} from '../src/model';
import { PeriodReplySchema, transitionPeriod } from '../src/periods';
import { assignColors, settlePolitics, validatePolitics, type FactionEffect } from '../src/politics';
import { exportTrees, importTrees, parseTreeFile } from '../src/tree-io';

const politics = (): Politics => ({
  ruling: 'crown',
  factions: [
    { id: 'crown', name: '王党', appeal: '王权高于一切', leader: '女王', stance: 'hardline', support: 40 },
    { id: 'nobles', name: '旧贵族', appeal: '恢复领主特权', stance: 'extreme', support: 30 },
    { id: 'guilds', name: '商会派', appeal: '开放商路', stance: 'moderate', support: 20 },
    { id: 'cabinet', name: '内阁派', appeal: '由议会组阁', stance: 'moderate', support: 10 },
  ],
  members: [
    { id: 'hohen', name: '霍亨家族', kind: 'family', weight: 'heavy', faction: 'nobles', note: '北境大领主' },
    { id: 'mint', name: '银秤家族', kind: 'family', weight: 'medium', faction: 'guilds', note: '银行世家' },
    {
      id: 'clerks',
      name: '书记官团',
      kind: 'institution',
      weight: 'light',
      faction: 'cabinet',
      note: '内阁属吏',
    },
    {
      id: 'academy',
      name: '星辉学塔',
      kind: 'institution',
      weight: 'heavy',
      faction: null,
      note: '不涉政争',
    },
  ],
  succession: '女王指定继承人，由枢密院确认',
});
type FactionFields = Partial<Extract<FactionEffect, { kind: 'faction' }>>;
const support = (id: string, faction: string, value: -15 | -10 | -5 | 5 | 10 | 15): FactionEffect => ({
  id,
  kind: 'support',
  faction,
  value,
});
const member = (id: string, who: string, faction: string | null): FactionEffect => ({
  id,
  kind: 'member',
  member: who,
  faction,
});
const merge = (id: string, source: string, target: string): FactionEffect => ({
  id,
  kind: 'merge',
  source,
  target,
});
const faction = (id: string, key: string, fields: FactionFields = {}): FactionEffect => ({
  id,
  kind: 'faction',
  key,
  name: `${key}党`,
  appeal: '新的诉求',
  stance: 'moderate',
  ...fields,
});
const rule = (faction: string, minimum: number, negate?: boolean): Requirement => ({
  kind: 'support',
  faction,
  minimum,
  label: `派系 ${faction} 支持度 ≥ ${minimum}`,
  ...(negate === undefined ? {} : { negate }),
});

/** Settle one batch on a copy; colours are assigned first, as on install. */
function settle(effects: FactionEffect[], base: Politics = politics()) {
  const value = structuredClone(base);
  value.factions = assignColors(value.factions);
  const invalid: string[] = [];
  const applied = settlePolitics(value, effects, (effect, reason) => invalid.push(`${effect.id}：${reason}`));
  return { politics: value, applied, invalid };
}
const supports = (value: Politics) => Object.fromEntries(value.factions.map((f) => [f.id, f.support]));
const factionOf = (value: Politics, id: string) => value.members.find((m) => m.id === id)!.faction;

test('支持度结算算例：新派系起始 10 由其余派系按比例让出；首位派系 +10 由未点名派系吸收', () => {
  const created = settle([faction('new', 'rebels', { support: 10 })]);
  assert.deepEqual(supports(created.politics), { crown: 36, nobles: 27, guilds: 18, cabinet: 9, rebels: 10 });
  assert.equal(created.politics.factions.at(-1)!.color, 4);
  assert.deepEqual(created.applied, ['new']);
  const raised = settle([support('up', 'crown', 10)]);
  assert.deepEqual(supports(raised.politics), { crown: 50, nobles: 25, guilds: 17, cabinet: 8 });
});

function permutations<T>(items: T[]): T[][] {
  return items.length <= 1
    ? [items]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );
}

test('结算结果与效果的书写顺序无关（含连锁并入、同一成员两次改投、同 key 的建立与修改）', () => {
  const batches = [
    [
      faction('a', 'rebels', { support: 10 }),
      support('b', 'nobles', -10),
      support('c', 'crown', 10),
      merge('d', 'cabinet', 'guilds'),
      member('e', 'hohen', 'crown'),
      member('f', 'academy', 'rebels'),
      support('g', 'rebels', 5),
    ],
    [
      merge('a', 'nobles', 'guilds'),
      merge('b', 'guilds', 'cabinet'),
      member('c', 'mint', 'crown'),
      member('d', 'mint', null),
      faction('e', 'rebels', { support: 5 }),
      faction('f', 'rebels', { name: '新名' }),
      support('g', 'cabinet', -15),
    ],
  ];
  for (const batch of batches) {
    const expected = settle(batch);
    for (const order of permutations(batch)) {
      assert.deepEqual(settle(order), expected);
    }
  }
  // Every faction of the first batch is named, so all of them scale together: 50/20/30/15 → 100.
  const first = settle(batches[0]).politics;
  assert.deepEqual(supports(first), { crown: 44, nobles: 17, guilds: 26, rebels: 13 });
  assert.equal(factionOf(first, 'clerks'), 'guilds');
  assert.equal(factionOf(first, 'academy'), 'rebels');
});

/** mulberry32: a small seeded generator, so a failing batch can be found again. */
function generator(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('随机批次：合计恒为 100、全为整数，色位、成员与执政派系都保持有效', () => {
  const random = generator(18);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const values = [-15, -10, -5, 5, 10, 15] as const;
  const members = ['hohen', 'mint', 'clerks', 'academy', 'nobody'];
  for (let round = 0; round < 150; round++) {
    let current = settle([]).politics;
    for (let turn = 0; turn < 12; turn++) {
      const ids = [...current.factions.map((f) => f.id), 'ghost', `new${turn % 5}`];
      const batch = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, i): FactionEffect => {
        const kind = pick(['support', 'support', 'member', 'merge', 'faction'] as const);
        const id = `e${i}`;
        return kind === 'support'
          ? support(id, pick(ids), pick(values))
          : kind === 'member'
            ? member(id, pick(members), random() < 0.2 ? null : pick(ids))
            : kind === 'merge'
              ? merge(id, pick(ids), pick(ids))
              : faction(id, pick(ids), random() < 0.7 ? { support: pick([5, 10, 15] as const) } : {});
      });
      current = settle(batch, current).politics;
      const where = `第 ${round} 轮第 ${turn} 批：${JSON.stringify(batch)}`;
      assert.doesNotThrow(() => CountrySchema.shape.politics.parse(current), where);
      assert.doesNotThrow(() => validatePolitics(current), where);
      assert.equal(
        current.factions.reduce((sum, f) => sum + f.support, 0),
        100,
        where,
      );
      assert.ok(
        current.factions.every((f) => Number.isInteger(f.support) && (f.support > 0 || f.id === 'crown')),
        where,
      );
    }
  }
});

test('支持度归零的派系解散，成员转为未表态；执政派系与待决接任的派系归零也不解散', () => {
  const dropped = settle([support('down', 'cabinet', -10)]).politics;
  assert.deepEqual(supports(dropped), { crown: 45, nobles: 33, guilds: 22 });
  assert.equal(factionOf(dropped, 'clerks'), null);
  const weak = politics();
  weak.factions[0].support = 10;
  weak.factions[3].support = 40;
  const fallen = settle([support('down', 'crown', -10)], weak).politics;
  assert.deepEqual(supports(fallen), { crown: 0, nobles: 33, guilds: 22, cabinet: 45 });
  const waiting = { ...politics(), pending: { ruling: 'cabinet', reason: '议会罢免首相', at: 0 } };
  const kept = settle([support('down', 'cabinet', -10)], waiting).politics;
  assert.equal(kept.factions.find((f) => f.id === 'cabinet')!.support, 0);
  assert.equal(factionOf(kept, 'clerks'), 'cabinet');
});

test('merge：来源的支持度与成员全部归目标，来源解散；无效的并入不改任何资料', () => {
  const merged = settle([merge('join', 'nobles', 'crown')]);
  assert.deepEqual(supports(merged.politics), { crown: 70, guilds: 20, cabinet: 10 });
  assert.equal(factionOf(merged.politics, 'hohen'), 'crown');
  assert.deepEqual(merged.applied, ['join']);
  // Merges may leave only the ruling faction; a country's state still accepts that.
  const alone = settle([
    merge('a', 'nobles', 'crown'),
    merge('b', 'guilds', 'crown'),
    merge('c', 'cabinet', 'crown'),
  ]);
  assert.deepEqual(supports(alone.politics), { crown: 100 });
  assert.doesNotThrow(() => CountrySchema.shape.politics.parse(alone.politics));
  const cases: [FactionEffect, RegExp][] = [
    [merge('m', 'crown', 'nobles'), /^m：执政派系「王党」不能并入其他派系$/],
    [merge('m', 'nobles', 'nobles'), /^m：派系不能并入自己$/],
    [merge('m', 'ghost', 'nobles'), /^m：派系 ghost 不存在$/],
    [merge('m', 'nobles', 'ghost'), /^m：派系 ghost 不存在$/],
  ];
  for (const [effect, message] of cases) {
    const result = settle([effect]);
    assert.deepEqual(result.politics, settle([]).politics);
    assert.deepEqual(result.applied, []);
    assert.match(result.invalid.join('\n'), message);
  }
});

test('member 只改成员标签，不动任何支持度', () => {
  const moved = settle([member('turn', 'hohen', 'crown'), member('quiet', 'mint', null)]);
  assert.deepEqual(moved.politics.factions, settle([]).politics.factions);
  assert.equal(factionOf(moved.politics, 'hohen'), 'crown');
  assert.equal(factionOf(moved.politics, 'mint'), null);
  assert.match(settle([member('m', 'nobody', 'crown')]).invalid[0], /^m：成员 nobody 不存在$/);
  assert.match(settle([member('m', 'hohen', 'ghost')]).invalid[0], /^m：派系 ghost 不存在$/);
});

test('faction：已存在时只改名称、诉求、作风与代表人物；不存在时建立并取空出的色位；第 9 个派系不建立', () => {
  const base = settle([]).politics;
  const updated = settle([
    faction('edit', 'nobles', {
      name: '新贵族',
      appeal: '分享权力',
      stance: 'moderate',
      leader: '霍亨公爵',
      support: 15,
    }),
  ]).politics;
  assert.deepEqual(updated.factions[1], {
    id: 'nobles',
    name: '新贵族',
    appeal: '分享权力',
    leader: '霍亨公爵',
    stance: 'moderate',
    support: 30,
    color: 1,
  });
  assert.deepEqual(supports(updated), supports(base));
  // A leader the effect leaves out stays.
  assert.equal(settle([faction('edit', 'crown', { name: '王党' })]).politics.factions[0].leader, '女王');
  const missing = settle([faction('new', 'rebels')]);
  assert.deepEqual(missing.politics, base);
  assert.match(
    missing.invalid[0],
    /^new：派系 rebels 不存在，建立新派系须填起始支持度 support（5、10 或 15）$/,
  );
  // In one batch the effect that creates a faction runs before one that updates it, whatever the ids.
  const renamed = settle([faction('a', 'rebels', { name: '改名' }), faction('b', 'rebels', { support: 10 })]);
  assert.deepEqual(renamed.applied, ['b', 'a']);
  assert.equal(renamed.politics.factions.at(-1)!.name, '改名');
  assert.equal(renamed.politics.factions.at(-1)!.support, 10);
  // The dissolved cabinet frees colour 3; the next new faction takes it and the others keep theirs.
  const dissolved = settle([support('down', 'cabinet', -10)]).politics;
  const reborn = settle([faction('new', 'rebels', { support: 5, leader: '无名者' })], dissolved).politics;
  assert.deepEqual(
    reborn.factions.map((f) => [f.id, f.color]),
    [
      ['crown', 0],
      ['nobles', 1],
      ['guilds', 2],
      ['rebels', 3],
    ],
  );
  assert.equal(reborn.factions[3].leader, '无名者');
  const full = settle([
    faction('a', 'f5', { support: 5 }),
    faction('b', 'f6', { support: 5 }),
    faction('c', 'f7', { support: 5 }),
    faction('d', 'f8', { support: 5 }),
  ]).politics;
  assert.equal(full.factions.length, 8);
  const ninth = settle([faction('e', 'f9', { support: 5 })], full);
  assert.deepEqual(ninth.politics, full);
  assert.match(ninth.invalid[0], /^e：派系已有 8 个，不能再建立新派系$/);
});

const focus = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  name: `国策${id}`,
  branch: '政局',
  description: `${id} 的行动`,
  reason: '设定',
  icon: 'crown',
  x: 0,
  y: 0,
  days: 10,
  durationReason: '协商',
  prerequisites: [],
  requirements: [],
  sustain: [],
  outcomes: [],
  investments: [],
  effects: [],
  mutex: null,
  ...fields,
});
const realm = (nodes: Record<string, unknown>[], value: Politics | null) => ({
  id: 'realm',
  name: '试验王国',
  description: '试验',
  stability: 55,
  warSupport: 40,
  evidence: '设定',
  capabilities: [],
  historical: [],
  nodes: nodes.map((node, i) => ({ ...node, y: i })),
  ...(value ? { politics: value } : {}),
});
const install = (nodes: Record<string, unknown>[], value: Politics | null = politics()) =>
  installCountry(createState(0), realm(nodes, value), 0);
const complete = (state: State, node: string, until = 10) =>
  applyProposal(startFocus(state, 'realm', node), { id: `done_${node}`, until, reason: '推进', steps: [] });
const event = (effects: unknown[], fields: Record<string, unknown> = {}) => ({
  id: 'e1',
  at: 1,
  countries: ['realm'],
  title: '朝局变动',
  description: '朝中派系重新站队',
  evidence: '正文',
  origin: 'story',
  public: true,
  changes: [{ country: 'realm', effects }],
  ...fields,
});
const withEvent = (state: State, effects: unknown[], fields: Record<string, unknown> = {}) =>
  applyProposal(state, {
    id: 'news',
    until: 1,
    reason: '事件',
    steps: [{ at: 1, facts: [], events: [event(effects, fields)], selections: [] }],
  });

test('support 条件：支持度 ≥ 门槛，negate 取反；不存在的派系与没有政局的国家都视为 0', () => {
  const country = install([focus('rise', { requirements: [rule('crown', 45)] })]).countries.realm;
  assert.equal(conditionMet(country, rule('nobles', 30)), true);
  assert.equal(conditionMet(country, rule('nobles', 31)), false);
  assert.equal(conditionMet(country, rule('nobles', 31, true)), true);
  assert.equal(conditionMet(country, rule('nobles', 30, true)), false);
  assert.equal(conditionMet(country, rule('ghost', 0)), true);
  assert.equal(conditionMet(country, rule('ghost', 1)), false);
  assert.equal(conditionMet(country, rule('ghost', 1, true)), true);
  assert.deepEqual(blockers(country, country.nodes.rise), ['派系 crown 支持度 ≥ 45']);
  const plain = install([focus('x')], null).countries.realm;
  assert.equal(conditionMet(plain, rule('crown', 1)), false);
  assert.equal(conditionMet(plain, rule('crown', 1, true)), true);
});

test('国策完成：派系效果整批结算，所有 when 都在本批任何效果套用前读取', () => {
  const state = install([
    focus('purge', {
      effects: [
        support('a', 'nobles', -10),
        { ...support('b', 'guilds', 10), when: [rule('nobles', 30)] },
        { id: 'c', kind: 'stability', value: 5, when: [rule('nobles', 30)] },
        { ...member('d', 'hohen', 'crown'), when: [rule('nobles', 31)] },
      ],
    }),
  ]);
  const country = complete(state, 'purge').countries.realm;
  assert.equal(country.progress.purge.status, 'completed');
  assert.deepEqual(supports(country.politics!), { crown: 40, nobles: 20, guilds: 30, cabinet: 10 });
  assert.equal(country.stability, 60);
  assert.equal(factionOf(country.politics!, 'hohen'), 'nobles');
  assert.deepEqual(country.progress.purge.applied, ['a', 'b', 'c']);
});

test('国策完成：引用已不成立的派系效果只略过该效果，国策照常完成，其余效果照常套用', () => {
  const eight = politics();
  eight.factions = [
    ...eight.factions.map((f) => ({ ...f, support: f.support - 5 })),
    ...['f5', 'f6', 'f7', 'f8'].map((id) => ({
      id,
      name: id,
      appeal: '诉求',
      stance: 'moderate' as const,
      support: 5,
    })),
  ];
  const cases: [string, Effect, Politics | null][] = [
    ['派系不存在', support('bad', 'ghost', 5), politics()],
    ['成员不存在', member('bad', 'nobody', 'crown'), politics()],
    ['改投的派系不存在', member('bad', 'hohen', 'ghost'), politics()],
    ['并入的派系不存在', merge('bad', 'ghost', 'crown'), politics()],
    ['执政派系并入别人', merge('bad', 'crown', 'nobles'), politics()],
    ['建立新派系没有起始支持度', faction('bad', 'rebels'), politics()],
    ['第 9 个派系', faction('bad', 'rebels', { support: 5 }), eight],
    ['此国没有派系', support('bad', 'crown', 5), null],
  ];
  for (const [name, bad, value] of cases) {
    const state = install(
      [focus('x', { effects: [bad, { id: 'ok', kind: 'stability', value: 5 }] })],
      value ?? politics(),
    );
    if (!value) {
      delete state.countries.realm.politics;
    }
    const before = structuredClone(state.countries.realm.politics);
    const country = complete(state, 'x').countries.realm;
    assert.equal(country.progress.x.status, 'completed', name);
    assert.deepEqual(country.politics, before, name);
    assert.deepEqual(country.progress.x.applied, ['ok'], name);
    assert.equal(country.stability, 60, name);
  }
});

test('事件 changes：派系效果当场整批结算，when 在本批任何效果前读取；数值效果仍依书写顺序', () => {
  const state = install([focus('x')]);
  const after = withEvent(state, [
    { id: 's', kind: 'stability', value: 10 },
    { ...support('f', 'guilds', 5), when: [{ kind: 'stability', minimum: 60, label: '稳定度 ≥ 60' }] },
    {
      id: 'w',
      kind: 'warSupport',
      value: 5,
      when: [{ kind: 'stability', minimum: 60, label: '稳定度 ≥ 60' }],
    },
    faction('n', 'rebels', { support: 10 }),
    member('m', 'academy', 'rebels'),
  ]);
  const country = after.countries.realm;
  assert.equal(country.stability, 65);
  assert.equal(country.warSupport, 45);
  assert.deepEqual(supports(country.politics!), {
    crown: 36,
    nobles: 27,
    guilds: 18,
    cabinet: 9,
    rebels: 10,
  });
  assert.equal(factionOf(country.politics!, 'academy'), 'rebels');
  assert.equal(after.events.e1.changes[0].effects.length, 5);
});

test('事件 changes 中引用不成立的派系效果退回整份提案，并指出事件、国家与效果', () => {
  const state = install([focus('x')]);
  const full = politics();
  full.factions = [
    ...full.factions.map((f) => ({ ...f, support: f.support - 5 })),
    ...['f5', 'f6', 'f7', 'f8'].map((id) => ({
      id,
      name: id,
      appeal: '诉求',
      stance: 'moderate' as const,
      support: 5,
    })),
  ];
  const plain = install([focus('x')], null);
  const cases: [Effect, RegExp, State][] = [
    [support('a', 'ghost', 5), /派系 ghost 不存在/, state],
    [member('a', 'nobody', 'crown'), /成员 nobody 不存在/, state],
    [member('a', 'hohen', 'ghost'), /派系 ghost 不存在/, state],
    [merge('a', 'ghost', 'crown'), /派系 ghost 不存在/, state],
    [merge('a', 'crown', 'nobles'), /执政派系「王党」不能并入其他派系/, state],
    [merge('a', 'nobles', 'nobles'), /派系不能并入自己/, state],
    [faction('a', 'rebels'), /派系 rebels 不存在，建立新派系须填起始支持度/, state],
    [faction('a', 'rebels', { support: 5 }), /派系已有 8 个，不能再建立新派系/, install([focus('x')], full)],
    [support('a', 'crown', 5), /此国没有派系/, plain],
  ];
  for (const [bad, reason, base] of cases) {
    assert.throws(
      () => withEvent(base, [bad]),
      (error: Error) =>
        error.message.startsWith('事件 e1 对试验王国的效果 a 无法套用：') && reason.test(error.message),
    );
  }
  // A conditional effect whose condition fails is skipped for good, so it is not checked.
  const skipped = withEvent(state, [{ ...support('a', 'ghost', 5), when: [rule('crown', 90)] }]);
  assert.deepEqual(skipped.countries.realm.politics, state.countries.realm.politics);
  // The changes of an event update are checked the same way.
  const running = withEvent(state, [], { status: 'ongoing', changes: [] });
  assert.throws(
    () =>
      applyProposal(running, {
        id: 'progress',
        until: 2,
        reason: '推进',
        steps: [
          {
            at: 2,
            facts: [],
            events: [],
            selections: [],
            eventUpdates: [
              {
                id: 'e1',
                text: '继续',
                changes: [{ country: 'realm', effects: [member('a', 'nobody', null)] }],
              },
            ],
          },
        ],
      }),
    /事件 e1 对试验王国的效果 a 无法套用：成员 nobody 不存在/,
  );
});

test('本机验证：support 条件只能在 requirements 与 when；没有政局不能用派系规则；派系不能并入自己', () => {
  for (const list of ['sustain', 'outcomes']) {
    assert.throws(
      () => install([focus('x', { [list]: [rule('crown', 10)] })]),
      /国策 x：派系支持度条件只能写在 requirements 或效果的 when，不能写在 sustain 或 outcomes/,
    );
  }
  const route = { group: 'g', route: 'r', lock: 'complete', reason: '择一', backers: ['crown'] };
  for (const fields of [
    { requirements: [rule('crown', 10)] },
    { effects: [support('a', 'crown', 5)] },
    { effects: [{ id: 'a', kind: 'stability', value: 5, when: [rule('crown', 10)] }] },
    { mutex: route },
  ]) {
    assert.throws(
      () => install([focus('x', fields)], null),
      /国策 x 使用了派系条件、派系效果或 backers，但此国没有派系/,
    );
  }
  assert.throws(
    () => install([focus('x', { effects: [merge('m', 'nobles', 'nobles')] })]),
    /国策 x 的效果 m：派系不能并入自己/,
  );
  assert.deepEqual(install([focus('x', { mutex: route })]).countries.realm.nodes.x.mutex?.backers, ['crown']);
});

test('改树（edits）的新国策：引用的派系与成员须存在，执政派系不并入别人，新派系须有起始支持度', () => {
  const state = install([focus('x')]);
  const edit = (fields: Record<string, unknown>) =>
    applyProposal(
      state,
      {
        id: 'edit',
        until: 0,
        reason: '改树',
        steps: [],
        edits: [{ country: 'realm', remove: [], nodes: [{ ...focus('n', fields), y: 5 }], reason: '改写' }],
      },
      true,
    );
  const route = (backers: string[]) => ({
    group: 'g',
    route: 'r',
    lock: 'complete',
    reason: '择一',
    backers,
  });
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ requirements: [rule('ghost', 10)] }, /国策 n 引用的派系 ghost 不存在/],
    [{ effects: [{ id: 'a', kind: 'stability', value: 5, when: [rule('ghost', 1)] }] }, /派系 ghost 不存在/],
    [{ effects: [support('a', 'ghost', 5)] }, /国策 n 引用的派系 ghost 不存在/],
    [{ effects: [merge('a', 'ghost', 'crown')] }, /国策 n 引用的派系 ghost 不存在/],
    [{ effects: [member('a', 'hohen', 'ghost')] }, /国策 n 引用的派系 ghost 不存在/],
    [{ mutex: route(['crown', 'ghost']) }, /国策 n 引用的派系 ghost 不存在/],
    [{ effects: [member('a', 'nobody', 'crown')] }, /国策 n 的效果 a：成员 nobody 不存在/],
    [{ effects: [merge('a', 'crown', 'nobles')] }, /国策 n 的效果 a：执政派系不能并入其他派系/],
    [{ effects: [faction('a', 'rebels')] }, /国策 n 的效果 a：派系 rebels 不存在，建立新派系须填起始支持度/],
    [{ sustain: [rule('crown', 10)] }, /不能写在 sustain 或 outcomes/],
  ];
  for (const [fields, message] of cases) {
    assert.throws(() => edit(fields), message);
  }
  // A faction this focus creates may be named by its other effects; an existing key needs no support.
  const valid = edit({
    effects: [
      faction('a', 'rebels', { support: 10 }),
      member('b', 'academy', 'rebels'),
      support('c', 'rebels', 5),
      faction('d', 'nobles', { name: '新贵族' }),
      merge('e', 'cabinet', 'crown'),
    ],
    mutex: route(['crown', 'nobles']),
  });
  assert.equal(valid.countries.realm.nodes.n.effects.length, 5);
});

/** A focus that names `key` in every place a faction can be named. */
const uses = (id: string, key: string, route = id) =>
  focus(id, {
    requirements: [rule(key, 10)],
    effects: [
      support('a', key, 5),
      merge('b', 'cabinet', key),
      member('c', 'academy', key),
      { id: 'd', kind: 'stability', value: 5, when: [rule(key, 15)] },
    ],
    mutex: { group: 'p2_way', route, lock: 'complete', reason: '择一', backers: [key] },
  });

test('改树：本国保留或新写的国策建立的派系，其他国策可以引用；无人建立的派系仍退回', () => {
  const state = install([focus('x', { effects: [faction('found', 'rebels', { support: 10 })] })]);
  const edit = (nodes: Record<string, unknown>[], remove: string[] = []) =>
    applyProposal(
      state,
      {
        id: 'edit',
        until: 0,
        reason: '改树',
        steps: [],
        edits: [
          {
            country: 'realm',
            remove,
            nodes: nodes.map((node, i) => ({ ...node, y: 5 + i })),
            reason: '改写',
          },
        ],
      },
      true,
    );
  const after = edit([
    uses('n1', 'rebels'),
    uses('n3', 'zealots'),
    focus('n2', { effects: [faction('found', 'zealots', { support: 5 })] }),
  ]);
  assert.deepEqual(Object.keys(after.countries.realm.nodes).sort(), ['n1', 'n2', 'n3', 'x']);
  assert.deepEqual(after.countries.realm.politics, state.countries.realm.politics);
  assert.throws(() => edit([uses('n1', 'ghost')]), /国策 n1 引用的派系 ghost 不存在/);
  // A removed focus creates nothing, and an effect without a starting support creates nothing.
  assert.throws(() => edit([uses('n1', 'rebels')], ['x']), /国策 n1 引用的派系 rebels 不存在/);
  assert.throws(
    () => edit([uses('n3', 'zealots'), focus('n2', { effects: [faction('found', 'zealots')] })]),
    /国策 n3 引用的派系 zealots 不存在/,
  );
});

const branch = {
  id: 'court',
  name: '政局',
  purpose: '整顿朝局',
  supporters: '王党',
  opposition: '旧贵族',
  tradeoff: '稳定与改革',
  destination: '新的朝局',
};
function nextPeriod(state: State, nodes: Record<string, unknown>[]): State {
  const { politics: _politics, nodes: _nodes, ...definition } = realm([], politics());
  return transitionPeriod(
    state,
    { country: 'realm', cause: 'completed', reason: '议程完成', invalidateActive: false },
    PeriodReplySchema.parse({
      summary: '本期结束',
      tree: {
        ...definition,
        analysis: '新一期',
        periodTitle: '新议程',
        agenda: '整顿朝局',
        branches: [branch],
        nodes: nodes.map(({ x: _x, y: _y, ...node }) => node),
      },
    }),
  );
}

test('换期：新树可用派系规则并引用现有派系，政局原样保留；新国策的引用须成立', () => {
  const state = install([focus('x')]);
  const after = nextPeriod(state, [
    focus('p2_rally', {
      requirements: [rule('crown', 30)],
      effects: [support('a', 'crown', 5), member('b', 'academy', 'crown')],
      mutex: { group: 'p2_way', route: 'royal', lock: 'complete', reason: '择一', backers: ['crown'] },
    }),
    focus('p2_talks', {
      mutex: { group: 'p2_way', route: 'council', lock: 'complete', reason: '择一', backers: ['cabinet'] },
    }),
  ]);
  assert.equal(after.countries.realm.period.number, 2);
  assert.deepEqual(after.countries.realm.politics, state.countries.realm.politics);
  assert.deepEqual(after.countries.realm.nodes.p2_rally.mutex?.backers, ['crown']);
  assert.throws(
    () => nextPeriod(state, [focus('p2_rally', { effects: [support('a', 'ghost', 5)] })]),
    /国策 p2_rally 引用的派系 ghost 不存在/,
  );
  assert.throws(
    () => nextPeriod(state, [focus('p2_rally', { outcomes: [rule('crown', 30)] })]),
    /不能写在 sustain 或 outcomes/,
  );
  const plain = install([focus('x')], null);
  assert.throws(
    () => nextPeriod(plain, [focus('p2_rally', { requirements: [rule('crown', 30)] })]),
    /但此国没有派系/,
  );
});

test('换期：新树中一项国策建立的派系，其他国策可以引用（不检查先后）；无人建立的派系仍退回', () => {
  const state = install([focus('x')]);
  const royal = focus('p2_royal', {
    mutex: { group: 'p2_way', route: 'royal', lock: 'complete', reason: '择一', backers: ['crown'] },
  });
  const found = focus('p2_found', { effects: [faction('a', 'rebels', { support: 10 })] });
  const after = nextPeriod(state, [uses('p2_rise', 'rebels'), royal, found]);
  assert.equal(after.countries.realm.period.number, 2);
  assert.deepEqual(after.countries.realm.politics, state.countries.realm.politics);
  assert.deepEqual(after.countries.realm.nodes.p2_rise.mutex?.backers, ['rebels']);
  assert.throws(
    () => nextPeriod(state, [uses('p2_rise', 'rebels'), royal]),
    /国策 p2_rise 引用的派系 rebels 不存在/,
  );
});

test('执政派系支持度归零、派系并入后，国家仍可汇出再汇入，政局原样保留', () => {
  const weak = politics();
  weak.factions[0].support = 10;
  weak.factions[3].support = 40;
  let state = install(
    [
      focus('join', { effects: [merge('m', 'nobles', 'guilds')] }),
      focus('later', { requirements: [rule('nobles', 10)], effects: [support('s', 'nobles', 5)] }),
    ],
    weak,
  );
  state = startFocus(state, 'realm', 'join');
  state = applyProposal(state, {
    id: 'fall',
    until: 10,
    reason: '推进',
    steps: [{ at: 1, facts: [], events: [event([support('down', 'crown', -10)])], selections: [] }],
  });
  const stored = state.countries.realm.politics!;
  assert.equal(state.countries.realm.progress.join.status, 'completed');
  assert.deepEqual(supports(stored), { crown: 0, guilds: 55, cabinet: 45 });
  assert.equal(factionOf(stored, 'hohen'), 'guilds');
  const file = JSON.parse(exportTrees(state));
  for (const withProgress of [false, true]) {
    const restored = importTrees(createState(state.day), parseTreeFile(file), {
      withProgress,
      replace: false,
    });
    assert.deepEqual(restored.countries.realm.politics, stored);
  }
});

test('只剩执政派系的国家：状态有效，可以汇出再汇入，政局原样保留', () => {
  const state = withEvent(install([focus('x')]), [
    merge('a', 'nobles', 'crown'),
    merge('b', 'guilds', 'crown'),
    merge('c', 'cabinet', 'crown'),
  ]);
  const stored = state.countries.realm.politics!;
  assert.deepEqual(supports(stored), { crown: 100 });
  assert.ok(stored.members.every((m) => m.faction === 'crown' || m.faction === null));
  assert.doesNotThrow(() => StateSchema.parse(state));
  const file = JSON.parse(exportTrees(state));
  for (const withProgress of [false, true]) {
    const restored = importTrees(createState(state.day), parseTreeFile(file), {
      withProgress,
      replace: false,
    });
    assert.deepEqual(restored.countries.realm.politics, stored);
  }
});
