use serde::Serialize;
use std::fs;
use std::path::Path;
use std::process::Command;
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

#[derive(Serialize, Clone)]
pub struct Branch {
    pub name: String,
    pub is_current: bool,
}

#[derive(Serialize, Clone)]
pub struct Commit {
    pub hash: String,
    pub short_hash: String,
    pub message: String,
    pub author: String,
    pub time: String,
}

#[derive(Serialize, Clone)]
pub struct ChangedFile {
    pub path: String,
    pub status: String, // M, A, D, R, C, U
}

#[derive(Serialize, Clone)]
pub struct FileDiff {
    pub path: String,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Serialize, Clone)]
pub struct DiffHunk {
    pub old_start: usize,
    pub old_lines: usize,
    pub new_start: usize,
    pub new_lines: usize,
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Serialize, Clone)]
pub struct DiffLine {
    pub kind: String, // "+", "-", " " (context)
    pub content: String,
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
}

#[derive(Serialize, Clone)]
pub struct CommitFiles {
    pub hash: String,
    pub files: Vec<ChangedFile>,
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

// Git helpers
fn run_git_command(args: &[&str], cwd: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git command: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git command failed: {}", stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn is_git_repo(path: &str) -> bool {
    run_git_command(&["rev-parse", "--git-dir"], path).is_ok()
}

#[tauri::command]
async fn get_current_branch(path: String) -> Result<Option<String>, String> {
    if !is_git_repo(&path) {
        return Ok(None);
    }

    match run_git_command(&["rev-parse", "--abbrev-ref", "HEAD"], &path) {
        Ok(branch) => Ok(Some(branch.trim().to_string())),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
async fn get_branches(path: String) -> Result<Vec<Branch>, String> {
    if !is_git_repo(&path) {
        return Ok(vec![]);
    }

    let output = run_git_command(&["branch", "-v"], &path)?;
    let mut branches = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let is_current = line.starts_with("* ");
        let name = if is_current {
            line[2..].split_whitespace().next().unwrap_or("").to_string()
        } else {
            line.split_whitespace().next().unwrap_or("").to_string()
        };

        if !name.is_empty() {
            branches.push(Branch { name, is_current });
        }
    }

    Ok(branches)
}

#[tauri::command]
async fn switch_branch(path: String, branch: String) -> Result<(), String> {
    if !is_git_repo(&path) {
        return Err("Not a git repository".to_string());
    }

    run_git_command(&["checkout", &branch], &path).map(|_| ())
}

#[tauri::command]
async fn get_git_history(path: String, max_count: Option<usize>) -> Result<Vec<Commit>, String> {
    if !is_git_repo(&path) {
        return Ok(vec![]);
    }

    let count = max_count.unwrap_or(50);
    let format = "%H|%h|%s|%an|%ar";
    let output = run_git_command(
        &["log", &format!("-n{}", count), &format!("--format={}", format)],
        &path,
    )?;

    let mut commits = Vec::new();

    for line in output.lines() {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() >= 5 {
            commits.push(Commit {
                hash: parts[0].to_string(),
                short_hash: parts[1].to_string(),
                message: parts[2].to_string(),
                author: parts[3].to_string(),
                time: parts[4].to_string(),
            });
        }
    }

    Ok(commits)
}

#[tauri::command]
async fn get_working_tree_changes(path: String) -> Result<Vec<ChangedFile>, String> {
    if !is_git_repo(&path) {
        return Ok(vec![]);
    }

    let output = run_git_command(&["status", "--porcelain"], &path)?;
    let mut files = Vec::new();

    for line in output.lines() {
        if line.len() < 3 {
            continue;
        }

        let status_code = &line[0..2];
        let file_path = &line[3..];

        let status = match status_code.trim() {
            "M" => "M",
            "A" => "A",
            "D" => "D",
            "R" => "R",
            "C" => "C",
            "U" => "U",
            "??" => "?",
            _ => "M",
        };

        files.push(ChangedFile {
            path: file_path.to_string(),
            status: status.to_string(),
        });
    }

    Ok(files)
}

#[tauri::command]
async fn get_file_diff(path: String, file: String, staged: Option<bool>) -> Result<FileDiff, String> {
    if !is_git_repo(&path) {
        return Err("Not a git repository".to_string());
    }

    let mut args = vec!["diff"];
    if staged.unwrap_or(false) {
        args.push("--staged");
    }
    args.push(&file);

    let output = run_git_command(&args, &path)?;
    Ok(parse_diff_output(&output, &file))
}

#[tauri::command]
async fn get_commit_files(path: String, commit: String) -> Result<CommitFiles, String> {
    if !is_git_repo(&path) {
        return Err("Not a git repository".to_string());
    }

    let output = run_git_command(&["show", "--name-status", "--format=", &commit], &path)?;
    let mut files = Vec::new();

    for line in output.lines() {
        if line.is_empty() {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            let status = parts[0].to_string();
            let file_path = parts[1].to_string();
            // Convert relative path to absolute path
            let absolute_path = std::path::Path::new(&path).join(&file_path);
            files.push(ChangedFile {
                path: absolute_path.to_string_lossy().to_string(),
                status,
            });
        }
    }

    Ok(CommitFiles {
        hash: commit,
        files,
    })
}

fn parse_diff_output(output: &str, file_path: &str) -> FileDiff {
    let mut hunks = Vec::new();
    let mut current_hunk: Option<DiffHunk> = None;
    let mut old_line = 0usize;
    let mut new_line = 0usize;

    for line in output.lines() {
        if line.starts_with("@@") {
            // Save previous hunk if exists
            if let Some(hunk) = current_hunk.take() {
                hunks.push(hunk);
            }

            // Parse hunk header: @@ -old_start,old_lines +new_start,new_lines @@
            if let Some(end) = line.find("@@", 2) {
                let header = &line[2..end];
                let parts: Vec<&str> = header.split_whitespace().collect();

                let old_range = parts.get(0).unwrap_or(&"-0,0");
                let new_range = parts.get(1).unwrap_or(&"+0,0");

                let old_parts: Vec<&str> = old_range[1..].split(',').collect();
                let new_parts: Vec<&str> = new_range[1..].split(',').collect();

                let old_start = old_parts.get(0).unwrap_or(&"0").parse().unwrap_or(0);
                let old_lines = old_parts.get(1).unwrap_or(&"0").parse().unwrap_or(0);
                let new_start = new_parts.get(0).unwrap_or(&"0").parse().unwrap_or(0);
                let new_lines = new_parts.get(1).unwrap_or(&"0").parse().unwrap_or(0);

                old_line = old_start;
                new_line = new_start;

                current_hunk = Some(DiffHunk {
                    old_start,
                    old_lines,
                    new_start,
                    new_lines,
                    header: line.to_string(),
                    lines: Vec::new(),
                });
            }
        } else if line.starts_with('+') || line.starts_with('-') || line.starts_with(' ') {
            if let Some(ref mut hunk) = current_hunk {
                let kind = &line[0..1];
                let content = line[1..].to_string();

                let (old_num, new_num) = match kind {
                    "+" => {
                        let nl = new_line;
                        new_line += 1;
                        (None, Some(nl))
                    }
                    "-" => {
                        let ol = old_line;
                        old_line += 1;
                        (Some(ol), None)
                    }
                    _ => {
                        let ol = old_line;
                        let nl = new_line;
                        old_line += 1;
                        new_line += 1;
                        (Some(ol), Some(nl))
                    }
                };

                hunk.lines.push(DiffLine {
                    kind: kind.to_string(),
                    content,
                    old_line: old_num,
                    new_line: new_num,
                });
            }
        }
    }

    if let Some(hunk) = current_hunk {
        hunks.push(hunk);
    }

    FileDiff {
        path: file_path.to_string(),
        hunks,
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
        .invoke_handler(tauri::generate_handler![
            open_folder, read_file, write_file, search_in_project,
            get_current_branch, get_branches, switch_branch,
            get_git_history, get_working_tree_changes, get_file_diff, get_commit_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
