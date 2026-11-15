import type { Effect, FocusNode, Politics } from './model';

function requireThat(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

type Faction = Politics['factions'][number];
/** Effects that change a country's factions (v0.18.0). */
export type FactionEffect = Extract<Effect, { kind: 'support' | 'member' | 'merge' | 'faction' }>;
export function isFactionEffect(effect: Effect): effect is FactionEffect {
  return ['support', 'member', 'merge', 'faction'].includes(effect.kind);
}

type RuleNode = Pick<FocusNode, 'id' | 'requirements' | 'sustain' | 'outcomes' | 'effects' | 'mutex'>;
/**
 * Faction rules of focuses (spec 七). A tree needs politics to use them, a `support` condition goes
 * only in requirements and in an effect's `when`, and a faction never merges into itself. With
 * `tree`, references are checked too: named factions and members must exist, the ruling faction
 * never merges away and a new faction has a starting support. A faction that a focus of `tree`
 * creates counts as existing; the order of focuses is not checked, because an effect on a missing
 * faction is skipped and a condition reads 0. New focuses get these checks. An installed tree does
 * not: a faction it names may have dissolved since the tree was written.
 */
export function validateFactionRules(
  nodes: RuleNode[],
  politics: Politics | undefined,
  tree?: RuleNode[],
): void {
  const created = (tree ?? []).flatMap((node) =>
    node.effects.flatMap((effect) => (effect.kind === 'faction' && effect.support ? [effect.key] : [])),
  );
  for (const node of nodes) {
    for (const rule of [...node.sustain, ...node.outcomes]) {
      requireThat(
        rule.kind !== 'support',
        `国策 ${node.id}：派系支持度条件只能写在 requirements 或效果的 when，不能写在 sustain 或 outcomes`,
      );
    }
    const conditions = [...node.requirements, ...node.effects.flatMap((effect) => effect.when ?? [])].flatMap(
      (rule) => (rule.kind === 'support' ? [rule] : []),
    );
    const effects = node.effects.filter(isFactionEffect);
    const backers = node.mutex?.backers ?? [];
    if (!conditions.length && !effects.length && !backers.length) {
      continue;
    }
    requireThat(politics, `国策 ${node.id} 使用了派系条件、派系效果或 backers，但此国没有派系`);
    for (const effect of effects) {
      requireThat(
        effect.kind !== 'merge' || effect.source !== effect.target,
        `国策 ${node.id} 的效果 ${effect.id}：派系不能并入自己`,
      );
    }
    if (!tree) {
      continue;
    }
    const factions = new Set([...politics.factions.map((faction) => faction.id), ...created]);
    const named = [
      ...conditions.map((rule) => rule.faction),
      ...backers,
      ...effects.flatMap((effect) =>
        effect.kind === 'support'
          ? [effect.faction]
          : effect.kind === 'merge'
            ? [effect.source, effect.target]
            : effect.kind === 'member' && effect.faction
              ? [effect.faction]
              : [],
      ),
    ];
    for (const id of named) {
      requireThat(factions.has(id), `国策 ${node.id} 引用的派系 ${id} 不存在`);
    }
    for (const effect of effects) {
      const where = `国策 ${node.id} 的效果 ${effect.id}`;
      if (effect.kind === 'member') {
        requireThat(
          politics.members.some((member) => member.id === effect.member),
          `${where}：成员 ${effect.member} 不存在`,
        );
      } else if (effect.kind === 'merge') {
        requireThat(effect.source !== politics.ruling, `${where}：执政派系不能并入其他派系`);
      } else if (effect.kind === 'faction') {
        requireThat(
          factions.has(effect.key),
          `${where}：派系 ${effect.key} 不存在，建立新派系须填起始支持度 support（5、10 或 15）`,
        );
      }
    }
  }
}

/** Integer shares of `total` in proportion to `weights` (equal when all are 0), by largest remainder. */
function shares(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const base = sum || weights.length;
  const parts = weights.map((weight) => (sum ? weight : 1) * total);
  const result = parts.map((part) => Math.floor(part / base));
  const left = total - result.reduce((a, b) => a + b, 0);
  const order = parts.map((_, i) => i).sort((a, b) => (parts[b] % base) - (parts[a] % base) || a - b);
  for (const i of order.slice(0, left)) {
    result[i]++;
  }
  return result;
}

/**
 * Make the total 100 again. Factions this batch did not name absorb the difference in proportion;
 * when they cannot, they drop to 0 and every faction scales in proportion.
 */
function normalize(factions: Faction[], named: Set<string>): void {
  const sum = (list: Faction[]) => list.reduce((total, faction) => total + faction.support, 0);
  const total = sum(factions);
  if (total === 100) {
    return;
  }
  const others = factions.filter((faction) => !named.has(faction.id));
  const target = sum(others) + 100 - total;
  if (sum(others) > 0 && target >= 0) {
    const values = shares(
      others.map((faction) => faction.support),
      target,
    );
    others.forEach((faction, i) => (faction.support = values[i]));
    return;
  }
  others.forEach((faction) => (faction.support = 0));
  const values = shares(
    factions.map((faction) => faction.support),
    100,
  );
  factions.forEach((faction, i) => (faction.support = values[i]));
}

/**
 * Settle one batch of faction effects: those of one completing focus, or of one event change for
 * one country (spec 五「支持度结算」). The steps run in a fixed order and each step takes its effects
 * by id, so the written order never changes the result. An effect whose references do not hold
 * goes to `invalid` and does not apply. Returns the ids of the effects that applied.
 */
export function settlePolitics(
  politics: Politics | undefined,
  batch: FactionEffect[],
  invalid: (effect: FactionEffect, reason: string) => void,
): string[] {
  const applied: string[] = [];
  if (!politics) {
    batch.forEach((effect) => invalid(effect, '此国没有派系'));
    return applied;
  }
  const effects = [...batch].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const find = (id: string) => politics.factions.find((faction) => faction.id === id);
  // Factions whose support this batch sets; the others absorb the difference.
  const named = new Set<string>();
  // 1. Create new factions; their starting support counts as an increase. Existing keys are updated.
  // Effects with a starting support go first, so an update in the same batch finds its faction.
  const factionEffects = effects.filter((effect) => effect.kind === 'faction');
  for (const effect of [
    ...factionEffects.filter((effect) => effect.support !== undefined),
    ...factionEffects.filter((effect) => effect.support === undefined),
  ]) {
    const existing = find(effect.key);
    if (existing) {
      Object.assign(existing, { name: effect.name, appeal: effect.appeal, stance: effect.stance });
      if (effect.leader !== undefined) {
        existing.leader = effect.leader;
      }
    } else if (effect.support === undefined) {
      invalid(effect, `派系 ${effect.key} 不存在，建立新派系须填起始支持度 support（5、10 或 15）`);
      continue;
    } else if (politics.factions.length >= 8) {
      invalid(effect, '派系已有 8 个，不能再建立新派系');
      continue;
    } else {
      const { key: id, name, appeal, leader, stance, support } = effect;
      politics.factions = assignColors([
        ...politics.factions,
        { id, name, appeal, ...(leader === undefined ? {} : { leader }), stance, support },
      ]);
      named.add(id);
    }
    applied.push(effect.id);
  }
  // 2. Sum the support changes of the batch, then apply them with a floor of 0.
  const changes = new Map<string, number>();
  for (const effect of effects) {
    if (effect.kind !== 'support') {
      continue;
    }
    if (!find(effect.faction)) {
      invalid(effect, `派系 ${effect.faction} 不存在`);
      continue;
    }
    changes.set(effect.faction, (changes.get(effect.faction) ?? 0) + effect.value);
    applied.push(effect.id);
  }
  for (const [id, change] of changes) {
    const faction = find(id)!;
    faction.support = Math.max(0, faction.support + change);
    named.add(id);
  }
  // 3. Merge: the source's support and members go to the target, and the source dissolves.
  for (const effect of effects) {
    if (effect.kind !== 'merge') {
      continue;
    }
    const source = find(effect.source);
    const target = find(effect.target);
    if (!source || !target) {
      invalid(effect, `派系 ${source ? effect.target : effect.source} 不存在`);
      continue;
    }
    if (source === target) {
      invalid(effect, '派系不能并入自己');
      continue;
    }
    // A faction that rules, or waits to rule, changes hands only with a change of government.
    if (source.id === politics.ruling || source.id === politics.pending?.ruling) {
      invalid(
        effect,
        `${source.id === politics.ruling ? '执政派系' : '待决接任的派系'}「${source.name}」不能并入其他派系`,
      );
      continue;
    }
    target.support += source.support;
    for (const member of politics.members) {
      if (member.faction === source.id) {
        member.faction = target.id;
      }
    }
    politics.factions = politics.factions.filter((faction) => faction !== source);
    named.add(target.id);
    applied.push(effect.id);
  }
  // 4. Members change their label only; no number changes.
  for (const effect of effects) {
    if (effect.kind !== 'member') {
      continue;
    }
    const member = politics.members.find((item) => item.id === effect.member);
    if (!member) {
      invalid(effect, `成员 ${effect.member} 不存在`);
      continue;
    }
    if (effect.faction !== null && !find(effect.faction)) {
      invalid(effect, `派系 ${effect.faction} 不存在`);
      continue;
    }
    member.faction = effect.faction;
    applied.push(effect.id);
  }
  if (!applied.length) {
    return applied;
  }
  // 5. Normalise once, then 6. dissolve factions at 0. The ruling and the pending faction stay.
  normalize(politics.factions, named);
  const kept = [politics.ruling, politics.pending?.ruling];
  const gone = new Set(
    politics.factions
      .filter((faction) => faction.support === 0 && !kept.includes(faction.id))
      .map((faction) => faction.id),
  );
  politics.factions = politics.factions.filter((faction) => !gone.has(faction.id));
  for (const member of politics.members) {
    if (member.faction && gone.has(member.faction)) {
      member.faction = null;
    }
  }
  return applied;
}

/**
 * Local checks for a country's politics. The schema already limits counts, ranges and integers;
 * these rules compare fields with each other.
 */
export function validatePolitics(politics: Politics): void {
  const ids = politics.factions.map((faction) => faction.id);
  requireThat(new Set(ids).size === ids.length, '派系 ID 重复');
  requireThat(new Set(politics.members.map((m) => m.id)).size === politics.members.length, '成员 ID 重复');
  const total = politics.factions.reduce((sum, faction) => sum + faction.support, 0);
  requireThat(total === 100, `派系支持度合计须为 100，目前为 ${total}`);
  // The ruling faction may be at 0 in play; only generation requires more (spec 七).
  requireThat(
    politics.factions.some((faction) => faction.id === politics.ruling),
    `执政派系 ${politics.ruling} 不在 factions 中`,
  );
  for (const member of politics.members) {
    requireThat(
      member.faction === null || ids.includes(member.faction),
      `成员「${member.name}」支持的派系 ${member.faction} 不存在；未表态请填 null`,
    );
  }
  const colors = politics.factions.flatMap((faction) => (faction.color === undefined ? [] : [faction.color]));
  requireThat(new Set(colors).size === colors.length, '派系色位重复');
  requireThat(
    !politics.pending || ids.includes(politics.pending.ruling),
    `待决更替的派系 ${politics.pending?.ruling} 不存在`,
  );
}

/**
 * Rules for politics that a generate or period reply writes (spec 七). The reply schema allows 2 to
 * 6 factions. Tree files keep the play rules: one faction, or a ruling faction at 0, is valid there.
 */
export function validateGeneratedPolitics(politics: Politics): void {
  validatePolitics(politics);
  const ruling = politics.factions.find((faction) => faction.id === politics.ruling)!;
  requireThat(ruling.support > 0, `执政派系「${ruling.name}」的支持度须大于 0：ruling 是现在掌权的派系`);
}

/**
 * Give each faction without a colour the first free slot. The slot is stored, so other colours
 * stay the same when a faction leaves.
 */
export function assignColors(factions: Politics['factions']): Politics['factions'] {
  const used = new Set(factions.flatMap((faction) => (faction.color === undefined ? [] : [faction.color])));
  return factions.map((faction) => {
    if (faction.color !== undefined) {
      return faction;
    }
    let color = 0;
    while (used.has(color)) {
      color++;
    }
    used.add(color);
    return { ...faction, color };
  });
}
