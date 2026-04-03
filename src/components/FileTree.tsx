import type { FileNode, GitFileStatus } from "../types";

function normalizeFilePath(path: string) {
  return path.replace(/\\/g, "/");
}

interface FileTreeProps {
  node: FileNode;
  depth: number;
  openFolders: Set<string>;
  toggleFolder: (p: string) => void;
  selectedPath: string;
  projectRoot?: string | null;
  gitStatusByPath?: Record<string, GitFileStatus>;
  onSelectFile: (path: string) => void;
  onSelectPath: (path: string, isDir: boolean) => void;
  onContextMenu?: (path: string, isDir: boolean, e: React.MouseEvent) => void;
}

export function FileTree({
  node,
  depth,
  openFolders,
  toggleFolder,
  selectedPath,
  projectRoot,
  gitStatusByPath,
  onSelectFile,
  onSelectPath,
  onContextMenu,
}: FileTreeProps) {
  if (!node.is_dir) {
    const normalizedPath = normalizeFilePath(node.path);
    const normalizedRoot = normalizeFilePath(projectRoot ?? "").replace(/\/$/, "");
    const relativePath =
      normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)
        ? normalizedPath.slice(normalizedRoot.length + 1)
        : normalizedPath;
    const gitStatus = gitStatusByPath?.[relativePath] ?? null;
    return (
      <li
        className={`tree-file ${selectedPath === node.path ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          onSelectPath(node.path, false);
          onSelectFile(node.path);
        }}
        onContextMenu={(e) => onContextMenu?.(node.path, false, e)}
      >
        <span className={`tree-bullet ${gitStatus ? `git-status-${gitStatus}` : ""}`} />
        <span className="tree-label">{node.name}</span>
        {gitStatus && <span className={`tree-git-status status-${gitStatus}`}>{gitStatus}</span>}
      </li>
    );
  }

  const isOpen = openFolders.has(node.path);
  return (
    <>
      <li
        className={`tree-folder ${selectedPath === node.path ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          onSelectPath(node.path, true);
          toggleFolder(node.path);
        }}
        onContextMenu={(e) => onContextMenu?.(node.path, true, e)}
      >
        <span className="tree-chevron">{isOpen ? "▼" : "▶"}</span>
        <span className="tree-label">{node.name}</span>
      </li>
      {isOpen &&
        node.children?.map((child) => (
          <FileTree
            key={child.path}
            node={child}
            depth={depth + 1}
            openFolders={openFolders}
            toggleFolder={toggleFolder}
            selectedPath={selectedPath}
            projectRoot={projectRoot}
            gitStatusByPath={gitStatusByPath}
            onSelectFile={onSelectFile}
            onSelectPath={onSelectPath}
            onContextMenu={onContextMenu}
          />
        ))}
    </>
  );
}
