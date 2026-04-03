export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
}

export type GitFileStatus = string | null;

export interface FolderResult {
  root: string;
  tree: FileNode;
}

export interface EditorDocument {
  path: string;
  content: string;
  isDirty: boolean;
  isLoading: boolean;
}

export interface SearchResult {
  path: string;
  line_number: number;
  line_content: string;
  matched_fragment: string;
}

export type BottomPanelTab = "diff" | "log" | "blame";

// Git types
export interface Branch {
  name: string;
  is_current: boolean;
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
  status: string;
}

// Persistence types
export interface RecentProject {
  path: string;
  name: string;
  last_opened: number;
}

export interface SessionState {
  project_root: string | null;
  open_tabs: string[];
  active_tab_path: string;
  open_folders: string[];
}

// Navigation history
export interface NavigationEntry {
  path: string;
  line?: number;
}
