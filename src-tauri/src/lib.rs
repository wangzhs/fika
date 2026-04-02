use serde::Serialize;
use std::fs;
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
    pub files: Vec<FileEntry>,
}

#[derive(Serialize, Clone)]
pub struct FileEntry {
    pub id: String,
    pub path: String,
    pub content: String,
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

    let mut files = Vec::new();
    let tree = match read_dir_recursive(&root, &root, &mut files) {
        Ok(t) => t,
        Err(e) => return Err(format!("Failed to read folder: {}", e)),
    };

    Ok(Some(FolderResult { root, tree, files }))
}

fn read_dir_recursive(dir: &str, root: &str, files: &mut Vec<FileEntry>) -> Result<FileNode, String> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(err) => {
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
            if let Ok(child) = read_dir_recursive(&path_str, root, files) {
                children.push(child);
            }
        } else {
            let content = fs::read_to_string(&path).unwrap_or_default();
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().to_string();
            let id = rel.replace(|c: char| !c.is_alphanumeric(), "_");
            files.push(FileEntry {
                id: id.clone(),
                path: rel.clone(),
                content,
            });
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
