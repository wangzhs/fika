import { invoke } from "@tauri-apps/api/core";
import type { FolderResult, SearchResult } from "./types";

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
