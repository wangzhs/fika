import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import CodeMirror, { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import "./App.css";
import type { FileNode, EditorDocument, SearchResult, BottomPanelTab } from "./types";
import { openFolder, readFile, writeFile, searchInProject } from "./api";
import { FileTree } from "./components/FileTree";
import { TabBar } from "./components/TabBar";
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
  const [openTabs, setOpenTabs] = useState<EditorDocument[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [recentFilePaths, setRecentFilePaths] = useState<string[]>([]);

  const [finderOpen, setFinderOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const [recentOpen, setRecentOpen] = useState(false);
  const [recentSelectedIndex, setRecentSelectedIndex] = useState(0);

  // In-file search state
  const [inFileSearchOpen, setInFileSearchOpen] = useState(false);
  const [inFileQuery, setInFileQuery] = useState("");
  const inFileInputRef = useRef<HTMLInputElement>(null);

  // Global search state
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchResults, setGlobalSearchResults] = useState<SearchResult[]>([]);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSelectedIndex, setGlobalSelectedIndex] = useState(0);
  const globalInputRef = useRef<HTMLInputElement>(null);

  // Bottom panel tab state
  const [bottomPanelTab, setBottomPanelTab] = useState<BottomPanelTab>("search");

  // Editor ref for scrolling to line
  const editorRef = useRef<ReactCodeMirrorRef>(null);

  const allFilePaths = useMemo(() => {
    if (!tree) return [];
    return collectFilePaths(tree);
  }, [tree]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allFilePaths;
    return allFilePaths.filter((p) => p.toLowerCase().includes(q));
  }, [query, allFilePaths]);

  const activeTab = useMemo(
    () => openTabs.find((t) => t.path === activeTabPath) || null,
    [openTabs, activeTabPath]
  );

  // In-file search state - current match index tracking (-1 means no selection yet)
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);

  // In-file search matches
  const inFileMatches = useMemo(() => {
    if (!activeTab || !inFileQuery.trim()) return [];
    const query = inFileQuery.toLowerCase();
    const lines = activeTab.content.split('\n');
    const matches: number[] = [];
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes(query)) {
        matches.push(idx + 1);
      }
    });
    return matches;
  }, [activeTab, inFileQuery]);

  // Reset current match index when search query or active tab changes
  useEffect(() => {
    setCurrentMatchIndex(-1);
  }, [inFileQuery, activeTabPath]);

  const updateRecentFiles = useCallback((path: string) => {
    if (!projectRoot || !path.startsWith(projectRoot)) return;
    setRecentFilePaths((prev) => {
      const filtered = prev.filter((p) => p !== path);
      return [path, ...filtered].slice(0, 20);
    });
  }, [projectRoot]);

  // Scroll to a specific line in the editor
  const scrollToLine = useCallback((lineNumber: number) => {
    const view = editorRef.current?.view;
    if (!view) return;

    try {
      const doc = view.state.doc;
      const line = doc.line(Math.min(Math.max(1, lineNumber), doc.lines));
      if (line) {
        view.dispatch({
          selection: { anchor: line.from },
          scrollIntoView: true,
        });
      }
    } catch {
      // Ignore errors from invalid line numbers
    }
  }, []);

  // In-file search navigation
  const goToNextMatch = useCallback(() => {
    if (inFileMatches.length === 0) return;
    // If no selection yet, select first match (index 0), otherwise go to next
    const nextIndex = currentMatchIndex === -1 ? 0 : (currentMatchIndex + 1) % inFileMatches.length;
    setCurrentMatchIndex(nextIndex);
    scrollToLine(inFileMatches[nextIndex]);
  }, [inFileMatches, currentMatchIndex, scrollToLine]);

  const goToPrevMatch = useCallback(() => {
    if (inFileMatches.length === 0) return;
    // If no selection yet, select last match, otherwise go to previous
    const prevIndex = currentMatchIndex === -1
      ? inFileMatches.length - 1
      : (currentMatchIndex - 1 + inFileMatches.length) % inFileMatches.length;
    setCurrentMatchIndex(prevIndex);
    scrollToLine(inFileMatches[prevIndex]);
  }, [inFileMatches, currentMatchIndex, scrollToLine]);

  // Global search handler
  const handleGlobalSearch = useCallback(async () => {
    if (!projectRoot || !globalSearchQuery.trim()) {
      setGlobalSearchResults([]);
      return;
    }

    setGlobalSearchLoading(true);
    setError(null);

    try {
      const results = await searchInProject(projectRoot, globalSearchQuery);
      setGlobalSearchResults(results);
      setGlobalSelectedIndex(0);
      setBottomPanelTab("search");
    } catch (e) {
      setError(String(e));
      setGlobalSearchResults([]);
    } finally {
      setGlobalSearchLoading(false);
    }
  }, [projectRoot, globalSearchQuery]);

  const handleOpenFolder = useCallback(async () => {
    if (openTabs.some((t) => t.isDirty)) {
      const ok = confirm("Unsaved changes will be lost. Open new folder?");
      if (!ok) return;
    }
    try {
      setError(null);
      const result = await openFolder();
      if (!result) return;
      setProjectRoot(result.root);
      setRootName(result.root.split(/[\/\\]/).pop() || result.root);
      setTree(result.tree);
      setOpenTabs([]);
      setActiveTabPath("");
      setRecentFilePaths([]);
      setOpenFolders(new Set([result.tree.path]));
    } catch (e) {
      setError(String(e));
    }
  }, [openTabs]);

  const handleOpenFile = useCallback(
    async (path: string, lineNumber?: number) => {
      if (!path) return;
      const existing = openTabs.find((t) => t.path === path);
      if (existing) {
        setActiveTabPath(path);
        updateRecentFiles(path);
        // If line number specified, scroll to it after a short delay to allow editor to render
        if (lineNumber !== undefined && lineNumber > 0) {
          setTimeout(() => scrollToLine(lineNumber), 50);
        }
        return;
      }

      const newTab: EditorDocument = {
        path,
        content: "",
        isDirty: false,
        isLoading: true,
        isSaving: false,
      };
      setOpenTabs((prev) => [...prev, newTab]);
      setActiveTabPath(path);
      setError(null);

      try {
        const content = await readFile(path);
        setOpenTabs((prev) =>
          prev.map((t) =>
            t.path === path ? { ...t, content, isLoading: false } : t
          )
        );
        updateRecentFiles(path);
        // If line number specified, scroll to it after content is loaded
        if (lineNumber !== undefined && lineNumber > 0) {
          setTimeout(() => scrollToLine(lineNumber), 100);
        }
      } catch (e) {
        setError(String(e));
        setOpenTabs((prev) => {
          const next = prev.filter((t) => t.path !== path);
          return next;
        });
        setActiveTabPath((current) =>
          current === path ? "" : current
        );
      }
    },
    [openTabs, activeTabPath, updateRecentFiles, scrollToLine]
  );

  const handleSave = useCallback(async () => {
    const tab = openTabs.find((t) => t.path === activeTabPath);
    if (!tab || !tab.isDirty || tab.isLoading || tab.isSaving) return;
    setOpenTabs((prev) =>
      prev.map((t) => (t.path === activeTabPath ? { ...t, isSaving: true } : t))
    );
    setError(null);
    try {
      await writeFile(tab.path, tab.content);
      setOpenTabs((prev) =>
        prev.map((t) =>
          t.path === activeTabPath ? { ...t, isDirty: false, isSaving: false } : t
        )
      );
    } catch (e) {
      setError(String(e));
      setOpenTabs((prev) =>
        prev.map((t) => (t.path === activeTabPath ? { ...t, isSaving: false } : t))
      );
    }
  }, [openTabs, activeTabPath]);

  const handleSaveAll = useCallback(async () => {
    const dirtyTabs = openTabs.filter((t) => t.isDirty && !t.isLoading && !t.isSaving);
    if (dirtyTabs.length === 0) return;

    // Mark all dirty tabs as saving
    setOpenTabs((prev) =>
      prev.map((t) => (t.isDirty && !t.isLoading && !t.isSaving ? { ...t, isSaving: true } : t))
    );
    setError(null);

    // Save each tab independently, collecting errors
    const results = await Promise.allSettled(
      dirtyTabs.map(async (tab) => {
        try {
          await writeFile(tab.path, tab.content);
          return { path: tab.path, success: true, error: null };
        } catch (e) {
          return { path: tab.path, success: false, error: String(e) };
        }
      })
    );

    // Update tab states based on results (only for tabs that participated in save)
    const errors: string[] = [];
    const savedPaths = new Set(dirtyTabs.map((t) => t.path));
    setOpenTabs((prev) =>
      prev.map((t) => {
        if (!savedPaths.has(t.path)) return t;
        const result = results.find((r) => r.status === "fulfilled" && r.value.path === t.path);
        if (!result) return { ...t, isSaving: false };
        const { success, error } = (result as PromiseFulfilledResult<{ path: string; success: boolean; error: string | null }>).value;
        if (!success && error) {
          errors.push(`${t.path}: ${error}`);
        }
        return { ...t, isDirty: success ? false : t.isDirty, isSaving: false };
      })
    );

    if (errors.length > 0) {
      setError(`Save all failed for some files:\n${errors.join("\n")}`);
    }
  }, [openTabs]);

  const handleSwitchTab = useCallback((path: string) => {
    setActiveTabPath(path);
    updateRecentFiles(path);
  }, [updateRecentFiles]);

  const handleCloseTab = useCallback(
    (path: string) => {
      const tab = openTabs.find((t) => t.path === path);
      if (!tab) return;
      if (tab.isDirty) {
        const ok = confirm("Unsaved changes will be lost. Close tab?");
        if (!ok) return;
      }
      const idx = openTabs.findIndex((t) => t.path === path);
      const nextTabs = openTabs.filter((t) => t.path !== path);
      setOpenTabs(nextTabs);
      if (activeTabPath === path) {
        if (nextTabs.length === 0) {
          setActiveTabPath("");
        } else {
          const next =
            nextTabs[Math.min(idx, nextTabs.length - 1)] ||
            nextTabs[nextTabs.length - 1];
          setActiveTabPath(next.path);
        }
      }
    },
    [openTabs, activeTabPath]
  );

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
    setRecentSelectedIndex(0);
  }, [recentOpen]);

  useEffect(() => {
    setGlobalSelectedIndex(0);
  }, [globalSearchQuery]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isOpenFolder =
        (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o";
      const isFindFile =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n";
      const isSaveAll =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s";
      const isSave =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "s";
      const isRecentFiles =
        (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e";
      const isInFileSearch =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f";
      const isGlobalSearch =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f";

      // Handle Global Search modal keyboard navigation
      if (globalSearchOpen) {
        switch (e.key) {
          case "Escape":
            e.preventDefault();
            setGlobalSearchOpen(false);
            return;
          case "ArrowDown":
            e.preventDefault();
            setGlobalSelectedIndex((i) => Math.min(i + 1, globalSearchResults.length - 1));
            return;
          case "ArrowUp":
            e.preventDefault();
            setGlobalSelectedIndex((i) => Math.max(i - 1, 0));
            return;
          case "Enter":
            e.preventDefault();
            if (globalSearchResults[globalSelectedIndex]) {
              const result = globalSearchResults[globalSelectedIndex];
              handleOpenFile(result.path, result.line_number);
              setGlobalSearchOpen(false);
            }
            return;
        }
      }

      // Handle In-file search
      if (inFileSearchOpen) {
        switch (e.key) {
          case "Escape":
            e.preventDefault();
            setInFileSearchOpen(false);
            return;
          case "Enter":
            if (e.shiftKey) {
              e.preventDefault();
              goToPrevMatch();
            } else {
              e.preventDefault();
              goToNextMatch();
            }
            return;
        }
      }

      // Handle Recent Files modal keyboard navigation
      if (recentOpen) {
        switch (e.key) {
          case "Escape":
            e.preventDefault();
            setRecentOpen(false);
            return;
          case "ArrowDown":
            e.preventDefault();
            setRecentSelectedIndex((i) => Math.min(i + 1, recentFilePaths.length - 1));
            return;
          case "ArrowUp":
            e.preventDefault();
            setRecentSelectedIndex((i) => Math.max(i - 1, 0));
            return;
          case "Enter":
            e.preventDefault();
            if (recentFilePaths[recentSelectedIndex]) {
              handleOpenFile(recentFilePaths[recentSelectedIndex]);
              setRecentOpen(false);
            }
            return;
        }
      }

      // Handle Finder modal keyboard navigation
      if (finderOpen) {
        switch (e.key) {
          case "Escape":
            e.preventDefault();
            setFinderOpen(false);
            return;
          case "ArrowDown":
            e.preventDefault();
            setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
            return;
          case "ArrowUp":
            e.preventDefault();
            setSelectedIndex((i) => Math.max(i - 1, 0));
            return;
          case "Enter":
            e.preventDefault();
            if (filtered[selectedIndex]) {
              handleOpenFile(filtered[selectedIndex]);
              setFinderOpen(false);
            }
            return;
        }
      }

      // Global shortcuts
      if (isOpenFolder) {
        e.preventDefault();
        handleOpenFolder();
        return;
      }

      if (isSaveAll) {
        e.preventDefault();
        handleSaveAll();
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

      if (isRecentFiles) {
        e.preventDefault();
        if (recentFilePaths.length === 0) return;
        setRecentOpen(true);
        setRecentSelectedIndex(0);
        return;
      }

      if (isInFileSearch) {
        e.preventDefault();
        if (!activeTab) return;
        setInFileSearchOpen(true);
        setTimeout(() => inFileInputRef.current?.focus(), 0);
        return;
      }

      if (isGlobalSearch) {
        e.preventDefault();
        if (!projectRoot) return;
        setGlobalSearchOpen(true);
        setTimeout(() => globalInputRef.current?.focus(), 0);
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    finderOpen,
    filtered,
    selectedIndex,
    recentOpen,
    recentFilePaths,
    recentSelectedIndex,
    globalSearchOpen,
    globalSearchResults,
    globalSelectedIndex,
    inFileSearchOpen,
    activeTab,
    projectRoot,
    tree,
    handleOpenFolder,
    handleSave,
    handleSaveAll,
    handleOpenFile,
    goToNextMatch,
    goToPrevMatch,
  ]);

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
                    handleOpenFile(p);
                    setFinderOpen(false);
                  }}
                >
                  <span className="finder-icon">📝</span>
                  <span className="finder-path">
                    {toRelativePath(projectRoot, p)}
                  </span>
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="finder-empty">No files found</div>
              )}
            </div>
            <div className="finder-hint">
              <span>↑↓</span> navigate <span>↵</span> open <span>esc</span> close
            </div>
          </div>
        </div>
      )}

      {recentOpen && (
        <div className="finder-overlay" onClick={() => setRecentOpen(false)}>
          <div className="finder-modal" onClick={(e) => e.stopPropagation()}>
            <div className="finder-header">Recent Files</div>
            <div className="finder-list">
              {recentFilePaths.map((p, idx) => (
                <div
                  key={p}
                  className={`finder-item ${idx === recentSelectedIndex ? "active" : ""}`}
                  onMouseEnter={() => setRecentSelectedIndex(idx)}
                  onClick={() => {
                    handleOpenFile(p);
                    setRecentOpen(false);
                  }}
                >
                  <span className="finder-icon">📝</span>
                  <span className="finder-path">
                    {toRelativePath(projectRoot, p)}
                  </span>
                </div>
              ))}
            </div>
            <div className="finder-hint">
              <span>↑↓</span> navigate <span>↵</span> open <span>esc</span> close
            </div>
          </div>
        </div>
      )}

      {/* In-file Search Bar */}
      {inFileSearchOpen && activeTab && (
        <div className="infile-search-bar">
          <input
            ref={inFileInputRef}
            className="infile-search-input"
            placeholder="Find in file..."
            value={inFileQuery}
            onChange={(e) => setInFileQuery(e.target.value)}
          />
          <span className="infile-search-count">
            {inFileMatches.length > 0
              ? currentMatchIndex === -1
                ? `- of ${inFileMatches.length}`
                : `${currentMatchIndex + 1} of ${inFileMatches.length}`
              : inFileQuery ? "0 of 0" : ""}
          </span>
          <button
            className="infile-search-btn"
            onClick={goToPrevMatch}
            disabled={inFileMatches.length === 0}
            title="Previous match (Shift+Enter)"
          >
            ↑
          </button>
          <button
            className="infile-search-btn"
            onClick={goToNextMatch}
            disabled={inFileMatches.length === 0}
            title="Next match (Enter)"
          >
            ↓
          </button>
          <button
            className="infile-search-btn close"
            onClick={() => setInFileSearchOpen(false)}
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
      )}

      {/* Global Search Modal */}
      {globalSearchOpen && (
        <div className="finder-overlay" onClick={() => setGlobalSearchOpen(false)}>
          <div className="finder-modal global-search-modal" onClick={(e) => e.stopPropagation()}>
            <input
              ref={globalInputRef}
              className="finder-input"
              placeholder="Search in project... (Ctrl+Shift+F)"
              value={globalSearchQuery}
              onChange={(e) => setGlobalSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleGlobalSearch();
                }
              }}
            />
            <div className="finder-actions">
              <button
                className="search-btn"
                onClick={handleGlobalSearch}
                disabled={globalSearchLoading || !globalSearchQuery.trim()}
              >
                {globalSearchLoading ? "Searching..." : "Search"}
              </button>
            </div>
            <div className="finder-list search-results">
              {globalSearchResults.length > 0 ? (
                globalSearchResults.map((result, idx) => (
                  <div
                    key={`${result.path}:${result.line_number}`}
                    className={`search-result-item ${idx === globalSelectedIndex ? "active" : ""}`}
                    onMouseEnter={() => setGlobalSelectedIndex(idx)}
                    onClick={() => {
                      handleOpenFile(result.path, result.line_number);
                      setGlobalSearchOpen(false);
                    }}
                  >
                    <div className="search-result-path">
                      {toRelativePath(projectRoot, result.path)}:{result.line_number}
                    </div>
                    <div className="search-result-content">
                      {result.matched_fragment}
                    </div>
                  </div>
                ))
              ) : globalSearchQuery && !globalSearchLoading ? (
                <div className="finder-empty">
                  {globalSearchResults.length === 0 ? "No results found" : ""}
                </div>
              ) : null}
            </div>
            <div className="finder-hint">
              <span>↑↓</span> navigate <span>↵</span> open <span>esc</span> close
            </div>
          </div>
        </div>
      )}

      <header className="titlebar">
        <span className="logo">Fika</span>
        <span className="project-name">
          {rootName || "No folder opened"}
        </span>
        <div className="spacer" />
        <button
          className="icon-btn"
          title="Open Folder (Ctrl+O)"
          onClick={handleOpenFolder}
        >
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
                  selectedFile={activeTabPath}
                  onSelectFile={handleOpenFile}
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
            {activeTab?.path || (rootName ? "Select a file" : "—")}
            {activeTab?.isDirty ? " ●" : ""}
            {activeTab?.isSaving ? " (saving...)" : ""}
            {activeTab?.isLoading ? " (loading...)" : ""}
          </div>
          <TabBar
            tabs={openTabs}
            activeTabPath={activeTabPath}
            onSwitchTab={handleSwitchTab}
            onCloseTab={handleCloseTab}
          />
          {error && (
            <div
              className="error-banner"
              style={{
                padding: "8px 12px",
                background: "#3a1c1c",
                color: "#ff6b6b",
                borderBottom: "1px solid #5c2a2a",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}
          <div className="code-editor">
            {activeTab ? (
              <CodeMirror
                ref={editorRef}
                value={activeTab.content}
                height="100%"
                theme={dracula}
                extensions={langFromPath(activeTab.path)}
                editable={!activeTab.isLoading && !activeTab.isSaving}
                onChange={(value) =>
                  setOpenTabs((prev) =>
                    prev.map((t) =>
                      t.path === activeTabPath
                        ? { ...t, content: value, isDirty: true }
                        : t
                    )
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
          <button
            className={bottomPanelTab === "search" ? "active" : ""}
            onClick={() => setBottomPanelTab("search")}
          >
            Search
          </button>
          <button
            className={bottomPanelTab === "diff" ? "active" : ""}
            onClick={() => setBottomPanelTab("diff")}
          >
            Diff
          </button>
          <button
            className={bottomPanelTab === "log" ? "active" : ""}
            onClick={() => setBottomPanelTab("log")}
          >
            Log
          </button>
          <button
            className={bottomPanelTab === "blame" ? "active" : ""}
            onClick={() => setBottomPanelTab("blame")}
          >
            Blame
          </button>
        </div>
        <div className="panel-content-area">
          {bottomPanelTab === "search" && (
            <div className="search-results-panel">
              {globalSearchLoading ? (
                <div className="search-loading">Searching...</div>
              ) : globalSearchResults.length > 0 ? (
                globalSearchResults.map((result) => (
                  <div
                    key={`${result.path}:${result.line_number}`}
                    className="search-result-row"
                    onClick={() => handleOpenFile(result.path, result.line_number)}
                  >
                    <span className="search-result-file">{toRelativePath(projectRoot, result.path)}</span>
                    <span className="search-result-line">:{result.line_number}</span>
                    <span className="search-result-text">{result.matched_fragment}</span>
                  </div>
                ))
              ) : (
                <div className="search-empty">
                  {globalSearchQuery
                    ? "No results found"
                    : "Use Ctrl+Shift+F to search in project"}
                </div>
              )}
            </div>
          )}
          {bottomPanelTab === "diff" && (
            <div className="diff-content">
              <div className="diff-hunk">
                <div className="diff-line ctx">Git integration coming soon</div>
              </div>
            </div>
          )}
          {bottomPanelTab === "log" && (
            <div className="diff-content">
              <div className="diff-hunk">
                <div className="diff-line ctx">Git log will appear here</div>
              </div>
            </div>
          )}
          {bottomPanelTab === "blame" && (
            <div className="diff-content">
              <div className="diff-hunk">
                <div className="diff-line ctx">Git blame will appear here</div>
              </div>
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}

export default App;
