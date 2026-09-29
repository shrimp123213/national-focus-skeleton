import type { FocusNode } from './model';

/** Place branches in separate lanes and prerequisites above their dependants. */
export function layoutTree<T extends Pick<FocusNode, 'id' | 'branch' | 'prerequisites'>>(
  nodes: T[],
): (T & { x: number; y: number })[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) {
    throw new Error('國策 ID 重複');
  }
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  function level(id: string): number {
    const known = levels.get(id);
    if (known !== undefined) {
      return known;
    }
    const node = byId.get(id);
    if (!node) {
      throw new Error(`不存在的前置國策：${id}`);
    }
    if (visiting.has(id)) {
      throw new Error('國策前置形成循環');
    }
    visiting.add(id);
    const parents = node.prerequisites.flat();
    const result = parents.length ? 1 + Math.max(...parents.map(level)) : 0;
    visiting.delete(id);
    levels.set(id, result);
    return result;
  }
  for (const node of nodes) {
    level(node.id);
  }
  const positions = new Map<string, { x: number; y: number }>();
  let lane = 0;
  for (const branch of new Set(nodes.map((n) => n.branch))) {
    const rows = new Map<number, T[]>();
    for (const node of nodes.filter((n) => n.branch === branch)) {
      const y = levels.get(node.id)!;
      rows.set(y, [...(rows.get(y) ?? []), node]);
    }
    const width = Math.max(...[...rows.values()].map((row) => row.length));
    for (const [y, row] of [...rows].sort(([a], [b]) => a - b)) {
      const center = (node: T) => {
        const parents = node.prerequisites
          .flat()
          .flatMap((id) => (positions.has(id) ? [positions.get(id)!.x] : []));
        return parents.length ? parents.reduce((a, b) => a + b, 0) / parents.length : lane;
      };
      row.sort((a, b) => center(a) - center(b));
      row.forEach((node, index) =>
        positions.set(node.id, { x: lane + Math.floor((width - row.length) / 2) + index, y }),
      );
    }
    lane += width + 1;
  }
  return nodes.map((node) => ({ ...node, ...positions.get(node.id)! }));
}
