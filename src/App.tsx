import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import CodeMirror, { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { EditorView, Decoration, gutter, GutterMarker, keymap } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./App.css";
import type { Branch, ChangedFile, Commit, CommitFiles, FileDiff, FileNode, EditorDocument, SearchResult, BottomPanelTab, FileBlame, StagedFile, RecentProject, NavigationEntry } from "./types";
import {
  openFolder, readFile, writeFile, searchInProject,
  getCurrentBranch, getBranches, switchBranch,
  getGitHistory, getWorkingTreeChanges, getFileDiff, getCommitFiles,
  getFileBlame, stageFile, unstageFile, discardFileChanges, commit, getStagedFiles,
  createFile, createDirectory, renamePath, deletePath, refreshTree,
  saveRecentProjects, loadRecentProjects, saveSession, loadSession, setUnsavedChangesFlag, getOpenTarget
} from "./api";
import { FileTree } from "./components/FileTree";
import { TabBar } from "./components/TabBar";
import { collectFilePaths } from "./utils/tree";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow, getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo } from "@tauri-apps/api/event";

function computeModifiedLineNumbers(originalContent: string, currentContent: string) {
  const originalLines = originalContent.split("\n");
  const currentLines = currentContent.split("\n");

  let prefixLength = 0;
  const maxPrefix = Math.min(originalLines.length, currentLines.length);
  while (
    prefixLength < maxPrefix &&
    originalLines[prefixLength] === currentLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let originalSuffix = originalLines.length - 1;
  let currentSuffix = currentLines.length - 1;
  while (
    originalSuffix >= prefixLength &&
    currentSuffix >= prefixLength &&
    originalLines[originalSuffix] === currentLines[currentSuffix]
  ) {
    originalSuffix -= 1;
    currentSuffix -= 1;
  }

  const modifiedLines = new Set<number>();
  if (currentSuffix < prefixLength) {
    return modifiedLines;
  }

  for (let lineNumber = prefixLength + 1; lineNumber <= currentSuffix + 1; lineNumber += 1) {
    modifiedLines.add(lineNumber);
  }

  return modifiedLines;
}

class ModifiedLineMarker extends GutterMarker {
  constructor(private readonly className = "cm-modified-line-marker") {
    super();
  }

  toDOM() {
    const marker = document.createElement("span");
    marker.className = this.className;
    return marker;
  }
}

const modifiedLineMarker = new ModifiedLineMarker();
const addedLineMarker = new ModifiedLineMarker("cm-added-line-marker");
const deletedLineMarker = new ModifiedLineMarker("cm-deleted-line-marker");

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

function normalizeFilePath(path: string) {
  return path.replace(/\\/g, "/");
}

function toProjectRelativePathValue(projectRoot: string | null, absolutePath: string) {
  if (!projectRoot) return normalizeFilePath(absolutePath);
  const normalizedRoot = normalizeFilePath(projectRoot).replace(/\/$/, "");
  const normalizedPath = normalizeFilePath(absolutePath);
  if (!normalizedPath.startsWith(`${normalizedRoot}/`) && normalizedPath !== normalizedRoot) {
    return normalizedPath;
  }
  return normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, "");
}

function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/i.test(navigator.platform);
}

declare global {
  interface Window {
    __FIKA_CLOSE_ACTIVE_TAB__?: () => void;
    __FIKA_OPEN_FOLDER__?: () => void;
    __FIKA_SHOW_RECENT_PROJECTS__?: () => void;
    __FIKA_OPEN_FOLDER_NEW_WINDOW__?: () => void;
    __FIKA_CLEAR_PROJECT__?: () => void;
    __FIKA_SESSION_RESTORED__?: boolean;
  }
}

function App() {
  const isMac = useMemo(() => isMacPlatform(), []);
  const [markdownPreviewOpen, setMarkdownPreviewOpen] = useState(false);
  const shortcutLabel = useCallback((key: string, options?: { shift?: boolean; alt?: boolean }) => {
    if (isMac) {
      return `${options?.shift ? "⇧" : ""}${options?.alt ? "⌥" : ""}⌘${key}`;
    }
    const parts = ["Ctrl"];
    if (options?.shift) parts.push("Shift");
    if (options?.alt) parts.push("Alt");
    parts.push(key);
    return parts.join("+");
  }, [isMac]);

  const [rootName, setRootName] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<FileNode | null>(null);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [openTabs, setOpenTabs] = useState<EditorDocument[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string>("");
  const [selectedTreePath, setSelectedTreePath] = useState<string>("");
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
  const [bottomPanelTab, setBottomPanelTab] = useState<BottomPanelTab>("diff");
  const [isBottomPanelOpen, setIsBottomPanelOpen] = useState(false);

  // Git state
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [gitHistory, setGitHistory] = useState<Commit[]>([]);
  const [gitHistoryFilePath, setGitHistoryFilePath] = useState<string | null>(null);
  const [gitChanges, setGitChanges] = useState<ChangedFile[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFiles | null>(null);
  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
  const [selectedGitFilePath, setSelectedGitFilePath] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [activeEditorGitDiff, setActiveEditorGitDiff] = useState<FileDiff | null>(null);
  const [diffSourceTab, setDiffSourceTab] = useState<"diff" | "log">("diff");
  const [branchSwitcherOpen, setBranchSwitcherOpen] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);

  // Git blame state
  const [fileBlame, setFileBlame] = useState<FileBlame | null>(null);
  const [selectedBlameCommitHash, setSelectedBlameCommitHash] = useState<string | null>(null);

  // Git staging/commit state
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [isCommitting, setIsCommitting] = useState(false);

  // Persistence state
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [recentProjectsOpen, setRecentProjectsOpen] = useState(false);

  // File tree context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const [renameModal, setRenameModal] = useState<{ path: string; isDir: boolean; newName: string } | null>(null);
  const [newFileModal, setNewFileModal] = useState<{ dirPath: string; name: string; isDir: boolean } | null>(null);
  const [discardFileModalPath, setDiscardFileModalPath] = useState<string | null>(null);

  // Navigation history state
  const [navHistory, setNavHistory] = useState<NavigationEntry[]>([]);
  const [navIndex, setNavIndex] = useState(-1);
  const isNavigatingRef = useRef(false);
  const resizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(260);
  const pendingOpenPathsRef = useRef<Set<string>>(new Set());

  // Editor ref for scrolling to line
  const editorRef = useRef<ReactCodeMirrorRef>(null);

  const isSameOrDescendantPath = useCallback((candidate: string, parent: string) => {
    if (candidate === parent) return true;
    const normalizedParent = parent.endsWith("/") || parent.endsWith("\\")
      ? parent
      : `${parent}/`;
    return candidate.startsWith(normalizedParent) || candidate.startsWith(`${parent}\\`);
  }, []);

  const replacePathPrefix = useCallback((originalPath: string, oldBase: string, newBase: string) => {
    if (originalPath === oldBase) return newBase;
    const suffix = originalPath.slice(oldBase.length);
    return `${newBase}${suffix}`;
  }, []);

  const toProjectRelativePath = useCallback((absolutePath: string) => {
    return toProjectRelativePathValue(projectRoot, absolutePath);
  }, [projectRoot]);

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
  const isMarkdownTab = useMemo(
    () => !!activeTab?.path && /\.(md|markdown)$/i.test(activeTab.path),
    [activeTab]
  );
  const getEditorContent = useCallback(
    () => editorRef.current?.view?.state.doc.toString() ?? null,
    []
  );
  const hasUnsavedChangesForPath = useCallback((path: string) => {
    const tab = openTabs.find((t) => t.path === path);
    if (!tab) return false;
    const currentContent =
      path === activeTabPath ? (getEditorContent() ?? tab.content) : tab.content;
    return currentContent !== tab.originalContent;
  }, [activeTabPath, getEditorContent, openTabs]);
  const hasAnyUnsavedTabs = useMemo(
    () => openTabs.some((tab) => hasUnsavedChangesForPath(tab.path)),
    [openTabs, hasUnsavedChangesForPath]
  );

  const lineChangeSets = useMemo(() => {
    const modified = new Set<number>();
    const added = new Set<number>();
    const deleted = new Set<number>();
    const currentRelativePath =
      activeTab && projectRoot && activeTab.path.startsWith(projectRoot)
        ? toProjectRelativePath(activeTab.path)
        : null;
    const currentGitStatus = currentRelativePath
      ? stagedFiles.find((file) => file.path === currentRelativePath)?.status ??
        gitChanges.find((file) => file.path === currentRelativePath)?.status ??
        null
      : null;

    if (currentGitStatus === "?") {
      const lineCount = activeTab?.content.split("\n").length ?? 0;
      for (let lineNumber = 1; lineNumber <= lineCount; lineNumber += 1) {
        added.add(lineNumber);
      }
    } else if (activeEditorGitDiff?.hunks.length) {
      for (const hunk of activeEditorGitDiff.hunks) {
        let pendingDeleted = 0;
        let deleteAnchor = hunk.new_start;

        for (const line of hunk.lines) {
          if (line.kind === " ") {
            if (pendingDeleted > 0) {
              deleted.add(Math.max(1, deleteAnchor));
              pendingDeleted = 0;
            }
            continue;
          }

          if (line.kind === "-") {
            pendingDeleted += 1;
            deleteAnchor = line.new_line ?? deleteAnchor;
            continue;
          }

          if (line.kind === "+") {
            if (pendingDeleted > 0) {
              if (line.new_line) modified.add(line.new_line);
              pendingDeleted -= 1;
            } else if (line.new_line) {
              added.add(line.new_line);
            }
          }
        }

        if (pendingDeleted > 0) {
          deleted.add(Math.max(1, deleteAnchor));
        }
      }
    } else if (activeTab?.isDirty) {
      for (const lineNumber of computeModifiedLineNumbers(activeTab.originalContent, activeTab.content)) {
        modified.add(lineNumber);
      }
    }

    return { modified, added, deleted };
  }, [activeEditorGitDiff, activeTab, gitChanges, projectRoot, stagedFiles, toProjectRelativePath]);

  const modifiedLineExtensions = useMemo(() => {
    if (
      !activeTab ||
      (lineChangeSets.modified.size === 0 &&
        lineChangeSets.added.size === 0 &&
        lineChangeSets.deleted.size === 0)
    ) {
      return [];
    }

    const lineDecorations = EditorView.decorations.compute([], (state) => {
      const builder = new RangeSetBuilder<Decoration>();
      for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
        let className = "";
        if (lineChangeSets.modified.has(lineNumber)) className = "cm-line-modified";
        else if (lineChangeSets.added.has(lineNumber)) className = "cm-line-added";
        else if (lineChangeSets.deleted.has(lineNumber)) className = "cm-line-deleted-anchor";
        if (!className) continue;
        const line = state.doc.line(lineNumber);
        builder.add(line.from, line.from, Decoration.line({ class: className }));
      }
      return builder.finish();
    });

    const modifiedLineGutter = gutter({
      class: "cm-modified-gutter",
      markers: (view) => {
        const builder = new RangeSetBuilder<GutterMarker>();
        for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
          let marker: GutterMarker | null = null;
          if (lineChangeSets.modified.has(lineNumber)) marker = modifiedLineMarker;
          else if (lineChangeSets.added.has(lineNumber)) marker = addedLineMarker;
          else if (lineChangeSets.deleted.has(lineNumber)) marker = deletedLineMarker;
          if (!marker) continue;
          const line = view.state.doc.line(lineNumber);
          builder.add(line.from, line.from, marker);
        }
        return builder.finish();
      },
      initialSpacer: () => modifiedLineMarker,
    });

    return [modifiedLineGutter, lineDecorations];
  }, [activeTab, lineChangeSets]);

  const gitStatusByPath = useMemo(() => {
    const statusMap: Record<string, string> = {};
    for (const file of gitChanges) {
      statusMap[normalizeFilePath(file.path)] = file.status;
    }
    for (const file of stagedFiles) {
      statusMap[normalizeFilePath(file.path)] = file.status;
    }
    return statusMap;
  }, [gitChanges, stagedFiles]);

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

  useEffect(() => {
    setMarkdownPreviewOpen(false);
  }, [activeTabPath]);

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
    } catch (e) {
      setError(String(e));
      setGlobalSearchResults([]);
    } finally {
      setGlobalSearchLoading(false);
    }
  }, [projectRoot, globalSearchQuery]);

  // Add a project to recent projects list
  const addRecentProject = useCallback((rootPath: string) => {
    const name = rootPath.split(/[\/\\]/).pop() || rootPath;
    setRecentProjects(prev => {
      const filtered = prev.filter(p => p.path !== rootPath);
      const updated = [{ path: rootPath, name, last_opened: Date.now() }, ...filtered].slice(0, 10);
      saveRecentProjects(updated).catch(() => {});
      return updated;
    });
  }, []);

  // Modified handleOpenFolder to support recent projects
  const handleOpenFolderWithSession = useCallback(async (targetPath?: string) => {
    if (openTabs.some((t) => t.isDirty)) {
      const ok = confirm("Unsaved changes will be lost. Open new folder?");
      if (!ok) return;
    }
    try {
      setError(null);
      const result = targetPath ? { root: targetPath, tree: await refreshTree(targetPath) } : await openFolder();
      if (!result) return;
      setProjectRoot(result.root);
      setRootName(result.root.split(/[\/\\]/).pop() || result.root);
      setTree(result.tree);
      setOpenTabs([]);
      setActiveTabPath("");
      setSelectedTreePath(result.tree.path);
      setRecentFilePaths([]);
      setSelectedGitFilePath(null);
      setOpenFolders(new Set([result.tree.path]));
      // Add to recent projects
      addRecentProject(result.root);
      // Clear navigation history
      setNavHistory([]);
      setNavIndex(-1);
      const [changes, staged] = await Promise.all([
        getWorkingTreeChanges(result.root).catch(() => []),
        getStagedFiles(result.root).catch(() => []),
      ]);
      setGitChanges(changes);
      setStagedFiles(staged);
    } catch (e) {
      setError(String(e));
    }
  }, [openTabs, addRecentProject]);

  const handleOpenFolder = useCallback(async () => {
    await handleOpenFolderWithSession();
  }, [handleOpenFolderWithSession]);

  const createProjectWindow = useCallback(async (targetPath?: string) => {
    let projectPath = targetPath;
    if (!projectPath) {
      const result = await openFolder();
      if (!result) return;
      projectPath = result.root;
    }

    const label = `project-${Date.now()}`;
    const storageKey = `fika:pending-project:${label}`;
    localStorage.setItem(storageKey, projectPath);

    const nextWindow = new WebviewWindow(label, {
      title: "fika",
      width: 1440,
      height: 900,
      minWidth: 1100,
      minHeight: 720,
      url: window.location.href,
    });

    nextWindow.once("tauri://created", () => {
      setTimeout(() => {
        void emitTo({ kind: "WebviewWindow", label }, "fika://open-project-path", projectPath);
      }, 250);
    });

    nextWindow.once("tauri://error", () => {
      localStorage.removeItem(storageKey);
      setError("Failed to open a new project window");
    });
  }, []);

  const clearCurrentProject = useCallback(async () => {
    pendingOpenPathsRef.current.clear();
    setProjectRoot(null);
    setRootName(null);
    setTree(null);
    setOpenFolders(new Set());
    setOpenTabs([]);
    setActiveTabPath("");
    setSelectedTreePath("");
    setRecentFilePaths([]);
    setNavHistory([]);
    setNavIndex(-1);
    setBottomPanelTab("diff");
    setIsBottomPanelOpen(false);
    setCurrentBranch(null);
    setBranches([]);
    setGitHistory([]);
    setGitHistoryFilePath(null);
    setGitChanges([]);
    setSelectedCommit(null);
    setCommitFiles(null);
    setSelectedDiffFile(null);
    setSelectedGitFilePath(null);
    setFileDiff(null);
    setActiveEditorGitDiff(null);
    setDiffSourceTab("diff");
    setBranchSwitcherOpen(false);
    setIsGitRepo(false);
    setFileBlame(null);
    setSelectedBlameCommitHash(null);
    setStagedFiles([]);
    setCommitMessage("");
    setIsCommitting(false);
    setContextMenu(null);
    setRenameModal(null);
    setNewFileModal(null);
    setDiscardFileModalPath(null);
    setError(null);
    saveSession({
      project_root: null,
      open_tabs: [],
      active_tab_path: "",
      open_folders: [],
    }).catch(() => {});
    setUnsavedChangesFlag(false).catch(() => {});
  }, []);

  // Navigation history handlers
  const addToNavHistory = useCallback((path: string, line?: number) => {
    if (isNavigatingRef.current) {
      isNavigatingRef.current = false;
      return;
    }
    setNavHistory(prev => {
      const entry: NavigationEntry = { path, line };
      // Remove any entries after current index
      const newHistory = prev.slice(0, navIndex + 1);
      // Add new entry if different from current
      const lastEntry = newHistory[newHistory.length - 1];
      if (!lastEntry || lastEntry.path !== path || lastEntry.line !== line) {
        newHistory.push(entry);
        // Keep only last 50 entries
        if (newHistory.length > 50) {
          newHistory.shift();
        }
        setNavIndex(newHistory.length - 1);
      }
      return newHistory;
    });
  }, [navIndex]);

  const handleOpenFile = useCallback(
    async (path: string, lineNumber?: number, _source = "unknown") => {
      if (!path) return;
      const existing = openTabs.find((t) => t.path === path);
      if (existing) {
        setActiveTabPath(path);
        updateRecentFiles(path);
        addToNavHistory(path, lineNumber);
        // If line number specified, scroll to it after a short delay to allow editor to render
        if (lineNumber !== undefined && lineNumber > 0) {
          setTimeout(() => scrollToLine(lineNumber), 50);
        }
        return;
      }
      if (pendingOpenPathsRef.current.has(path)) {
        setActiveTabPath(path);
        return;
      }
      pendingOpenPathsRef.current.add(path);

      const newTab: EditorDocument = {
        path,
        content: "",
        originalContent: "",
        isDirty: false,
        isLoading: true,
      };
      setOpenTabs((prev) => (prev.some((t) => t.path === path) ? prev : [...prev, newTab]));
      setActiveTabPath(path);
      setError(null);

      try {
        const content = await readFile(path);
        setOpenTabs((prev) =>
          prev.some((t) => t.path === path)
            ? prev.map((t) =>
                t.path === path ? { ...t, content, originalContent: content, isLoading: false } : t
              )
            : prev
        );
        setSelectedTreePath(path);
        updateRecentFiles(path);
        addToNavHistory(path, lineNumber);
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
      } finally {
        pendingOpenPathsRef.current.delete(path);
      }
    },
    [openTabs, activeTabPath, updateRecentFiles, scrollToLine, addToNavHistory]
  );

  const handleOpenSystemPath = useCallback(async (path: string) => {
    try {
      const target = await getOpenTarget(path);
      if (target.kind === "file" && target.file_path) {
        await handleOpenFolderWithSession(target.root);
        await handleOpenFile(target.file_path, undefined, "system-open");
        return;
      }

      await handleOpenFolderWithSession(target.root);
    } catch (e) {
      setError(String(e));
    }
  }, [handleOpenFile, handleOpenFolderWithSession]);

  const refreshGitWorkingTreeState = useCallback(async () => {
    if (!projectRoot) return;
    const [changes, staged] = await Promise.all([
      getWorkingTreeChanges(projectRoot).catch(() => []),
      getStagedFiles(projectRoot).catch(() => []),
    ]);
    setGitChanges(changes);
    setStagedFiles(staged);
    setSelectedGitFilePath((current) => {
      const availablePaths = new Set([
        ...staged.map((file) => file.path),
        ...changes.map((file) => file.path),
      ]);
      if (current && availablePaths.has(current)) return current;
      return staged[0]?.path ?? changes[0]?.path ?? null;
    });
  }, [projectRoot]);

  const handleSave = useCallback(async () => {
    const tab = openTabs.find((t) => t.path === activeTabPath);
    if (!tab || !tab.isDirty || tab.isLoading) return;
    setError(null);
    try {
      await writeFile(tab.path, tab.content);
      setOpenTabs((prev) =>
        prev.map((t) =>
          t.path === activeTabPath
            ? { ...t, originalContent: t.content, isDirty: false }
            : t
        )
      );
      await refreshGitWorkingTreeState();
    } catch (e) {
      setError(String(e));
    }
  }, [openTabs, activeTabPath, refreshGitWorkingTreeState]);

  const handleSaveAll = useCallback(async () => {
    const dirtyTabs = openTabs.filter((t) => t.isDirty && !t.isLoading);
    if (dirtyTabs.length === 0) return;
    setError(null);

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

    const errors: string[] = [];
    const savedPaths = new Set(dirtyTabs.map((t) => t.path));
    setOpenTabs((prev) =>
      prev.map((t) => {
        if (!savedPaths.has(t.path)) return t;
        const result = results.find((r) => r.status === "fulfilled" && r.value.path === t.path);
        if (!result) return t;
        const { success, error } = (result as PromiseFulfilledResult<{ path: string; success: boolean; error: string | null }>).value;
        if (!success && error) {
          errors.push(`${t.path}: ${error}`);
        }
        return { ...t, originalContent: success ? t.content : t.originalContent, isDirty: success ? false : t.isDirty };
      })
    );

    if (errors.length > 0) {
      setError(`Save all failed for some files:\n${errors.join("\n")}`);
    }
    await refreshGitWorkingTreeState();
  }, [openTabs, refreshGitWorkingTreeState]);

  const handleSwitchTab = useCallback((path: string) => {
    setActiveTabPath(path);
    setSelectedTreePath(path);
    updateRecentFiles(path);
  }, [updateRecentFiles]);

  const handleCloseTab = useCallback(
    async (path: string) => {
      const tab = openTabs.find((t) => t.path === path);
      if (!tab) return;

      const currentContent =
        path === activeTabPath ? (getEditorContent() ?? tab.content) : tab.content;
      const hasUnsavedChanges = currentContent !== tab.originalContent;

      if (hasUnsavedChanges) {
        setError(null);
        try {
          await writeFile(path, currentContent);
        } catch (e) {
          setError(`Failed to save before closing: ${String(e)}`);
          return;
        }
      }

      let removed = false;
      setOpenTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        if (idx === -1) {
          return prev;
        }

        const nextTabs = prev.filter((t) => t.path !== path);
        removed = true;
        const next =
          nextTabs[Math.min(idx, nextTabs.length - 1)] ||
          nextTabs[nextTabs.length - 1] ||
          null;

        setActiveTabPath((current) => {
          if (current !== path) return current;
          return next?.path ?? "";
        });
        setSelectedTreePath((current) => {
          if (current !== path) return current;
          return next?.path ?? projectRoot ?? "";
        });
        return nextTabs;
      });

      if (!removed) return;
      await refreshGitWorkingTreeState();
    },
    [openTabs, activeTabPath, getEditorContent, refreshGitWorkingTreeState, projectRoot, selectedTreePath]
  );

  useEffect(() => {
    window.__FIKA_CLOSE_ACTIVE_TAB__ = () => {
      if (!activeTabPath) return;
      void handleCloseTab(activeTabPath);
    };

    return () => {
      delete window.__FIKA_CLOSE_ACTIVE_TAB__;
    };
  }, [activeTabPath, handleCloseTab]);

  useEffect(() => {
    window.__FIKA_OPEN_FOLDER__ = () => {
      void handleOpenFolder();
    };
    window.__FIKA_SHOW_RECENT_PROJECTS__ = () => {
      setRecentProjectsOpen(true);
    };
    window.__FIKA_OPEN_FOLDER_NEW_WINDOW__ = () => {
      void createProjectWindow();
    };
    window.__FIKA_CLEAR_PROJECT__ = () => {
      void (async () => {
        await handleSaveAll();
        await clearCurrentProject();
      })();
    };

    return () => {
      delete window.__FIKA_OPEN_FOLDER__;
      delete window.__FIKA_SHOW_RECENT_PROJECTS__;
      delete window.__FIKA_OPEN_FOLDER_NEW_WINDOW__;
      delete window.__FIKA_CLEAR_PROJECT__;
    };
  }, [clearCurrentProject, createProjectWindow, handleOpenFolder, handleSaveAll]);

  const editorKeybindings = useMemo(
    () =>
      keymap.of([
        {
          key: "Mod-Shift-p",
          preventDefault: true,
          run: () => {
            if (!isMarkdownTab) return false;
            setMarkdownPreviewOpen((prev) => !prev);
            return true;
          },
        },
        {
          key: "Mod-w",
          preventDefault: true,
          run: () => {
            if (activeTabPath) {
              handleCloseTab(activeTabPath);
            }
            return true;
          },
        },
      ]),
    [activeTabPath, handleCloseTab, isMarkdownTab]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isMarkdownTab) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setMarkdownPreviewOpen((prev) => !prev);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isMarkdownTab]);

  const toggleFolder = useCallback((path: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Git data fetching - each command is independent, failures don't affect others
  const refreshGitData = useCallback(async () => {
    if (!projectRoot) {
      setIsGitRepo(false);
      setCurrentBranch(null);
      setBranches([]);
      setGitHistory([]);
      setGitChanges([]);
      return;
    }

    // Check if it's a git repo first
    let isRepo = false;
    try {
      const branch = await getCurrentBranch(projectRoot);
      isRepo = branch !== null;
      setCurrentBranch(branch);
    } catch {
      setCurrentBranch(null);
    }

    // Fetch other git data independently - failures in one don't affect others
    const [branchesResult, historyResult, changesResult, stagedResult] = await Promise.allSettled([
      getBranches(projectRoot),
      getGitHistory(projectRoot, 50),
      getWorkingTreeChanges(projectRoot),
      getStagedFiles(projectRoot),
    ]);

    if (branchesResult.status === 'fulfilled') {
      setBranches(branchesResult.value);
      if (branchesResult.value.length > 0) isRepo = true;
    } else {
      setBranches([]);
    }

    if (historyResult.status === 'fulfilled') {
      setGitHistory(historyResult.value);
      setGitHistoryFilePath(null);
      if (historyResult.value.length > 0) isRepo = true;
    } else {
      setGitHistory([]);
      setGitHistoryFilePath(null);
    }

    if (changesResult.status === 'fulfilled') {
      setGitChanges(changesResult.value);
    } else {
      setGitChanges([]);
    }

    if (stagedResult.status === 'fulfilled') {
      setStagedFiles(stagedResult.value);
    } else {
      setStagedFiles([]);
    }

    const stagedFilesValue = stagedResult.status === 'fulfilled' ? stagedResult.value : [];
    const changedFilesValue = changesResult.status === 'fulfilled' ? changesResult.value : [];
    const availablePaths = new Set([
      ...stagedFilesValue.map((file) => file.path),
      ...changedFilesValue.map((file) => file.path),
    ]);
    setSelectedGitFilePath((current) => {
      if (current && availablePaths.has(current)) return current;
      return stagedFilesValue[0]?.path ?? changedFilesValue[0]?.path ?? null;
    });

    setIsGitRepo(isRepo);
  }, [projectRoot]);

  const handleSwitchBranch = useCallback(async (branchName: string) => {
    if (!projectRoot) return;

    // Check for unsaved changes
    const dirtyTabs = openTabs.filter((t) => t.isDirty);
    if (dirtyTabs.length > 0) {
      const ok = confirm(`You have ${dirtyTabs.length} unsaved tab(s). Switching branches will close all tabs. Continue?`);
      if (!ok) return;
    }

    try {
      await switchBranch(projectRoot, branchName);
      // Close all tabs to prevent stale content
      setOpenTabs([]);
      setActiveTabPath("");
      setRecentFilePaths([]);
      setSelectedDiffFile(null);
      setSelectedGitFilePath(null);
      setFileDiff(null);
      setSelectedCommit(null);
      setCommitFiles(null);
      await refreshGitData();
      setBranchSwitcherOpen(false);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, refreshGitData, openTabs]);

  const handleShowFileDiff = useCallback(async (filePath: string, options?: { staged?: boolean; commit?: string | null }) => {
    if (!projectRoot) return;
    try {
      const sourceTab = options?.commit ? "log" : "diff";
      const diff = await getFileDiff(
        projectRoot,
        filePath,
        options?.staged,
        options?.commit ?? undefined
      );
      setDiffSourceTab(sourceTab);
      setIsBottomPanelOpen(true);
      setBottomPanelTab("diff");
      setSelectedDiffFile(filePath);
      setSelectedGitFilePath(filePath);
      setFileDiff(diff);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot]);

  const handleShowBlameCommitDiff = useCallback(async () => {
    if (!projectRoot || !activeTab || !selectedBlameCommitHash) return;
    const relativePath = toProjectRelativePath(activeTab.path);
    await handleShowFileDiff(relativePath, { commit: selectedBlameCommitHash });
  }, [projectRoot, activeTab, selectedBlameCommitHash, toProjectRelativePath, handleShowFileDiff]);

  const handleShowCommitFiles = useCallback(async (commitHash: string) => {
    if (!projectRoot) return;
    if (gitHistoryFilePath) {
      await handleShowFileDiff(gitHistoryFilePath, { commit: commitHash });
      return;
    }
    try {
      const files = await getCommitFiles(projectRoot, commitHash, gitHistoryFilePath ?? undefined);
      setSelectedCommit(commitHash);
      setCommitFiles(files);
      setSelectedGitFilePath(files.files[0]?.path ?? null);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, gitHistoryFilePath, handleShowFileDiff]);

  const handleOpenGitHistory = useCallback(async () => {
    if (projectRoot) {
      try {
        const historyPath = selectedTreePath
          ? toProjectRelativePath(selectedTreePath)
          : activeTab
            ? toProjectRelativePath(activeTab.path)
            : undefined;
        const history = await getGitHistory(projectRoot, 50, historyPath);
        setGitHistory(history);
        setGitHistoryFilePath(historyPath ?? null);
      } catch (e) {
        setError(String(e));
      }
    }
    setIsBottomPanelOpen(true);
    setBottomPanelTab("log");
    setSelectedCommit(null);
    setCommitFiles(null);
  }, [activeTab, projectRoot, selectedTreePath, toProjectRelativePath]);

  const handleCloseDiffView = useCallback(() => {
    setSelectedDiffFile(null);
    setFileDiff(null);
    setBottomPanelTab(diffSourceTab);
  }, [diffSourceTab]);

  const handleCompareSelectedGitFile = useCallback(() => {
    if (!selectedGitFilePath || !isGitRepo) return;
    const selectedIsStaged = stagedFiles.some((file) => file.path === selectedGitFilePath);
    const commitForDiff = bottomPanelTab === "log" && selectedCommit ? selectedCommit : undefined;
    void handleShowFileDiff(selectedGitFilePath, {
      staged: bottomPanelTab === "diff" ? selectedIsStaged : undefined,
      commit: commitForDiff,
    });
  }, [selectedGitFilePath, isGitRepo, handleShowFileDiff, stagedFiles, bottomPanelTab, selectedCommit]);

  // Refresh git data when project changes or when switching to git tabs
  useEffect(() => {
    refreshGitData();
  }, [refreshGitData]);

  // Refresh git changes when switching to diff tab
  useEffect(() => {
    if (bottomPanelTab === "diff" && projectRoot && isGitRepo) {
      Promise.all([
        getWorkingTreeChanges(projectRoot).catch(() => []),
        getStagedFiles(projectRoot).catch(() => []),
      ]).then(([changes, staged]) => {
        setGitChanges(changes);
        setStagedFiles(staged);
        const availablePaths = new Set([...staged.map((file) => file.path), ...changes.map((file) => file.path)]);
        setSelectedGitFilePath((current) => {
          if (current && availablePaths.has(current)) return current;
          return staged[0]?.path ?? changes[0]?.path ?? null;
        });
      });
    }
  }, [bottomPanelTab, projectRoot, isGitRepo]);

  useEffect(() => {
    if (!projectRoot || !isGitRepo || !activeTab) {
      setActiveEditorGitDiff(null);
      return;
    }

    const relativePath = toProjectRelativePath(activeTab.path);
    const currentStatus = gitStatusByPath[relativePath];
    if (!currentStatus) {
      setActiveEditorGitDiff(null);
      return;
    }

    if (currentStatus === "?") {
      setActiveEditorGitDiff(null);
      return;
    }

    const isStagedOnly =
      stagedFiles.some((file) => file.path === relativePath) &&
      !gitChanges.some((file) => file.path === relativePath);

    let cancelled = false;

    getFileDiff(projectRoot, relativePath, isStagedOnly)
      .then((diff) => {
        if (cancelled) return;
        setActiveEditorGitDiff(diff);
      })
      .catch(() => {
        if (!cancelled) setActiveEditorGitDiff(null);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, gitChanges, gitStatusByPath, isGitRepo, projectRoot, stagedFiles, toProjectRelativePath]);

  // Load blame when switching to blame tab
  useEffect(() => {
    if (bottomPanelTab === "blame" && projectRoot && isGitRepo && activeTab) {
      getFileBlame(projectRoot, activeTab.path)
        .then((blame) => {
          setIsBottomPanelOpen(true);
          setFileBlame(blame);
          setSelectedBlameCommitHash(blame.lines[0]?.commit_hash ?? null);
        })
        .catch(() => {
          setFileBlame(null);
          setSelectedBlameCommitHash(null);
        });
    }
  }, [bottomPanelTab, projectRoot, isGitRepo, activeTab]);

  // Git stage/unstage handlers
  const handleStageFile = useCallback(async (filePath: string) => {
    if (!projectRoot) return;
    try {
      await stageFile(projectRoot, filePath);
      // Refresh both changes and staged files
      const [changes, staged] = await Promise.all([
        getWorkingTreeChanges(projectRoot).catch(() => []),
        getStagedFiles(projectRoot).catch(() => []),
      ]);
      setGitChanges(changes);
      setStagedFiles(staged);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot]);

  const handleUnstageFile = useCallback(async (filePath: string) => {
    if (!projectRoot) return;
    try {
      await unstageFile(projectRoot, filePath);
      // Refresh both changes and staged files
      const [changes, staged] = await Promise.all([
        getWorkingTreeChanges(projectRoot).catch(() => []),
        getStagedFiles(projectRoot).catch(() => []),
      ]);
      setGitChanges(changes);
      setStagedFiles(staged);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot]);

  const performDiscardFileChanges = useCallback(async (filePath: string) => {
    if (!projectRoot) return;

    try {
      await discardFileChanges(projectRoot, filePath);

      const absolutePath = projectRoot
        ? `${normalizeFilePath(projectRoot).replace(/\/$/, "")}/${normalizeFilePath(filePath)}`
        : filePath;

      const existsAfterDiscard = allFilePaths.includes(absolutePath) || openTabs.some((tab) => tab.path === absolutePath);

      if (activeTab?.path === absolutePath) {
        try {
          const content = await readFile(absolutePath);
          setOpenTabs((prev) =>
            prev.map((tab) =>
              tab.path === absolutePath
                ? { ...tab, content, originalContent: content, isDirty: false }
                : tab
            )
          );
        } catch {
          setOpenTabs((prev) => prev.filter((tab) => tab.path !== absolutePath));
          if (activeTabPath === absolutePath) {
            setActiveTabPath("");
          }
        }
      } else if (!existsAfterDiscard) {
        setOpenTabs((prev) => prev.filter((tab) => tab.path !== absolutePath));
      }

      const newTree = await refreshTree(projectRoot);
      setTree(newTree);
      await refreshGitData();
      setSelectedDiffFile(null);
      setFileDiff(null);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, allFilePaths, openTabs, activeTab, activeTabPath, refreshGitData]);

  const handleDiscardFileChanges = useCallback((filePath: string) => {
    setDiscardFileModalPath(filePath);
  }, []);

  const handleCommit = useCallback(async () => {
    if (!projectRoot || !commitMessage.trim()) return;
    setIsCommitting(true);
    try {
      await commit(projectRoot, commitMessage.trim());
      setCommitMessage("");
      // Refresh git data
      await refreshGitData();
      // Refresh staged files
      const staged = await getStagedFiles(projectRoot).catch(() => []);
      setStagedFiles(staged);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsCommitting(false);
    }
  }, [projectRoot, commitMessage, refreshGitData]);

  // Persistence handlers
  const removeRecentProject = useCallback((path: string) => {
    setRecentProjects(prev => {
      const updated = prev.filter(p => p.path !== path);
      saveRecentProjects(updated).catch(() => {});
      return updated;
    });
  }, []);

  // Load recent projects on mount
  useEffect(() => {
    loadRecentProjects().then(setRecentProjects).catch(() => setRecentProjects([]));
  }, []);

  // Navigation history handlers
  const goBack = useCallback(() => {
    if (navIndex <= 0) return;
    isNavigatingRef.current = true;
      const entry = navHistory[navIndex - 1];
    if (entry) {
      setNavIndex(navIndex - 1);
      void handleOpenFile(entry.path, entry.line, "nav-back");
    }
  }, [navIndex, navHistory, handleOpenFile]);

  const goForward = useCallback(() => {
    if (navIndex >= navHistory.length - 1) return;
    isNavigatingRef.current = true;
    const entry = navHistory[navIndex + 1];
    if (entry) {
      setNavIndex(navIndex + 1);
      void handleOpenFile(entry.path, entry.line, "nav-forward");
    }
  }, [navIndex, navHistory, handleOpenFile]);

  // File tree operations
  const handleCreateFile = useCallback(async (dirPath: string, name: string) => {
    if (!projectRoot) return;
    const fullPath = `${dirPath}/${name}`;
    try {
      await createFile(projectRoot, fullPath);
      // Refresh tree
      const newTree = await refreshTree(projectRoot);
      setTree(newTree);
      // Open the new file
      await handleOpenFile(fullPath, undefined, "create-file");
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, handleOpenFile]);

  const handleCreateDirectory = useCallback(async (dirPath: string, name: string) => {
    if (!projectRoot) return;
    const fullPath = `${dirPath}/${name}`;
    try {
      await createDirectory(projectRoot, fullPath);
      // Refresh tree
      const newTree = await refreshTree(projectRoot);
      setTree(newTree);
      // Auto-open the new folder
      setOpenFolders(prev => new Set([...prev, fullPath]));
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot]);

  const handleRename = useCallback(async (oldPath: string, newName: string) => {
    if (!projectRoot) return;
    const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/'));
    const newPath = `${parentPath}/${newName}`;
    try {
      await renamePath(projectRoot, oldPath, newPath);
      setOpenTabs(prev => prev.map(tab => (
        isSameOrDescendantPath(tab.path, oldPath)
          ? { ...tab, path: replacePathPrefix(tab.path, oldPath, newPath) }
          : tab
      )));
      setActiveTabPath(prev => (
        isSameOrDescendantPath(prev, oldPath)
          ? replacePathPrefix(prev, oldPath, newPath)
          : prev
      ));
      setRecentFilePaths(prev => prev.map(path => (
        isSameOrDescendantPath(path, oldPath)
          ? replacePathPrefix(path, oldPath, newPath)
          : path
      )));
      setOpenFolders(prev => {
        const next = new Set<string>();
        for (const path of prev) {
          next.add(
            isSameOrDescendantPath(path, oldPath)
              ? replacePathPrefix(path, oldPath, newPath)
              : path
          );
        }
        return next;
      });
      setNavHistory(prev => prev.map(entry => (
        isSameOrDescendantPath(entry.path, oldPath)
          ? { ...entry, path: replacePathPrefix(entry.path, oldPath, newPath) }
          : entry
      )));
      // Refresh tree
      const newTree = await refreshTree(projectRoot);
      setTree(newTree);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, isSameOrDescendantPath, replacePathPrefix]);

  const handleDelete = useCallback(async (path: string, isDir: boolean) => {
    if (!projectRoot) return;
    const itemType = isDir ? "directory" : "file";
    const ok = confirm(`Are you sure you want to delete this ${itemType}?\n${path}`);
    if (!ok) return;

    // Check for unsaved changes if it's a file
    if (!isDir) {
      const tab = openTabs.find(t => t.path === path);
      if (tab?.isDirty) {
        const saveOk = confirm("This file has unsaved changes. Delete anyway?");
        if (!saveOk) return;
      }
    }

    try {
      await deletePath(projectRoot, path);
      const remainingTabs = openTabs.filter(tab => !isSameOrDescendantPath(tab.path, path));
      setOpenTabs(remainingTabs);
      setRecentFilePaths(prev => prev.filter(item => !isSameOrDescendantPath(item, path)));
      setOpenFolders(prev => {
        const next = new Set<string>();
        for (const item of prev) {
          if (!isSameOrDescendantPath(item, path)) next.add(item);
        }
        return next;
      });
      setNavHistory(prev => prev.filter(entry => !isSameOrDescendantPath(entry.path, path)));
      setNavIndex(prev => {
        const nextHistory = navHistory.filter(entry => !isSameOrDescendantPath(entry.path, path));
        return nextHistory.length === 0 ? -1 : Math.min(prev, nextHistory.length - 1);
      });
      setActiveTabPath(prev => {
        if (!isSameOrDescendantPath(prev, path)) return prev;
        return remainingTabs.length > 0 ? remainingTabs[0].path : "";
      });
      // Refresh tree
      const newTree = await refreshTree(projectRoot);
      setTree(newTree);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, openTabs, navHistory, isSameOrDescendantPath]);

  const handleRefreshTree = useCallback(async () => {
    if (!projectRoot) return;
    try {
      const newTree = await refreshTree(projectRoot);
      setTree(newTree);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot]);

  // Load session on mount
  useEffect(() => {
    if (window.__FIKA_SESSION_RESTORED__) return;
    window.__FIKA_SESSION_RESTORED__ = true;

    const init = async () => {
      const currentLabel = getCurrentWebviewWindow().label;
      const pendingProjectKey = `fika:pending-project:${currentLabel}`;
      const pendingProjectPath = localStorage.getItem(pendingProjectKey);
      if (pendingProjectPath) {
        localStorage.removeItem(pendingProjectKey);
        await handleOpenFolderWithSession(pendingProjectPath);
        return;
      }

      const session = await loadSession().catch(() => null);
      if (session?.project_root) {
        try {
          const tree = await refreshTree(session.project_root);
          setProjectRoot(session.project_root);
          setRootName(session.project_root.split(/[\/\\]/).pop() || session.project_root);
          setTree(tree);
          setOpenFolders(new Set(session.open_folders));
          // Open tabs
          for (const path of session.open_tabs) {
            await handleOpenFile(path, undefined, "session-restore");
          }
          // Set active tab
          if (session.active_tab_path) {
            setActiveTabPath(session.active_tab_path);
          }
          const [changes, staged] = await Promise.all([
            getWorkingTreeChanges(session.project_root).catch(() => []),
            getStagedFiles(session.project_root).catch(() => []),
          ]);
          setGitChanges(changes);
          setStagedFiles(staged);
        } catch {
          // Session loading failed, start fresh
        }
      }
    };
    init();
  }, [handleOpenFile, handleOpenFolderWithSession]);

  useEffect(() => {
    let unlistenOpenProject: (() => void) | undefined;
    let unlistenSystemOpen: (() => void) | undefined;

    getCurrentWindow().listen<string>("fika://open-project-path", async (event) => {
      await handleOpenFolderWithSession(event.payload);
    }).then((unlisten) => {
      unlistenOpenProject = unlisten;
    });

    getCurrentWindow().listen<string[]>("fika://open-system-paths", async (event) => {
      for (const path of event.payload) {
        await handleOpenSystemPath(path);
      }
    }).then((unlisten) => {
      unlistenSystemOpen = unlisten;
    });

    return () => {
      unlistenOpenProject?.();
      unlistenSystemOpen?.();
    };
  }, [handleOpenFolderWithSession, handleOpenSystemPath]);

  useEffect(() => {
    let unlistenDragDrop: (() => void) | undefined;

    getCurrentWindow().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") return;
      for (const path of event.payload.paths) {
        await handleOpenSystemPath(path);
      }
    }).then((unlisten) => {
      unlistenDragDrop = unlisten;
    });

    return () => {
      unlistenDragDrop?.();
    };
  }, [handleOpenSystemPath]);

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
    if (!hasAnyUnsavedTabs) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasAnyUnsavedTabs]);

  useEffect(() => {
    setUnsavedChangesFlag(hasAnyUnsavedTabs).catch(() => {});
  }, [hasAnyUnsavedTabs]);

  // Save session state when relevant state changes (debounced)
  useEffect(() => {
    if (!projectRoot) return;
    const timeoutId = setTimeout(() => {
      const state = {
        project_root: projectRoot,
        open_tabs: openTabs.map(t => t.path),
        active_tab_path: activeTabPath,
        open_folders: Array.from(openFolders),
      };
      saveSession(state).catch(() => {});
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [projectRoot, openTabs, activeTabPath, openFolders]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isFindFile =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n";
      const isSaveAll =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s";
      const isSave =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "s";
      const isCloseTab =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "w";
      const isQuitApp =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "q";
      const isRecentFiles =
        (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "e";
      const isRecentProjects =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o";
      const isInFileSearch =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f";
      const isGlobalSearch =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f";
      const isBack =
        (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "arrowleft";
      const isForward =
        (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "arrowright";
      const isCompareFile =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "d";
      const target = e.target as HTMLElement | null;
      const isTypingTarget = !!target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      );

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
              handleOpenFile(result.path, result.line_number, "global-search-enter");
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
              handleOpenFile(recentFilePaths[recentSelectedIndex], undefined, "recent-files-enter");
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
              handleOpenFile(filtered[selectedIndex], undefined, "find-file-enter");
              setFinderOpen(false);
            }
            return;
        }
      }

      // Global shortcuts
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

      if (isQuitApp) {
        e.preventDefault();
        if (hasAnyUnsavedTabs) {
          const shouldClose = window.confirm("You have unsaved changes. Close anyway?");
          if (!shouldClose) return;
        }
        void getCurrentWindow().close();
        return;
      }

      if (isCloseTab) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") {
          e.stopImmediatePropagation();
        }
        if (!activeTabPath) return;
        handleCloseTab(activeTabPath);
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

      if (isRecentProjects) {
        e.preventDefault();
        setRecentProjectsOpen(true);
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

      if (isBack) {
        e.preventDefault();
        goBack();
        return;
      }

      if (isForward) {
        e.preventDefault();
        goForward();
        return;
      }

      if (isCompareFile && !isTypingTarget) {
        if (!isGitRepo) return;
        e.preventDefault();
        if (bottomPanelTab === "blame") {
          void handleShowBlameCommitDiff();
          return;
        }
        handleCompareSelectedGitFile();
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [
    finderOpen,
    filtered,
    selectedIndex,
    recentOpen,
    recentFilePaths,
    recentSelectedIndex,
    recentProjectsOpen,
    setRecentProjectsOpen,
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
    hasAnyUnsavedTabs,
    handleCloseTab,
    handleOpenFile,
    goToNextMatch,
    goToPrevMatch,
    goBack,
    goForward,
    selectedGitFilePath,
    isGitRepo,
    bottomPanelTab,
    handleCompareSelectedGitFile,
    handleShowBlameCommitDiff,
    handleCloseDiffView,
  ]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      const resizeState = resizeStateRef.current;
      if (!resizeState) return;
      const nextHeight = resizeState.startHeight + (resizeState.startY - e.clientY);
      setBottomPanelHeight(Math.max(160, Math.min(520, nextHeight)));
    }

    function onMouseUp() {
      resizeStateRef.current = null;
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return (
    <div className="app">
      {finderOpen && (
        <div className="finder-overlay" onClick={() => setFinderOpen(false)}>
          <div className="finder-modal" onClick={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              className="finder-input"
              placeholder={`Find file (${shortcutLabel("N", { shift: true })})`}
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
                    handleOpenFile(p, undefined, "find-file-click");
                    setFinderOpen(false);
                  }}
                >
                  <span className="finder-icon finder-icon-file" />
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
                    handleOpenFile(p, undefined, "recent-files-click");
                    setRecentOpen(false);
                  }}
                >
                  <span className="finder-icon finder-icon-file" />
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
              placeholder={`Search in project... (${shortcutLabel("F", { shift: true })})`}
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
                      handleOpenFile(result.path, result.line_number, "global-search-click");
                      setGlobalSearchOpen(false);
                    }}
                  >
                    <div className="search-result-meta">
                      <div className="search-result-path">
                        {toRelativePath(projectRoot, result.path)}
                      </div>
                      <div className="search-result-line-badge">
                        Line {result.line_number}
                      </div>
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

      {/* Branch Switcher Modal */}
      {branchSwitcherOpen && (
        <div className="finder-overlay" onClick={() => setBranchSwitcherOpen(false)}>
          <div className="finder-modal" onClick={(e) => e.stopPropagation()}>
            <div className="finder-header">Switch Branch</div>
            <div className="finder-list">
              {branches.length === 0 ? (
                <div className="finder-empty">No branches found</div>
              ) : (
                branches.map((branch) => (
                  <div
                    key={branch.name}
                    className={`finder-item ${branch.is_current ? "active" : ""}`}
                    onClick={() => handleSwitchBranch(branch.name)}
                  >
                    <span className={`finder-icon ${branch.is_current ? "finder-icon-branch-active" : "finder-icon-branch"}`} />
                    <span className="finder-path">{branch.name}</span>
                  </div>
                ))
              )}
            </div>
            <div className="finder-hint">
              <span>Click</span> to switch <span>esc</span> to close
            </div>
          </div>
        </div>
      )}

      {/* Recent Projects Modal */}
      {recentProjectsOpen && (
        <div className="finder-overlay" onClick={() => setRecentProjectsOpen(false)}>
          <div className="finder-modal" onClick={(e) => e.stopPropagation()}>
            <div className="finder-header">Recent Projects</div>
            <div className="finder-list">
              {recentProjects.length === 0 ? (
                <div className="finder-empty">No recent projects</div>
              ) : (
                recentProjects.map((project) => (
                  <div
                    key={project.path}
                    className="finder-item"
                  >
                    <span className="finder-icon finder-icon-project" />
                    <span
                      className="finder-path"
                      style={{ flex: 1, cursor: 'pointer' }}
                      onClick={() => {
                        handleOpenFolderWithSession(project.path);
                        setRecentProjectsOpen(false);
                      }}
                    >
                      {project.name}
                    </span>
                    <button
                      className="icon-btn"
                      style={{ padding: '2px 6px', fontSize: '12px' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeRecentProject(project.path);
                      }}
                      title="Remove from list"
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="finder-hint">
              <span>Click</span> to open <span>×</span> to remove <span>esc</span> to close
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {renameModal && (
        <div className="finder-overlay" onClick={() => setRenameModal(null)}>
          <div className="finder-modal" onClick={(e) => e.stopPropagation()}>
            <div className="finder-header">Rename</div>
            <input
              className="finder-input"
              value={renameModal.newName}
              onChange={(e) => setRenameModal({ ...renameModal, newName: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleRename(renameModal.path, renameModal.newName);
                  setRenameModal(null);
                } else if (e.key === 'Escape') {
                  setRenameModal(null);
                }
              }}
              autoFocus
            />
            <div className="finder-actions">
              <button className="search-btn" onClick={() => setRenameModal(null)}>Cancel</button>
              <button
                className="search-btn"
                onClick={() => {
                  handleRename(renameModal.path, renameModal.newName);
                  setRenameModal(null);
                }}
                disabled={!renameModal.newName.trim()}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New File/Directory Modal */}
      {newFileModal && (
        <div className="finder-overlay" onClick={() => setNewFileModal(null)}>
          <div className="finder-modal" onClick={(e) => e.stopPropagation()}>
            <div className="finder-header">{newFileModal.isDir ? 'New Folder' : 'New File'}</div>
            <input
              className="finder-input"
              placeholder={newFileModal.isDir ? 'folder-name' : 'file-name'}
              value={newFileModal.name}
              onChange={(e) => setNewFileModal({ ...newFileModal, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (newFileModal.isDir) {
                    handleCreateDirectory(newFileModal.dirPath, newFileModal.name);
                  } else {
                    handleCreateFile(newFileModal.dirPath, newFileModal.name);
                  }
                  setNewFileModal(null);
                } else if (e.key === 'Escape') {
                  setNewFileModal(null);
                }
              }}
              autoFocus
            />
            <div className="finder-actions">
              <button className="search-btn" onClick={() => setNewFileModal(null)}>Cancel</button>
              <button
                className="search-btn"
                onClick={() => {
                  if (newFileModal.isDir) {
                    handleCreateDirectory(newFileModal.dirPath, newFileModal.name);
                  } else {
                    handleCreateFile(newFileModal.dirPath, newFileModal.name);
                  }
                  setNewFileModal(null);
                }}
                disabled={!newFileModal.name.trim()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {discardFileModalPath && (
        <div className="finder-overlay" onClick={() => setDiscardFileModalPath(null)}>
          <div className="finder-modal discard-modal" onClick={(e) => e.stopPropagation()}>
            <div className="finder-header">Revert File</div>
            <div className="discard-modal-body">
              <div className="discard-modal-title">Revert this file to the Git version?</div>
              <div className="discard-modal-path">{discardFileModalPath}</div>
              <div className="discard-modal-note">
                This will discard local changes for this file.
              </div>
            </div>
            <div className="finder-actions">
              <button className="search-btn" onClick={() => setDiscardFileModalPath(null)}>
                Cancel
              </button>
              <button
                className="search-btn discard-btn"
                onClick={async () => {
                  const targetPath = discardFileModalPath;
                  setDiscardFileModalPath(null);
                  if (targetPath) {
                    await performDiscardFileChanges(targetPath);
                  }
                }}
              >
                Revert
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="titlebar">
        <div className="titlebar-leading">
          <span className="logo">Fika</span>
          <div className="titlebar-meta">
            <span className="project-name">
              {rootName || "No folder opened"}
            </span>
            {isGitRepo && currentBranch && (
              <button
                className="branch-badge"
                onClick={() => setBranchSwitcherOpen(true)}
                title="Switch branch"
              >
                <span className="branch-icon">⎇</span>
                <span className="branch-name">{currentBranch}</span>
              </button>
            )}
          </div>
        </div>
        <div className="spacer" />
        {isGitRepo && (
          <div className="titlebar-actions">
            <button
              className="titlebar-action"
              onClick={handleOpenGitHistory}
              title="Open Git tools"
            >
              <span className="titlebar-action-icon">◷</span>
              <span>Git</span>
            </button>
          </div>
        )}
      </header>

      <div className="main">
        <aside className="sidebar left">
          <div className="panel-header">
            <span>Project</span>
            <button
              className="icon-btn"
              title="Refresh"
              onClick={handleRefreshTree}
              style={{ marginLeft: 'auto', fontSize: '12px' }}
            >
              ↻
            </button>
          </div>
          <div
            className="panel-content"
            onContextMenu={(e) => {
              e.preventDefault();
              if (projectRoot) {
                setContextMenu({ x: e.clientX, y: e.clientY, path: projectRoot, isDir: true });
              }
            }}
          >
            <ul className="file-tree">
              {tree ? (
                <FileTree
                  node={tree}
                  depth={0}
                  openFolders={openFolders}
                  toggleFolder={toggleFolder}
                  selectedPath={selectedTreePath || activeTabPath}
                  projectRoot={projectRoot}
                  gitStatusByPath={gitStatusByPath}
                  onSelectFile={handleOpenFile}
                  onSelectPath={(path) => {
                    setSelectedTreePath(path);
                  }}
                  onContextMenu={(path, isDir, e) => {
                    e.stopPropagation();
                    setContextMenu({ x: e.clientX, y: e.clientY, path, isDir });
                  }}
                />
              ) : null}
            </ul>
          </div>
          {/* Context Menu */}
          {contextMenu && (
            <div
              className="context-menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onClick={() => setContextMenu(null)}
            >
              {contextMenu.isDir && (
                <>
                  <div
                    className="context-menu-item"
                    onClick={() => {
                      setNewFileModal({ dirPath: contextMenu.path, name: '', isDir: false });
                      setContextMenu(null);
                    }}
                  >
                    New File
                  </div>
                  <div
                    className="context-menu-item"
                    onClick={() => {
                      setNewFileModal({ dirPath: contextMenu.path, name: '', isDir: true });
                      setContextMenu(null);
                    }}
                  >
                    New Folder
                  </div>
                  <div className="context-menu-divider" />
                </>
              )}
              <div
                className="context-menu-item"
                onClick={() => {
                  const name = contextMenu.path.split('/').pop() || '';
                  setRenameModal({ path: contextMenu.path, isDir: contextMenu.isDir, newName: name });
                  setContextMenu(null);
                }}
              >
                Rename
              </div>
              <div
                className="context-menu-item context-menu-item-danger"
                onClick={() => {
                  handleDelete(contextMenu.path, contextMenu.isDir);
                  setContextMenu(null);
                }}
              >
                Delete
              </div>
            </div>
          )}
        </aside>

        <section className="editor">
          <div className="breadcrumb">
            <span className="breadcrumb-path">
              {activeTab?.path || (rootName ? "Select a file" : "—")}
            </span>
            {activeTab?.isDirty && (
              <span className="editor-status-badge dirty">Unsaved</span>
            )}
            {activeTab?.isLoading ? " (loading...)" : ""}
            {isMarkdownTab && !activeTab?.isLoading && (
              <div className="editor-mode-toggle">
                <button
                  type="button"
                  className={`editor-mode-button ${!markdownPreviewOpen ? "active" : ""}`}
                  onClick={() => setMarkdownPreviewOpen(false)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`editor-mode-button ${markdownPreviewOpen ? "active" : ""}`}
                  onClick={() => setMarkdownPreviewOpen(true)}
                >
                  Preview
                </button>
              </div>
            )}
          </div>
          <TabBar
            tabs={openTabs}
            activeTabPath={activeTabPath}
            onSwitchTab={handleSwitchTab}
            onCloseTab={handleCloseTab}
            closeTabTitle={`Close tab (${shortcutLabel("W")})`}
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
              activeTab.isLoading ? (
                <div className="code-placeholder">
                  <div className="empty-state-card">
                    <div className="empty-state-title">Loading file…</div>
                    <div className="empty-state-subtitle">{activeTab.path}</div>
                  </div>
                </div>
              ) : (
              markdownPreviewOpen && isMarkdownTab ? (
                <div className="markdown-preview">
                  <div className="markdown-preview-inner">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        h1: ({ children }) => <h1 className="md-heading md-heading-1">{children}</h1>,
                        h2: ({ children }) => <h2 className="md-heading md-heading-2">{children}</h2>,
                        h3: ({ children }) => <h3 className="md-heading md-heading-3">{children}</h3>,
                        h4: ({ children }) => <h4 className="md-heading md-heading-4">{children}</h4>,
                        h5: ({ children }) => <h5 className="md-heading md-heading-5">{children}</h5>,
                        h6: ({ children }) => <h6 className="md-heading md-heading-6">{children}</h6>,
                        p: ({ children }) => <p className="md-paragraph">{children}</p>,
                        ul: ({ children }) => <ul className="md-list">{children}</ul>,
                        ol: ({ children }) => <ol className="md-list">{children}</ol>,
                        blockquote: ({ children }) => <blockquote className="md-quote">{children}</blockquote>,
                        a: ({ children, href }) => (
                          <a className="md-link" href={href} target="_blank" rel="noreferrer">
                            {children}
                          </a>
                        ),
                        code: ({ children, className }) => {
                          const language = className?.replace(/^language-/, "") ?? "";
                          const text = String(children).replace(/\n$/, "");
                          if (!className) {
                            return <code className="md-inline-code">{text}</code>;
                          }
                          return (
                            <div className="md-code-block">
                              {language ? <div className="md-code-language">{language}</div> : null}
                              <pre><code>{text}</code></pre>
                            </div>
                          );
                        },
                        img: ({ src, alt }) => <img className="md-image" src={src ?? ""} alt={alt ?? ""} />,
                        table: ({ children }) => <div className="md-table-wrap"><table className="md-table">{children}</table></div>,
                        th: ({ children }) => <th className="md-table-head">{children}</th>,
                        td: ({ children }) => <td className="md-table-cell">{children}</td>,
                        hr: () => <hr className="md-divider" />,
                        input: ({ checked, type, disabled }) =>
                          type === "checkbox" ? (
                            <input className="md-task-checkbox" type="checkbox" checked={checked} disabled={disabled ?? true} readOnly />
                          ) : (
                            <input type={type} checked={checked} disabled={disabled} readOnly />
                          ),
                      }}
                    >
                      {activeTab.content}
                    </ReactMarkdown>
                  </div>
                </div>
              ) : (
                <CodeMirror
                  key={activeTab.path}
                  ref={editorRef}
                  value={activeTab.content}
                  height="100%"
                  theme={dracula}
                  extensions={[editorKeybindings, ...langFromPath(activeTab.path), ...modifiedLineExtensions]}
                  editable
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
              )
              )
            ) : projectRoot && tree ? (
              <div className="code-placeholder">
                <div className="empty-state-card">
                  <div className="empty-state-title">No file selected</div>
                  <div className="empty-state-subtitle">
                    Choose a file from the project tree or use <kbd>{shortcutLabel("N", { shift: true })}</kbd> to find one quickly.
                  </div>
                </div>
              </div>
            ) : (
              <div className="code-placeholder">
                <div className="welcome-card">
                  <div className="welcome-title">Open a project</div>
                  <div className="welcome-subtitle">
                    Start with a folder or reopen a recent workspace.
                  </div>
                  <div className="welcome-actions">
                    <button
                      className="welcome-btn welcome-btn-primary"
                      onClick={handleOpenFolder}
                    >
                      Open Folder
                      <span className="welcome-btn-shortcut">{shortcutLabel("O")}</span>
                    </button>
                    <button
                      className="welcome-btn"
                      onClick={() => setRecentProjectsOpen(true)}
                    >
                      Recent Projects
                      <span className="welcome-btn-shortcut">{shortcutLabel("O", { shift: true })}</span>
                    </button>
                  </div>
                  {!!recentProjects.length && (
                    <div className="welcome-recent-list">
                      {recentProjects.slice(0, 6).map((project) => (
                        <button
                          key={project.path}
                          className="welcome-recent-item"
                          onClick={() => handleOpenFolderWithSession(project.path)}
                        >
                          <span className="welcome-recent-name">{project.name}</span>
                          <span className="welcome-recent-path">{project.path}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {isBottomPanelOpen && (
        <>
          <div
            className="bottom-panel-resizer"
            onMouseDown={(e) => {
              resizeStateRef.current = {
                startY: e.clientY,
                startHeight: bottomPanelHeight,
              };
            }}
          />
          <footer className="bottom-panel" style={{ height: bottomPanelHeight }}>
        <div className="panel-header tabs">
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
          <button
            className="panel-close-btn"
            onClick={() => setIsBottomPanelOpen(false)}
            title="Close bottom panel"
          >
            ×
          </button>
        </div>
        <div className="panel-content-area">
          {bottomPanelTab === "diff" && (
            <div className="git-panel">
              {!isGitRepo ? (
                <div className="git-empty">Not a git repository</div>
              ) : selectedDiffFile && fileDiff ? (
                <div className="diff-view">
                  <div className="diff-header">
                    <button
                      className="back-btn"
                      onClick={handleCloseDiffView}
                    >
                      ← Back to {diffSourceTab === "log" ? "history" : "changes"}
                    </button>
                    <span className="diff-file-path">{fileDiff.path}</span>
                    {diffSourceTab === "diff" && (
                      <button
                        className="action-btn"
                        onClick={() => void handleDiscardFileChanges(fileDiff.path)}
                      >
                        Revert File
                      </button>
                    )}
                  </div>
                  <div className="diff-content">
                    {fileDiff.hunks.length === 0 ? (
                      <div className="diff-hunk">
                        <div className="diff-line ctx">No diff available</div>
                      </div>
                    ) : (
                      fileDiff.hunks.map((hunk, idx) => (
                        <div key={idx} className="diff-hunk">
                          <div className="diff-hunk-header">{hunk.header}</div>
                          {hunk.lines.map((line, lineIdx) => (
                            <div
                              key={lineIdx}
                              className={`diff-line ${line.kind === "+" ? "add" : line.kind === "-" ? "del" : "ctx"}`}
                            >
                              <span className="diff-line-num">
                                {line.old_line ?? ""}
                                {line.old_line && line.new_line ? "/" : ""}
                                {line.new_line ?? ""}
                              </span>
                              <span className="diff-line-kind">{line.kind}</span>
                              <span className="diff-line-content">{line.content}</span>
                            </div>
                          ))}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <div className="git-changes">
                  {/* Staged Files Section */}
                  <div className="changes-section">
                    <div className="changes-section-header">
                      <span>Staged Changes ({stagedFiles.length})</span>
                      {stagedFiles.length > 0 && (
                        <button
                          className="action-btn"
                          onClick={async () => {
                            for (const file of stagedFiles) {
                              await handleUnstageFile(file.path);
                            }
                          }}
                        >
                          Unstage All
                        </button>
                      )}
                    </div>
                    {stagedFiles.length === 0 ? (
                      <div className="changes-empty">No staged changes</div>
                    ) : (
                      <div className="changed-files-list">
                        {stagedFiles.map((file) => (
                          <div
                            key={file.path}
                            className={`changed-file-item ${selectedGitFilePath === file.path ? "selected" : ""}`}
                            onClick={() => setSelectedGitFilePath(file.path)}
                            onDoubleClick={() => void handleShowFileDiff(file.path, { staged: true })}
                          >
                            <span className={`file-status status-${file.status}`}>{file.status}</span>
                            <span className="file-path">{file.path}</span>
                            <button
                              className="action-btn-sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleUnstageFile(file.path);
                              }}
                            >
                              −
                            </button>
                            <button
                              className="action-btn-sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleDiscardFileChanges(file.path);
                              }}
                              title="Discard file changes"
                            >
                              ↺
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Unstaged Files Section */}
                  <div className="changes-section">
                    <div className="changes-section-header">
                      <span>Changes ({gitChanges.length})</span>
                      {gitChanges.length > 0 && (
                        <button
                          className="action-btn"
                          onClick={async () => {
                            for (const file of gitChanges) {
                              await handleStageFile(file.path);
                            }
                          }}
                        >
                          Stage All
                        </button>
                      )}
                    </div>
                    {gitChanges.length === 0 ? (
                      <div className="changes-empty">No changes</div>
                    ) : (
                      <div className="changed-files-list">
                        {gitChanges.map((file) => (
                          <div
                            key={file.path}
                            className={`changed-file-item ${selectedGitFilePath === file.path ? "selected" : ""}`}
                            onClick={() => setSelectedGitFilePath(file.path)}
                            onDoubleClick={() => void handleShowFileDiff(file.path)}
                          >
                            <span className={`file-status status-${file.status}`}>{file.status}</span>
                            <span className="file-path">{file.path}</span>
                            <button
                              className="action-btn-sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleStageFile(file.path);
                              }}
                            >
                              +
                            </button>
                            <button
                              className="action-btn-sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleDiscardFileChanges(file.path);
                              }}
                              title="Discard file changes"
                            >
                              ↺
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Commit Section */}
                  {stagedFiles.length > 0 && (
                    <div className="commit-section">
                      <input
                        className="commit-input"
                        placeholder="Commit message..."
                        value={commitMessage}
                        onChange={(e) => setCommitMessage(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && e.metaKey) {
                            handleCommit();
                          }
                        }}
                      />
                      <button
                        className="commit-btn"
                        onClick={handleCommit}
                        disabled={!commitMessage.trim() || isCommitting}
                      >
                        {isCommitting ? 'Committing...' : 'Commit'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {bottomPanelTab === "log" && (
            <div className="git-panel">
              {!isGitRepo ? (
                <div className="git-empty">Not a git repository</div>
              ) : selectedCommit && commitFiles ? (
                <div className="commit-files-view">
                  <div className="diff-header">
                    <button
                      className="back-btn"
                      onClick={() => {
                        setSelectedCommit(null);
                        setCommitFiles(null);
                      }}
                    >
                      ← Back to history
                    </button>
                    <span className="commit-hash">{commitFiles.hash.substring(0, 7)}</span>
                  </div>
                  <div className="changed-files-list">
                    {commitFiles.files.length === 0 ? (
                      <div className="git-empty">No files changed</div>
                    ) : (
                      commitFiles.files.map((file) => (
                        <div
                          key={file.path}
                          className={`changed-file-item ${selectedGitFilePath === file.path ? "selected" : ""}`}
                          onClick={() => setSelectedGitFilePath(file.path)}
                          onDoubleClick={() => void handleOpenFile(file.path, undefined, "git-log-file-double-click")}
                        >
                          <span className={`file-status status-${file.status}`}>{file.status}</span>
                          <span className="file-path">{file.path}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <div className="commit-list">
                  {gitHistoryFilePath && (
                    <div className="changes-section-header">
                      <span>History for {gitHistoryFilePath}</span>
                    </div>
                  )}
                  {gitHistory.length === 0 ? (
                    <div className="git-empty">No commits found</div>
                  ) : (
                    gitHistory.map((commit) => (
                      <div
                        key={commit.hash}
                        className="commit-item"
                        onClick={() => handleShowCommitFiles(commit.hash)}
                      >
                        <div className="commit-main">
                          <span className="commit-hash-short">{commit.short_hash}</span>
                          <span className="commit-message" title={commit.message}>
                            {commit.message.split("\n")[0]}
                          </span>
                        </div>
                        <div className="commit-meta">
                          <span className="commit-author">{commit.author}</span>
                          <span className="commit-time">{commit.time}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          {bottomPanelTab === "blame" && (
            <div className="git-panel">
              {!isGitRepo ? (
                <div className="git-empty">Not a git repository</div>
              ) : !activeTab ? (
                <div className="git-empty">Open a file to see blame</div>
              ) : fileBlame ? (
                <div className="blame-view">
                  {fileBlame.lines.map((line, idx) => (
                    <div
                      key={idx}
                      className={`blame-line ${selectedBlameCommitHash === line.commit_hash ? "selected" : ""}`}
                      onClick={() => setSelectedBlameCommitHash(line.commit_hash)}
                      onDoubleClick={() => void handleShowBlameCommitDiff()}
                    >
                      <span className="blame-hash" title={line.commit_hash}>
                        {line.short_hash}
                      </span>
                      <span className="blame-author" title={line.author}>
                        {line.author}
                      </span>
                      <span className="blame-time">{line.time}</span>
                      <span className="blame-line-num">{line.line_number}</span>
                      <span className="blame-content">{line.content}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="git-empty">Loading blame...</div>
              )}
            </div>
          )}
        </div>
          </footer>
        </>
      )}
    </div>
  );
}

export default App;
