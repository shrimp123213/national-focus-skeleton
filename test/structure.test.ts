import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categories, drawStructure, signature, treeTypes, typeShape, type Structure } from '../src/structure';
import { generationPlan, shapeLimits } from '../src/generation';
import { createState } from '../src/engine';

/** Small seeded generator, so the draws below are repeatable. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lot = (structure: Structure, category: string) =>
  structure.lots.find((l) => l.category === category)?.key;

test('结构签：每次抽树型、命名、五支骨架签与三支细部签，并遵守树型与篇幅的相容规则', () => {
  const types = new Set<string>();
  for (let seed = 1; seed <= 1500; seed++) {
    const large = seed % 2 === 0;
    const s = drawStructure({ large, random: seeded(seed) });
    types.add(s.type.key);
    assert.equal(s.lots.length, 8);
    for (const name of ['开局', '分岔位置', '路线数', '终局', '侧翼']) {
      assert.ok(
        s.lots.some((l) => l.category === name),
        `${seed} 缺 ${name}`,
      );
    }
    assert.ok(treeTypes[s.type.key as keyof typeof treeTypes].naming.includes(s.naming.key));
    // Every lot fits the tree type.
    for (const l of s.lots) {
      const option = categories.find((c) => c.name === l.category)!.options.find((o) => o.key === l.key)!;
      assert.ok(
        !option.types || option.types.includes(s.type.key as never),
        `${seed} ${l.category}:${l.key}`,
      );
    }
    const routes = lot(s, '路线数');
    if (s.type.key === 'chess') assert.equal(routes, 'three');
    if (s.type.key === 'choice') {
      assert.equal(routes, 'two');
      assert.equal(lot(s, '侧翼'), 'none');
      assert.ok(!lot(s, '互斥规则') || lot(s, '互斥规则') === 'nested');
    }
    if (s.type.key === 'crisis') assert.equal(lot(s, '开局'), 'crisis_open');
    if (s.type.key === 'dual') assert.equal(lot(s, '侧翼'), 'feeds');
    if (lot(s, '路线长度') === 'stairs') assert.equal(routes, 'three');
    if (lot(s, '路线长度') === 'long_short') assert.notEqual(routes, 'three');
    if (lot(s, '侧翼') === 'none') {
      assert.ok(!['needs_wing', 'affect_wing', 'wing_end'].some((key) => s.lots.some((l) => l.key === key)));
    }
    if (!large && routes === 'three') {
      assert.ok(!['twice', 'nested', 'mini_fork_merge'].some((key) => s.lots.some((l) => l.key === key)));
    }
  }
  assert.deepEqual([...types].sort(), ['build', 'chess', 'choice', 'crisis', 'dual', 'reform']);
});

test('结构签避开其他国家已用的骨架组合', () => {
  const first = drawStructure({ large: false, random: seeded(7) });
  const again = drawStructure({ large: false, random: seeded(7) });
  assert.equal(signature(first), signature(again));
  const avoided = drawStructure({ large: false, taken: [signature(first)], random: seeded(7) });
  assert.notEqual(signature(avoided), signature(first));
  // The signature is the tree type and the four skeleton lots.
  assert.equal(signature(first).split('|').length, 5);
  assert.ok(!signature(first).includes('-'));
  // With many shapes taken, draws still come back distinct from all of them.
  const taken = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const s = drawStructure({ large: true, taken, random: seeded(100 + i) });
    assert.ok(!taken.has(signature(s)));
    taken.add(signature(s));
  }
});

test('树型调整分支、路线与侧翼目标，生成资料带出结构签', () => {
  const state = createState(100);
  assert.equal(shapeLimits(state.settings, 'choice').branches, '1');
  assert.equal(shapeLimits(state.settings, 'choice').wings.count, '0');
  assert.equal(shapeLimits(state.settings, 'chess').core.routes, '3');
  assert.deepEqual(shapeLimits(state.settings, 'build'), shapeLimits(state.settings));
  assert.equal(typeShape(undefined, false), undefined);
  const structure = drawStructure({ large: false, random: seeded(3) });
  const plan = generationPlan(
    { state, day: 100, context: {} } as never,
    { id: 'x', name: 'x', description: 'x', evidence: 'x' },
    structure,
  );
  const data = plan.data as unknown as {
    structure: { type: { name: string }; lots: unknown[]; note: string };
  };
  assert.equal(data.structure.type.name, structure.type.name);
  assert.equal(data.structure.lots.length, 8);
  assert.match(data.structure.note, /倾向/);
  assert.equal(
    (
      generationPlan({ state, day: 100, context: {} } as never, {
        id: 'x',
        name: 'x',
        description: 'x',
        evidence: 'x',
      }).data as Record<string, unknown>
    ).structure,
    undefined,
  );
});
