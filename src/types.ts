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
