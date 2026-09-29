/**
 * Local repair of common shape slips in model JSON, applied before schema validation.
 * Only unambiguous rewrites; anything else is left for the schema to reject.
 */
const idKeys = ['id', 'node', 'focus', 'ref', 'value'] as const;

function asId(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of idKeys) {
      if (typeof record[key] === 'string') {
        return record[key];
      }
    }
  }
  return value;
}

/** AND of OR groups. Accepts `a`, `[a, b]` (AND), `[[a], {any: [b, c]}]` and `{id: a}` items. */
export function repairPrerequisites(value: unknown): unknown {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  const groups = Array.isArray(value) ? value : [value];
  return groups.map((group) => {
    if (group && typeof group === 'object' && !Array.isArray(group)) {
      const record = group as Record<string, unknown>;
      const options = record.any ?? record.or ?? record.anyOf ?? record.oneOf;
      if (Array.isArray(options)) {
        return options.map(asId);
      }
    }
    return Array.isArray(group) ? group.map(asId) : [asId(group)];
  });
}

const listKeys = ['requirements', 'sustain', 'outcomes', 'investments', 'effects'] as const;
/** Skeleton focuses have conditions but no investments or effects (skeleton.ts). */
const skeletonListKeys = ['requirements', 'sustain', 'outcomes'] as const;

function repairNode(node: unknown, keys: readonly string[] = listKeys): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return node;
  }
  const next = { ...(node as Record<string, unknown>) };
  if ('prerequisites' in next || 'id' in next) {
    next.prerequisites = repairPrerequisites(next.prerequisites);
  }
  for (const key of keys) {
    if (next[key] === null || next[key] === undefined) {
      next[key] = [];
    }
  }
  if (
    next.mutex === undefined ||
    next.mutex === '' ||
    (next.mutex && typeof next.mutex === 'object' && !Object.keys(next.mutex).length)
  ) {
    next.mutex = null;
  }
  return next;
}

/**
 * Walk a reply and repair every `nodes` array (generated trees and reshape edits). Fill replies
 * carry text only and are checked per focus, so they are left as written; skeleton focuses get
 * only the keys their schema has.
 */
export function repairReply(value: unknown, stage?: string): unknown {
  if (stage === 'fill' || stage === 'skeleton-fix') {
    return value;
  }
  if (stage === 'skeleton') {
    return repairSkeleton(repairReplyWith(value, skeletonListKeys));
  }
  const keys = stage === 'skeleton' ? skeletonListKeys : listKeys;
  const walk = (item: unknown): unknown => repairReplyWith(item, keys);
  return walk(value);
}
function repairReplyWith(value: unknown, keys: readonly string[]): unknown {
  const repairReply = (item: unknown) => repairReplyWith(item, keys);
  if (Array.isArray(value)) {
    return value.map(repairReply);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] =
      key === 'nodes' && Array.isArray(child)
        ? child.map((node) => repairReply(repairNode(node, keys)))
        : repairReply(child);
  }
  return result;
}

const relationKindAliases: Record<string, string> = {
  利益交換: 'exchange',
  利益交换: 'exchange',
  政策配合: 'synergy',
  機會成本: 'opportunity',
  机会成本: 'opportunity',
  情境差異: 'context',
  情境差异: 'context',
  延後兌現: 'deferred',
  延后兑现: 'deferred',
  制度替代: 'replacement',
};
/** "not capability", "capability_absent", "no-fact" … → the base kind with negate. */
const negatedKind =
  /^(?:not|no|non|without|lack|lacks|absent|negate|negated|!)[\s_-]?(capability|fact)$|^(capability|fact)[\s_-]?(?:absent|missing|not|negate|negated|lacking|none)$/i;
/** Keys a model adds for its own notes; they carry no rule, so they are dropped. */
const noteKeys = ['label', 'name', 'description', 'reason', 'note', 'notes', 'comment'];
const nodeNoteKeys = ['description', 'reason', 'note', 'notes', 'comment', 'label', 'days', 'icon'];

function squash(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, '');
}
/** The one branch name that `text` misspells by at most two characters (same length), if any. */
function closestBranch(text: string, names: string[]): string | undefined {
  const target = squash(text);
  const exact = names.filter((name) => squash(name) === target);
  if (exact.length === 1) {
    return exact[0];
  }
  const near = names.filter((name) => {
    const other = squash(name);
    if (other.length !== target.length) {
      return false;
    }
    let differences = 0;
    for (let i = 0; i < other.length; i++) {
      differences += other[i] === target[i] ? 0 : 1;
    }
    return differences <= 2;
  });
  return near.length === 1 ? near[0] : undefined;
}
function repairCondition(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const next = { ...(value as Record<string, unknown>) };
  for (const key of noteKeys) {
    delete next[key];
  }
  if (typeof next.kind === 'string') {
    const kind = next.kind.trim();
    const negated = negatedKind.exec(kind);
    if (negated) {
      next.kind = (negated[1] ?? negated[2]).toLowerCase();
      next.negate = true;
    } else if (/^(capability|fact|stability|warsupport)$/i.test(kind)) {
      next.kind = kind.toLowerCase() === 'warsupport' ? 'warSupport' : kind.toLowerCase();
    }
  }
  for (const alias of ['not', 'negated', 'absent']) {
    if (alias in next) {
      if (next[alias] === true) {
        next.negate = true;
      }
      delete next[alias];
    }
  }
  if (typeof next.minimum === 'string' && /^\d+(\.\d+)?$/.test(next.minimum.trim())) {
    next.minimum = Number(next.minimum);
  }
  return next;
}
const conditionLists = ['requirements', 'sustain', 'outcomes'] as const;

/**
 * Unambiguous slips in skeleton replies, fixed locally instead of asking again: branch names that
 * differ only in variant characters or spacing (or give the branch id), Chinese relation kind
 * names, made-up "not capability" kinds, note fields inside conditions, and a missing mutex lock.
 * Anything that could change the design is left for the checks to report.
 */
export function repairSkeleton(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const tree = { ...(value as Record<string, unknown>) };
  const branches = Array.isArray(tree.branches) ? (tree.branches as Record<string, unknown>[]) : [];
  const names = branches.map((b) => b?.name).filter((n): n is string => typeof n === 'string');
  const byId = new Map(
    branches
      .filter((b) => typeof b?.id === 'string' && typeof b?.name === 'string')
      .map((b) => [b.id as string, b.name as string]),
  );
  // Keywords only help the worldbook trigger; keep what is usable instead of rejecting the skeleton.
  if (typeof tree.keywords === 'string') {
    tree.keywords = tree.keywords.split(/[、,，/;；\s]+/);
  }
  if (Array.isArray(tree.keywords)) {
    tree.keywords = [
      ...new Set(tree.keywords.filter((k): k is string => typeof k === 'string').map((k) => k.trim())),
    ]
      .filter((k) => k.length > 0 && k.length <= 24)
      .slice(0, 8);
  }
  if (Array.isArray(tree.nodes)) {
    tree.nodes = tree.nodes.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return raw;
      }
      const node = { ...(raw as Record<string, unknown>) };
      for (const key of nodeNoteKeys) {
        delete node[key];
      }
      if (typeof node.branch === 'string' && !names.includes(node.branch)) {
        node.branch = byId.get(node.branch) ?? closestBranch(node.branch, names) ?? node.branch;
      }
      for (const list of conditionLists) {
        if (Array.isArray(node[list])) {
          node[list] = (node[list] as unknown[]).map(repairCondition);
        }
      }
      if (Array.isArray(node.conditional)) {
        node.conditional = node.conditional.map((item) =>
          item && typeof item === 'object' && Array.isArray((item as { when?: unknown }).when)
            ? { ...(item as object), when: (item as { when: unknown[] }).when.map(repairCondition) }
            : item,
        );
      }
      if (node.mutex && typeof node.mutex === 'object' && !Array.isArray(node.mutex)) {
        const mutex = { ...(node.mutex as Record<string, unknown>) };
        delete mutex.reason;
        mutex.lock ??= 'complete';
        node.mutex = mutex;
      }
      if (node.impact !== 'pivotal' && (node.action === '' || node.action === undefined)) {
        node.action = null;
      }
      return node;
    });
  }
  if (Array.isArray(tree.relations)) {
    tree.relations = tree.relations.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return raw;
      }
      const relation = { ...(raw as Record<string, unknown>) };
      if (typeof relation.kind === 'string') {
        const kind = relation.kind.trim();
        relation.kind = relationKindAliases[kind] ?? kind.toLowerCase();
      }
      for (const key of ['reason', 'description', 'effect']) {
        if (typeof relation[key] === 'string' && !relation.change) {
          relation.change = relation[key];
        }
        delete relation[key];
      }
      return relation;
    });
  }
  return tree;
}
