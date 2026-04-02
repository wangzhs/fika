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
