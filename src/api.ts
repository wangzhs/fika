import { invoke } from "@tauri-apps/api/core";
import type { Branch, ChangedFile, Commit, CommitFiles, FileDiff, FolderResult, SearchResult, FileBlame, StagedFile, RecentProject, SessionState, FileNode } from "./types";

export function openFolder() {
  return invoke<FolderResult | null>("open_folder");
}

export function readFile(path: string) {
  return invoke<string>("read_file", { path });
}

export function writeFile(path: string, content: string) {
  return invoke<void>("write_file", { path, content });
}

export function setUnsavedChangesFlag(hasUnsavedChanges: boolean) {
  return invoke<void>("set_unsaved_changes_flag", { hasUnsavedChanges });
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

export function getFileDiff(path: string, file: string, staged?: boolean, commit?: string) {
  return invoke<FileDiff>("get_file_diff", { path, file, staged, commit });
}

export function getCommitFiles(path: string, commit: string) {
  return invoke<CommitFiles>("get_commit_files", { path, commit });
}

// Git Blame API
export function getFileBlame(path: string, file: string) {
  return invoke<FileBlame>("get_file_blame", { path, file });
}

// Git Stage/Unstage API
export function stageFile(path: string, file: string) {
  return invoke<void>("stage_file", { path, file });
}

export function unstageFile(path: string, file: string) {
  return invoke<void>("unstage_file", { path, file });
}

export function commit(path: string, message: string) {
  return invoke<string>("commit", { path, message });
}

export function getStagedFiles(path: string) {
  return invoke<StagedFile[]>("get_staged_files", { path });
}

// File System Operations
export function createFile(projectRoot: string, path: string) {
  return invoke<void>("create_file", { projectRoot, path });
}

export function createDirectory(projectRoot: string, path: string) {
  return invoke<void>("create_directory", { projectRoot, path });
}

export function renamePath(projectRoot: string, oldPath: string, newPath: string) {
  return invoke<void>("rename_path", { projectRoot, oldPath, newPath });
}

export function deletePath(projectRoot: string, path: string) {
  return invoke<void>("delete_path", { projectRoot, path });
}

export function refreshTree(root: string) {
  return invoke<FileNode>("refresh_tree", { root });
}

// Persistence API
export function saveRecentProjects(projects: RecentProject[]) {
  return invoke<void>("save_recent_projects", { projects });
}

export function loadRecentProjects() {
  return invoke<RecentProject[]>("load_recent_projects");
}

export function saveSession(state: SessionState) {
  return invoke<void>("save_session", { state });
}

export function loadSession() {
  return invoke<SessionState>("load_session");
}
