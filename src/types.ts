export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
}

export interface FolderResult {
  root: string;
  tree: FileNode;
}

export interface EditorDocument {
  path: string;
  content: string;
  isDirty: boolean;
  isLoading: boolean;
  isSaving: boolean;
}

export interface SearchResult {
  path: string;
  line_number: number;
  line_content: string;
  matched_fragment: string;
}

export type BottomPanelTab = "search" | "diff" | "log" | "blame";

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
