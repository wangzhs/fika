import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import CodeMirror, { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import "./App.css";
import type { Branch, ChangedFile, Commit, CommitFiles, FileDiff, FileNode, EditorDocument, SearchResult, BottomPanelTab, FileBlame, StagedFile, RecentProject, NavigationEntry } from "./types";
import {
  openFolder, readFile, writeFile, searchInProject,
  getCurrentBranch, getBranches, switchBranch,
  getGitHistory, getWorkingTreeChanges, getFileDiff, getCommitFiles,
  getFileBlame, stageFile, unstageFile, commit, getStagedFiles,
  createFile, createDirectory, renamePath, deletePath, refreshTree,
  saveRecentProjects, loadRecentProjects, saveSession, loadSession
} from "./api";
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

  // Git state
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [gitHistory, setGitHistory] = useState<Commit[]>([]);
  const [gitChanges, setGitChanges] = useState<ChangedFile[]>([]);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<CommitFiles | null>(null);
  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [branchSwitcherOpen, setBranchSwitcherOpen] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);

  // Git blame state
  const [fileBlame, setFileBlame] = useState<FileBlame | null>(null);

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

  // Navigation history state
  const [navHistory, setNavHistory] = useState<NavigationEntry[]>([]);
  const [navIndex, setNavIndex] = useState(-1);
  const [isNavigating, setIsNavigating] = useState(false);

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
      setRecentFilePaths([]);
      setOpenFolders(new Set([result.tree.path]));
      // Add to recent projects
      addRecentProject(result.root);
      // Clear navigation history
      setNavHistory([]);
      setNavIndex(-1);
    } catch (e) {
      setError(String(e));
    }
  }, [openTabs, addRecentProject]);

  const handleOpenFolder = useCallback(async () => {
    await handleOpenFolderWithSession();
  }, [handleOpenFolderWithSession]);

  // Navigation history handlers
  const addToNavHistory = useCallback((path: string, line?: number) => {
    if (isNavigating) return;
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
  }, [navIndex, isNavigating]);

  const handleOpenFile = useCallback(
    async (path: string, lineNumber?: number) => {
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
      }
    },
    [openTabs, activeTabPath, updateRecentFiles, scrollToLine, addToNavHistory]
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
    const [branchesResult, historyResult, changesResult] = await Promise.allSettled([
      getBranches(projectRoot),
      getGitHistory(projectRoot, 50),
      getWorkingTreeChanges(projectRoot),
    ]);

    if (branchesResult.status === 'fulfilled') {
      setBranches(branchesResult.value);
      if (branchesResult.value.length > 0) isRepo = true;
    } else {
      setBranches([]);
    }

    if (historyResult.status === 'fulfilled') {
      setGitHistory(historyResult.value);
      if (historyResult.value.length > 0) isRepo = true;
    } else {
      setGitHistory([]);
    }

    if (changesResult.status === 'fulfilled') {
      setGitChanges(changesResult.value);
    } else {
      setGitChanges([]);
    }

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
      setFileDiff(null);
      setSelectedCommit(null);
      setCommitFiles(null);
      await refreshGitData();
      setBranchSwitcherOpen(false);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, refreshGitData, openTabs]);

  const handleShowCommitFiles = useCallback(async (commitHash: string) => {
    if (!projectRoot) return;
    try {
      const files = await getCommitFiles(projectRoot, commitHash);
      setSelectedCommit(commitHash);
      setCommitFiles(files);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot]);

  const handleShowFileDiff = useCallback(async (filePath: string) => {
    if (!projectRoot) return;
    try {
      const diff = await getFileDiff(projectRoot, filePath);
      setSelectedDiffFile(filePath);
      setFileDiff(diff);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot]);

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
      });
    }
  }, [bottomPanelTab, projectRoot, isGitRepo]);

  // Load blame when switching to blame tab
  useEffect(() => {
    if (bottomPanelTab === "blame" && projectRoot && isGitRepo && activeTab) {
      getFileBlame(projectRoot, activeTab.path)
        .then(setFileBlame)
        .catch(() => setFileBlame(null));
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
    setIsNavigating(true);
    const entry = navHistory[navIndex - 1];
    if (entry) {
      handleOpenFile(entry.path, entry.line);
      setNavIndex(navIndex - 1);
    }
    setTimeout(() => setIsNavigating(false), 100);
  }, [navIndex, navHistory]);

  const goForward = useCallback(() => {
    if (navIndex >= navHistory.length - 1) return;
    setIsNavigating(true);
    const entry = navHistory[navIndex + 1];
    if (entry) {
      handleOpenFile(entry.path, entry.line);
      setNavIndex(navIndex + 1);
    }
    setTimeout(() => setIsNavigating(false), 100);
  }, [navIndex, navHistory]);

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
      await handleOpenFile(fullPath);
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
      // Update tabs if the renamed file was open
      setOpenTabs(prev => prev.map(tab =>
        tab.path === oldPath ? { ...tab, path: newPath } : tab
      ));
      if (activeTabPath === oldPath) {
        setActiveTabPath(newPath);
      }
      // Refresh tree
      const newTree = await refreshTree(projectRoot);
      setTree(newTree);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, activeTabPath]);

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
      // Close tab if the deleted file was open
      if (!isDir) {
        setOpenTabs(prev => prev.filter(t => t.path !== path));
        if (activeTabPath === path) {
          const remaining = openTabs.filter(t => t.path !== path);
          setActiveTabPath(remaining.length > 0 ? remaining[0].path : "");
        }
      }
      // Refresh tree
      const newTree = await refreshTree(projectRoot);
      setTree(newTree);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, openTabs, activeTabPath]);

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
    const init = async () => {
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
            await handleOpenFile(path);
          }
          // Set active tab
          if (session.active_tab_path) {
            setActiveTabPath(session.active_tab_path);
          }
        } catch {
          // Session loading failed, start fresh
        }
      }
    };
    init();
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
    handleOpenFile,
    goToNextMatch,
    goToPrevMatch,
    goBack,
    goForward,
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
                    <span className="finder-icon">{branch.is_current ? "●" : "○"}</span>
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
                    <span className="finder-icon">📁</span>
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

      <header className="titlebar">
        <span className="logo">Fika</span>
        <span className="project-name">
          {rootName || "No folder opened"}
        </span>
        {isGitRepo && currentBranch && (
          <button
            className="branch-badge"
            onClick={() => setBranchSwitcherOpen(true)}
            title="Switch branch"
          >
            <span className="branch-icon">🌿</span>
            <span className="branch-name">{currentBranch}</span>
          </button>
        )}
        <div className="spacer" />
        {/* Navigation buttons */}
        <button
          className="icon-btn"
          title="Back (Ctrl+Left)"
          onClick={goBack}
          disabled={navIndex <= 0}
        >
          ←
        </button>
        <button
          className="icon-btn"
          title="Forward (Ctrl+Right)"
          onClick={goForward}
          disabled={navIndex >= navHistory.length - 1}
        >
          →
        </button>
        {/* Recent Projects button */}
        <button
          className="icon-btn"
          title="Recent Projects (Ctrl+Shift+O)"
          onClick={() => setRecentProjectsOpen(true)}
        >
          📚
        </button>
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
          <div className="panel-header">
            <span>Project</span>
            <button
              className="icon-btn"
              title="Refresh"
              onClick={handleRefreshTree}
              style={{ marginLeft: 'auto', fontSize: '12px' }}
            >
              🔄
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
                  selectedFile={activeTabPath}
                  onSelectFile={handleOpenFile}
                  onContextMenu={(path, isDir, e) => {
                    e.stopPropagation();
                    setContextMenu({ x: e.clientX, y: e.clientY, path, isDir });
                  }}
                />
              ) : (
                <li className="tree-empty" onClick={handleOpenFolder}>
                  Click to open a folder
                </li>
              )}
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
            <div className="git-panel">
              {!isGitRepo ? (
                <div className="git-empty">Not a git repository</div>
              ) : selectedDiffFile && fileDiff ? (
                <div className="diff-view">
                  <div className="diff-header">
                    <button
                      className="back-btn"
                      onClick={() => {
                        setSelectedDiffFile(null);
                        setFileDiff(null);
                      }}
                    >
                      ← Back to changes
                    </button>
                    <span className="diff-file-path">{fileDiff.path}</span>
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
                            className="changed-file-item"
                          >
                            <span className={`file-status status-${file.status}`}>{file.status}</span>
                            <span className="file-path" onClick={() => handleShowFileDiff(file.path)}>{file.path}</span>
                            <button
                              className="action-btn-sm"
                              onClick={() => handleUnstageFile(file.path)}
                            >
                              −
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
                            className="changed-file-item"
                          >
                            <span className={`file-status status-${file.status}`}>{file.status}</span>
                            <span className="file-path" onClick={() => handleShowFileDiff(file.path)}>{file.path}</span>
                            <button
                              className="action-btn-sm"
                              onClick={() => handleStageFile(file.path)}
                            >
                              +
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
                          className="changed-file-item"
                          onClick={() => handleOpenFile(file.path)}
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
                    <div key={idx} className="blame-line">
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
    </div>
  );
}

export default App;
