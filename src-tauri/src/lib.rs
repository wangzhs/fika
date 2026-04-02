use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
}

#[derive(Serialize, Clone)]
pub struct FolderResult {
    pub root: String,
    pub tree: FileNode,
}

#[derive(Serialize, Clone)]
pub struct SearchResult {
    pub path: String,
    pub line_number: usize,
    pub line_content: String,
    pub matched_fragment: String,
}

#[tauri::command]
async fn open_folder(handle: tauri::AppHandle) -> Result<Option<FolderResult>, String> {
    let dialog = handle.dialog();
    let picked = dialog
        .file()
        .set_title("Open Folder")
        .blocking_pick_folder();

    let Some(path) = picked else {
        return Ok(None);
    };
    let root = path.to_string();

    let tree = match read_dir_recursive(&root) {
        Ok(t) => t,
        Err(e) => return Err(format!("Failed to read folder: {}", e)),
    };

    Ok(Some(FolderResult { root, tree }))
}

fn read_dir_recursive(dir: &str) -> Result<FileNode, String> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => {
            return Ok(FileNode {
                name: std::path::Path::new(dir)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| dir.to_string()),
                path: dir.to_string(),
                is_dir: true,
                children: Some(vec![]),
            });
        }
    };

    let mut children = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let path_str = path.to_string_lossy().to_string();
        let is_dir = path.is_dir();

        if is_dir {
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" {
                continue;
            }
            if let Ok(child) = read_dir_recursive(&path_str) {
                children.push(child);
            }
        } else {
            children.push(FileNode {
                name,
                path: path_str,
                is_dir: false,
                children: None,
            });
        }
    }

    children.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));

    Ok(FileNode {
        name: std::path::Path::new(dir)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.to_string()),
        path: dir.to_string(),
        is_dir: true,
        children: Some(children),
    })
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Cannot access file: {}", e))?;

    if !meta.is_file() {
        return Err("Path is not a file".to_string());
    }

    if meta.len() > 10 * 1024 * 1024 {
        return Err("File is too large (>10MB)".to_string());
    }

    let bytes = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;

    if bytes.contains(&0) {
        return Err("Binary files are not supported".to_string());
    }

    String::from_utf8(bytes)
        .map_err(|e| format!("File encoding is not valid UTF-8: {}", e))
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("Failed to write file: {}", e))
}

#[tauri::command]
async fn search_in_project(root: String, query: String) -> Result<Vec<SearchResult>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }

    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    // Search recursively - individual directory/file errors are ignored
    // and the search continues with other paths
    search_recursive(Path::new(&root), &query_lower, &mut results);

    Ok(results)
}

fn search_recursive(dir: &Path, query: &str, results: &mut Vec<SearchResult>) {
    // Try to read directory, but don't fail the entire search if this directory can't be read
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // Skip this directory and continue with others
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if path.is_dir() {
            // Skip ignored directories
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist" {
                continue;
            }
            // Recursively search subdirectory, but don't fail if it errors
            search_recursive(&path, query, results);
        } else {
            // Skip binary files by extension
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            let binary_exts = ["exe", "dll", "so", "dylib", "bin", "o", "a", "lib", "png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "mp3", "wav", "ogg", "zip", "tar", "gz", "bz2", "7z", "rar", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"];
            if binary_exts.contains(&ext.as_str()) {
                continue;
            }

            // Skip files that are too large (>1MB)
            if let Ok(meta) = fs::metadata(&path) {
                if meta.len() > 1024 * 1024 {
                    continue;
                }
            }

            // Search in file - skip files that can't be read
            if let Ok(content) = fs::read_to_string(&path) {
                let path_str = path.to_string_lossy().to_string();
                for (line_number, line) in content.lines().enumerate() {
                    if line.to_lowercase().contains(query) {
                        let matched_fragment = extract_matched_fragment(line, query);
                        results.push(SearchResult {
                            path: path_str.clone(),
                            line_number: line_number + 1,
                            line_content: line.to_string(),
                            matched_fragment,
                        });
                    }
                }
            }
        }
    }
}

fn extract_matched_fragment(line: &str, query: &str) -> String {
    let line_lower = line.to_lowercase();
    let query_lower = query.to_lowercase();

    if let Some(start_idx) = line_lower.find(&query_lower) {
        let match_start = start_idx;
        let match_end = match_start + query.len();

        // Calculate context window
        let context_start = match_start.saturating_sub(20);
        let context_end = (match_end + 20).min(line.len());

        let mut fragment = String::new();
        if context_start > 0 {
            fragment.push_str("...");
        }
        fragment.push_str(&line[context_start..context_end]);
        if context_end < line.len() {
            fragment.push_str("...");
        }

        return fragment;
    }

    // Fallback: return first 60 chars
    if line.len() > 60 {
        format!("{}...", &line[..60])
    } else {
        line.to_string()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_folder, read_file, write_file, search_in_project])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
