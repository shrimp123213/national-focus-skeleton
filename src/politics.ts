import type { Politics } from './model';

function requireThat(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
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
  const ruling = politics.factions.find((faction) => faction.id === politics.ruling);
  requireThat(ruling, `执政派系 ${politics.ruling} 不在 factions 中`);
  requireThat(ruling.support > 0, `执政派系「${ruling.name}」的支持度须大于 0`);
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
