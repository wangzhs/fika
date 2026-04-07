import { useMemo } from "react";
import type { FileNode, GitFileStatus } from "../types";

const MAX_VISIBLE_TREE_ITEMS = 1600;

function normalizeFilePath(path: string) {
  return path.replace(/\\/g, "/");
}

interface FileTreeProps {
  node: FileNode;
  depth: number;
  openFolders: Set<string>;
  loadingFolders?: Set<string>;
  toggleFolder: (p: string) => Promise<void> | void;
  selectedPath: string;
  projectRoot?: string | null;
  gitStatusByPath?: Record<string, GitFileStatus>;
  onSelectFile: (path: string, lineNumber?: number, source?: string) => void;
  onSelectPath: (path: string, isDir: boolean) => void;
  onContextMenu?: (path: string, isDir: boolean, e: React.MouseEvent) => void;
}

export function FileTree({
  node,
  depth,
  openFolders,
  loadingFolders,
  toggleFolder,
  selectedPath,
  projectRoot,
  gitStatusByPath,
  onSelectFile,
  onSelectPath,
  onContextMenu,
}: FileTreeProps) {
  const visibleNodes = useMemo(() => {
    const items: Array<{ node: FileNode; depth: number }> = [];

    const walk = (currentNode: FileNode, currentDepth: number) => {
      if (items.length >= MAX_VISIBLE_TREE_ITEMS) return;
      items.push({ node: currentNode, depth: currentDepth });
      if (!currentNode.is_dir) return;
      if (!openFolders.has(currentNode.path)) return;
      if (currentNode.children_loaded === false) return;
      for (const child of currentNode.children || []) {
        if (items.length >= MAX_VISIBLE_TREE_ITEMS) return;
        walk(child, currentDepth + 1);
      }
    };

    walk(node, depth);
    return items;
  }, [depth, node, openFolders]);

  const hiddenCount = useMemo(() => {
    if (visibleNodes.length < MAX_VISIBLE_TREE_ITEMS) return 0;

    let count = 0;
    const walk = (currentNode: FileNode) => {
      count += 1;
      if (!currentNode.is_dir) return;
      if (!openFolders.has(currentNode.path)) return;
      if (currentNode.children_loaded === false) return;
      for (const child of currentNode.children || []) {
        walk(child);
      }
    };

    walk(node);
    return Math.max(0, count - visibleNodes.length);
  }, [node, openFolders, visibleNodes.length]);

  return (
    <>
      {visibleNodes.map(({ node: visibleNode, depth: visibleDepth }) => {
        if (!visibleNode.is_dir) {
          const normalizedPath = normalizeFilePath(visibleNode.path);
          const normalizedRoot = normalizeFilePath(projectRoot ?? "").replace(/\/$/, "");
          const relativePath =
            normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)
              ? normalizedPath.slice(normalizedRoot.length + 1)
              : normalizedPath;
          const gitStatus = gitStatusByPath?.[relativePath] ?? null;
          return (
            <li
              key={visibleNode.path}
              className={`tree-file ${selectedPath === visibleNode.path ? "active" : ""}`}
              style={{ paddingLeft: 8 + visibleDepth * 14 }}
              onClick={() => {
                onSelectPath(visibleNode.path, false);
                onSelectFile(visibleNode.path, undefined, "file-tree-click");
              }}
              onContextMenu={(e) => onContextMenu?.(visibleNode.path, false, e)}
            >
              <span className={`tree-bullet ${gitStatus ? `git-status-${gitStatus}` : ""}`} />
              <span className="tree-label">{visibleNode.name}</span>
              {gitStatus && <span className={`tree-git-status status-${gitStatus}`}>{gitStatus}</span>}
            </li>
          );
        }

        const isOpen = openFolders.has(visibleNode.path);
        const isLoading = loadingFolders?.has(visibleNode.path);
        const showChevron = visibleNode.has_children ?? !!visibleNode.children?.length;
        return (
          <li
            key={visibleNode.path}
            className={`tree-folder ${selectedPath === visibleNode.path ? "active" : ""}`}
            style={{ paddingLeft: 8 + visibleDepth * 14 }}
            onClick={() => {
              onSelectPath(visibleNode.path, true);
              void toggleFolder(visibleNode.path);
            }}
            onContextMenu={(e) => onContextMenu?.(visibleNode.path, true, e)}
          >
            <span className="tree-chevron">
              {isLoading ? "…" : showChevron ? (isOpen ? "▼" : "▶") : "•"}
            </span>
            <span className="tree-label">{visibleNode.name}</span>
          </li>
        );
      })}
      {hiddenCount > 0 && (
        <li className="tree-overflow-note">
          Showing first {visibleNodes.length} items. Expand fewer folders to view the remaining {hiddenCount}.
        </li>
      )}
    </>
  );
}
