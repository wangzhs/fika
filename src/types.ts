export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
  has_children?: boolean;
  children_loaded?: boolean;
}

export type GitFileStatus = string | null;

export interface FolderResult {
  root: string;
  tree: FileNode;
}

export interface EditorDocument {
  path: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
  isLoading: boolean;
  loadError?: string | null;
}

export interface SearchResult {
  path: string;
  line_number: number;
  line_content: string;
  matched_fragment: string;
}

export interface SearchOptions {
  case_sensitive?: boolean;
  whole_word?: boolean;
  regex?: boolean;
}

export type BottomPanelTab = "diff" | "log" | "blame";

// Git types
export interface Branch {
  name: string;
  is_current: boolean;
}

export interface GitSyncStatus {
  has_upstream: boolean;
  ahead: number;
  behind: number;
}

export interface Commit {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  time: string;
}

export interface ChangedFile {
  path: string;
  old_path?: string | null;
  status: string; // M, A, D, R, C, U, ?
}

export interface DiffLine {
  kind: string; // "+", "-", " "
  content: string;
  old_line?: number;
  new_line?: number;
}

export interface DiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
}

export interface CommitFiles {
  hash: string;
  files: ChangedFile[];
}

// Blame types
export interface BlameLine {
  line_number: number;
  content: string;
  commit_hash: string;
  short_hash: string;
  author: string;
  time: string;
}

export interface FileBlame {
  path: string;
  lines: BlameLine[];
}

// Stage types
export interface StagedFile {
  path: string;
  old_path?: string | null;
  status: string;
}

// Persistence types
export interface RecentProject {
  path: string;
  name: string;
  last_opened: number;
}

export interface EditorViewStateSnapshot {
  selection_anchor: number;
  scroll_top: number;
}

export type AutoSaveMode = "off" | "after_delay";
export type ExternalLinkMode = "browser" | "confirm";

export interface SessionState {
  project_root: string | null;
  open_tabs: string[];
  pinned_tab_paths: string[];
  editor_view_states: Record<string, EditorViewStateSnapshot>;
  auto_save_mode: AutoSaveMode;
  external_link_mode: ExternalLinkMode;
  active_tab_path: string;
  open_folders: string[];
  recent_file_paths: string[];
  selected_tree_path: string;
  bottom_panel_tab: BottomPanelTab;
  is_bottom_panel_open: boolean;
  bottom_panel_height: number;
}

// Navigation history
export interface NavigationEntry {
  path: string;
  line?: number;
}

export interface AvailableUpdate {
  current_version: string;
  version: string;
  date?: string | null;
  body?: string | null;
}
