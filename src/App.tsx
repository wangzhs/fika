import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import CodeMirror from "@uiw/react-codemirror";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import "./App.css";

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
}

export interface FileEntry {
  id: string;
  path: string;
  content: string;
}

export interface FolderResult {
  root: string;
  tree: FileNode;
  files: FileEntry[];
}

function langFromPath(path: string) {
  const p = path.toLowerCase();
  if (p.endsWith(".json")) return [json()];
  if (p.endsWith(".md") || p.endsWith(".markdown")) return [markdown()];
  if (p.endsWith(".css") || p.endsWith(".scss") || p.endsWith(".less")) return [css()];
  if (
    p.endsWith(".js") ||
    p.endsWith(".jsx") ||
    p.endsWith(".ts") ||
    p.endsWith(".tsx") ||
    p.endsWith(".mjs") ||
    p.endsWith(".cjs")
  )
    return [javascript({ jsx: true, typescript: true })];
  return [];
}

function FileTree({
  node,
  depth,
  openFolders,
  toggleFolder,
  selectedFile,
  onSelectFile,
}: {
  node: FileNode;
  depth: number;
  openFolders: Set<string>;
  toggleFolder: (p: string) => void;
  selectedFile: string;
  onSelectFile: (id: string) => void;
}) {
  if (!node.is_dir) {
    return (
      <li
        className={`tree-file ${selectedFile === node.path ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelectFile(node.path)}
      >
        <span className="tree-icon file">📝</span>
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
      >
        <span className="tree-chevron">{isOpen ? "▼" : "▶"}</span>
        <span className="tree-icon folder">{isOpen ? "📂" : "📁"}</span>
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
          />
        ))}
    </>
  );
}

function App() {
  const [rootName, setRootName] = useState<string | null>(null);
  const [tree, setTree] = useState<FileNode | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [gitTab, setGitTab] = useState<"diff" | "log" | "blame">("diff");
  const [error, setError] = useState<string | null>(null);

  const [finderOpen, setFinderOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [query, files]);

  const currentFile = useMemo(
    () => files.find((f) => f.path === selectedFile),
    [files, selectedFile]
  );

  async function handleOpenFolder() {
    try {
      setError(null);
      const result = await invoke<FolderResult | null>("open_folder");
      if (!result) return;
      setRootName(result.root.split(/[\/\\]/).pop() || result.root);
      setTree(result.tree);
      setFiles(result.files);
      if (result.files.length > 0) {
        setSelectedFile(result.files[0].path);
        setOpenFolders(new Set([result.tree.path]));
      } else {
        setSelectedFile("");
        setOpenFolders(new Set());
      }
    } catch (e) {
      setError(String(e));
    }
  }

  const toggleFolder = (path: string) => {
    const next = new Set(openFolders);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setOpenFolders(next);
  };

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isOpenFolder = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o";
      const isFindFile = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n";

      if (isOpenFolder) {
        e.preventDefault();
        handleOpenFolder();
        return;
      }

      if (isFindFile) {
        e.preventDefault();
        if (files.length === 0) return;
        setFinderOpen(true);
        setQuery("");
        setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }

      if (!finderOpen) return;

      switch (e.key) {
        case "Escape":
          e.preventDefault();
          setFinderOpen(false);
          break;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (filtered[selectedIndex]) {
            setSelectedFile(filtered[selectedIndex].path);
            setFinderOpen(false);
          }
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finderOpen, filtered, selectedIndex, files.length]);

  return (
    <div className="app">
      {finderOpen && (
        <div className="finder-overlay" onClick={() => setFinderOpen(false)}>
          <div className="finder-modal" onClick={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              className="finder-input"
              placeholder="Find file (Ctrl+Shift+N)"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="finder-list">
              {filtered.map((f, idx) => (
                <div
                  key={f.id}
                  className={`finder-item ${idx === selectedIndex ? "active" : ""}`}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => {
                    setSelectedFile(f.path);
                    setFinderOpen(false);
                  }}
                >
                  <span className="finder-icon">📝</span>
                  <span className="finder-path">{f.path}</span>
                </div>
              ))}
              {filtered.length === 0 && <div className="finder-empty">No files found</div>}
            </div>
            <div className="finder-hint">
              <span>↑↓</span> navigate <span>↵</span> open <span>esc</span> close
            </div>
          </div>
        </div>
      )}

      <header className="titlebar">
        <span className="logo">Fika</span>
        <span className="project-name">{rootName || "No folder opened"}</span>
        <div className="spacer" />
        <button className="icon-btn" title="Open Folder (Ctrl+O)" onClick={handleOpenFolder}>
          📂
        </button>
        <button
          className="icon-btn"
          title="Find File (Ctrl+Shift+N)"
          onClick={() => {
            if (files.length === 0) return;
            setFinderOpen(true);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        >
          🔍
        </button>
        <div className="window-controls">
          <button>─</button>
          <button>□</button>
          <button>✕</button>
        </div>
      </header>

      <div className="main">
        <aside className="sidebar left">
          <div className="panel-header">Project</div>
          <div className="panel-content">
            <ul className="file-tree">
              {tree ? (
                <FileTree
                  node={tree}
                  depth={0}
                  openFolders={openFolders}
                  toggleFolder={toggleFolder}
                  selectedFile={selectedFile}
                  onSelectFile={setSelectedFile}
                />
              ) : (
                <li className="tree-empty" onClick={handleOpenFolder}>
                  Click to open a folder
                </li>
              )}
            </ul>
          </div>
        </aside>

        <section className="editor">
          <div className="breadcrumb">{currentFile?.path || (rootName ? "Select a file" : "—")}</div>
          <div className="code-editor">
            {currentFile ? (
              <CodeMirror
                value={currentFile.content}
                height="100%"
                theme={dracula}
                extensions={langFromPath(currentFile.path)}
                editable={false}
                basicSetup={{
                  lineNumbers: true,
                  highlightActiveLineGutter: false,
                  highlightActiveLine: false,
                  foldGutter: false,
                }}
              />
            ) : (
              <div className="code-placeholder">
                <div>Press <kbd>Ctrl+O</kbd> to open a folder</div>
                {error && <div className="error-text">{error}</div>}
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="bottom-panel">
        <div className="panel-header tabs">
          <button className={gitTab === "diff" ? "active" : ""} onClick={() => setGitTab("diff")}>
            Diff
          </button>
          <button className={gitTab === "log" ? "active" : ""} onClick={() => setGitTab("log")}>
            Log
          </button>
          <button className={gitTab === "blame" ? "active" : ""} onClick={() => setGitTab("blame")}>
            Blame
          </button>
        </div>
        <div className="diff-content">
          {gitTab === "diff" && (
            <div className="diff-hunk">
              <div className="diff-line ctx">@@ -1,4 +1,4 @@</div>
              <div className="diff-line del">- import {'{'} oldHook {'}'} from 'legacy';</div>
              <div className="diff-line add">+ import {'{'} newHook {'}'} from 'modern';</div>
              <div className="diff-line ctx">  export function Editor() {'{'}</div>
            </div>
          )}
          {gitTab === "log" && (
            <div className="git-log">
              <div className="log-row">
                <span className="hash">a1b2c3d</span>
                <span className="msg">feat: init fika project</span>
                <span className="time">2 hours ago</span>
              </div>
              <div className="log-row">
                <span className="hash">e4f5g6h</span>
                <span className="msg">docs: update readme</span>
                <span className="time">5 hours ago</span>
              </div>
            </div>
          )}
          {gitTab === "blame" && (
            <div className="git-log">
              <div className="log-row">
                <span className="hash">a1b2c3d</span>
                <span className="msg">You</span>
                <span className="time">import React from 'react';</span>
              </div>
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}

export default App;
