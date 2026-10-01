import type { FocusNode } from './model';

/** The core branch name of a tree, for the lane order. */
export const coreBranch = (tree: { branches: { name: string; core?: boolean }[] }) =>
  tree.branches.find((branch) => branch.core)?.name;

/** Coordinates are in half-card steps: neighbours in a row sit two units apart. */
const STEP = 2;
/** Extra space between branch lanes: half a card more than neighbours within a lane. */
const LANE_GAP = 1;
/** Alternating sweeps that centre parents over children and merges under their parents. */
const SWEEPS = 4;

/**
 * Least-squares positions for targets that must keep their order and stay STEP apart (pool
 * adjacent violators on target − STEP × index), so centring never makes cards overlap or cross.
 */
function spread(targets: number[]): number[] {
  const blocks: { start: number; size: number; mean: number }[] = [];
  targets.forEach((target, index) => {
    blocks.push({ start: index, size: 1, mean: target - STEP * index });
    while (blocks.length > 1 && blocks[blocks.length - 2].mean >= blocks[blocks.length - 1].mean) {
      const last = blocks.pop()!;
      const prev = blocks[blocks.length - 1];
      prev.mean = (prev.mean * prev.size + last.mean * last.size) / (prev.size + last.size);
      prev.size += last.size;
    }
  });
  const result: number[] = [];
  for (const block of blocks) {
    for (let i = 0; i < block.size; i++) {
      result.push(block.mean + STEP * (block.start + i));
    }
  }
  return result;
}

/**
 * Place branches in separate lanes and prerequisites above their dependants, focus-tree style:
 * within a lane a focus sits centred over the focuses it leads to and a merge sits centred under
 * the routes that join it. The core branch, when named, takes the middle lane with the other
 * branches split to its left and right. x counts half-card steps, so every position is a whole
 * number and two cards in a row are always STEP apart.
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
  // Same-lane links only: a link into another lane must not pull a card off its own lane.
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    const own = node.prerequisites.flat().filter((id) => byId.get(id)!.branch === node.branch);
    parents.set(node.id, [...new Set(own)]);
    for (const parent of parents.get(node.id)!) {
      children.set(parent, [...(children.get(parent) ?? []), node.id]);
    }
  }
  const mean = (ids: string[], at: Map<string, number>) =>
    ids.reduce((sum, id) => sum + at.get(id)!, 0) / ids.length;

  let order = [...branches.keys()];
  if (core && branches.has(core)) {
    const others = order.filter((name) => name !== core);
    const left = Math.floor(others.length / 2);
    order = [...others.slice(0, left), core, ...others.slice(left)];
  }
  const positions = new Map<string, { x: number; y: number }>();
  let lane = 0;
  for (const name of order) {
    const rows = [...branches.get(name)!].sort(([a], [b]) => a - b).map(([y, row]) => ({ y, row: [...row] }));
    const x = new Map<string, number>();
    // First pass: each row left to right in input order under its parents.
    for (const { row } of rows) {
      const targets = row.map((node, index) => {
        const own = parents.get(node.id)!;
        return own.length ? mean(own, x) : STEP * index;
      });
      // Keep input order among cards that have no parent to follow (stable sort).
      const ranked = row.map((node, index) => ({ node, target: targets[index], index }));
      ranked.sort((a, b) => a.target - b.target || a.index - b.index);
      const placed = spread(ranked.map((item) => item.target));
      ranked.forEach((item, index) => x.set(item.node.id, placed[index]));
      row.splice(0, row.length, ...ranked.map((item) => item.node));
    }
    // Alternate: parents over their children (bottom up), merges under their parents (top down).
    for (let sweep = 0; sweep < SWEEPS; sweep++) {
      const upward = sweep % 2 === 0;
      for (const { row } of upward ? [...rows].reverse() : rows) {
        const targets = row.map((node) => {
          const linked = (upward ? children : parents).get(node.id) ?? [];
          return linked.length ? mean(linked, x) : x.get(node.id)!;
        });
        // Order is fixed after the first pass, so lines between rows never start to cross.
        const placed = spread(targets);
        row.forEach((node, index) => x.set(node.id, placed[index]));
      }
    }
    // Whole numbers, still STEP apart, then shift the lane so its leftmost card starts the lane.
    let lowest = Infinity;
    let highest = -Infinity;
    for (const { row } of rows) {
      let previous = -Infinity;
      for (const node of row) {
        const value = Math.max(Math.round(x.get(node.id)!), previous + STEP);
        x.set(node.id, value);
        previous = value;
        lowest = Math.min(lowest, value);
        highest = Math.max(highest, value);
      }
    }
    for (const { y, row } of rows) {
      for (const node of row) {
        positions.set(node.id, { x: lane + x.get(node.id)! - lowest, y });
      }
    }
    lane += highest - lowest + STEP + LANE_GAP;
  }
  return nodes.map((node) => ({ ...node, ...positions.get(node.id)! }));
}
