import { invoke } from "@tauri-apps/api/core";
import type { Branch, ChangedFile, Commit, CommitFiles, FileDiff, FolderResult, SearchResult } from "./types";

export function openFolder() {
  return invoke<FolderResult | null>("open_folder");
}

export function readFile(path: string) {
  return invoke<string>("read_file", { path });
}

export function writeFile(path: string, content: string) {
  return invoke<void>("write_file", { path, content });
}

export function searchInProject(root: string, query: string) {
  return invoke<SearchResult[]>("search_in_project", { root, query });
}

// Git API
export function getCurrentBranch(path: string) {
  return invoke<string | null>("get_current_branch", { path });
}

export function getBranches(path: string) {
  return invoke<Branch[]>("get_branches", { path });
}

export function switchBranch(path: string, branch: string) {
  return invoke<void>("switch_branch", { path, branch });
}

export function getGitHistory(path: string, maxCount?: number) {
  return invoke<Commit[]>("get_git_history", { path, maxCount });
}

export function getWorkingTreeChanges(path: string) {
  return invoke<ChangedFile[]>("get_working_tree_changes", { path });
}

export function getFileDiff(path: string, file: string, staged?: boolean) {
  return invoke<FileDiff>("get_file_diff", { path, file, staged });
}

export function getCommitFiles(path: string, commit: string) {
  return invoke<CommitFiles>("get_commit_files", { path, commit });
}
