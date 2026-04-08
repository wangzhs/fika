import { useDeferredValue, useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { ReactNode } from "react";
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
import { relaunch } from "@tauri-apps/plugin-process";
import "./App.css";
import type { AvailableUpdate, Branch, ChangedFile, Commit, CommitFiles, FileDiff, FileNode, EditorDocument, SearchResult, BottomPanelTab, FileBlame, StagedFile, RecentProject, NavigationEntry, SessionState, EditorViewStateSnapshot, AutoSaveMode } from "./types";
import {
  openFolder, readFile, writeFile, searchInProject,
  readImageDataUrl,
  getCurrentBranch, getBranches, switchBranch,
  getGitHistory, getWorkingTreeChanges, getFileDiff, getCommitFiles,
  getFileBlame, stageFile, unstageFile, discardFileChanges, commit, getStagedFiles,
  createFile, createDirectory, renamePath, deletePath, refreshTree,
  listProjectFiles,
  saveRecentProjects, loadRecentProjects, saveSession, loadSession, loadWorkspace, setUnsavedChangesFlag, getOpenTarget,
  checkForUpdates, installUpdate
} from "./api";
import { FileTree } from "./components/FileTree";
import { TabBar } from "./components/TabBar";
import { findFirstUnloadedOpenFolder, findNodeByPath, mergeLoadedTree, removeNodeByPath, replaceNodeByPath } from "./utils/tree";
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

function getParentDirPath(path: string, fallback: string) {
  const normalizedPath = normalizeFilePath(path).replace(/\/$/, "");
  const normalizedFallback = normalizeFilePath(fallback).replace(/\/$/, "");
  const lastSlashIndex = normalizedPath.lastIndexOf("/");

  if (lastSlashIndex < 0) {
    return normalizedFallback;
  }

  if (lastSlashIndex === 0) {
    return "/";
  }

  const parentPath = normalizedPath.slice(0, lastSlashIndex);
  return parentPath || normalizedFallback;
}

function parseFinderQuery(rawQuery: string) {
  const trimmed = rawQuery.trim();
  const match = trimmed.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
  const baseQuery = match?.[1]?.trim() ?? trimmed;
  const lineNumber = match?.[2] ? Number(match[2]) : undefined;
  const columnNumber = match?.[3] ? Number(match[3]) : undefined;

  return {
    rawQuery: trimmed,
    baseQuery,
    lineNumber,
    columnNumber,
  };
}

function scoreFileMatch(relativePath: string, query: string) {
  if (!query) return 0;

  const normalizedPath = relativePath.toLowerCase();
  const fileName = normalizedPath.split("/").pop() || normalizedPath;

  if (fileName === query) return 1000;
  if (normalizedPath === query) return 950;
  if (fileName.startsWith(query)) return 850 - fileName.length;
  if (normalizedPath.startsWith(query)) return 800 - normalizedPath.length;
  if (fileName.includes(query)) return 700 - fileName.indexOf(query) - fileName.length;
  if (normalizedPath.includes(query)) return 500 - normalizedPath.indexOf(query) - normalizedPath.length;

  return -1;
}

function isWordCharacter(char: string | undefined) {
  return !!char && /[A-Za-z0-9_]/.test(char);
}

function findInText(
  content: string,
  query: string,
  options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }
) {
  if (!query) return { matches: [], error: null as string | null };

  if (options?.regex) {
    try {
      const flags = options.caseSensitive ? "g" : "gi";
      const pattern = new RegExp(query, flags);
      const matches: Array<{ from: number; to: number; lineNumber: number }> = [];
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(content)) !== null) {
        const matchedText = match[0] ?? "";
        const from = match.index;
        const to = from + matchedText.length;
        const lineNumber = content.slice(0, from).split("\n").length;
        matches.push({ from, to, lineNumber });

        if (matchedText.length === 0) {
          pattern.lastIndex += 1;
        }
      }

      return { matches, error: null as string | null };
    } catch (error) {
      return { matches: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  const haystack = options?.caseSensitive ? content : content.toLowerCase();
  const needle = options?.caseSensitive ? query : query.toLowerCase();
  const matches: Array<{ from: number; to: number; lineNumber: number }> = [];
  let searchIndex = 0;

  while (searchIndex <= haystack.length - needle.length) {
    const foundIndex = haystack.indexOf(needle, searchIndex);
    if (foundIndex === -1) break;
    const beforeChar = content[foundIndex - 1];
    const afterChar = content[foundIndex + query.length];
    const isWholeWordMatch =
      !isWordCharacter(beforeChar) &&
      !isWordCharacter(afterChar);

    if (options?.wholeWord && !isWholeWordMatch) {
      searchIndex = foundIndex + 1;
      continue;
    }
    const lineNumber = haystack.slice(0, foundIndex).split("\n").length;
    matches.push({
      from: foundIndex,
      to: foundIndex + query.length,
      lineNumber,
    });
    searchIndex = foundIndex + Math.max(needle.length, 1);
  }

  return { matches, error: null as string | null };
}

function applyTextReplace(
  content: string,
  query: string,
  replacement: string,
  options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }
) {
  const result = findInText(content, query, options);
  if (result.error) {
    return { content, count: 0, error: result.error };
  }

  if (result.matches.length === 0) {
    return { content, count: 0, error: null as string | null };
  }

  let cursor = 0;
  let nextContent = "";
  for (const match of result.matches) {
    nextContent += content.slice(cursor, match.from);
    nextContent += replacement;
    cursor = match.to;
  }
  nextContent += content.slice(cursor);

  return { content: nextContent, count: result.matches.length, error: null as string | null };
}

function buildSearchSnippet(line: string, fragment: string) {
  const fragmentIndex = line.indexOf(fragment);
  if (fragmentIndex === -1 || !fragment) {
    return {
      before: "",
      match: line,
      after: "",
    };
  }

  const contextRadius = 60;
  const beforeStart = Math.max(0, fragmentIndex - contextRadius);
  const afterEnd = Math.min(line.length, fragmentIndex + fragment.length + contextRadius);

  return {
    before: `${beforeStart > 0 ? "…" : ""}${line.slice(beforeStart, fragmentIndex)}`,
    match: fragment,
    after: `${line.slice(fragmentIndex + fragment.length, afterEnd)}${afterEnd < line.length ? "…" : ""}`,
  };
}

function gitStatusSortRank(status: string) {
  switch (status) {
    case "U":
      return 0;
    case "M":
      return 1;
    case "A":
      return 2;
    case "R":
      return 3;
    case "D":
      return 4;
    case "C":
      return 5;
    case "?":
      return 6;
    default:
      return 99;
  }
}

function summarizeDiff(diff: FileDiff | null) {
  let additions = 0;
  let deletions = 0;

  for (const hunk of diff?.hunks ?? []) {
    for (const line of hunk.lines) {
      if (line.kind === "+") additions += 1;
      if (line.kind === "-") deletions += 1;
    }
  }

  return { additions, deletions };
}

function getGitScopeLabel(path: string, stagedPaths: Set<string>, unstagedPaths: Set<string>) {
  const inStaged = stagedPaths.has(path);
  const inUnstaged = unstagedPaths.has(path);

  if (inStaged && inUnstaged) return "Both";
  if (inStaged) return "Staged";
  if (inUnstaged) return "Unstaged";
  return null;
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

function isImagePath(path: string) {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(path);
}

const markdownImageDataUrlCache = new Map<string, string>();

function MarkdownImage({
  src,
  alt,
  baseFilePath,
  projectRoot,
}: {
  src?: string | null;
  alt?: string;
  baseFilePath: string;
  projectRoot: string | null;
}) {
  const resolvedPath = useMemo(
    () => (src ? resolveMarkdownResourcePath(baseFilePath, src, projectRoot) : null),
    [baseFilePath, projectRoot, src]
  );
  const [imageSrc, setImageSrc] = useState<string>(() => {
    if (!resolvedPath) return src ?? "";
    return markdownImageDataUrlCache.get(resolvedPath) ?? "";
  });
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!src) {
      setImageSrc("");
      setLoadError(null);
      return () => {
        cancelled = true;
      };
    }

    if (!resolvedPath) {
      setImageSrc(src);
      setLoadError(null);
      return () => {
        cancelled = true;
      };
    }

    const cached = markdownImageDataUrlCache.get(resolvedPath);
    if (cached) {
      setImageSrc(cached);
      setLoadError(null);
      return () => {
        cancelled = true;
      };
    }

    setImageSrc("");
    setLoadError(null);

    void readImageDataUrl(resolvedPath)
      .then((dataUrl) => {
        if (cancelled) return;
        markdownImageDataUrlCache.set(resolvedPath, dataUrl);
        setImageSrc(dataUrl);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(`${resolvedPath}\n${String(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [resolvedPath, src]);

  if (loadError) {
    return (
      <div className="md-image-error">
        <strong>Image failed to load</strong>
        <div>{alt ?? src ?? resolvedPath ?? "Unknown image"}</div>
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{loadError}</div>
      </div>
    );
  }

  if (!imageSrc) {
    return <div className="md-image-loading">Loading image...</div>;
  }

  return <img className="md-image" src={imageSrc} alt={alt ?? ""} title={resolvedPath ?? src ?? ""} />;
}

function duplicateCurrentLine(view: EditorView) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const lineText = state.doc.sliceString(line.from, line.to);
  const insertText = `\n${lineText}`;
  const insertAt = line.to;
  const newAnchor = state.selection.main.head + insertText.length;

  view.dispatch({
    changes: { from: insertAt, insert: insertText },
    selection: { anchor: newAnchor },
    scrollIntoView: true,
  });

  return true;
}

function deleteCurrentLine(view: EditorView) {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const nextLine = state.doc.lineAt(Math.min(line.to + 1, state.doc.length));
  const hasNextLine = nextLine.number !== line.number;
  const from = line.from;
  const to = hasNextLine ? nextLine.from : line.to;

  if (from === to && state.doc.length === 0) return true;

  view.dispatch({
    changes: { from, to },
    selection: { anchor: from },
    scrollIntoView: true,
  });

  return true;
}

function createEmptySessionState(projectRoot: string | null = null): SessionState {
  return {
    project_root: projectRoot,
    open_tabs: [],
    pinned_tab_paths: [],
    editor_view_states: {},
    auto_save_mode: "off",
    active_tab_path: "",
    open_folders: [],
    recent_file_paths: [],
    selected_tree_path: "",
    bottom_panel_tab: "diff",
    is_bottom_panel_open: false,
    bottom_panel_height: 260,
  };
}

function slugifyHeading(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[`~!@#$%^&*()+=[\]{}|\\:;"'<>,.?/]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function isExternalUrl(value: string) {
  return /^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith("mailto:") || value.startsWith("tel:");
}

function decodeUriRecursively(value: string, attempts = 3) {
  let current = value;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      break;
    }
  }
  return current;
}

function normalizeLocalFilePath(value: string) {
  const normalized = normalizeFilePath(value);
  return normalized.replace(/^\/{2,}/, "/");
}

function normalizeInputFilePath(value: string) {
  const decodedValue = decodeUriRecursively(value.trim());

  if (decodedValue.startsWith("asset://localhost/")) {
    return normalizeLocalFilePath(decodedValue.slice("asset://localhost".length));
  }

  if (decodedValue.startsWith("file://")) {
    return normalizeLocalFilePath(decodedValue.slice("file://".length));
  }

  return normalizeFilePath(decodedValue);
}

function normalizeStoredPaths(paths: string[] | undefined | null) {
  return (paths ?? []).filter(Boolean).map((path) => normalizeInputFilePath(path));
}

function resolveMarkdownResourcePath(baseFilePath: string, target: string, _projectRoot: string | null) {
  const trimmed = target.trim();
  const decodedTarget = decodeUriRecursively(trimmed);

  if (!decodedTarget || decodedTarget.startsWith("#") || decodedTarget.startsWith("data:")) {
    return null;
  }

  if (decodedTarget.startsWith("asset://localhost/")) {
    return normalizeInputFilePath(decodedTarget);
  }

  if (decodedTarget.startsWith("file://")) {
    return normalizeInputFilePath(decodedTarget);
  }

  if (isExternalUrl(decodedTarget)) {
    return null;
  }

  if (decodedTarget.startsWith("/")) {
    return normalizeFilePath(decodedTarget);
  }

  const baseDir = getParentDirPath(baseFilePath, baseFilePath);
  const parts = normalizeFilePath(`${baseDir}/${decodedTarget}`).split("/");
  const resolved: string[] = [];

  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }

  const prefix = normalizeFilePath(baseFilePath).startsWith("/") ? "/" : "";
  return `${prefix}${resolved.join("/")}`;
}

function splitMarkdownHref(target: string) {
  const [pathPart, ...hashParts] = target.split("#");
  const hash = hashParts.join("#").trim();
  return {
    path: pathPart ?? "",
    hash: hash ? decodeURIComponent(hash) : "",
  };
}

function normalizeMarkdownPreviewContent(content: string) {
  return content.replace(/(!?\[[^\]]*\])\(([^()\n]*\s[^()\n]*)\)/g, (fullMatch, label, target) => {
    const trimmedTarget = target.trim();
    if (!trimmedTarget) return fullMatch;
    if (trimmedTarget.startsWith("<") && trimmedTarget.endsWith(">")) return fullMatch;
    if (trimmedTarget.includes('"') || trimmedTarget.includes("'")) return fullMatch;
    return `${label}(<${trimmedTarget}>)`;
  });
}

function extractTextFromReactNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractTextFromReactNode).join("");
  if (!node || typeof node !== "object") return "";
  if ("props" in node && node.props && typeof node.props === "object" && "children" in node.props) {
    return extractTextFromReactNode((node.props as { children?: ReactNode }).children ?? "");
  }
  return "";
}

function extractMarkdownHeadings(content: string) {
  const headingCounts = new Map<string, number>();
  const headings: Array<{ level: number; text: string; id: string }> = [];
  const lines = content.split("\n");
  let inFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }

    if (inFence) continue;

    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].replace(/\s+#*$/, "").trim();
    if (!text) continue;
    const baseSlug = slugifyHeading(text) || `section-${headingCounts.size + 1}`;
    const seen = headingCounts.get(baseSlug) ?? 0;
    headingCounts.set(baseSlug, seen + 1);
    const id = seen === 0 ? baseSlug : `${baseSlug}-${seen + 1}`;
    headings.push({ level, text, id });
  }

  return headings;
}

type CommandPaletteGroup = "Files" | "Search" | "Editor" | "Git" | "Workspace" | "View";

const MAX_RENDERED_GIT_FILES = 400;
const MAX_RENDERED_GIT_HISTORY = 300;

interface CommandPaletteCommand {
  id: string;
  title: string;
  subtitle: string;
  shortcut?: string;
  group: CommandPaletteGroup;
  keywords?: string;
  available: boolean;
  run: () => void;
}

declare global {
  interface Window {
    __FIKA_CLOSE_ACTIVE_TAB__?: () => void;
    __FIKA_OPEN_FOLDER__?: () => void;
    __FIKA_SHOW_RECENT_PROJECTS__?: () => void;
    __FIKA_OPEN_FOLDER_NEW_WINDOW__?: () => void;
    __FIKA_CHECK_FOR_UPDATES__?: () => void;
    __FIKA_CLEAR_PROJECT__?: () => void;
    __FIKA_SESSION_RESTORED__?: boolean;
  }
}

function App() {
  const isMac = useMemo(() => isMacPlatform(), []);
  const currentWindowLabel = useMemo(() => getCurrentWebviewWindow().label, []);
  const [markdownPreviewByPath, setMarkdownPreviewByPath] = useState<Record<string, boolean>>({});
  const [imagePreviewError, setImagePreviewError] = useState<string | null>(null);
  const [imageZoom, setImageZoom] = useState(100);
  const [imageFitMode, setImageFitMode] = useState<"fit" | "actual">("fit");
  const [imageNaturalSize, setImageNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const markdownPreviewScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingMarkdownAnchorRef = useRef<{ path: string; id: string } | null>(null);
  const finderPreviewCacheRef = useRef(new Map<string, { content: string; unsupported: boolean }>());
  const workspaceRestoreRunRef = useRef(0);
  const lastExternalFileRefreshRef = useRef(0);
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
  const tabSwitcherShortcutLabel = useMemo(() => (
    isMac ? "⌃Tab" : "Ctrl+Tab"
  ), [isMac]);

  const [rootName, setRootName] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<FileNode | null>(null);
  const [projectFilePaths, setProjectFilePaths] = useState<string[]>([]);
  const [projectFileIndexLoaded, setProjectFileIndexLoaded] = useState(false);
  const [projectFileIndexLoading, setProjectFileIndexLoading] = useState(false);
  const [autoSaveMode, setAutoSaveMode] = useState<AutoSaveMode>("off");
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [openTabs, setOpenTabs] = useState<EditorDocument[]>([]);
  const [pinnedTabPaths, setPinnedTabPaths] = useState<Set<string>>(new Set());
  const [activeTabPath, setActiveTabPath] = useState<string>("");
  const [closedTabHistory, setClosedTabHistory] = useState<string[]>([]);
  const [selectedTreePath, setSelectedTreePath] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [recentFilePaths, setRecentFilePaths] = useState<string[]>([]);

  const [finderOpen, setFinderOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [finderPreview, setFinderPreview] = useState<{
    path: string;
    content: string;
    loading: boolean;
    unsupported: boolean;
  } | null>(null);

  const [recentOpen, setRecentOpen] = useState(false);
  const [recentSelectedIndex, setRecentSelectedIndex] = useState(0);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [commandPaletteSelectedIndex, setCommandPaletteSelectedIndex] = useState(0);
  const [commandPaletteRecentIds, setCommandPaletteRecentIds] = useState<string[]>([]);
  const commandPaletteInputRef = useRef<HTMLInputElement>(null);

  const [tabSwitcherOpen, setTabSwitcherOpen] = useState(false);
  const [tabSwitcherQuery, setTabSwitcherQuery] = useState("");
  const [tabSwitcherSelectedIndex, setTabSwitcherSelectedIndex] = useState(0);
  const tabSwitcherInputRef = useRef<HTMLInputElement>(null);

  // In-file search state
  const [inFileSearchOpen, setInFileSearchOpen] = useState(false);
  const [inFileQuery, setInFileQuery] = useState("");
  const [inFileReplaceOpen, setInFileReplaceOpen] = useState(false);
  const [inFileReplaceValue, setInFileReplaceValue] = useState("");
  const [inFileCaseSensitive, setInFileCaseSensitive] = useState(false);
  const [inFileWholeWord, setInFileWholeWord] = useState(false);
  const [inFileRegex, setInFileRegex] = useState(false);
  const inFileInputRef = useRef<HTMLInputElement>(null);
  const inFileReplaceInputRef = useRef<HTMLInputElement>(null);

  // Global search state
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [globalSearchQuery, setGlobalSearchQuery] = useState("");
  const [globalSearchResults, setGlobalSearchResults] = useState<SearchResult[]>([]);
  const [globalSearchLoading, setGlobalSearchLoading] = useState(false);
  const [globalSearchReplaceOpen, setGlobalSearchReplaceOpen] = useState(false);
  const [globalSearchReplaceValue, setGlobalSearchReplaceValue] = useState("");
  const [globalSearchHistory, setGlobalSearchHistory] = useState<string[]>([]);
  const [globalSearchCaseSensitive, setGlobalSearchCaseSensitive] = useState(false);
  const [globalSearchWholeWord, setGlobalSearchWholeWord] = useState(false);
  const [globalSearchRegex, setGlobalSearchRegex] = useState(false);
  const [globalSelectedIndex, setGlobalSelectedIndex] = useState(0);
  const globalInputRef = useRef<HTMLInputElement>(null);
  const globalReplaceInputRef = useRef<HTMLInputElement>(null);
  const globalSearchRequestIdRef = useRef(0);

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
  const [selectedDiffIsStaged, setSelectedDiffIsStaged] = useState(false);
  const [selectedGitFilePath, setSelectedGitFilePath] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [selectedDiffHunkIndex, setSelectedDiffHunkIndex] = useState(0);
  const [activeEditorGitDiff, setActiveEditorGitDiff] = useState<FileDiff | null>(null);
  const [diffSourceTab, setDiffSourceTab] = useState<"diff" | "log">("diff");
  const [branchSwitcherOpen, setBranchSwitcherOpen] = useState(false);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [gitFileFilterQuery, setGitFileFilterQuery] = useState("");
  const [gitStatusFilter, setGitStatusFilter] = useState<string>("all");
  const [gitSortMode, setGitSortMode] = useState<"path" | "status">("status");
  const lastGitFocusRefreshRef = useRef(0);
  const diffHunkRefs = useRef<Array<HTMLDivElement | null>>([]);

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
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [renameModal, setRenameModal] = useState<{ path: string; isDir: boolean; newName: string } | null>(null);
  const [newFileModal, setNewFileModal] = useState<{ dirPath: string; name: string; isDir: boolean } | null>(null);
  const [discardFileModalPath, setDiscardFileModalPath] = useState<string | null>(null);
  const [closeTabModal, setCloseTabModal] = useState<{ path: string; content: string } | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<AvailableUpdate | null>(null);
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [updateStatusMessage, setUpdateStatusMessage] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveStatusTimeoutRef = useRef<number | null>(null);

  // Navigation history state
  const [navHistory, setNavHistory] = useState<NavigationEntry[]>([]);
  const [navIndex, setNavIndex] = useState(-1);
  const isNavigatingRef = useRef(false);
  const resizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(260);
  const pendingOpenPathsRef = useRef<Set<string>>(new Set());
  const pendingWorkspaceStateRef = useRef<SessionState | null>(null);
  const preferredWorkspaceStateRef = useRef<SessionState | null>(null);
  const [loadingFolderPaths, setLoadingFolderPaths] = useState<Set<string>>(new Set());
  const editorViewStateRef = useRef<Map<string, EditorViewStateSnapshot>>(new Map());

  // Editor ref for scrolling to line
  const editorRef = useRef<ReactCodeMirrorRef>(null);

  const showTransientSaveStatus = useCallback((status: "saved" | "error") => {
    if (saveStatusTimeoutRef.current !== null) {
      window.clearTimeout(saveStatusTimeoutRef.current);
    }
    setSaveStatus(status);
    saveStatusTimeoutRef.current = window.setTimeout(() => {
      setSaveStatus("idle");
      saveStatusTimeoutRef.current = null;
    }, status === "saved" ? 1400 : 2200);
  }, []);

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

  const deferredFinderQuery = useDeferredValue(query);
  const parsedFinderQuery = useMemo(() => parseFinderQuery(deferredFinderQuery), [deferredFinderQuery]);
  const finderFileEntries = useMemo(
    () => projectFilePaths.map((path) => {
      const relativePath = toRelativePath(projectRoot, path);
      return {
        path,
        relativePath,
        normalizedRelativePath: relativePath.toLowerCase(),
      };
    }),
    [projectFilePaths, projectRoot]
  );
  const recentFileOrder = useMemo(
    () => new Map(recentFilePaths.map((path, index) => [path, index])),
    [recentFilePaths]
  );
  const filtered = useMemo(() => {
    const q = parsedFinderQuery.baseQuery.toLowerCase();
    const items = finderFileEntries
      .map((entry) => {
        const score = q ? scoreFileMatch(entry.normalizedRelativePath, q) : 0;
        return {
          path: entry.path,
          relativePath: entry.relativePath,
          score,
          recentIndex: recentFileOrder.get(entry.path) ?? Number.MAX_SAFE_INTEGER,
          lineNumber: parsedFinderQuery.lineNumber,
          columnNumber: parsedFinderQuery.columnNumber,
        };
      })
      .filter((item) => !q || item.score >= 0)
      .sort((a, b) => {
        if (!q && a.recentIndex !== b.recentIndex) return a.recentIndex - b.recentIndex;
        if (b.score !== a.score) return b.score - a.score;
        return a.relativePath.localeCompare(b.relativePath);
      });

    return items.slice(0, q ? 300 : 200);
  }, [finderFileEntries, parsedFinderQuery, recentFileOrder]);

  const openCommandPalette = useCallback(() => {
    setCommandPaletteOpen(true);
    setCommandPaletteQuery("");
    setCommandPaletteSelectedIndex(0);
    window.setTimeout(() => commandPaletteInputRef.current?.focus(), 0);
  }, []);
  const executeCommandPaletteCommand = useCallback((command: CommandPaletteCommand) => {
    setCommandPaletteOpen(false);
    setCommandPaletteQuery("");
    setCommandPaletteSelectedIndex(0);
    setCommandPaletteRecentIds((prev) => {
      const next = [command.id, ...prev.filter((item) => item !== command.id)].slice(0, 12);
      try {
        localStorage.setItem("fika:command-palette-recent", JSON.stringify(next));
      } catch {
        // Ignore persistence failures
      }
      return next;
    });
    command.run();
  }, []);

  const activeTab = useMemo(
    () => openTabs.find((t) => t.path === activeTabPath) || null,
    [openTabs, activeTabPath]
  );
  const breadcrumbItems = useMemo(() => {
    if (!activeTab?.path || !projectRoot) return [];

    const relativePath = toProjectRelativePath(activeTab.path);
    if (!relativePath) return [];

    const segments = relativePath.split("/").filter(Boolean);
    const items: Array<{ label: string; path: string; isFile: boolean }> = [];
    let currentPath = normalizeFilePath(projectRoot).replace(/\/$/, "");

    for (let index = 0; index < segments.length; index += 1) {
      currentPath = `${currentPath}/${segments[index]}`;
      items.push({
        label: segments[index],
        path: currentPath,
        isFile: index === segments.length - 1,
      });
    }

    return items;
  }, [activeTab?.path, projectRoot, toProjectRelativePath]);
  const orderedOpenTabs = useMemo(() => {
    const pinned = openTabs.filter((tab) => pinnedTabPaths.has(tab.path));
    const unpinned = openTabs.filter((tab) => !pinnedTabPaths.has(tab.path));
    const displayTabs = [...pinned, ...unpinned];
    if (displayTabs.length <= 1) return displayTabs;
    const activeIndex = displayTabs.findIndex((tab) => tab.path === activeTabPath);
    if (activeIndex <= 0) return displayTabs;
    return [
      ...displayTabs.slice(activeIndex + 1),
      ...displayTabs.slice(0, activeIndex + 1),
    ];
  }, [openTabs, activeTabPath, pinnedTabPaths]);
  const displayOpenTabs = useMemo(() => {
    const pinned = openTabs.filter((tab) => pinnedTabPaths.has(tab.path));
    const unpinned = openTabs.filter((tab) => !pinnedTabPaths.has(tab.path));
    return [...pinned, ...unpinned];
  }, [openTabs, pinnedTabPaths]);
  const filteredOpenTabs = useMemo(() => {
    const q = tabSwitcherQuery.trim().toLowerCase();
    if (!q) return orderedOpenTabs;

    return orderedOpenTabs
      .map((tab) => {
        const relativePath = toRelativePath(projectRoot, tab.path);
        return {
          tab,
          relativePath,
          score: scoreFileMatch(relativePath, q),
        };
      })
      .filter((item) => item.score >= 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.relativePath.localeCompare(b.relativePath);
      })
      .map((item) => item.tab);
  }, [orderedOpenTabs, projectRoot, tabSwitcherQuery]);
  const isImageTab = useMemo(
    () => !!activeTab?.path && isImagePath(activeTab.path),
    [activeTab]
  );
  const isMarkdownTab = useMemo(
    () => !!activeTab?.path && /\.(md|markdown)$/i.test(activeTab.path),
    [activeTab]
  );
  const isActiveMarkdownPreviewOpen = useMemo(
    () => Boolean(activeTab?.path && markdownPreviewByPath[activeTab.path]),
    [activeTab?.path, markdownPreviewByPath]
  );
  const [activeImageSrc, setActiveImageSrc] = useState<string | null>(null);
  const [renderedMarkdownHeadings, setRenderedMarkdownHeadings] = useState<Array<{ level: number; text: string; id: string }>>([]);
  const markdownPreviewContent = useMemo(
    () => (activeTab && isMarkdownTab ? normalizeMarkdownPreviewContent(activeTab.content) : ""),
    [activeTab, isMarkdownTab]
  );
  const markdownHeadings = useMemo(() => {
    if (!activeTab || !isMarkdownTab) return [];
    return extractMarkdownHeadings(markdownPreviewContent);
  }, [activeTab, isMarkdownTab, markdownPreviewContent]);
  const setActiveMarkdownPreviewOpen = useCallback((open: boolean) => {
    if (!activeTab?.path) return;
    setMarkdownPreviewByPath((prev) => ({
      ...prev,
      [activeTab.path]: open,
    }));
  }, [activeTab?.path]);
  const toggleActiveMarkdownPreview = useCallback(() => {
    if (!activeTab?.path) return;
    setMarkdownPreviewByPath((prev) => ({
      ...prev,
      [activeTab.path]: !prev[activeTab.path],
    }));
  }, [activeTab?.path]);
  const scrollMarkdownHeadingIntoView = useCallback((id: string) => {
    const container = markdownPreviewScrollRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!target) return;
    const top = target.offsetTop - 24;
    container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, []);
  useEffect(() => {
    if (!isMarkdownTab || !isActiveMarkdownPreviewOpen) {
      setRenderedMarkdownHeadings([]);
      return;
    }

    const container = markdownPreviewScrollRef.current;
    if (!container) return;

    const collect = () => {
      const headings = Array.from(container.querySelectorAll<HTMLElement>(".md-heading")).map((element) => ({
        level: Number(element.tagName.replace("H", "")) || 1,
        text: element.textContent?.trim() ?? "",
        id: element.id,
      })).filter((heading) => heading.text && heading.id);
      setRenderedMarkdownHeadings(headings);
    };

    collect();
    const frameId = window.requestAnimationFrame(collect);
    return () => window.cancelAnimationFrame(frameId);
  }, [activeTab?.path, isActiveMarkdownPreviewOpen, isMarkdownTab, markdownPreviewContent]);
  useEffect(() => {
    if (!contextMenu && !tabContextMenu) return;

    const handlePointerDown = () => {
      setContextMenu(null);
      setTabContextMenu(null);
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => window.removeEventListener("pointerdown", handlePointerDown, true);
  }, [contextMenu, tabContextMenu]);
  const getEditorContent = useCallback(
    () => editorRef.current?.view?.state.doc.toString() ?? null,
    []
  );
  const rememberEditorViewState = useCallback((path?: string | null) => {
    if (!path) return;
    const view = editorRef.current?.view;
    if (!view) return;

    editorViewStateRef.current.set(path, {
      selection_anchor: view.state.selection.main.head,
      scroll_top: view.scrollDOM.scrollTop,
    });
  }, []);
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
  const filterAndSortGitFiles = useCallback(<T extends { path: string; status: string }>(files: T[]) => {
    const query = gitFileFilterQuery.trim().toLowerCase();
    return files
      .filter((file) => {
        if (gitStatusFilter !== "all" && file.status !== gitStatusFilter) return false;
        if (!query) return true;
        return file.path.toLowerCase().includes(query);
      })
      .sort((a, b) => {
        if (gitSortMode === "status") {
          const rankDiff = gitStatusSortRank(a.status) - gitStatusSortRank(b.status);
          if (rankDiff !== 0) return rankDiff;
        }
        return a.path.localeCompare(b.path);
      });
  }, [gitFileFilterQuery, gitSortMode, gitStatusFilter]);
  const filteredStagedFiles = useMemo(
    () => filterAndSortGitFiles(stagedFiles),
    [filterAndSortGitFiles, stagedFiles]
  );
  const filteredGitChanges = useMemo(
    () => filterAndSortGitFiles(gitChanges),
    [filterAndSortGitFiles, gitChanges]
  );
  const activeEditorDiffSummary = useMemo(
    () => summarizeDiff(activeEditorGitDiff),
    [activeEditorGitDiff]
  );
  const stagedPathSet = useMemo(
    () => new Set(stagedFiles.map((file) => file.path)),
    [stagedFiles]
  );
  const unstagedPathSet = useMemo(
    () => new Set(gitChanges.map((file) => file.path)),
    [gitChanges]
  );
  const visibleWorkingTreeFiles = useMemo(() => {
    const byPath = new Map<string, { path: string; status: string; old_path?: string | null; staged?: boolean }>();

    for (const file of filteredStagedFiles) {
      byPath.set(file.path, { ...file, staged: true });
    }
    for (const file of filteredGitChanges) {
      if (!byPath.has(file.path)) {
        byPath.set(file.path, { ...file, staged: false });
      }
    }

    return Array.from(byPath.values());
  }, [filteredGitChanges, filteredStagedFiles]);
  const visibleLogFiles = useMemo(
    () => commitFiles?.files ?? [],
    [commitFiles]
  );
  const renderedStagedFiles = useMemo(
    () => filteredStagedFiles.slice(0, MAX_RENDERED_GIT_FILES),
    [filteredStagedFiles]
  );
  const renderedGitChanges = useMemo(
    () => filteredGitChanges.slice(0, MAX_RENDERED_GIT_FILES),
    [filteredGitChanges]
  );
  const renderedLogFiles = useMemo(
    () => visibleLogFiles.slice(0, MAX_RENDERED_GIT_FILES),
    [visibleLogFiles]
  );
  const renderedGitHistory = useMemo(
    () => gitHistory.slice(0, MAX_RENDERED_GIT_HISTORY),
    [gitHistory]
  );
  const hiddenStagedFilesCount = filteredStagedFiles.length - renderedStagedFiles.length;
  const hiddenGitChangesCount = filteredGitChanges.length - renderedGitChanges.length;
  const hiddenLogFilesCount = visibleLogFiles.length - renderedLogFiles.length;
  const hiddenGitHistoryCount = gitHistory.length - renderedGitHistory.length;
  const stagedStatusSummary = useMemo(() => {
    const summary = new Map<string, number>();
    for (const file of stagedFiles) {
      summary.set(file.status, (summary.get(file.status) ?? 0) + 1);
    }
    return Array.from(summary.entries())
      .sort((a, b) => gitStatusSortRank(a[0]) - gitStatusSortRank(b[0]))
      .map(([status, count]) => ({ status, count }));
  }, [stagedFiles]);
  const selectedDiffEntry = useMemo(() => {
    if (!selectedDiffFile) return null;
    if (selectedCommit) {
      return visibleLogFiles.find((file) => file.path === selectedDiffFile) ?? null;
    }
    return visibleWorkingTreeFiles.find((file) => file.path === selectedDiffFile) ?? null;
  }, [selectedCommit, selectedDiffFile, visibleLogFiles, visibleWorkingTreeFiles]);
  const selectedDiffStatus = selectedDiffEntry?.status ?? null;
  const canOpenSelectedDiffInEditor = selectedDiffStatus !== "D";
  const canRevertSelectedDiffFile = diffSourceTab === "diff" && !selectedDiffIsStaged;

  // In-file search state - current match index tracking (-1 means no selection yet)
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);

  // In-file search matches
  const inFileSearchResult = useMemo(() => {
    if (!activeTab || !inFileQuery.trim()) return { matches: [], error: null as string | null };
    return findInText(activeTab.content, inFileQuery, {
      caseSensitive: inFileCaseSensitive,
      wholeWord: inFileRegex ? false : inFileWholeWord,
      regex: inFileRegex,
    });
  }, [activeTab, inFileCaseSensitive, inFileQuery, inFileRegex, inFileWholeWord]);
  const inFileMatches = inFileSearchResult.matches;
  const inFileSearchError = inFileSearchResult.error;
  const searchHighlightExtensions = useMemo(() => {
    if (!activeTab || !inFileSearchOpen || !inFileQuery.trim() || inFileSearchError || inFileMatches.length === 0) {
      return [];
    }

    const matchDecorations = EditorView.decorations.compute([], (state) => {
      const builder = new RangeSetBuilder<Decoration>();
      const activeIndex = currentMatchIndex === -1 ? 0 : currentMatchIndex;

      for (let index = 0; index < inFileMatches.length; index += 1) {
        const match = inFileMatches[index];
        const from = Math.max(0, Math.min(match.from, state.doc.length));
        const to = Math.max(from, Math.min(match.to, state.doc.length));
        builder.add(
          from,
          to,
          Decoration.mark({
            class: index === activeIndex ? "cm-search-match-active" : "cm-search-match",
          })
        );
      }

      return builder.finish();
    });

    return [matchDecorations];
  }, [activeTab, currentMatchIndex, inFileMatches, inFileQuery, inFileSearchError, inFileSearchOpen]);

  // Reset current match index when search query or active tab changes
  useEffect(() => {
    setCurrentMatchIndex(-1);
  }, [inFileCaseSensitive, inFileQuery, inFileRegex, inFileWholeWord, activeTabPath]);

  useEffect(() => {
    setImagePreviewError(null);
    setActiveImageSrc(null);
    setImageZoom(100);
    setImageFitMode("fit");
    setImageNaturalSize(null);
  }, [activeTabPath]);

  useEffect(() => {
    let cancelled = false;

    if (!isImageTab || !activeTab?.path) {
      setActiveImageSrc(null);
      return () => {
        cancelled = true;
      };
    }

    setActiveImageSrc(null);
    setImagePreviewError(null);

    void readImageDataUrl(activeTab.path)
      .then((dataUrl) => {
        if (cancelled) return;
        setActiveImageSrc(dataUrl);
      })
      .catch((error) => {
        if (cancelled) return;
        setImagePreviewError(`${activeTab.path}\n${String(error)}`);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab?.path, isImageTab]);

  useEffect(() => {
    if (!activeTab || isImageTab || (isMarkdownTab && isActiveMarkdownPreviewOpen)) return;

    const viewState = editorViewStateRef.current.get(activeTab.path);
    if (!viewState) return;

    const frameId = window.requestAnimationFrame(() => {
      const view = editorRef.current?.view;
      if (!view) return;

      const anchor = Math.max(0, Math.min(viewState.selection_anchor, view.state.doc.length));
      view.dispatch({
        selection: { anchor },
      });
      view.scrollDOM.scrollTop = viewState.scroll_top;
      view.focus();
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [activeTab, isImageTab, isMarkdownTab, isActiveMarkdownPreviewOpen]);

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

  const selectInEditor = useCallback((from: number, to: number) => {
    const view = editorRef.current?.view;
    if (!view) return;

    const safeFrom = Math.max(0, Math.min(from, view.state.doc.length));
    const safeTo = Math.max(safeFrom, Math.min(to, view.state.doc.length));
    view.dispatch({
      selection: { anchor: safeFrom, head: safeTo },
      scrollIntoView: true,
    });
    view.focus();
  }, []);

  const getEditorSelectionState = useCallback(() => {
    const view = editorRef.current?.view;
    if (!view) return null;
    const selection = view.state.selection.main;
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    return {
      from,
      to,
      text: from === to ? "" : view.state.doc.sliceString(from, to),
    };
  }, []);

  const findMatchIndexForSelection = useCallback((
    matches: Array<{ from: number; to: number }>,
    selection: { from: number; to: number } | null
  ) => {
    if (!selection || matches.length === 0) return matches.length > 0 ? 0 : -1;

    const exactIndex = matches.findIndex(
      (match) => match.from === selection.from && match.to === selection.to
    );
    if (exactIndex >= 0) return exactIndex;

    const containingIndex = matches.findIndex(
      (match) => selection.from >= match.from && selection.from <= match.to
    );
    if (containingIndex >= 0) return containingIndex;

    const nearestIndex = matches.findIndex((match) => match.from >= selection.from);
    if (nearestIndex >= 0) return nearestIndex;

    return matches.length > 0 ? matches.length - 1 : -1;
  }, []);

  useEffect(() => {
    if (!inFileSearchOpen || !inFileQuery.trim() || inFileSearchError || inFileMatches.length === 0) {
      return;
    }

    const selection = getEditorSelectionState();
    const nextIndex = findMatchIndexForSelection(inFileMatches, selection);
    setCurrentMatchIndex((current) => (current === nextIndex ? current : nextIndex));
  }, [
    findMatchIndexForSelection,
    getEditorSelectionState,
    inFileMatches,
    inFileQuery,
    inFileSearchError,
    inFileSearchOpen,
  ]);

  // In-file search navigation
  const goToNextMatch = useCallback(() => {
    if (inFileMatches.length === 0) return;
    // If no selection yet, select first match (index 0), otherwise go to next
    const nextIndex = currentMatchIndex === -1 ? 0 : (currentMatchIndex + 1) % inFileMatches.length;
    setCurrentMatchIndex(nextIndex);
    const nextMatch = inFileMatches[nextIndex];
    selectInEditor(nextMatch.from, nextMatch.to);
  }, [inFileMatches, currentMatchIndex, selectInEditor]);

  const goToPrevMatch = useCallback(() => {
    if (inFileMatches.length === 0) return;
    // If no selection yet, select last match, otherwise go to previous
    const prevIndex = currentMatchIndex === -1
      ? inFileMatches.length - 1
      : (currentMatchIndex - 1 + inFileMatches.length) % inFileMatches.length;
    setCurrentMatchIndex(prevIndex);
    const prevMatch = inFileMatches[prevIndex];
    selectInEditor(prevMatch.from, prevMatch.to);
  }, [inFileMatches, currentMatchIndex, selectInEditor]);

  const handleReplaceCurrentMatch = useCallback(() => {
    if (!activeTab || !inFileQuery || inFileMatches.length === 0) return;
    const matchIndex = currentMatchIndex === -1 ? 0 : currentMatchIndex;
    const match = inFileMatches[matchIndex];
    if (!match) return;

    const nextContent =
      activeTab.content.slice(0, match.from) +
      inFileReplaceValue +
      activeTab.content.slice(match.to);

    setOpenTabs((prev) =>
      prev.map((tab) =>
        tab.path === activeTab.path
          ? { ...tab, content: nextContent, isDirty: nextContent !== tab.originalContent }
          : tab
      )
    );

    const nextSelectionFrom = match.from;
    const nextSelectionTo = match.from + inFileReplaceValue.length;
    window.requestAnimationFrame(() => {
      selectInEditor(nextSelectionFrom, nextSelectionTo);
    });
  }, [activeTab, currentMatchIndex, inFileMatches, inFileQuery, inFileReplaceValue, selectInEditor]);

  const handleReplaceAllMatches = useCallback(() => {
    if (!activeTab || !inFileQuery || inFileMatches.length === 0) return;

    let cursor = 0;
    let nextContent = "";
    for (const match of inFileMatches) {
      nextContent += activeTab.content.slice(cursor, match.from);
      nextContent += inFileReplaceValue;
      cursor = match.to;
    }
    nextContent += activeTab.content.slice(cursor);

    setOpenTabs((prev) =>
      prev.map((tab) =>
        tab.path === activeTab.path
          ? { ...tab, content: nextContent, isDirty: nextContent !== tab.originalContent }
          : tab
      )
    );
    setCurrentMatchIndex(-1);
  }, [activeTab, inFileMatches.length, inFileQuery, inFileReplaceValue]);

  // Global search handler
  const handleGlobalSearch = useCallback(async () => {
    if (!projectRoot || !globalSearchQuery.trim()) {
      setGlobalSearchResults([]);
      return;
    }

    const requestId = globalSearchRequestIdRef.current + 1;
    globalSearchRequestIdRef.current = requestId;
    setGlobalSearchLoading(true);
    setError(null);

    try {
      const results = await searchInProject(projectRoot, globalSearchQuery, {
        case_sensitive: globalSearchCaseSensitive,
        whole_word: globalSearchRegex ? false : globalSearchWholeWord,
        regex: globalSearchRegex,
      });
      if (globalSearchRequestIdRef.current !== requestId) return;
      setGlobalSearchResults(results);
      setGlobalSelectedIndex(0);
      const normalizedQuery = globalSearchQuery.trim();
      if (normalizedQuery) {
        setGlobalSearchHistory((prev) => {
          const next = [normalizedQuery, ...prev.filter((item) => item !== normalizedQuery)].slice(0, 12);
          localStorage.setItem("fika:global-search-history", JSON.stringify(next));
          return next;
        });
      }
    } catch (e) {
      if (globalSearchRequestIdRef.current !== requestId) return;
      setError(String(e));
      setGlobalSearchResults([]);
    } finally {
      if (globalSearchRequestIdRef.current !== requestId) return;
      setGlobalSearchLoading(false);
    }
  }, [projectRoot, globalSearchQuery, globalSearchCaseSensitive, globalSearchRegex, globalSearchWholeWord]);
  const groupedGlobalSearchResults = useMemo(() => {
    const groups: Array<{ path: string; results: SearchResult[] }> = [];
    const byPath = new Map<string, SearchResult[]>();

    for (const result of globalSearchResults) {
      const current = byPath.get(result.path);
      if (current) {
        current.push(result);
      } else {
        const items = [result];
        byPath.set(result.path, items);
        groups.push({ path: result.path, results: items });
      }
    }

    return groups;
  }, [globalSearchResults]);

  const loadProjectFileIndex = useCallback(async (force = false) => {
    if (!projectRoot) return [];
    if (projectFileIndexLoading) return projectFilePaths;
    if (projectFileIndexLoaded && !force) return projectFilePaths;

    setProjectFileIndexLoading(true);
    try {
      const nextPaths = await listProjectFiles(projectRoot);
      setProjectFilePaths(nextPaths);
      setProjectFileIndexLoaded(true);
      return nextPaths;
    } catch (e) {
      setError(String(e));
      return projectFilePaths;
    } finally {
      setProjectFileIndexLoading(false);
    }
  }, [projectRoot, projectFileIndexLoaded, projectFileIndexLoading, projectFilePaths]);

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
      const preferredState = preferredWorkspaceStateRef.current?.project_root === result.root
        ? preferredWorkspaceStateRef.current
        : null;
      preferredWorkspaceStateRef.current = null;
      const workspaceState =
        preferredState ??
        await loadWorkspace(result.root).catch(() => createEmptySessionState(result.root));
      pendingWorkspaceStateRef.current = workspaceState;
      setProjectRoot(result.root);
      setRootName(result.root.split(/[\/\\]/).pop() || result.root);
      setTree(result.tree);
      workspaceRestoreRunRef.current += 1;
      finderPreviewCacheRef.current.clear();
      setProjectFilePaths([]);
      setProjectFileIndexLoaded(false);
      setProjectFileIndexLoading(false);
      setOpenTabs([]);
      setActiveTabPath("");
      setSelectedTreePath(workspaceState.selected_tree_path ? normalizeInputFilePath(workspaceState.selected_tree_path) : result.tree.path);
      setRecentFilePaths(normalizeStoredPaths(workspaceState.recent_file_paths));
      setSelectedGitFilePath(null);
      setOpenFolders(new Set(normalizeStoredPaths(workspaceState.open_folders).length > 0 ? normalizeStoredPaths(workspaceState.open_folders) : [result.tree.path]));
      setBottomPanelTab(workspaceState.bottom_panel_tab);
      setIsBottomPanelOpen(workspaceState.is_bottom_panel_open);
      setBottomPanelHeight(workspaceState.bottom_panel_height);
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

    const sourceWindow = getCurrentWindow();
    const [isFullscreen, isMaximized] = await Promise.all([
      sourceWindow.isFullscreen().catch(() => false),
      sourceWindow.isMaximized().catch(() => false),
    ]);

    const label = `project-${Date.now()}`;
    const storageKey = `fika:pending-project:${label}`;
    localStorage.setItem(storageKey, projectPath);

    const nextWindow = new WebviewWindow(label, {
      title: "fika",
      width: 1440,
      height: 900,
      minWidth: 1100,
      minHeight: 720,
      maximized: !isFullscreen && isMaximized,
      fullscreen: isFullscreen,
      url: window.location.href,
    });

    nextWindow.once("tauri://created", () => {
      if (isFullscreen) {
        void nextWindow.setFullscreen(true).catch(() => {});
      } else if (isMaximized) {
        void nextWindow.maximize().catch(() => {});
      }
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
    pendingWorkspaceStateRef.current = null;
    preferredWorkspaceStateRef.current = null;
    workspaceRestoreRunRef.current += 1;
    finderPreviewCacheRef.current.clear();
    setProjectRoot(null);
    setRootName(null);
    setTree(null);
    setProjectFilePaths([]);
    setProjectFileIndexLoaded(false);
    setProjectFileIndexLoading(false);
    setLoadingFolderPaths(new Set());
    setAutoSaveMode("off");
    setOpenFolders(new Set());
    setOpenTabs([]);
    editorViewStateRef.current.clear();
    setPinnedTabPaths(new Set());
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
    saveSession(currentWindowLabel, createEmptySessionState()).catch(() => {});
    setUnsavedChangesFlag(false).catch(() => {});
  }, [currentWindowLabel]);

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

  const revealPathInTree = useCallback((path: string) => {
    if (!projectRoot) return;

    const normalizedRoot = normalizeFilePath(projectRoot).replace(/\/$/, "");
    const normalizedPath = normalizeFilePath(path);
    if (!normalizedPath.startsWith(normalizedRoot)) return;

    const relativePath = normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, "");
    if (!relativePath) {
      setSelectedTreePath(projectRoot);
      setOpenFolders((prev) => new Set(prev).add(projectRoot));
      return;
    }

    const segments = relativePath.split("/").filter(Boolean);
    const directoriesToOpen = new Set<string>([projectRoot]);
    let currentPath = normalizedRoot;

    for (let index = 0; index < segments.length - 1; index += 1) {
      currentPath = `${currentPath}/${segments[index]}`;
      directoriesToOpen.add(currentPath);
    }

    setOpenFolders((prev) => new Set([...prev, ...directoriesToOpen]));
    setSelectedTreePath(path);
  }, [projectRoot]);

  const handleOpenFile = useCallback(
    async (path: string, lineNumber?: number, _source = "unknown") => {
      if (!path) return;
      const nextPath = normalizeInputFilePath(path);
      const existing = openTabs.find((t) => t.path === nextPath);
      if (existing) {
        rememberEditorViewState(activeTabPath);
        setActiveTabPath(nextPath);
        updateRecentFiles(nextPath);
        addToNavHistory(nextPath, lineNumber);
        // If line number specified, scroll to it after a short delay to allow editor to render
        if (lineNumber !== undefined && lineNumber > 0) {
          setTimeout(() => scrollToLine(lineNumber), 50);
        }
        return;
      }
      if (pendingOpenPathsRef.current.has(nextPath)) {
        rememberEditorViewState(activeTabPath);
        setActiveTabPath(nextPath);
        return;
      }
      if (isImagePath(nextPath)) {
        const imageTab: EditorDocument = {
          path: nextPath,
          content: "",
          originalContent: "",
          isDirty: false,
          isLoading: false,
          loadError: null,
        };
        setOpenTabs((prev) => (prev.some((t) => t.path === nextPath) ? prev : [...prev, imageTab]));
        rememberEditorViewState(activeTabPath);
        setActiveTabPath(nextPath);
        setSelectedTreePath(nextPath);
        updateRecentFiles(nextPath);
        addToNavHistory(nextPath, lineNumber);
        setError(null);
        return;
      }
      pendingOpenPathsRef.current.add(nextPath);

      const newTab: EditorDocument = {
        path: nextPath,
        content: "",
        originalContent: "",
        isDirty: false,
        isLoading: true,
        loadError: null,
      };
      setOpenTabs((prev) => (prev.some((t) => t.path === nextPath) ? prev : [...prev, newTab]));
      rememberEditorViewState(activeTabPath);
      setActiveTabPath(nextPath);
      setError(null);

      try {
        const content = await readFile(nextPath);
        setOpenTabs((prev) =>
          prev.some((t) => t.path === nextPath)
            ? prev.map((t) =>
                t.path === nextPath ? { ...t, content, originalContent: content, isLoading: false, loadError: null } : t
              )
            : prev
        );
        setSelectedTreePath(nextPath);
        updateRecentFiles(nextPath);
        addToNavHistory(nextPath, lineNumber);
        // If line number specified, scroll to it after content is loaded
        if (lineNumber !== undefined && lineNumber > 0) {
          setTimeout(() => scrollToLine(lineNumber), 100);
        }
      } catch (e) {
        const errorMessage = String(e);
        setError(errorMessage);
        setOpenTabs((prev) =>
          prev.map((t) =>
            t.path === nextPath
              ? { ...t, content: "", originalContent: "", isDirty: false, isLoading: false, loadError: errorMessage }
              : t
          )
        );
      } finally {
        pendingOpenPathsRef.current.delete(nextPath);
      }
    },
    [openTabs, activeTabPath, updateRecentFiles, scrollToLine, addToNavHistory, rememberEditorViewState]
  );

  const handleMarkdownPreviewLink = useCallback(async (href: string) => {
    if (!href || !activeTab?.path) return;

    const { path: hrefPath, hash } = splitMarkdownHref(href);
    if (!hrefPath && hash) {
      scrollMarkdownHeadingIntoView(hash);
      return;
    }

    if (isExternalUrl(href)) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }

    const resolvedPath = resolveMarkdownResourcePath(activeTab.path, hrefPath, projectRoot);
    if (!resolvedPath) return;

    if (resolvedPath === activeTab.path) {
      if (hash) {
        scrollMarkdownHeadingIntoView(hash);
      }
      return;
    }

    if (hash) {
      pendingMarkdownAnchorRef.current = { path: resolvedPath, id: hash };
    }

    if (/\.(md|markdown)$/i.test(resolvedPath)) {
      setMarkdownPreviewByPath((prev) => ({
        ...prev,
        [resolvedPath]: true,
      }));
    }

    await handleOpenFile(resolvedPath, undefined, "markdown-link-open");
  }, [activeTab?.path, handleOpenFile, projectRoot, scrollMarkdownHeadingIntoView]);

  useEffect(() => {
    const pendingAnchor = pendingMarkdownAnchorRef.current;
    if (!pendingAnchor) return;
    if (!activeTab?.path || activeTab.path !== pendingAnchor.path) return;
    if (!isMarkdownTab || !isActiveMarkdownPreviewOpen || markdownHeadings.length === 0) return;

    pendingMarkdownAnchorRef.current = null;
    window.setTimeout(() => {
      scrollMarkdownHeadingIntoView(pendingAnchor.id);
    }, 0);
  }, [
    activeTab?.path,
    isMarkdownTab,
    isActiveMarkdownPreviewOpen,
    markdownHeadings,
    scrollMarkdownHeadingIntoView,
  ]);

  const openFinderResult = useCallback((result: { path: string; lineNumber?: number }) => {
    void handleOpenFile(result.path, result.lineNumber, "find-file-open");
  }, [handleOpenFile]);

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

  useEffect(() => {
    const pendingState = pendingWorkspaceStateRef.current;
    if (!pendingState || !projectRoot || !tree) return;
    if (pendingState.project_root && pendingState.project_root !== projectRoot) return;

    pendingWorkspaceStateRef.current = null;

    void (async () => {
      const normalizedOpenTabs = [...new Set(normalizeStoredPaths(pendingState.open_tabs))];
      const normalizedActivePath = pendingState.active_tab_path
        ? normalizeInputFilePath(pendingState.active_tab_path)
        : "";
      const prioritizedPaths = normalizedActivePath
        ? [
            normalizedActivePath,
            ...normalizedOpenTabs.filter((path) => path !== normalizedActivePath),
          ]
        : normalizedOpenTabs;
      const restoreRunId = workspaceRestoreRunRef.current + 1;
      workspaceRestoreRunRef.current = restoreRunId;
      setPinnedTabPaths(new Set(normalizeStoredPaths(pendingState.pinned_tab_paths)));
      editorViewStateRef.current = new Map(Object.entries(pendingState.editor_view_states ?? {}));
      setAutoSaveMode(pendingState.auto_save_mode ?? "off");

      const [primaryPath, ...secondaryPaths] = prioritizedPaths;
      if (primaryPath) {
        await handleOpenFile(primaryPath, undefined, "workspace-restore-primary");
      }

      window.setTimeout(() => {
        if (workspaceRestoreRunRef.current !== restoreRunId) return;
        void (async () => {
          for (const path of secondaryPaths) {
            if (workspaceRestoreRunRef.current !== restoreRunId) return;
            await handleOpenFile(path, undefined, "workspace-restore-secondary");
          }
        })();
      }, 0);

      if (normalizedActivePath) {
        setActiveTabPath(normalizedActivePath);
      }

      setSelectedTreePath(
        (pendingState.selected_tree_path ? normalizeInputFilePath(pendingState.selected_tree_path) : "") ||
        normalizedActivePath ||
        tree.path
      );
    })();
  }, [handleOpenFile, projectRoot, tree]);

  const refreshGitWorkingTreeState = useCallback(async () => {
    if (!projectRoot) return { changes: [] as ChangedFile[], staged: [] as StagedFile[] };
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
    return { changes, staged };
  }, [projectRoot]);

  const handleReplaceAcrossProject = useCallback(async () => {
    if (!projectRoot || !globalSearchQuery.trim() || groupedGlobalSearchResults.length === 0) return;

    const totalMatches = globalSearchResults.length;
    const totalFiles = groupedGlobalSearchResults.length;
    const confirmed = window.confirm(
      `Replace ${totalMatches} matches across ${totalFiles} files?`
    );
    if (!confirmed) return;

    setGlobalSearchLoading(true);
    setError(null);

    try {
      const searchOptions = {
        caseSensitive: globalSearchCaseSensitive,
        wholeWord: globalSearchRegex ? false : globalSearchWholeWord,
        regex: globalSearchRegex,
      };
      const changedPaths = new Set<string>();

      for (const group of groupedGlobalSearchResults) {
        const content = await readFile(group.path);
        const replacement = applyTextReplace(
          content,
          globalSearchQuery,
          globalSearchReplaceValue,
          searchOptions
        );

        if (replacement.error) {
          throw new Error(replacement.error);
        }

        if (replacement.count === 0 || replacement.content === content) continue;

        await writeFile(group.path, replacement.content);
        changedPaths.add(group.path);

        setOpenTabs((prev) =>
          prev.map((tab) =>
            tab.path === group.path
              ? {
                  ...tab,
                  content: replacement.content,
                  originalContent: tab.isDirty ? tab.originalContent : replacement.content,
                  isDirty: tab.isDirty,
                  loadError: null,
                }
              : tab
          )
        );
      }

      if (changedPaths.size > 0) {
        await refreshGitWorkingTreeState();
      }

      await handleGlobalSearch();
    } catch (e) {
      setError(String(e));
    } finally {
      setGlobalSearchLoading(false);
    }
  }, [
    globalSearchCaseSensitive,
    globalSearchQuery,
    globalSearchRegex,
    globalSearchReplaceValue,
    globalSearchResults.length,
    globalSearchWholeWord,
    groupedGlobalSearchResults,
    handleGlobalSearch,
    projectRoot,
    refreshGitWorkingTreeState,
  ]);

  const runGitWorkingTreeMutation = useCallback(async (
    operation: () => Promise<void>,
    options?: {
      onAfterRefresh?: (state: { changes: ChangedFile[]; staged: StagedFile[] }) => Promise<void> | void;
    }
  ) => {
    setError(null);
    try {
      await operation();
      const nextState = await refreshGitWorkingTreeState();
      await options?.onAfterRefresh?.(nextState);
    } catch (e) {
      setError(String(e));
    }
  }, [refreshGitWorkingTreeState]);

  const handleSave = useCallback(async () => {
    const tab = openTabs.find((t) => t.path === activeTabPath);
    if (!tab || !tab.isDirty || tab.isLoading || tab.loadError) return;
    setError(null);
    setSaveStatus("saving");
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
      showTransientSaveStatus("saved");
    } catch (e) {
      setError(String(e));
      showTransientSaveStatus("error");
    }
  }, [openTabs, activeTabPath, refreshGitWorkingTreeState, showTransientSaveStatus]);

  const handleSaveAll = useCallback(async () => {
    const dirtyTabs = openTabs.filter((t) => t.isDirty && !t.isLoading && !t.loadError);
    if (dirtyTabs.length === 0) return;
    setError(null);
    setSaveStatus("saving");

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
      showTransientSaveStatus("error");
    } else {
      showTransientSaveStatus("saved");
    }
    await refreshGitWorkingTreeState();
  }, [openTabs, refreshGitWorkingTreeState, showTransientSaveStatus]);

  const refreshOpenTabsFromDisk = useCallback(async () => {
    const reloadableTabs = openTabs.filter(
      (tab) => !tab.isDirty && !tab.isLoading && !tab.loadError && !isImagePath(tab.path)
    );
    if (reloadableTabs.length === 0) return;

    const results = await Promise.allSettled(
      reloadableTabs.map(async (tab) => ({
        path: tab.path,
        content: await readFile(tab.path),
      }))
    );

    const updatedContent = new Map<string, string>();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const existingTab = reloadableTabs.find((tab) => tab.path === result.value.path);
      if (!existingTab) continue;
      if (existingTab.content !== result.value.content || existingTab.originalContent !== result.value.content) {
        updatedContent.set(result.value.path, result.value.content);
      }
    }

    if (updatedContent.size === 0) return;

    setOpenTabs((prev) =>
      prev.map((tab) => {
        const nextContent = updatedContent.get(tab.path);
        if (nextContent === undefined || tab.isDirty) return tab;
        return {
          ...tab,
          content: nextContent,
          originalContent: nextContent,
          isDirty: false,
          loadError: null,
        };
      })
    );
  }, [openTabs]);

  useEffect(() => {
    if (autoSaveMode !== "after_delay") return;
    const dirtyTabs = openTabs.filter((tab) => tab.isDirty && !tab.isLoading && !tab.loadError);
    if (dirtyTabs.length === 0) return;

    const timeoutId = window.setTimeout(() => {
      void handleSaveAll();
    }, 1200);

    return () => window.clearTimeout(timeoutId);
  }, [autoSaveMode, handleSaveAll, openTabs]);

  const handleSwitchTab = useCallback((path: string) => {
    rememberEditorViewState(activeTabPath);
    setActiveTabPath(path);
    setSelectedTreePath(path);
    updateRecentFiles(path);
  }, [activeTabPath, rememberEditorViewState, updateRecentFiles]);

  const handleTogglePinTab = useCallback((path: string) => {
    setPinnedTabPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleReorderTabs = useCallback((fromPath: string, toPath: string) => {
    if (!fromPath || !toPath || fromPath === toPath) return;
    const fromPinned = pinnedTabPaths.has(fromPath);
    const toPinned = pinnedTabPaths.has(toPath);
    if (fromPinned !== toPinned) return;

    setOpenTabs((prev) => {
      const sourceIndex = prev.findIndex((tab) => tab.path === fromPath);
      const targetIndex = prev.findIndex((tab) => tab.path === toPath);
      if (sourceIndex === -1 || targetIndex === -1) return prev;

      const next = [...prev];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(sourceIndex < targetIndex ? targetIndex - 1 : targetIndex, 0, moved);
      return next;
    });
  }, [pinnedTabPaths]);

  const handleRevealActiveFile = useCallback(() => {
    if (!activeTabPath) return;
    revealPathInTree(activeTabPath);
  }, [activeTabPath, revealPathInTree]);

  const handleBreadcrumbClick = useCallback((path: string, isFile: boolean) => {
    if (isFile) {
      void handleOpenFile(path, undefined, "breadcrumb-click");
      return;
    }
    revealPathInTree(path);
  }, [handleOpenFile, revealPathInTree]);

  const openTabSwitcherSelection = useCallback((index: number) => {
    const nextTab = filteredOpenTabs[index];
    if (!nextTab) return;
    handleSwitchTab(nextTab.path);
    setTabSwitcherOpen(false);
    setTabSwitcherQuery("");
  }, [filteredOpenTabs, handleSwitchTab]);

  const finalizeCloseTab = useCallback(
    async (path: string) => {
      const tab = openTabs.find((t) => t.path === path);
      if (!tab) return;

      let removed = false;
      setOpenTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        if (idx === -1) {
          return prev;
        }

        const nextTabs = prev.filter((t) => t.path !== path);
        removed = true;
        const orderedNextTabs = [
          ...nextTabs.filter((tab) => pinnedTabPaths.has(tab.path)),
          ...nextTabs.filter((tab) => !pinnedTabPaths.has(tab.path)),
        ];
        const displayIndex = displayOpenTabs.findIndex((t) => t.path === path);
        const next =
          orderedNextTabs[Math.min(displayIndex, orderedNextTabs.length - 1)] ||
          orderedNextTabs[orderedNextTabs.length - 1] ||
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
      setPinnedTabPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      setClosedTabHistory((prev) => [path, ...prev.filter((item) => item !== path)].slice(0, 20));
      await refreshGitWorkingTreeState();
    },
    [displayOpenTabs, openTabs, pinnedTabPaths, projectRoot, refreshGitWorkingTreeState]
  );

  const handleCloseTab = useCallback((path: string) => {
    const tab = openTabs.find((t) => t.path === path);
    if (!tab) return;

    const currentContent =
      path === activeTabPath ? (getEditorContent() ?? tab.content) : tab.content;
    const hasUnsavedChanges = currentContent !== tab.originalContent;

    if (hasUnsavedChanges) {
      setCloseTabModal({ path, content: currentContent });
      return;
    }

    void finalizeCloseTab(path);
  }, [openTabs, activeTabPath, getEditorContent, finalizeCloseTab]);

  const closeTabsByPaths = useCallback(async (paths: string[]) => {
    const uniquePaths = [...new Set(paths)].filter(Boolean);
    if (uniquePaths.length === 0) return;

    const dirtyPaths = uniquePaths.filter((path) => hasUnsavedChangesForPath(path));
    if (dirtyPaths.length > 0) {
      const shouldClose = window.confirm(
        dirtyPaths.length === 1
          ? "This tab has unsaved changes. Close it anyway?"
          : `${dirtyPaths.length} tabs have unsaved changes. Close them anyway?`
      );
      if (!shouldClose) return;
    }

    const pathSet = new Set(uniquePaths);
    const remainingTabs = openTabs.filter((tab) => !pathSet.has(tab.path));
    const nextDisplayTabs = [
      ...remainingTabs.filter((tab) => pinnedTabPaths.has(tab.path)),
      ...remainingTabs.filter((tab) => !pinnedTabPaths.has(tab.path)),
    ];

    setOpenTabs(remainingTabs);
    setPinnedTabPaths((prev) => {
      const next = new Set(prev);
      for (const path of uniquePaths) {
        next.delete(path);
      }
      return next;
    });
    setClosedTabHistory((prev) => [
      ...uniquePaths,
      ...prev.filter((item) => !pathSet.has(item)),
    ].slice(0, 20));
    setActiveTabPath((current) => (
      pathSet.has(current) ? (nextDisplayTabs[0]?.path ?? "") : current
    ));
    setSelectedTreePath((current) => (
      pathSet.has(current) ? (nextDisplayTabs[0]?.path ?? projectRoot ?? "") : current
    ));
    await refreshGitWorkingTreeState();
  }, [hasUnsavedChangesForPath, openTabs, pinnedTabPaths, projectRoot, refreshGitWorkingTreeState]);

  const handleCloseOtherTabs = useCallback((path: string) => {
    const pathsToClose = displayOpenTabs
      .filter((tab) => tab.path !== path)
      .map((tab) => tab.path);
    void closeTabsByPaths(pathsToClose);
  }, [closeTabsByPaths, displayOpenTabs]);

  const handleCloseTabsToRight = useCallback((path: string) => {
    const tabIndex = displayOpenTabs.findIndex((tab) => tab.path === path);
    if (tabIndex === -1) return;
    const pathsToClose = displayOpenTabs.slice(tabIndex + 1).map((tab) => tab.path);
    void closeTabsByPaths(pathsToClose);
  }, [closeTabsByPaths, displayOpenTabs]);

  const handleCloseTabModalAction = useCallback(async (action: "save" | "discard" | "cancel") => {
    const modal = closeTabModal;
    if (!modal) return;

    if (action === "cancel") {
      setCloseTabModal(null);
      return;
    }

    if (action === "save") {
      setError(null);
      setSaveStatus("saving");
      try {
        await writeFile(modal.path, modal.content);
        setOpenTabs((prev) =>
          prev.map((tab) =>
            tab.path === modal.path
              ? { ...tab, content: modal.content, originalContent: modal.content, isDirty: false }
              : tab
          )
        );
        showTransientSaveStatus("saved");
      } catch (e) {
        setError(`Failed to save before closing: ${String(e)}`);
        showTransientSaveStatus("error");
        return;
      }
    }

    setCloseTabModal(null);
    await finalizeCloseTab(modal.path);
  }, [closeTabModal, finalizeCloseTab, showTransientSaveStatus]);

  const handleReopenClosedTab = useCallback(() => {
    const [nextPath] = closedTabHistory;
    if (!nextPath) return;
    setClosedTabHistory((prev) => prev.slice(1));
    void handleOpenFile(nextPath, undefined, "reopen-closed-tab");
  }, [closedTabHistory, handleOpenFile]);

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
          key: "Mod-d",
          run: (view) => duplicateCurrentLine(view),
        },
        {
          key: isMac ? "Mod-Backspace" : "Ctrl-y",
          run: (view) => deleteCurrentLine(view),
        },
        {
          key: "Mod-Shift-m",
          preventDefault: true,
          run: () => {
            if (!isMarkdownTab) return false;
            toggleActiveMarkdownPreview();
            return true;
          },
        },
        {
          key: "Mod-w",
          preventDefault: true,
          run: () => {
            if (activeTabPath) {
              handleCloseTab(activeTabPath);
              return true;
            }
            return false;
          },
        },
      ]),
    [activeTabPath, handleCloseTab, isMac, isMarkdownTab, toggleActiveMarkdownPreview]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isMarkdownTab) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        toggleActiveMarkdownPreview();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isMarkdownTab, toggleActiveMarkdownPreview]);

  const toggleFolder = useCallback(async (path: string) => {
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

  const handleOpenBranchSwitcher = useCallback(async () => {
    if (!projectRoot) return;

    try {
      setError(null);
      const [branchResult, branchesResult] = await Promise.allSettled([
        getCurrentBranch(projectRoot),
        getBranches(projectRoot),
      ]);

      if (branchResult.status === "fulfilled") {
        setCurrentBranch(branchResult.value);
      }

      if (branchesResult.status === "fulfilled") {
        setBranches(branchesResult.value);
      } else {
        setBranches([]);
      }

      setBranchSwitcherOpen(true);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot]);

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
      setSelectedDiffIsStaged(Boolean(options?.staged) && !options?.commit);
      setSelectedGitFilePath(filePath);
      setFileDiff(diff);
      setSelectedDiffHunkIndex(0);
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

  const handleOpenUpdateModal = useCallback(async () => {
    setUpdateModalOpen(true);
    setAvailableUpdate(null);
    setUpdateStatusMessage(null);
    setIsCheckingForUpdates(true);
    try {
      const update = await checkForUpdates();
      if (update) {
        setAvailableUpdate(update);
      } else {
        setUpdateStatusMessage("You’re already on the latest version.");
      }
    } catch (e) {
      setUpdateStatusMessage(String(e));
    } finally {
      setIsCheckingForUpdates(false);
    }
  }, []);

  const commandPaletteCommands = useMemo(() => {
    const commands: CommandPaletteCommand[] = [
      {
        id: "find-file",
        title: "Find File",
        subtitle: "Jump to any file in the current project",
        shortcut: shortcutLabel("N", { shift: true }),
        group: "Files",
        keywords: "open file jump finder",
        available: Boolean(tree),
        run: () => {
          if (!tree) return;
          setFinderOpen(true);
          setQuery("");
          window.setTimeout(() => inputRef.current?.focus(), 0);
        },
      },
      {
        id: "recent-files",
        title: "Recent Files",
        subtitle: "Reopen a recently visited file",
        shortcut: shortcutLabel("E"),
        group: "Files",
        keywords: "history recent files reopen",
        available: recentFilePaths.length > 0,
        run: () => {
          if (recentFilePaths.length === 0) return;
          setRecentOpen(true);
          setRecentSelectedIndex(0);
        },
      },
      {
        id: "recent-projects",
        title: "Recent Projects",
        subtitle: "Open a workspace from your recent project list",
        shortcut: shortcutLabel("O", { shift: true }),
        group: "Workspace",
        keywords: "workspace project history",
        available: recentProjects.length > 0,
        run: () => {
          setRecentProjectsOpen(true);
        },
      },
      {
        id: "search-project",
        title: "Search In Project",
        subtitle: "Search text across the current workspace",
        shortcut: shortcutLabel("F", { shift: true }),
        group: "Search",
        keywords: "global search grep replace",
        available: Boolean(projectRoot),
        run: () => {
          if (!projectRoot) return;
          setGlobalSearchOpen(true);
          window.setTimeout(() => globalInputRef.current?.focus(), 0);
        },
      },
      {
        id: "save-file",
        title: "Save File",
        subtitle: activeTab ? `Save ${toRelativePath(projectRoot, activeTab.path)}` : "Save the active editor tab",
        shortcut: shortcutLabel("S"),
        group: "Editor",
        keywords: "write persist current tab",
        available: Boolean(activeTab),
        run: () => {
          if (!activeTab) return;
          void handleSave();
        },
      },
      {
        id: "save-all",
        title: "Save All",
        subtitle: "Write all dirty tabs to disk",
        shortcut: shortcutLabel("S", { shift: true }),
        group: "Editor",
        keywords: "write persist all tabs",
        available: openTabs.length > 0,
        run: () => {
          void handleSaveAll();
        },
      },
      {
        id: "reveal-file",
        title: "Reveal Active File",
        subtitle: "Locate the active file in the project tree",
        shortcut: shortcutLabel("R", { alt: true }),
        group: "Files",
        keywords: "tree locate reveal current file",
        available: Boolean(activeTab && tree),
        run: () => {
          handleRevealActiveFile();
        },
      },
      {
        id: "reopen-closed-tab",
        title: "Reopen Closed Tab",
        subtitle: "Bring back the last closed editor tab",
        shortcut: shortcutLabel("T", { shift: true }),
        group: "Editor",
        keywords: "restore closed tab reopen",
        available: closedTabHistory.length > 0,
        run: () => {
          handleReopenClosedTab();
        },
      },
      {
        id: "git-history",
        title: "Open Git History",
        subtitle: "Review commit history for the current file or selection",
        group: "Git",
        keywords: "log commits history git",
        available: Boolean(projectRoot && isGitRepo),
        run: () => {
          void handleOpenGitHistory();
        },
      },
      {
        id: "switch-branch",
        title: "Switch Branch",
        subtitle: currentBranch ? `Current branch: ${currentBranch}` : "Choose another branch in this repository",
        group: "Git",
        keywords: "checkout branch switch git",
        available: Boolean(projectRoot && isGitRepo),
        run: () => {
          void handleOpenBranchSwitcher();
        },
      },
      {
        id: "toggle-autosave",
        title: autoSaveMode === "off" ? "Enable Auto Save" : "Disable Auto Save",
        subtitle: autoSaveMode === "off" ? "Save files automatically after a short delay" : "Return to explicit manual saves",
        group: "Editor",
        keywords: "autosave save delay",
        available: Boolean(projectRoot),
        run: () => {
          setAutoSaveMode((prev) => (prev === "off" ? "after_delay" : "off"));
        },
      },
      {
        id: "open-folder",
        title: "Open Folder",
        subtitle: "Switch to another project directory",
        shortcut: shortcutLabel("O"),
        group: "Workspace",
        keywords: "open folder workspace project",
        available: true,
        run: () => {
          void handleOpenFolder();
        },
      },
      {
        id: "open-folder-new-window",
        title: "Open Folder In New Window",
        subtitle: "Launch another project window",
        shortcut: shortcutLabel("O", { shift: true }),
        group: "Workspace",
        keywords: "new window open folder project",
        available: true,
        run: () => {
          void createProjectWindow();
        },
      },
      {
        id: "check-updates",
        title: "Check For Updates",
        subtitle: "Open the updater and check the latest release",
        group: "Workspace",
        keywords: "update upgrade release version",
        available: true,
        run: () => {
          void handleOpenUpdateModal();
        },
      },
    ];

    return commands.filter((command) => command.available);
  }, [
    activeTab,
    autoSaveMode,
    branches,
    currentBranch,
    handleOpenBranchSwitcher,
    closedTabHistory.length,
    createProjectWindow,
    handleOpenFolder,
    handleOpenGitHistory,
    handleOpenUpdateModal,
    handleRevealActiveFile,
    handleReopenClosedTab,
    handleSave,
    handleSaveAll,
    isGitRepo,
    openTabs.length,
    projectRoot,
    recentFilePaths.length,
    recentProjects.length,
    shortcutLabel,
    tree,
  ]);
  const filteredCommandPaletteCommands = useMemo(() => {
    const queryText = commandPaletteQuery.trim().toLowerCase();
    const recentRank = (id: string) => {
      const index = commandPaletteRecentIds.indexOf(id);
      return index === -1 ? 0 : commandPaletteRecentIds.length - index;
    };

    if (!queryText) {
      return [...commandPaletteCommands].sort((a, b) => {
        const recentDiff = recentRank(b.id) - recentRank(a.id);
        if (recentDiff !== 0) return recentDiff;
        return a.title.localeCompare(b.title);
      });
    }

    return commandPaletteCommands
      .map((command) => {
        const haystack = `${command.title} ${command.subtitle} ${command.group} ${command.keywords ?? ""}`.toLowerCase();
        const exactPrefix = command.title.toLowerCase().startsWith(queryText) ? 3 : 0;
        const includes = haystack.includes(queryText) ? 1 : -1;
        return {
          command,
          score: exactPrefix + includes + recentRank(command.id) * 0.1,
        };
      })
      .filter((item) => item.score >= 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.command.title.localeCompare(b.command.title);
      })
      .map((item) => item.command);
  }, [commandPaletteCommands, commandPaletteQuery, commandPaletteRecentIds]);
  const commandPaletteEntries = useMemo(() => {
    const queryText = commandPaletteQuery.trim();
    const entries: Array<
      | { type: "header"; id: string; label: string }
      | { type: "command"; id: string; command: CommandPaletteCommand; commandIndex: number }
    > = [];

    const pushGroup = (label: string, commands: CommandPaletteCommand[], startIndex: number) => {
      if (commands.length === 0) return startIndex;
      entries.push({ type: "header", id: `header:${label}`, label });
      for (let index = 0; index < commands.length; index += 1) {
        entries.push({
          type: "command",
          id: commands[index].id,
          command: commands[index],
          commandIndex: startIndex + index,
        });
      }
      return startIndex + commands.length;
    };

    if (!queryText) {
      const recentCommands = filteredCommandPaletteCommands
        .filter((command) => commandPaletteRecentIds.includes(command.id))
        .slice(0, 5);
      const recentIds = new Set(recentCommands.map((command) => command.id));
      let nextIndex = 0;
      nextIndex = pushGroup("Recent", recentCommands, nextIndex);

      const grouped = new Map<CommandPaletteGroup, CommandPaletteCommand[]>();
      for (const command of filteredCommandPaletteCommands) {
        if (recentIds.has(command.id)) continue;
        const items = grouped.get(command.group) ?? [];
        items.push(command);
        grouped.set(command.group, items);
      }

      for (const group of ["Files", "Search", "Editor", "Git", "Workspace", "View"] as CommandPaletteGroup[]) {
        nextIndex = pushGroup(group, grouped.get(group) ?? [], nextIndex);
      }

      return entries;
    }

    const grouped = new Map<CommandPaletteGroup, CommandPaletteCommand[]>();
    for (const command of filteredCommandPaletteCommands) {
      const items = grouped.get(command.group) ?? [];
      items.push(command);
      grouped.set(command.group, items);
    }

    let nextIndex = 0;
    for (const group of ["Files", "Search", "Editor", "Git", "Workspace", "View"] as CommandPaletteGroup[]) {
      nextIndex = pushGroup(group, grouped.get(group) ?? [], nextIndex);
    }
    return entries;
  }, [commandPaletteQuery, commandPaletteRecentIds, filteredCommandPaletteCommands]);

  const handleInstallUpdate = useCallback(async () => {
    setIsInstallingUpdate(true);
    setUpdateStatusMessage(null);
    try {
      const installedUpdate = await installUpdate();
      if (!installedUpdate) {
        setAvailableUpdate(null);
        setUpdateStatusMessage("You’re already on the latest version.");
        return;
      }
      setAvailableUpdate(installedUpdate);
      setUpdateStatusMessage(`Updated to ${installedUpdate.version}. Restarting…`);
      await relaunch();
    } catch (e) {
      setUpdateStatusMessage(String(e));
    } finally {
      setIsInstallingUpdate(false);
    }
  }, []);

  useEffect(() => {
    window.__FIKA_CHECK_FOR_UPDATES__ = () => {
      void handleOpenUpdateModal();
    };

    return () => {
      delete window.__FIKA_CHECK_FOR_UPDATES__;
    };
  }, [handleOpenUpdateModal]);

  const handleCloseDiffView = useCallback(() => {
    setSelectedDiffFile(null);
    setSelectedDiffIsStaged(false);
    setFileDiff(null);
    setSelectedDiffHunkIndex(0);
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

  const handleOpenChangedFile = useCallback(async (
    filePath: string,
    options?: { staged?: boolean; commit?: string | null; openDiff?: boolean; status?: string | null }
  ) => {
    if (!projectRoot) return;
    setSelectedGitFilePath(filePath);
    const shouldOpenEditor = options?.status !== "D";
    if (shouldOpenEditor) {
      const absolutePath = `${normalizeFilePath(projectRoot).replace(/\/$/, "")}/${normalizeFilePath(filePath)}`;
      await handleOpenFile(absolutePath, undefined, "git-change-open");
    }
    if (options?.openDiff) {
      await handleShowFileDiff(filePath, {
        staged: options?.staged,
        commit: options?.commit ?? undefined,
      });
    }
  }, [handleOpenFile, handleShowFileDiff, projectRoot]);

  const handleStepGitFileSelection = useCallback((direction: 1 | -1) => {
    const files = selectedCommit ? visibleLogFiles : visibleWorkingTreeFiles;
    if (files.length === 0) return;

    const currentIndex = files.findIndex((file) => file.path === selectedGitFilePath);
    const nextIndex = currentIndex === -1
      ? 0
      : (currentIndex + direction + files.length) % files.length;
    const nextFile = files[nextIndex];
    if (!nextFile) return;

    setSelectedGitFilePath(nextFile.path);
    if (selectedDiffFile) {
      const staged = !selectedCommit && "staged" in nextFile
        ? Boolean((nextFile as { staged?: boolean }).staged)
        : undefined;
      void handleShowFileDiff(nextFile.path, {
        staged,
        commit: selectedCommit ?? undefined,
      });
    }
  }, [handleShowFileDiff, selectedCommit, selectedDiffFile, selectedGitFilePath, visibleLogFiles, visibleWorkingTreeFiles]);

  const handleOpenSelectedGitEntry = useCallback(() => {
    if (!selectedGitFilePath) return;
    const currentFile = selectedCommit
      ? visibleLogFiles.find((file) => file.path === selectedGitFilePath)
      : visibleWorkingTreeFiles.find((file) => file.path === selectedGitFilePath);
    if (!currentFile) return;
    const staged = !selectedCommit && "staged" in currentFile
      ? Boolean((currentFile as { staged?: boolean }).staged)
      : undefined;

    void handleOpenChangedFile(selectedGitFilePath, {
      staged,
      commit: selectedCommit ?? undefined,
      openDiff: true,
      status: currentFile.status,
    });
  }, [handleOpenChangedFile, selectedCommit, selectedGitFilePath, visibleLogFiles, visibleWorkingTreeFiles]);

  const handleStepDiffHunk = useCallback((direction: 1 | -1) => {
    if (!fileDiff || fileDiff.hunks.length === 0) return;
    setSelectedDiffHunkIndex((current) => {
      const nextIndex = (current + direction + fileDiff.hunks.length) % fileDiff.hunks.length;
      return nextIndex;
    });
  }, [fileDiff]);

  const syncWorkingTreeDiffAfterMutation = useCallback(async (
    filePath: string,
    nextStaged: boolean,
    state: { changes: ChangedFile[]; staged: StagedFile[] }
  ) => {
    if (diffSourceTab !== "diff" || selectedDiffFile !== filePath) return;
    const stillExists = nextStaged
      ? state.staged.some((file) => file.path === filePath)
      : state.changes.some((file) => file.path === filePath);

    const existsInEitherSet =
      state.staged.some((file) => file.path === filePath) ||
      state.changes.some((file) => file.path === filePath);

    if (!existsInEitherSet || !stillExists) {
      setSelectedDiffFile(null);
      setSelectedDiffIsStaged(false);
      setFileDiff(null);
      setSelectedDiffHunkIndex(0);
      setBottomPanelTab("diff");
      return;
    }

    await handleShowFileDiff(filePath, { staged: nextStaged });
  }, [diffSourceTab, handleShowFileDiff, selectedDiffFile]);

  // Refresh git data when project changes or when switching to git tabs
  useEffect(() => {
    refreshGitData();
  }, [refreshGitData]);

  // Refresh git changes when switching to diff tab
  useEffect(() => {
    if (bottomPanelTab === "diff" && projectRoot && isGitRepo) {
      void refreshGitWorkingTreeState();
    }
  }, [bottomPanelTab, projectRoot, isGitRepo, refreshGitWorkingTreeState]);

  useEffect(() => {
    if (!projectRoot) return;

    const handleWindowFocus = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();

      if (now - lastExternalFileRefreshRef.current >= 1500) {
        lastExternalFileRefreshRef.current = now;
        void refreshOpenTabsFromDisk();
      }

      if (isGitRepo && now - lastGitFocusRefreshRef.current >= 2000) {
        lastGitFocusRefreshRef.current = now;
        void refreshGitWorkingTreeState();
      }
    };

    window.addEventListener("focus", handleWindowFocus);
    document.addEventListener("visibilitychange", handleWindowFocus);
    return () => {
      window.removeEventListener("focus", handleWindowFocus);
      document.removeEventListener("visibilitychange", handleWindowFocus);
    };
  }, [isGitRepo, projectRoot, refreshGitWorkingTreeState, refreshOpenTabsFromDisk]);

  useEffect(() => {
    diffHunkRefs.current = diffHunkRefs.current.slice(0, fileDiff?.hunks.length ?? 0);
    setSelectedDiffHunkIndex(0);
  }, [fileDiff]);

  useEffect(() => {
    if (!fileDiff || fileDiff.hunks.length === 0) return;
    const maxIndex = fileDiff.hunks.length - 1;
    const nextIndex = Math.max(0, Math.min(selectedDiffHunkIndex, maxIndex));
    if (nextIndex !== selectedDiffHunkIndex) {
      setSelectedDiffHunkIndex(nextIndex);
      return;
    }
    diffHunkRefs.current[nextIndex]?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [fileDiff, selectedDiffHunkIndex]);

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
    await runGitWorkingTreeMutation(
      () => stageFile(projectRoot, filePath),
      {
        onAfterRefresh: (state) => syncWorkingTreeDiffAfterMutation(filePath, true, state),
      }
    );
  }, [projectRoot, runGitWorkingTreeMutation, syncWorkingTreeDiffAfterMutation]);

  const handleUnstageFile = useCallback(async (filePath: string) => {
    if (!projectRoot) return;
    await runGitWorkingTreeMutation(
      () => unstageFile(projectRoot, filePath),
      {
        onAfterRefresh: (state) => syncWorkingTreeDiffAfterMutation(filePath, false, state),
      }
    );
  }, [projectRoot, runGitWorkingTreeMutation, syncWorkingTreeDiffAfterMutation]);

  const handleStageAll = useCallback(async () => {
    if (!projectRoot || gitChanges.length === 0) return;
    await runGitWorkingTreeMutation(async () => {
      await Promise.all(gitChanges.map((file) => stageFile(projectRoot, file.path)));
    });
  }, [gitChanges, projectRoot, runGitWorkingTreeMutation]);

  const handleUnstageAll = useCallback(async () => {
    if (!projectRoot || stagedFiles.length === 0) return;
    await runGitWorkingTreeMutation(async () => {
      await Promise.all(stagedFiles.map((file) => unstageFile(projectRoot, file.path)));
    });
  }, [projectRoot, runGitWorkingTreeMutation, stagedFiles]);

  const refreshTreeSubdirectory = useCallback(async (directoryPath: string) => {
    if (!projectRoot) return;

    const refreshedNode = await refreshTree(directoryPath);
    setTree((currentTree) => {
      if (!currentTree) {
        return refreshedNode;
      }
      if (currentTree.path === directoryPath) {
        return mergeLoadedTree(currentTree, refreshedNode);
      }
      const previousNode = findNodeByPath(currentTree, directoryPath);
      return replaceNodeByPath(currentTree, directoryPath, mergeLoadedTree(previousNode, refreshedNode));
    });
  }, [projectRoot]);

  useEffect(() => {
    if (!tree) return;
    const nextFolderToLoad = findFirstUnloadedOpenFolder(tree, openFolders);
    if (!nextFolderToLoad || loadingFolderPaths.has(nextFolderToLoad.path)) return;

    setLoadingFolderPaths((prev) => new Set(prev).add(nextFolderToLoad.path));

    void refreshTreeSubdirectory(nextFolderToLoad.path)
      .catch((e) => {
        setError(String(e));
      })
      .finally(() => {
        setLoadingFolderPaths((prev) => {
          const next = new Set(prev);
          next.delete(nextFolderToLoad.path);
          return next;
        });
      });
  }, [tree, openFolders, loadingFolderPaths, refreshTreeSubdirectory]);

  const performDiscardFileChanges = useCallback(async (filePath: string) => {
    if (!projectRoot) return;

    try {
      await discardFileChanges(projectRoot, filePath);

      const absolutePath = projectRoot
        ? `${normalizeFilePath(projectRoot).replace(/\/$/, "")}/${normalizeFilePath(filePath)}`
        : filePath;

      const existsAfterDiscard = (!projectFileIndexLoaded || projectFilePaths.includes(absolutePath)) || openTabs.some((tab) => tab.path === absolutePath);

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
        if (projectFileIndexLoaded) {
          setProjectFilePaths((prev) => prev.filter((path) => path !== absolutePath));
        }
      }

      const parentPath = getParentDirPath(absolutePath, projectRoot);
      await refreshTreeSubdirectory(parentPath);
      await refreshGitData();
      setSelectedDiffFile(null);
      setFileDiff(null);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, projectFileIndexLoaded, projectFilePaths, openTabs, activeTab, activeTabPath, refreshGitData, refreshTreeSubdirectory]);

  const handleDiscardFileChanges = useCallback((filePath: string) => {
    setDiscardFileModalPath(filePath);
  }, []);

  const handleCommit = useCallback(async () => {
    if (!projectRoot || !commitMessage.trim()) return;
    setIsCommitting(true);
    try {
      await commit(projectRoot, commitMessage.trim());
      setCommitMessage("");
      setSelectedDiffFile(null);
      setSelectedDiffIsStaged(false);
      setFileDiff(null);
      setSelectedDiffHunkIndex(0);
      await refreshGitData();
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
      if (projectFileIndexLoaded) {
        setProjectFilePaths((prev) => (prev.includes(fullPath) ? prev : [...prev, fullPath].sort()));
      }
      await refreshTreeSubdirectory(dirPath);
      // Open the new file
      await handleOpenFile(fullPath, undefined, "create-file");
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, projectFileIndexLoaded, handleOpenFile, refreshTreeSubdirectory]);

  const handleCreateDirectory = useCallback(async (dirPath: string, name: string) => {
    if (!projectRoot) return;
    const fullPath = `${dirPath}/${name}`;
    try {
      await createDirectory(projectRoot, fullPath);
      await refreshTreeSubdirectory(dirPath);
      // Auto-open the new folder
      setOpenFolders(prev => new Set([...prev, fullPath]));
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, refreshTreeSubdirectory]);

  const handleRename = useCallback(async (oldPath: string, newName: string) => {
    if (!projectRoot) return;
    const parentPath = getParentDirPath(oldPath, projectRoot);
    const newPath = `${parentPath}/${newName}`;
    try {
      await renamePath(projectRoot, oldPath, newPath);
      setOpenTabs(prev => prev.map(tab => (
        isSameOrDescendantPath(tab.path, oldPath)
          ? { ...tab, path: replacePathPrefix(tab.path, oldPath, newPath) }
          : tab
      )));
      {
        const nextViewState = new Map<string, EditorViewStateSnapshot>();
        for (const [path, state] of editorViewStateRef.current.entries()) {
          nextViewState.set(
            isSameOrDescendantPath(path, oldPath)
              ? replacePathPrefix(path, oldPath, newPath)
              : path,
            state
          );
        }
        editorViewStateRef.current = nextViewState;
      }
      setPinnedTabPaths(prev => {
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
      if (projectFileIndexLoaded) {
        setProjectFilePaths((prev) => prev.map((path) => (
          isSameOrDescendantPath(path, oldPath)
            ? replacePathPrefix(path, oldPath, newPath)
            : path
        )));
      }
      await refreshTreeSubdirectory(parentPath || projectRoot);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, projectFileIndexLoaded, isSameOrDescendantPath, replacePathPrefix, refreshTreeSubdirectory]);

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
      const nextDisplayTabs = [
        ...remainingTabs.filter((tab) => pinnedTabPaths.has(tab.path)),
        ...remainingTabs.filter((tab) => !pinnedTabPaths.has(tab.path)),
      ];
      {
        const nextViewState = new Map<string, EditorViewStateSnapshot>();
        for (const [tabPath, state] of editorViewStateRef.current.entries()) {
          if (!isSameOrDescendantPath(tabPath, path)) {
            nextViewState.set(tabPath, state);
          }
        }
        editorViewStateRef.current = nextViewState;
      }
      setOpenTabs(remainingTabs);
      setPinnedTabPaths(prev => {
        const next = new Set<string>();
        for (const item of prev) {
          if (!isSameOrDescendantPath(item, path)) next.add(item);
        }
        return next;
      });
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
        return nextDisplayTabs.length > 0 ? nextDisplayTabs[0].path : "";
      });
      if (projectFileIndexLoaded) {
        setProjectFilePaths((prev) => prev.filter((item) => !isSameOrDescendantPath(item, path)));
      }
      const parentPath = getParentDirPath(path, projectRoot);
      setTree((currentTree) => currentTree ? removeNodeByPath(currentTree, path) : currentTree);
      await refreshTreeSubdirectory(parentPath);
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, projectFileIndexLoaded, openTabs, navHistory, isSameOrDescendantPath, refreshTreeSubdirectory]);

  const handleRefreshTree = useCallback(async () => {
    if (!projectRoot) return;
    try {
      const newTree = await refreshTree(projectRoot);
      setTree(newTree);
      if (projectFileIndexLoaded) {
        void loadProjectFileIndex(true);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [projectRoot, projectFileIndexLoaded, loadProjectFileIndex]);

  // Load session on mount
  useEffect(() => {
    if (window.__FIKA_SESSION_RESTORED__) return;
    window.__FIKA_SESSION_RESTORED__ = true;

    const init = async () => {
      const pendingProjectKey = `fika:pending-project:${currentWindowLabel}`;
      const pendingProjectPath = localStorage.getItem(pendingProjectKey);
      if (pendingProjectPath) {
        localStorage.removeItem(pendingProjectKey);
        await handleOpenFolderWithSession(pendingProjectPath);
        return;
      }

      const session = await loadSession(currentWindowLabel).catch(() => null);
      if (session?.project_root) {
        try {
          preferredWorkspaceStateRef.current = session;
          await handleOpenFolderWithSession(session.project_root);
        } catch {
          // Session loading failed, start fresh
        }
      }
    };
    init();
  }, [currentWindowLabel, handleOpenFolderWithSession]);

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
    if (!finderOpen || !projectRoot || projectFileIndexLoaded || projectFileIndexLoading) return;
    void loadProjectFileIndex();
  }, [finderOpen, projectRoot, projectFileIndexLoaded, projectFileIndexLoading, loadProjectFileIndex]);

  useEffect(() => {
    if (!finderOpen) {
      setFinderPreview(null);
      return;
    }

    const selectedResult = filtered[selectedIndex];
    if (!selectedResult) {
      setFinderPreview(null);
      return;
    }

    if (isImagePath(selectedResult.path)) {
      setFinderPreview({
        path: selectedResult.path,
        content: "Image preview is not shown in finder.",
        loading: false,
        unsupported: true,
      });
      return;
    }

    const cachedPreview = finderPreviewCacheRef.current.get(selectedResult.path);
    if (cachedPreview) {
      setFinderPreview({
        path: selectedResult.path,
        content: cachedPreview.content,
        loading: false,
        unsupported: cachedPreview.unsupported,
      });
      return;
    }

    let cancelled = false;
    setFinderPreview({
      path: selectedResult.path,
      content: "",
      loading: true,
      unsupported: false,
    });

    void readFile(selectedResult.path)
      .then((content) => {
        if (cancelled) return;
        const preview = content.slice(0, 12000).split("\n").slice(0, 80).join("\n");
        finderPreviewCacheRef.current.set(selectedResult.path, {
          content: preview,
          unsupported: false,
        });
        setFinderPreview({
          path: selectedResult.path,
          content: preview,
          loading: false,
          unsupported: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        finderPreviewCacheRef.current.set(selectedResult.path, {
          content: "Preview unavailable for this file.",
          unsupported: true,
        });
        setFinderPreview({
          path: selectedResult.path,
          content: "Preview unavailable for this file.",
          loading: false,
          unsupported: true,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [finderOpen, filtered, selectedIndex]);

  useEffect(() => {
    setRecentSelectedIndex(0);
  }, [recentOpen]);

  useEffect(() => {
    if (!commandPaletteOpen) return;
    setCommandPaletteSelectedIndex(0);
    window.setTimeout(() => commandPaletteInputRef.current?.focus(), 0);
  }, [commandPaletteOpen]);

  useEffect(() => {
    setCommandPaletteSelectedIndex(0);
  }, [commandPaletteQuery]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("fika:command-palette-recent");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setCommandPaletteRecentIds(parsed.filter((item): item is string => typeof item === "string").slice(0, 12));
      }
    } catch {
      // Ignore malformed persisted history
    }
  }, []);

  useEffect(() => {
    if (!tabSwitcherOpen) return;
    const activeIndex = filteredOpenTabs.findIndex((tab) => tab.path === activeTabPath);
    setTabSwitcherSelectedIndex(activeIndex >= 0 ? activeIndex : 0);
    setTimeout(() => tabSwitcherInputRef.current?.focus(), 0);
  }, [tabSwitcherOpen, filteredOpenTabs, activeTabPath]);

  useEffect(() => {
    setTabSwitcherSelectedIndex(0);
  }, [tabSwitcherQuery]);

  useEffect(() => {
    setGlobalSelectedIndex(0);
  }, [globalSearchQuery]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("fika:global-search-history");
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setGlobalSearchHistory(parsed.filter((item): item is string => typeof item === "string").slice(0, 12));
      }
    } catch {
      // Ignore malformed persisted history
    }
  }, []);

  useEffect(() => {
    if (!globalSearchOpen) return;
    if (!projectRoot) return;
    if (!globalSearchQuery.trim()) {
      setGlobalSearchResults([]);
      setGlobalSearchLoading(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void handleGlobalSearch();
    }, 220);

    return () => window.clearTimeout(timeoutId);
  }, [
    globalSearchOpen,
    projectRoot,
    globalSearchQuery,
    globalSearchCaseSensitive,
    globalSearchWholeWord,
    globalSearchRegex,
    handleGlobalSearch,
  ]);

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
        pinned_tab_paths: Array.from(pinnedTabPaths),
        editor_view_states: Object.fromEntries(editorViewStateRef.current.entries()),
        auto_save_mode: autoSaveMode,
        active_tab_path: activeTabPath,
        open_folders: Array.from(openFolders),
        recent_file_paths: recentFilePaths,
        selected_tree_path: selectedTreePath,
        bottom_panel_tab: bottomPanelTab,
        is_bottom_panel_open: isBottomPanelOpen,
        bottom_panel_height: bottomPanelHeight,
      };
      saveSession(currentWindowLabel, state).catch(() => {});
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [
    currentWindowLabel,
    projectRoot,
    openTabs,
    pinnedTabPaths,
    autoSaveMode,
    activeTabPath,
    openFolders,
    recentFilePaths,
    selectedTreePath,
    bottomPanelTab,
    isBottomPanelOpen,
    bottomPanelHeight,
  ]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isCommandPalette =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "p";
      const isFindFile =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n";
      const isSaveAll =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s";
      const isSave =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "s";
      const isCloseTab =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "w";
      const isReopenClosedTab =
        (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "t";
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
      const isRevealActiveFile =
        (e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "r";
      const isTabSwitcher =
        e.ctrlKey && !e.metaKey && e.key === "Tab";
      const target = e.target as HTMLElement | null;
      const isTypingTarget = !!target && (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      );

      if (commandPaletteOpen) {
        switch (e.key) {
          case "Escape":
            e.preventDefault();
            setCommandPaletteOpen(false);
            return;
          case "ArrowDown":
            e.preventDefault();
            setCommandPaletteSelectedIndex((i) => Math.min(i + 1, filteredCommandPaletteCommands.length - 1));
            return;
          case "ArrowUp":
            e.preventDefault();
            setCommandPaletteSelectedIndex((i) => Math.max(i - 1, 0));
            return;
          case "Enter":
            e.preventDefault();
            if (filteredCommandPaletteCommands[commandPaletteSelectedIndex]) {
              const command = filteredCommandPaletteCommands[commandPaletteSelectedIndex];
              executeCommandPaletteCommand(command);
            }
            return;
        }
      }

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
            if (inFileReplaceOpen && document.activeElement === inFileReplaceInputRef.current) {
              e.preventDefault();
              handleReplaceCurrentMatch();
              return;
            }
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

      if (tabSwitcherOpen) {
        switch (e.key) {
          case "Escape":
            e.preventDefault();
            setTabSwitcherOpen(false);
            return;
          case "ArrowDown":
            e.preventDefault();
            if (filteredOpenTabs.length === 0) return;
            setTabSwitcherSelectedIndex((i) => Math.min(i + 1, filteredOpenTabs.length - 1));
            return;
          case "ArrowUp":
            e.preventDefault();
            if (filteredOpenTabs.length === 0) return;
            setTabSwitcherSelectedIndex((i) => Math.max(i - 1, 0));
            return;
          case "Enter":
            e.preventDefault();
            openTabSwitcherSelection(tabSwitcherSelectedIndex);
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
              openFinderResult(filtered[selectedIndex]);
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

      if (isReopenClosedTab) {
        e.preventDefault();
        handleReopenClosedTab();
        return;
      }

      if (isCommandPalette) {
        e.preventDefault();
        openCommandPalette();
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

      if (isTabSwitcher) {
        e.preventDefault();
        if (orderedOpenTabs.length <= 1) return;
        setTabSwitcherOpen(true);
        setTabSwitcherQuery("");
        setTabSwitcherSelectedIndex((current) => {
          if (orderedOpenTabs.length === 0) return 0;
          const delta = e.shiftKey ? -1 : 1;
          const nextIndex = current + delta;
          if (nextIndex < 0) return orderedOpenTabs.length - 1;
          if (nextIndex >= orderedOpenTabs.length) return 0;
          return nextIndex;
        });
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
        const selection = getEditorSelectionState();
        const selectedText = selection?.text?.trim() ?? "";
        setInFileSearchOpen(true);
        setInFileReplaceOpen(false);
        if (selectedText) {
          setInFileQuery(selectedText);
        }
        setCurrentMatchIndex(-1);
        setTimeout(() => {
          inFileInputRef.current?.focus();
          if (selectedText) {
            inFileInputRef.current?.select();
          }
        }, 0);
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

      if (isRevealActiveFile && !isTypingTarget) {
        e.preventDefault();
        handleRevealActiveFile();
        return;
      }

      if (isBottomPanelOpen && !isTypingTarget && isGitRepo) {
        const gitNavigationActive =
          bottomPanelTab === "diff" ||
          (bottomPanelTab === "log" && !!selectedCommit);

        if (gitNavigationActive) {
          if (selectedDiffFile && fileDiff && fileDiff.hunks.length > 0) {
            if (e.key === "[") {
              e.preventDefault();
              handleStepDiffHunk(-1);
              return;
            }
            if (e.key === "]") {
              e.preventDefault();
              handleStepDiffHunk(1);
              return;
            }
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            handleStepGitFileSelection(1);
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            handleStepGitFileSelection(-1);
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            handleOpenSelectedGitEntry();
            return;
          }
        }
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [
    finderOpen,
    commandPaletteOpen,
    commandPaletteQuery,
    commandPaletteSelectedIndex,
    filteredCommandPaletteCommands,
    executeCommandPaletteCommand,
    filtered,
    selectedIndex,
    recentOpen,
    recentFilePaths,
    recentSelectedIndex,
    tabSwitcherOpen,
    tabSwitcherQuery,
    tabSwitcherSelectedIndex,
    orderedOpenTabs,
    filteredOpenTabs,
    recentProjectsOpen,
    setRecentProjectsOpen,
    globalSearchOpen,
    globalSearchResults,
    globalSelectedIndex,
    inFileSearchOpen,
    inFileReplaceOpen,
    activeTab,
    projectRoot,
    tree,
    handleOpenFolder,
    handleSave,
    handleSaveAll,
    handleCloseTab,
    handleReopenClosedTab,
    openCommandPalette,
    handleOpenFile,
    openFinderResult,
    openTabSwitcherSelection,
    goToNextMatch,
    goToPrevMatch,
    handleReplaceCurrentMatch,
    getEditorSelectionState,
    goBack,
    goForward,
    selectedGitFilePath,
    isGitRepo,
    bottomPanelTab,
    isBottomPanelOpen,
    handleCompareSelectedGitFile,
    handleRevealActiveFile,
    handleShowBlameCommitDiff,
    handleCloseDiffView,
    handleStepGitFileSelection,
    handleOpenSelectedGitEntry,
    handleStepDiffHunk,
    selectedCommit,
    selectedDiffFile,
    fileDiff,
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
      {commandPaletteOpen && (
        <div className="finder-overlay" onClick={() => setCommandPaletteOpen(false)}>
          <div className="finder-modal command-palette-modal" onClick={(e) => e.stopPropagation()}>
            <input
              ref={commandPaletteInputRef}
              className="finder-input"
              placeholder={`Run a command... (${shortcutLabel("P", { shift: true })})`}
              value={commandPaletteQuery}
              onChange={(e) => setCommandPaletteQuery(e.target.value)}
            />
            <div className="finder-list">
              {filteredCommandPaletteCommands.length > 0 ? commandPaletteEntries.map((entry) => (
                entry.type === "header" ? (
                  <div key={entry.id} className="command-palette-section">
                    {entry.label}
                  </div>
                ) : (
                  <div
                    key={entry.id}
                    className={`finder-item command-palette-item ${entry.commandIndex === commandPaletteSelectedIndex ? "active" : ""}`}
                    onMouseEnter={() => setCommandPaletteSelectedIndex(entry.commandIndex)}
                    onClick={() => executeCommandPaletteCommand(entry.command)}
                  >
                    <span className="finder-item-content">
                      <span className="finder-item-title-row">
                        <span className="finder-item-title">{entry.command.title}</span>
                        <span className="command-palette-group">{entry.command.group}</span>
                      </span>
                      <span className="finder-item-subtitle">{entry.command.subtitle}</span>
                    </span>
                    {entry.command.shortcut && (
                      <span className="command-palette-shortcut">{entry.command.shortcut}</span>
                    )}
                  </div>
                )
              )) : (
                <div className="finder-empty">No commands match this search.</div>
              )}
            </div>
            <div className="finder-hint">
              <span>↑↓</span> navigate <span>↵</span> run <span>esc</span> close
            </div>
          </div>
        </div>
      )}

      {finderOpen && (
        <div className="finder-overlay" onClick={() => setFinderOpen(false)}>
          <div className="finder-modal finder-modal-preview" onClick={(e) => e.stopPropagation()}>
            <div className="finder-pane finder-pane-list">
              <input
                ref={inputRef}
                className="finder-input"
                placeholder={`Find file (${shortcutLabel("N", { shift: true })})`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="finder-list">
                {projectFileIndexLoading && (
                  <div className="finder-empty">Indexing project files...</div>
                )}
                {!projectFileIndexLoading && filtered.map((result, idx) => (
                  (() => {
                    const fileName = result.relativePath.split(/[\/\\]/).pop() || result.relativePath;
                    const directoryPath = result.relativePath.includes("/")
                      ? result.relativePath.slice(0, result.relativePath.lastIndexOf("/"))
                      : "";
                    const suffix = `${result.lineNumber ? `:${result.lineNumber}` : ""}${result.columnNumber ? `:${result.columnNumber}` : ""}`;
                    return (
                  <div
                    key={`${result.path}:${result.lineNumber ?? 0}:${result.columnNumber ?? 0}`}
                    className={`finder-item ${idx === selectedIndex ? "active" : ""}`}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={() => {
                      openFinderResult(result);
                      setFinderOpen(false);
                    }}
                  >
                    <span className="finder-icon finder-icon-file" />
                    <span className="finder-item-content">
                      <span className="finder-item-title">
                        {fileName}
                        {suffix}
                      </span>
                      <span className="finder-item-subtitle">
                        {directoryPath || "."}
                      </span>
                    </span>
                  </div>
                    );
                  })()
                ))}
                {!projectFileIndexLoading && filtered.length === 0 && (
                  <div className="finder-empty">No files found</div>
                )}
              </div>
            </div>
            <div className="finder-preview">
              <div className="finder-preview-header">
                {finderPreview?.path ? toRelativePath(projectRoot, finderPreview.path) : "Preview"}
              </div>
              <div className={`finder-preview-body ${finderPreview?.unsupported ? "is-muted" : ""}`}>
                {finderPreview?.loading ? "Loading preview..." : (finderPreview?.content || "Select a file to preview.")}
              </div>
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
                (() => {
                  const relativePath = toRelativePath(projectRoot, p);
                  const fileName = relativePath.split(/[\/\\]/).pop() || relativePath;
                  const directoryPath = relativePath.includes("/")
                    ? relativePath.slice(0, relativePath.lastIndexOf("/"))
                    : "";
                  return (
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
                  <span className="finder-item-content">
                    <span className="finder-item-title">{fileName}</span>
                    <span className="finder-item-subtitle">{directoryPath || "."}</span>
                  </span>
                </div>
                  );
                })()
              ))}
            </div>
            <div className="finder-hint">
              <span>↑↓</span> navigate <span>↵</span> open <span>esc</span> close
            </div>
          </div>
        </div>
      )}

      {tabSwitcherOpen && (
        <div className="finder-overlay" onClick={() => setTabSwitcherOpen(false)}>
          <div className="finder-modal" onClick={(e) => e.stopPropagation()}>
            <input
              ref={tabSwitcherInputRef}
              className="finder-input"
              placeholder={`Search open tabs (${tabSwitcherShortcutLabel})`}
              value={tabSwitcherQuery}
              onChange={(e) => setTabSwitcherQuery(e.target.value)}
            />
            <div className="finder-list">
              {filteredOpenTabs.length > 0 ? filteredOpenTabs.map((tab, idx) => {
                const relativePath = toRelativePath(projectRoot, tab.path);
                const fileName = relativePath.split(/[\/\\]/).pop() || relativePath;
                const directoryPath = relativePath.includes("/")
                  ? relativePath.slice(0, relativePath.lastIndexOf("/"))
                  : "";
                return (
                  <div
                    key={tab.path}
                    className={`finder-item ${idx === tabSwitcherSelectedIndex ? "active" : ""}`}
                    onMouseEnter={() => setTabSwitcherSelectedIndex(idx)}
                    onClick={() => openTabSwitcherSelection(idx)}
                  >
                    <span className="finder-icon finder-icon-file" />
                    <span className="finder-item-content">
                      <span className="finder-item-title">
                        {fileName}
                        {tab.isDirty ? " ●" : ""}
                      </span>
                      <span className="finder-item-subtitle">{directoryPath || "."}</span>
                    </span>
                  </div>
                );
              }) : (
                <div className="finder-empty">No open tabs match this search.</div>
              )}
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
          <div className="infile-search-row">
            <input
              ref={inFileInputRef}
              className="infile-search-input"
              placeholder="Find in file..."
              value={inFileQuery}
              onChange={(e) => setInFileQuery(e.target.value)}
            />
            <span className="infile-search-count">
              {inFileSearchError
                ? "Regex error"
                : inFileMatches.length > 0
                ? `${(currentMatchIndex === -1 ? 0 : currentMatchIndex) + 1} of ${inFileMatches.length}`
                : inFileQuery ? "0 of 0" : ""}
            </span>
            <button
              className={`infile-search-btn infile-search-toggle ${inFileCaseSensitive ? "active" : ""}`}
              onClick={() => setInFileCaseSensitive((prev) => !prev)}
              title="Match case"
            >
              Aa
            </button>
            <button
              className={`infile-search-btn infile-search-toggle ${inFileWholeWord ? "active" : ""}`}
              onClick={() => setInFileWholeWord((prev) => !prev)}
              title="Whole word"
              disabled={inFileRegex}
            >
              W
            </button>
            <button
              className={`infile-search-btn infile-search-toggle ${inFileRegex ? "active" : ""}`}
              onClick={() => setInFileRegex((prev) => !prev)}
              title="Regex"
            >
              .*
            </button>
            <button
              className={`infile-search-btn ${inFileReplaceOpen ? "active" : ""}`}
              onClick={() => {
                setInFileReplaceOpen((prev) => !prev);
                setTimeout(() => {
                  if (!inFileReplaceOpen) {
                    inFileReplaceInputRef.current?.focus();
                  } else {
                    inFileInputRef.current?.focus();
                  }
                }, 0);
              }}
              title="Toggle replace"
            >
              Replace
            </button>
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
          {inFileReplaceOpen && (
            <div className="infile-search-row">
              <input
                ref={inFileReplaceInputRef}
                className="infile-search-input infile-replace-input"
                placeholder="Replace with..."
                value={inFileReplaceValue}
                onChange={(e) => setInFileReplaceValue(e.target.value)}
              />
              <button
                className="infile-search-btn"
                onClick={handleReplaceCurrentMatch}
                disabled={inFileMatches.length === 0}
                title="Replace current match"
              >
                Replace
              </button>
              <button
                className="infile-search-btn"
                onClick={handleReplaceAllMatches}
                disabled={inFileMatches.length === 0}
                title="Replace all matches"
              >
                All
              </button>
            </div>
          )}
          {inFileSearchError && (
            <div className="infile-search-error">{inFileSearchError}</div>
          )}
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
                className={`search-btn search-toggle-btn ${globalSearchCaseSensitive ? "active" : ""}`}
                onClick={() => setGlobalSearchCaseSensitive((prev) => !prev)}
                title="Match case"
              >
                Aa
              </button>
              <button
                className={`search-btn search-toggle-btn ${globalSearchWholeWord ? "active" : ""}`}
                onClick={() => setGlobalSearchWholeWord((prev) => !prev)}
                title="Whole word"
                disabled={globalSearchRegex}
              >
                W
              </button>
              <button
                className={`search-btn search-toggle-btn ${globalSearchRegex ? "active" : ""}`}
                onClick={() => setGlobalSearchRegex((prev) => !prev)}
                title="Regex"
              >
                .*
              </button>
              <button
                className={`search-btn ${globalSearchReplaceOpen ? "active" : ""}`}
                onClick={() => {
                  setGlobalSearchReplaceOpen((prev) => !prev);
                  setTimeout(() => {
                    if (!globalSearchReplaceOpen) {
                      globalReplaceInputRef.current?.focus();
                    } else {
                      globalInputRef.current?.focus();
                    }
                  }, 0);
                }}
                title="Toggle replace across project"
              >
                Replace
              </button>
              <button
                className="search-btn"
                onClick={handleGlobalSearch}
                disabled={globalSearchLoading || !globalSearchQuery.trim()}
              >
                {globalSearchLoading ? "Searching..." : "Refresh"}
              </button>
            </div>
            {globalSearchReplaceOpen && (
              <div className="finder-actions global-search-replace-row">
                <input
                  ref={globalReplaceInputRef}
                  className="finder-input global-search-replace-input"
                  placeholder="Replace across project..."
                  value={globalSearchReplaceValue}
                  onChange={(e) => setGlobalSearchReplaceValue(e.target.value)}
                />
                <button
                  className="search-btn"
                  onClick={() => void handleReplaceAcrossProject()}
                  disabled={globalSearchLoading || !globalSearchQuery.trim() || globalSearchResults.length === 0}
                >
                  Replace All
                </button>
              </div>
            )}
            <div className="finder-list search-results">
              {!globalSearchQuery.trim() && globalSearchHistory.length > 0 ? (
                <div className="search-history-list">
                  {globalSearchHistory.map((item) => (
                    <button
                      key={item}
                      className="search-history-item"
                      onClick={() => {
                        setGlobalSearchQuery(item);
                        setTimeout(() => globalInputRef.current?.focus(), 0);
                      }}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              ) : groupedGlobalSearchResults.length > 0 ? (
                groupedGlobalSearchResults.map((group) => (
                  <div key={group.path} className="search-result-group">
                    <div className="search-result-group-header">
                      <span className="search-result-group-path">{toRelativePath(projectRoot, group.path)}</span>
                      <span className="search-result-group-count">{group.results.length}</span>
                    </div>
                    {group.results.map((result) => {
                      const idx = globalSearchResults.findIndex(
                        (item) => item.path === result.path && item.line_number === result.line_number && item.line_content === result.line_content
                      );
                      return (
                        <div
                          key={`${result.path}:${result.line_number}:${result.line_content}`}
                          className={`search-result-item ${idx === globalSelectedIndex ? "active" : ""}`}
                          onMouseEnter={() => setGlobalSelectedIndex(idx)}
                          onClick={() => {
                            handleOpenFile(result.path, result.line_number, "global-search-click");
                            setGlobalSearchOpen(false);
                          }}
                        >
                          <div className="search-result-meta">
                            <div className="search-result-line-badge">
                              Line {result.line_number}
                            </div>
                          </div>
                          <div className="search-result-content">
                            {(() => {
                              const snippet = buildSearchSnippet(result.line_content, result.matched_fragment);
                              return (
                                <>
                                  <span>{snippet.before}</span>
                                  <span className="search-result-match">{snippet.match}</span>
                                  <span>{snippet.after}</span>
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      );
                    })}
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

      {closeTabModal && (
        <div className="finder-overlay" onClick={() => void handleCloseTabModalAction("cancel")}>
          <div className="finder-modal discard-modal" onClick={(e) => e.stopPropagation()}>
            <div className="finder-header">Close Tab</div>
            <div className="discard-modal-body">
              <div className="discard-modal-title">You have unsaved changes in this tab.</div>
              <div className="discard-modal-path">{closeTabModal.path}</div>
              <div className="discard-modal-note">
                Choose whether to save changes before closing.
              </div>
            </div>
            <div className="discard-modal-actions">
              <button className="search-btn" onClick={() => void handleCloseTabModalAction("cancel")}>
                Cancel
              </button>
              <button className="search-btn" onClick={() => void handleCloseTabModalAction("discard")}>
                Discard
              </button>
              <button className="search-btn discard-btn" onClick={() => void handleCloseTabModalAction("save")}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {updateModalOpen && (
        <div className="finder-overlay" onClick={() => !isInstallingUpdate && setUpdateModalOpen(false)}>
          <div className="finder-modal update-modal" onClick={(e) => e.stopPropagation()}>
            <div className="finder-header">Check for Updates</div>
            <div className="discard-modal-body">
              {isCheckingForUpdates ? (
                <>
                  <div className="discard-modal-title">Checking for updates…</div>
                  <div className="discard-modal-note">Fika is looking for a newer release.</div>
                </>
              ) : availableUpdate ? (
                <>
                  <div className="discard-modal-title">Version {availableUpdate.version} is available</div>
                  <div className="update-meta-row">
                    <span>Current {availableUpdate.current_version}</span>
                    {availableUpdate.date ? <span>Published {availableUpdate.date}</span> : null}
                  </div>
                  {availableUpdate.body ? (
                    <pre className="update-release-notes">{availableUpdate.body}</pre>
                  ) : (
                    <div className="discard-modal-note">No release notes were provided for this version.</div>
                  )}
                </>
              ) : (
                <>
                  <div className="discard-modal-title">No update available</div>
                  <div className="discard-modal-note">
                    {updateStatusMessage ?? "You’re already on the latest version."}
                  </div>
                </>
              )}
              {updateStatusMessage && availableUpdate && (
                <div className="discard-modal-note update-status-note">{updateStatusMessage}</div>
              )}
            </div>
            <div className="finder-actions">
              <button
                className="search-btn"
                onClick={() => setUpdateModalOpen(false)}
                disabled={isInstallingUpdate}
              >
                Close
              </button>
              {availableUpdate && (
                <button
                  className="search-btn"
                  onClick={() => void handleInstallUpdate()}
                  disabled={isInstallingUpdate}
                >
                  {isInstallingUpdate ? "Installing…" : `Install ${availableUpdate.version}`}
                </button>
              )}
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
                onClick={() => void handleOpenBranchSwitcher()}
                title="Switch branch"
              >
                <span className="branch-icon">⎇</span>
                <span className="branch-name">{currentBranch}</span>
              </button>
            )}
          </div>
        </div>
        <div className="spacer" />
        <div className="titlebar-actions">
          <button
            className="titlebar-action"
            onClick={() => setAutoSaveMode((prev) => (prev === "off" ? "after_delay" : "off"))}
            title={autoSaveMode === "off" ? "Enable auto save after delay" : "Disable auto save"}
          >
            <span className="titlebar-action-icon">◌</span>
            <span>{autoSaveMode === "off" ? "Auto Save Off" : "Auto Save Delay"}</span>
          </button>
          {isGitRepo && (
            <button
              className="titlebar-action"
              onClick={handleOpenGitHistory}
              title="Open Git tools"
            >
              <span className="titlebar-action-icon">◷</span>
              <span>Git</span>
            </button>
          )}
        </div>
      </header>

      <div className="main">
        <aside className="sidebar left">
          <div className="panel-header">
            <span>Project</span>
            <button
              className="icon-btn"
              title={`Reveal active file (${shortcutLabel("R", { alt: true })})`}
              onClick={handleRevealActiveFile}
              disabled={!activeTabPath}
              style={{ marginLeft: 'auto', fontSize: '12px' }}
            >
              ◎
            </button>
            <button
              className="icon-btn"
              title="Refresh"
              onClick={handleRefreshTree}
              style={{ fontSize: '12px' }}
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
                  loadingFolders={loadingFolderPaths}
                  toggleFolder={toggleFolder}
                  selectedPath={selectedTreePath || activeTabPath}
                  projectRoot={projectRoot}
                  gitStatusByPath={gitStatusByPath}
                  onSelectFile={handleOpenFile}
                  onSelectPath={(path) => {
                    setSelectedTreePath(path);
                  }}
                  onContextMenu={(path, isDir, e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setTabContextMenu(null);
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
              onPointerDown={(e) => e.stopPropagation()}
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
            <div className="breadcrumb-path">
              {activeTab && breadcrumbItems.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="breadcrumb-item"
                    onClick={() => projectRoot && revealPathInTree(projectRoot)}
                  >
                    {rootName ?? "Project"}
                  </button>
                  {breadcrumbItems.map((item, index) => (
                    <span key={item.path} className="breadcrumb-segment">
                      <span className="breadcrumb-separator">/</span>
                      <button
                        type="button"
                        className={`breadcrumb-item ${item.isFile ? "active" : ""}`}
                        onClick={() => handleBreadcrumbClick(item.path, item.isFile)}
                      >
                        {item.label}
                      </button>
                      {index === breadcrumbItems.length - 1 && activeTab.isLoading ? " (loading...)" : null}
                    </span>
                  ))}
                </>
              ) : (
                <span>{activeTab?.path || (rootName ? "Select a file" : "—")}</span>
              )}
            </div>
            {activeTab?.isDirty && (
              <span className="editor-status-badge dirty">Unsaved</span>
            )}
            {!activeTab?.isDirty && saveStatus === "saving" && (
              <span className="editor-status-badge saving">Saving…</span>
            )}
            {!activeTab?.isDirty && saveStatus === "saved" && (
              <span className="editor-status-badge saved">Saved</span>
            )}
            {!activeTab?.isDirty && saveStatus === "error" && (
              <span className="editor-status-badge error">Save Failed</span>
            )}
            {isMarkdownTab && !activeTab?.isLoading && (
              <div className="editor-mode-toggle">
                <button
                  type="button"
                  className={`editor-mode-button ${!isActiveMarkdownPreviewOpen ? "active" : ""}`}
                  onClick={() => setActiveMarkdownPreviewOpen(false)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className={`editor-mode-button ${isActiveMarkdownPreviewOpen ? "active" : ""}`}
                  onClick={() => setActiveMarkdownPreviewOpen(true)}
                >
                  Preview
                </button>
                <span className="editor-mode-hint">{shortcutLabel("M", { shift: true })}</span>
              </div>
            )}
          </div>
          {activeTab && isGitRepo && (() => {
            const relativePath = projectRoot ? toProjectRelativePath(activeTab.path) : null;
            const gitStatus = relativePath ? gitStatusByPath[relativePath] : null;
            if (!gitStatus) return null;
            return (
              <div className="editor-git-summary">
                <div className="editor-git-summary-main">
                  <span className={`file-status status-${gitStatus}`}>{gitStatus}</span>
                  <span className="editor-git-summary-label">
                    {activeEditorDiffSummary.additions} additions, {activeEditorDiffSummary.deletions} deletions
                  </span>
                </div>
                <div className="editor-git-summary-actions">
                  <button
                    className="action-btn"
                    onClick={() => {
                      if (!relativePath) return;
                      void handleShowFileDiff(relativePath, {
                        staged: stagedFiles.some((file) => file.path === relativePath) &&
                          !gitChanges.some((file) => file.path === relativePath),
                      });
                    }}
                  >
                    Open Diff
                  </button>
                  {bottomPanelTab === "diff" && gitStatus !== "?" && (
                    <button
                      className="action-btn"
                      onClick={() => {
                        if (!relativePath) return;
                        void handleDiscardFileChanges(relativePath);
                      }}
                    >
                      Revert
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
          <TabBar
            tabs={displayOpenTabs}
            activeTabPath={activeTabPath}
            pinnedPaths={pinnedTabPaths}
            onSwitchTab={handleSwitchTab}
            onCloseTab={handleCloseTab}
            onTogglePinTab={handleTogglePinTab}
            onReorderTab={handleReorderTabs}
            onTabContextMenu={(path, e) => {
              e.preventDefault();
              setContextMenu(null);
              setTabContextMenu({ x: e.clientX, y: e.clientY, path });
            }}
            closeTabTitle={`Close tab (${shortcutLabel("W")}) • Reopen with ${shortcutLabel("T", { shift: true })}`}
          />
          {tabContextMenu && (
            <div
              className="context-menu"
              style={{ left: tabContextMenu.x, top: tabContextMenu.y }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setTabContextMenu(null)}
            >
              <div
                className="context-menu-item"
                onClick={() => {
                  handleCloseOtherTabs(tabContextMenu.path);
                  setTabContextMenu(null);
                }}
              >
                Close Others
              </div>
              <div
                className="context-menu-item"
                onClick={() => {
                  handleCloseTabsToRight(tabContextMenu.path);
                  setTabContextMenu(null);
                }}
              >
                Close Tabs to Right
              </div>
            </div>
          )}
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
              ) : activeTab.loadError ? (
                <div className="code-placeholder">
                  <div className="empty-state-card">
                    <div className="empty-state-title">File cannot be opened in editor</div>
                    <div className="empty-state-subtitle">{activeTab.path}</div>
                    <div className="empty-state-subtitle" style={{ marginTop: 8 }}>
                      {activeTab.loadError}
                    </div>
                  </div>
                </div>
              ) : (
              isImageTab && activeImageSrc ? (
                <div className="image-preview">
                  <div className="image-preview-toolbar">
                    <div className="image-preview-actions">
                      <button
                        type="button"
                        className={`image-preview-btn ${imageFitMode === "fit" ? "active" : ""}`}
                        onClick={() => {
                          setImageFitMode("fit");
                          setImageZoom(100);
                        }}
                      >
                        Fit
                      </button>
                      <button
                        type="button"
                        className={`image-preview-btn ${imageFitMode === "actual" ? "active" : ""}`}
                        onClick={() => setImageFitMode("actual")}
                      >
                        Actual
                      </button>
                      <button
                        type="button"
                        className="image-preview-btn"
                        onClick={() => setImageZoom((prev) => Math.max(25, prev - 25))}
                      >
                        −
                      </button>
                      <span className="image-preview-zoom">{imageZoom}%</span>
                      <button
                        type="button"
                        className="image-preview-btn"
                        onClick={() => setImageZoom((prev) => Math.min(400, prev + 25))}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        className="image-preview-btn"
                        onClick={() => {
                          setImageFitMode("fit");
                          setImageZoom(100);
                        }}
                      >
                        Reset
                      </button>
                    </div>
                    <div className="image-preview-meta">
                      {imageNaturalSize ? `${imageNaturalSize.width} × ${imageNaturalSize.height}` : "Loading image…"}
                    </div>
                  </div>
                  {imagePreviewError ? (
                    <div className="image-preview-error">
                      <div className="empty-state-card">
                        <div className="empty-state-title">Image preview failed</div>
                        <div className="empty-state-subtitle">{imagePreviewError}</div>
                      </div>
                    </div>
                  ) : (
                    <div className={`image-preview-stage ${imageFitMode === "actual" ? "actual" : "fit"}`}>
                      <img
                        className="image-preview-content"
                        src={activeImageSrc}
                        alt={activeTab.path}
                        style={{ transform: `scale(${imageZoom / 100})` }}
                        onLoad={(event) => {
                          setImageNaturalSize({
                            width: event.currentTarget.naturalWidth,
                            height: event.currentTarget.naturalHeight,
                          });
                        }}
                        onError={() => setImagePreviewError(activeTab.path)}
                      />
                    </div>
                  )}
                </div>
              ) : isActiveMarkdownPreviewOpen && isMarkdownTab ? (
                (() => {
                  const outlineHeadings = renderedMarkdownHeadings.length > 0 ? renderedMarkdownHeadings : markdownHeadings;
                  const renderedHeadingCounts = new Map<string, number>();
                  const renderHeading = (level: number, children: ReactNode) => {
                    const text = extractTextFromReactNode(children).trim();
                    const baseSlug = slugifyHeading(text) || `section-${renderedHeadingCounts.size + 1}`;
                    const seen = renderedHeadingCounts.get(baseSlug) ?? 0;
                    renderedHeadingCounts.set(baseSlug, seen + 1);
                    const id = seen === 0 ? baseSlug : `${baseSlug}-${seen + 1}`;
                    const className = `md-heading md-heading-${level}`;

                    switch (level) {
                      case 1:
                        return <h1 id={id} className={className}>{children}</h1>;
                      case 2:
                        return <h2 id={id} className={className}>{children}</h2>;
                      case 3:
                        return <h3 id={id} className={className}>{children}</h3>;
                      case 4:
                        return <h4 id={id} className={className}>{children}</h4>;
                      case 5:
                        return <h5 id={id} className={className}>{children}</h5>;
                      default:
                        return <h6 id={id} className={className}>{children}</h6>;
                    }
                  };
                  return (
                    <div className="markdown-preview">
                      <div className="markdown-preview-toolbar">
                        <div className="markdown-preview-meta">
                          Previewing {toRelativePath(projectRoot, activeTab.path)}
                        </div>
                        <div className="markdown-preview-meta">
                          {outlineHeadings.length} section{outlineHeadings.length === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div className={`markdown-preview-layout ${outlineHeadings.length > 0 ? "has-outline" : ""}`}>
                        {outlineHeadings.length > 0 && (
                          <aside className="markdown-outline">
                            <div className="markdown-outline-title">Outline</div>
                            <div className="markdown-outline-list">
                              {outlineHeadings.map((heading) => (
                                <button
                                  key={heading.id}
                                  type="button"
                                  className={`markdown-outline-item level-${heading.level}`}
                                  onClick={() => scrollMarkdownHeadingIntoView(heading.id)}
                                >
                                  {heading.text}
                                </button>
                              ))}
                            </div>
                          </aside>
                        )}
                        <div ref={markdownPreviewScrollRef} className="markdown-preview-inner">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              h1: ({ children }) => renderHeading(1, children),
                              h2: ({ children }) => renderHeading(2, children),
                              h3: ({ children }) => renderHeading(3, children),
                              h4: ({ children }) => renderHeading(4, children),
                              h5: ({ children }) => renderHeading(5, children),
                              h6: ({ children }) => renderHeading(6, children),
                              p: ({ children }) => <p className="md-paragraph">{children}</p>,
                              ul: ({ children }) => <ul className="md-list">{children}</ul>,
                              ol: ({ children }) => <ol className="md-list">{children}</ol>,
                              blockquote: ({ children }) => <blockquote className="md-quote">{children}</blockquote>,
                              a: ({ children, href }) => {
                                const { path: hrefPath, hash } = href ? splitMarkdownHref(href) : { path: "", hash: "" };
                                const resolvedPath = hrefPath && activeTab?.path
                                  ? resolveMarkdownResourcePath(activeTab.path, hrefPath, projectRoot)
                                  : null;
                                const isLocalAnchor = !hrefPath && !!hash;
                                if (isLocalAnchor || resolvedPath) {
                                  return (
                                    <button
                                      type="button"
                                      className="md-link md-link-button"
                                      onClick={() => {
                                        if (!href) return;
                                        void handleMarkdownPreviewLink(href);
                                      }}
                                    >
                                      {children}
                                    </button>
                                  );
                                }
                                return (
                                  <a className="md-link" href={href} target="_blank" rel="noreferrer">
                                    {children}
                                  </a>
                                );
                              },
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
                              img: ({ src, alt }) => {
                                if (!activeTab?.path) return null;
                                return (
                                  <MarkdownImage
                                    src={src}
                                    alt={alt}
                                    baseFilePath={activeTab.path}
                                    projectRoot={projectRoot}
                                  />
                                );
                              },
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
                            {markdownPreviewContent}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  );
                })()
              ) : (
                <CodeMirror
                  key={activeTab.path}
                  ref={editorRef}
                  value={activeTab.content}
                  height="100%"
                  theme={dracula}
                  extensions={[
                    editorKeybindings,
                    ...langFromPath(activeTab.path),
                    ...modifiedLineExtensions,
                    ...searchHighlightExtensions,
                  ]}
                  editable
                  onUpdate={(update) => {
                    if (!update.view.hasFocus && !update.docChanged && !update.selectionSet && !update.viewportChanged) {
                      return;
                    }
                    editorViewStateRef.current.set(activeTab.path, {
                      selection_anchor: update.state.selection.main.head,
                      scroll_top: update.view.scrollDOM.scrollTop,
                    });
                  }}
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
                    <div className="diff-nav-actions">
                      <button
                        className="back-btn"
                        onClick={() => handleStepGitFileSelection(-1)}
                      >
                        ↑ Prev
                      </button>
                      <button
                        className="back-btn"
                        onClick={() => handleStepGitFileSelection(1)}
                      >
                        ↓ Next
                      </button>
                      {fileDiff.hunks.length > 0 && (
                        <>
                          <button
                            className="back-btn"
                            onClick={() => handleStepDiffHunk(-1)}
                          >
                            [ Prev Hunk
                          </button>
                          <button
                            className="back-btn"
                            onClick={() => handleStepDiffHunk(1)}
                          >
                            ] Next Hunk
                          </button>
                          <span className="diff-hunk-position">
                            Hunk {selectedDiffHunkIndex + 1}/{fileDiff.hunks.length}
                          </span>
                        </>
                      )}
                    </div>
                    <span className="diff-file-path">{fileDiff.path}</span>
                    <span className={`diff-source-badge ${diffSourceTab === "log" ? "history" : selectedDiffIsStaged ? "staged" : "working"}`}>
                      {diffSourceTab === "log" ? "Commit Diff" : selectedDiffIsStaged ? "Staged Diff" : "Working Tree Diff"}
                    </span>
                    <div className="diff-header-actions">
                      {canOpenSelectedDiffInEditor && (
                        <button
                          className="action-btn"
                          onClick={() => void handleOpenChangedFile(fileDiff.path, {
                            staged: diffSourceTab === "diff" ? selectedDiffIsStaged : undefined,
                            commit: selectedCommit ?? undefined,
                            status: selectedDiffStatus,
                          })}
                        >
                          Open File
                        </button>
                      )}
                      {diffSourceTab === "diff" && selectedDiffIsStaged && (
                        <button
                          className="action-btn"
                          onClick={() => void handleUnstageFile(fileDiff.path)}
                        >
                          Unstage File
                        </button>
                      )}
                      {diffSourceTab === "diff" && !selectedDiffIsStaged && (
                        <button
                          className="action-btn"
                          onClick={() => void handleStageFile(fileDiff.path)}
                        >
                          Stage File
                        </button>
                      )}
                      {canRevertSelectedDiffFile && (
                        <button
                          className="action-btn"
                          onClick={() => void handleDiscardFileChanges(fileDiff.path)}
                        >
                          Revert File
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="diff-content">
                    {fileDiff.hunks.length === 0 ? (
                      <div className="diff-hunk">
                        <div className="diff-line ctx">No diff available</div>
                      </div>
                    ) : (
                      fileDiff.hunks.map((hunk, idx) => (
                        <div
                          key={idx}
                          ref={(element) => {
                            diffHunkRefs.current[idx] = element;
                          }}
                          className={`diff-hunk ${idx === selectedDiffHunkIndex ? "active" : ""}`}
                        >
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
                  <div className="git-toolbar">
                    <input
                      className="git-filter-input"
                      placeholder="Filter changed files..."
                      value={gitFileFilterQuery}
                      onChange={(e) => setGitFileFilterQuery(e.target.value)}
                    />
                    <div className="git-toolbar-actions">
                      {["all", "M", "A", "D", "R", "U", "?"].map((status) => (
                        <button
                          key={status}
                          className={`git-filter-chip ${gitStatusFilter === status ? "active" : ""}`}
                          onClick={() => setGitStatusFilter(status)}
                        >
                          {status === "all" ? "All" : status}
                        </button>
                      ))}
                      <button
                        className={`git-filter-chip ${gitSortMode === "status" ? "active" : ""}`}
                        onClick={() => setGitSortMode((prev) => (prev === "status" ? "path" : "status"))}
                      >
                        Sort: {gitSortMode === "status" ? "Status" : "Path"}
                      </button>
                    </div>
                    <div className="git-toolbar-hint">↑↓ select, Enter open diff</div>
                  </div>
                  {/* Staged Files Section */}
                  <div className="changes-section">
                    <div className="changes-section-header">
                      <span>Staged Changes ({filteredStagedFiles.length}/{stagedFiles.length})</span>
                      {stagedFiles.length > 0 && (
                        <button
                          className="action-btn"
                          onClick={() => void handleUnstageAll()}
                        >
                          Unstage All
                        </button>
                      )}
                    </div>
                    {filteredStagedFiles.length === 0 ? (
                      <div className="changes-empty">{stagedFiles.length === 0 ? "No staged changes" : "No staged files match the current filter"}</div>
                    ) : (
                      <div className="changed-files-list">
                        {hiddenStagedFilesCount > 0 && (
                          <div className="list-overflow-note">
                            Showing first {renderedStagedFiles.length} staged files. Refine the filter to see the remaining {hiddenStagedFilesCount}.
                          </div>
                        )}
                        {renderedStagedFiles.map((file) => (
                          (() => {
                            const scopeLabel = getGitScopeLabel(file.path, stagedPathSet, unstagedPathSet);
                            const detailLabel = file.status === "R" ? "Renamed" : file.status === "D" ? "Deleted" : null;
                            const displayPath = file.old_path ? `${file.old_path} → ${file.path}` : file.path;
                            return (
                          <div
                            key={file.path}
                            className={`changed-file-item ${selectedGitFilePath === file.path ? "selected" : ""}`}
                            onClick={() => setSelectedGitFilePath(file.path)}
                            onDoubleClick={() => void handleOpenChangedFile(file.path, { staged: true, openDiff: true, status: file.status })}
                            title={displayPath}
                          >
                            <span className={`file-status status-${file.status}`}>{file.status}</span>
                            <span className="file-path">{displayPath}</span>
                            {detailLabel && <span className="file-meta-badge">{detailLabel}</span>}
                            {scopeLabel && <span className="file-scope-badge">{scopeLabel}</span>}
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
                            );
                          })()
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Unstaged Files Section */}
                  <div className="changes-section">
                    <div className="changes-section-header">
                      <span>Changes ({filteredGitChanges.length}/{gitChanges.length})</span>
                      {gitChanges.length > 0 && (
                        <button
                          className="action-btn"
                          onClick={() => void handleStageAll()}
                        >
                          Stage All
                        </button>
                      )}
                    </div>
                    {filteredGitChanges.length === 0 ? (
                      <div className="changes-empty">{gitChanges.length === 0 ? "No changes" : "No changed files match the current filter"}</div>
                    ) : (
                      <div className="changed-files-list">
                        {hiddenGitChangesCount > 0 && (
                          <div className="list-overflow-note">
                            Showing first {renderedGitChanges.length} changed files. Refine the filter to see the remaining {hiddenGitChangesCount}.
                          </div>
                        )}
                        {renderedGitChanges.map((file) => (
                          (() => {
                            const scopeLabel = getGitScopeLabel(file.path, stagedPathSet, unstagedPathSet);
                            const detailLabel = file.status === "R" ? "Renamed" : file.status === "D" ? "Deleted" : null;
                            const displayPath = file.old_path ? `${file.old_path} → ${file.path}` : file.path;
                            return (
                          <div
                            key={file.path}
                            className={`changed-file-item ${selectedGitFilePath === file.path ? "selected" : ""}`}
                            onClick={() => setSelectedGitFilePath(file.path)}
                            onDoubleClick={() => void handleOpenChangedFile(file.path, { openDiff: true, status: file.status })}
                            title={displayPath}
                          >
                            <span className={`file-status status-${file.status}`}>{file.status}</span>
                            <span className="file-path">{displayPath}</span>
                            {detailLabel && <span className="file-meta-badge">{detailLabel}</span>}
                            {scopeLabel && <span className="file-scope-badge">{scopeLabel}</span>}
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
                            );
                          })()
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Commit Section */}
                  {stagedFiles.length > 0 && (
                    <div className="commit-section">
                      <div className="commit-meta-row">
                        <div className="commit-summary">
                          <span className="commit-summary-title">
                            Ready to commit {stagedFiles.length} file{stagedFiles.length === 1 ? "" : "s"}
                          </span>
                          <div className="commit-summary-badges">
                            {stagedStatusSummary.map((entry) => (
                              <span key={entry.status} className="commit-summary-badge">
                                {entry.status} {entry.count}
                              </span>
                            ))}
                          </div>
                        </div>
                        <span className="commit-shortcut-hint">Mod+Enter to commit</span>
                      </div>
                      <textarea
                        className="commit-input"
                        placeholder={"Commit message...\n\nOptional body"}
                        value={commitMessage}
                        rows={3}
                        onChange={(e) => setCommitMessage(e.target.value)}
                        onKeyDown={(e) => {
                          const isMod = navigator.platform.includes("Mac") ? e.metaKey : e.ctrlKey;
                          if (e.key === "Enter" && isMod) {
                            e.preventDefault();
                            handleCommit();
                          }
                        }}
                      />
                      <div className="commit-actions-row">
                        <span className="commit-char-count">
                          {commitMessage.trim().split("\n")[0]?.length ?? 0} chars in subject
                        </span>
                        <button
                          className="commit-btn"
                          onClick={handleCommit}
                          disabled={!commitMessage.trim() || isCommitting}
                        >
                          {isCommitting ? 'Committing...' : 'Commit'}
                        </button>
                      </div>
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
                      <>
                        {hiddenLogFilesCount > 0 && (
                          <div className="list-overflow-note">
                            Showing first {renderedLogFiles.length} files in this commit. Narrow the scope to see the remaining {hiddenLogFilesCount}.
                          </div>
                        )}
                        {renderedLogFiles.map((file) => (
                        (() => {
                          const displayPath = file.old_path ? `${file.old_path} → ${file.path}` : file.path;
                          return (
                        <div
                          key={file.path}
                          className={`changed-file-item ${selectedGitFilePath === file.path ? "selected" : ""}`}
                          onClick={() => setSelectedGitFilePath(file.path)}
                          onDoubleClick={() => void handleOpenChangedFile(file.path, { commit: selectedCommit, openDiff: true })}
                          title={displayPath}
                        >
                          <span className={`file-status status-${file.status}`}>{file.status}</span>
                          <span className="file-path">{displayPath}</span>
                        </div>
                          );
                        })()
                      ))}
                      </>
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
                    <>
                      {hiddenGitHistoryCount > 0 && (
                        <div className="list-overflow-note">
                          Showing first {renderedGitHistory.length} commits. Use file history or narrower filters to reduce the list.
                        </div>
                      )}
                      {renderedGitHistory.map((commit) => (
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
                    ))}
                    </>
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
