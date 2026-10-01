import type { FocusNode } from './model';

/** The core branch name of a tree, for the lane order. */
export const coreBranch = (tree: { branches: { name: string; core?: boolean }[] }) =>
  tree.branches.find((branch) => branch.core)?.name;

/**
 * Place branches in separate lanes and prerequisites above their dependants. The core branch, when
 * named, takes the middle lane with the other branches split to its left and right.
 */
export function layoutTree<T extends Pick<FocusNode, 'id' | 'branch' | 'prerequisites'>>(
  nodes: T[],
  core?: string,
): (T & { x: number; y: number })[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) {
    throw new Error('国策 ID 重复');
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
      throw new Error(`不存在的前置国策：${id}`);
    }
    if (visiting.has(id)) {
      throw new Error('国策前置形成循环');
    }
    visiting.add(id);
    let result = 0;
    for (const group of node.prerequisites) {
      for (const parent of group) {
        result = Math.max(result, 1 + level(parent));
      }
    }
    visiting.delete(id);
    levels.set(id, result);
    return result;
  }
  const branches = new Map<string, Map<number, T[]>>();
  for (const node of nodes) {
    const y = level(node.id);
    let rows = branches.get(node.branch);
    if (!rows) {
      rows = new Map();
      branches.set(node.branch, rows);
    }
    const row = rows.get(y);
    if (row) {
      row.push(node);
    } else {
      rows.set(y, [node]);
    }
  }
  const positions = new Map<string, { x: number; y: number }>();
  let order = [...branches.keys()];
  if (core && branches.has(core)) {
    const others = order.filter((name) => name !== core);
    const left = Math.floor(others.length / 2);
    order = [...others.slice(0, left), core, ...others.slice(left)];
  }
  let lane = 0;
  for (const rows of order.map((name) => branches.get(name)!)) {
    const width = Math.max(...[...rows.values()].map((row) => row.length));
    for (const [y, row] of [...rows].sort(([a], [b]) => a - b)) {
      // Parent positions cannot change while sorting this row; calculate each center once.
      const centers = new Map<string, number>();
      for (const node of row) {
        let sum = 0;
        let count = 0;
        for (const group of node.prerequisites) {
          for (const parent of group) {
            const position = positions.get(parent);
            if (position) {
              sum += position.x;
              count++;
            }
          }
        }
        centers.set(node.id, count ? sum / count : lane);
      }
      row.sort((a, b) => centers.get(a.id)! - centers.get(b.id)!);
      row.forEach((node, index) =>
        positions.set(node.id, { x: lane + Math.floor((width - row.length) / 2) + index, y }),
      );
    }
    lane += width + 1;
  }
  return nodes.map((node) => ({ ...node, ...positions.get(node.id)! }));
}
