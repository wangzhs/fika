import type { FileNode } from "../types";

export function collectFilePaths(node: FileNode): string[] {
  if (!node.is_dir) {
    return [node.path];
  }
  const result: string[] = [];
  for (const child of node.children || []) {
    result.push(...collectFilePaths(child));
  }
  return result;
}

function sortChildren(children: FileNode[]) {
  return [...children].sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
}

export function findNodeByPath(node: FileNode, targetPath: string): FileNode | null {
  if (node.path === targetPath) {
    return node;
  }

  for (const child of node.children || []) {
    const match = findNodeByPath(child, targetPath);
    if (match) return match;
  }

  return null;
}

export function mergeLoadedTree(previousNode: FileNode | null, refreshedNode: FileNode): FileNode {
  if (!previousNode || !refreshedNode.is_dir) {
    return refreshedNode;
  }

  const previousChildrenByPath = new Map(
    (previousNode.children || []).map((child) => [child.path, child]),
  );

  return {
    ...refreshedNode,
    children: refreshedNode.children?.map((child) => {
      const previousChild = previousChildrenByPath.get(child.path) ?? null;
      if (
        child.is_dir &&
        child.children_loaded === false &&
        previousChild?.children_loaded
      ) {
        return previousChild;
      }
      return mergeLoadedTree(previousChild, child);
    }),
  };
}

export function replaceNodeByPath(node: FileNode, targetPath: string, replacement: FileNode): FileNode {
  if (node.path === targetPath) {
    return replacement;
  }

  if (!node.children?.length) {
    return node;
  }

  return {
    ...node,
    children: node.children.map((child) => replaceNodeByPath(child, targetPath, replacement)),
  };
}

export function removeNodeByPath(node: FileNode, targetPath: string): FileNode {
  if (!node.children?.length) {
    return node;
  }

  const nextChildren = node.children
    .filter((child) => child.path !== targetPath)
    .map((child) => removeNodeByPath(child, targetPath));

  return {
    ...node,
    children: sortChildren(nextChildren),
  };
}

export function findFirstUnloadedOpenFolder(node: FileNode, openFolders: Set<string>): FileNode | null {
  if (
    node.is_dir &&
    openFolders.has(node.path) &&
    node.has_children &&
    !node.children_loaded
  ) {
    return node;
  }

  for (const child of node.children || []) {
    const match = findFirstUnloadedOpenFolder(child, openFolders);
    if (match) return match;
  }

  return null;
}
