import type { FocusNode } from './model';

type Node = Pick<FocusNode, 'id' | 'prerequisites' | 'mutex'>;
type Task = { kind: 'enter' | 'exit'; id: string } | { kind: 'choice'; ids: string[] };
type Search = { tasks: Task[]; completed: Set<string>; visiting: Set<string>; locks: Map<string, string> };

/**
 * Backtracking search for a compatible completion order. `reach(goal, forbidden, locks)` answers
 * whether `goal` can be completed without completing any `forbidden` focus and while keeping the
 * given mutex routes (group → route) available.
 */
function solver(nodes: Node[], capabilitySources = new Map<string, string[][]>()) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let work = 0;
  function solve(search: Search, forbidden: Set<string>): boolean {
    while (search.tasks.length) {
      work++;
      if (work > 500000) {
        throw new Error('路线相容性过于复杂，请简化交叉互斥与择一前置后重试');
      }
      const task = search.tasks.pop()!;
      if (task.kind === 'choice') {
        if (task.ids.some((id) => search.completed.has(id))) {
          continue;
        }
        if (task.ids.length === 1) {
          search.tasks.push({ kind: 'enter', id: task.ids[0] });
          continue;
        }
        for (const id of task.ids) {
          if (
            solve(
              {
                tasks: [...search.tasks, { kind: 'enter', id }],
                completed: new Set(search.completed),
                visiting: new Set(search.visiting),
                locks: new Map(search.locks),
              },
              forbidden,
            )
          ) {
            return true;
          }
        }
        return false;
      }
      if (task.kind === 'exit') {
        search.visiting.delete(task.id);
        search.completed.add(task.id);
        continue;
      }
      if (search.completed.has(task.id)) {
        continue;
      }
      if (search.visiting.has(task.id) || forbidden.has(task.id)) {
        return false;
      }
      const node = byId.get(task.id);
      if (!node) {
        return false;
      }
      if (node.mutex) {
        const selected = search.locks.get(node.mutex.group);
        if (selected && selected !== node.mutex.route) {
          return false;
        }
        // Reserve the goal's route while proving predecessors, including locks made on completion.
        search.locks.set(node.mutex.group, node.mutex.route);
      }
      search.visiting.add(node.id);
      search.tasks.push({ kind: 'exit', id: node.id });
      for (const ids of [...node.prerequisites, ...(capabilitySources.get(node.id) ?? [])]) {
        search.tasks.push({ kind: 'choice', ids });
      }
    }
    return true;
  }
  return (goal: string, forbidden = new Set<string>(), locks = new Map<string, string>()) =>
    solve(
      {
        tasks: [{ kind: 'enter', id: goal }],
        completed: new Set(),
        visiting: new Set(),
        locks: new Map(locks),
      },
      forbidden,
    );
}

/** Prove a compatible prerequisite order for each alternative route, with bounded backtracking. */
export function assertReachable(nodes: Node[], capabilitySources = new Map<string, string[][]>()): void {
  const reach = solver(nodes, capabilitySources);
  for (const node of nodes) {
    if (!reach(node.id)) {
      throw new Error(`国策无相容的前置或能力来源：${node.id}`);
    }
  }
}

/**
 * Whether `goal` can be completed before `blocked` starts while `blocked` stays possible: without
 * completing `blocked` and without taking a route that excludes it (`locks`, its own routes).
 */
export function reachableBefore(
  nodes: Node[],
  goal: string,
  blocked: string,
  locks: Map<string, string>,
): boolean {
  return solver(nodes)(goal, new Set([blocked]), locks);
}

export function assertCapabilityOrder(nodes: FocusNode[], initial: string[], historical: string[]): void {
  const available = new Set(initial);
  const inherited = new Set(historical);
  const providers = new Map<string, string[]>();
  for (const node of nodes) {
    if (inherited.has(node.id)) {
      continue; // Historical completion never pays its effects again.
    }
    for (const effect of node.effects) {
      // A conditional effect may never apply, so it does not count as a guaranteed source.
      if (effect.kind === 'capability' && effect.active && !effect.when?.length) {
        providers.set(effect.key, [...(providers.get(effect.key) ?? []), node.id]);
      }
    }
  }
  const sources = new Map<string, string[][]>();
  for (const node of nodes) {
    if (inherited.has(node.id)) {
      continue;
    }
    const required: string[][] = [];
    for (const rule of [...node.requirements, ...node.sustain, ...node.outcomes]) {
      // "Must not have" conditions need no source; skeleton.ts checks they can hold.
      if (rule.kind === 'capability' && !rule.negate && !available.has(rule.id)) {
        required.push((providers.get(rule.id) ?? []).filter((id) => id !== node.id));
      }
    }
    sources.set(node.id, required);
  }
  assertReachable(nodes, sources);
}

/**
 * Routes of every mutex group. A route's heads are its nodes whose prerequisites contain no other
 * node of the same group and route: the points where a player actually commits to that route.
 */
export function mutexRoutes<T extends Node>(
  nodes: T[],
): Map<string, Map<string, { heads: T[]; members: T[] }>> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const groups = new Map<string, Map<string, { heads: T[]; members: T[] }>>();
  for (const node of nodes) {
    if (!node.mutex) {
      continue;
    }
    const routes = groups.get(node.mutex.group) ?? new Map<string, { heads: T[]; members: T[] }>();
    const entry = routes.get(node.mutex.route) ?? { heads: [], members: [] };
    entry.members.push(node);
    const inherited = node.prerequisites
      .flat()
      .some(
        (id) =>
          byId.get(id)?.mutex?.group === node.mutex!.group &&
          byId.get(id)?.mutex?.route === node.mutex!.route,
      );
    if (!inherited) {
      entry.heads.push(node);
    }
    routes.set(node.mutex.route, entry);
    groups.set(node.mutex.group, routes);
  }
  return groups;
}

/** A mutex group with a single route locks nothing; it is a modelling error. */
export function assertMutexChoices(nodes: Node[]): void {
  for (const [group, routes] of mutexRoutes(nodes)) {
    if (routes.size < 2) {
      throw new Error(
        `互斥组 ${group} 只有一条路线（${[...routes.keys()].join('')}），没有可互斥的对象；请补上其他路线，或移除这些国策的 mutex`,
      );
    }
  }
}
