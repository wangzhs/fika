import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import "./App.css";
import type { FileNode, EditorDocument } from "./types";
import { openFolder, readFile, writeFile } from "./api";
import { FileTree } from "./components/FileTree";
import { collectFilePaths } from "./utils/tree";

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

function toRelativePath(root: string | null, absolutePath: string) {
  if (!root) return absolutePath;
  if (absolutePath.startsWith(root)) {
    const rel = absolutePath.slice(root.length);
    return rel.startsWith("/") || rel.startsWith("\\") ? rel.slice(1) : rel;
  }
  return absolutePath;
}

function App() {
  const [rootName, setRootName] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<FileNode | null>(null);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [editorDocument, setEditorDocument] = useState<EditorDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingReadRef = useRef<string | null>(null);

  const [finderOpen, setFinderOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const allFilePaths = useMemo(() => {
    if (!tree) return [];
    return collectFilePaths(tree);
  }, [tree]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allFilePaths;
    return allFilePaths.filter((p) => p.toLowerCase().includes(q));
  }, [query, allFilePaths]);

  const handleOpenFolder = useCallback(async () => {
    try {
      setError(null);
      const result = await openFolder();
      if (!result) return;
      setProjectRoot(result.root);
      setRootName(result.root.split(/[\/\\]/).pop() || result.root);
      setTree(result.tree);
      setSelectedFile("");
      setEditorDocument(null);
      setOpenFolders(new Set([result.tree.path]));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleSelectFile = useCallback(async (path: string) => {
    if (!path) return;
    if (editorDocument?.isDirty) {
      const ok = confirm("Unsaved changes will be lost. Continue?");
      if (!ok) return;
    }
    setSelectedFile(path);
    setLoading(true);
    setError(null);
    pendingReadRef.current = path;
    try {
      const content = await readFile(path);
      if (pendingReadRef.current !== path) return;
      setEditorDocument({ path, content, isDirty: false });
    } catch (e) {
      if (pendingReadRef.current !== path) return;
      setError(String(e));
      setEditorDocument(null);
    } finally {
      if (pendingReadRef.current === path) {
        setLoading(false);
      }
    }
  }, [editorDocument?.isDirty]);

  const handleSave = useCallback(async () => {
    if (!editorDocument || !editorDocument.isDirty) return;
    setSaving(true);
    setError(null);
    try {
      await writeFile(editorDocument.path, editorDocument.content);
      setEditorDocument((prev) =>
        prev ? { ...prev, isDirty: false } : prev
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [editorDocument]);

  const toggleFolder = useCallback((path: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isOpenFolder = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o";
      const isFindFile = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n";
      const isSave = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s";

      if (isOpenFolder) {
        e.preventDefault();
        handleOpenFolder();
        return;
      }

      if (isSave) {
        e.preventDefault();
        handleSave();
        return;
      }

      if (isFindFile) {
        e.preventDefault();
        if (!tree) return;
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
            handleSelectFile(filtered[selectedIndex]);
            setFinderOpen(false);
          }
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finderOpen, filtered, selectedIndex, tree, handleOpenFolder, handleSave, handleSelectFile]);

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
              {filtered.map((p, idx) => (
                <div
                  key={p}
                  className={`finder-item ${idx === selectedIndex ? "active" : ""}`}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => {
                    handleSelectFile(p);
                    setFinderOpen(false);
                  }}
                >
                  <span className="finder-icon">📝</span>
                  <span className="finder-path">{toRelativePath(projectRoot, p)}</span>
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
            if (!tree) return;
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
                  onSelectFile={handleSelectFile}
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
          <div className="breadcrumb">
            {editorDocument?.path || selectedFile || (rootName ? "Select a file" : "—")}
            {editorDocument?.isDirty ? " ●" : ""}
            {saving ? " (saving...)" : ""}
            {loading ? " (loading...)" : ""}
          </div>
          {error && (
            <div className="error-banner" style={{ padding: "8px 12px", background: "#3a1c1c", color: "#ff6b6b", borderBottom: "1px solid #5c2a2a", fontSize: 13 }}>
              {error}
            </div>
          )}
          <div className="code-editor">
            {editorDocument ? (
              <CodeMirror
                value={editorDocument.content}
                height="100%"
                theme={dracula}
                extensions={langFromPath(editorDocument.path)}
                editable={!loading}
                onChange={(value) =>
                  setEditorDocument((prev) =>
                    prev ? { ...prev, content: value, isDirty: true } : prev
                  )
                }
                basicSetup={{
                  lineNumbers: true,
                  highlightActiveLineGutter: false,
                  highlightActiveLine: false,
                  foldGutter: false,
                }}
              />
            ) : (
              <div className="code-placeholder">
                <div>
                  Press <kbd>Ctrl+O</kbd> to open a folder
                </div>
                {!error && <div>Select a file to view its contents</div>}
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="bottom-panel">
        <div className="panel-header tabs">
          <button>Diff</button>
          <button>Log</button>
          <button>Blame</button>
        </div>
        <div className="diff-content">
          <div className="diff-hunk">
            <div className="diff-line ctx">Git integration coming soon</div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
