/** Keep stored branch names compatible with the renderer; accept only exact, unique aliases. */
export function normalizeBranchReferences<
  T extends { branches: { id: string; name: string }[]; nodes: { id: string; branch: string }[] },
>(tree: T): T {
  const nodes = tree.nodes.map((node) => {
    const matches = tree.branches.filter(
      (branch) => branch.name === node.branch || branch.id === node.branch,
    );
    if (!matches.length) {
      throw new Error(`國策「${node.id}」引用不存在的分支「${node.branch}」，請使用 branches 中的名稱或 ID`);
    }
    if (matches.length > 1) {
      throw new Error(`國策「${node.id}」的分支「${node.branch}」對應多個分支，請使用唯一名稱或 ID`);
    }
    return { ...node, branch: matches[0].name };
  });
  return { ...tree, nodes };
}
