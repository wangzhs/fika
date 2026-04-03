import type { FileNode } from "../types";

interface FileTreeProps {
  node: FileNode;
  depth: number;
  openFolders: Set<string>;
  toggleFolder: (p: string) => void;
  selectedFile: string;
  onSelectFile: (path: string) => void;
  onContextMenu?: (path: string, isDir: boolean, e: React.MouseEvent) => void;
}

export function FileTree({
  node,
  depth,
  openFolders,
  toggleFolder,
  selectedFile,
  onSelectFile,
  onContextMenu,
}: FileTreeProps) {
  if (!node.is_dir) {
    return (
      <li
        className={`tree-file ${selectedFile === node.path ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelectFile(node.path)}
        onContextMenu={(e) => onContextMenu?.(node.path, false, e)}
      >
        <span className="tree-bullet" />
        <span className="tree-label">{node.name}</span>
      </li>
    );
  }

  const isOpen = openFolders.has(node.path);
  return (
    <>
      <li
        className="tree-folder"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => toggleFolder(node.path)}
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
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            onContextMenu={onContextMenu}
          />
        ))}
    </>
  );
}
