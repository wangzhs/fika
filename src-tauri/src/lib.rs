use serde::{Serialize, Deserialize};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

#[derive(Default)]
struct CloseGuard {
    has_unsaved_changes: AtomicBool,
    allow_next_close: AtomicBool,
}

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

#[derive(Serialize, Clone)]
pub struct BlameLine {
    pub line_number: usize,
    pub content: String,
    pub commit_hash: String,
    pub short_hash: String,
    pub author: String,
    pub time: String,
}

#[derive(Serialize, Clone)]
pub struct FileBlame {
    pub path: String,
    pub lines: Vec<BlameLine>,
}

#[derive(Serialize, Clone)]
pub struct StagedFile {
    pub path: String,
    pub status: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened: i64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SessionState {
    pub project_root: Option<String>,
    pub open_tabs: Vec<String>,
    pub active_tab_path: String,
    pub open_folders: Vec<String>,
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
async fn set_unsaved_changes_flag(
    state: tauri::State<'_, CloseGuard>,
    has_unsaved_changes: bool,
) -> Result<(), String> {
    state
        .has_unsaved_changes
        .store(has_unsaved_changes, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn search_in_project(root: String, query: String) -> Result<Vec<SearchResult>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }

    if let Ok(results) = search_with_ripgrep(&root, &query) {
        return Ok(results);
    }

    let query_lower = query.to_lowercase();
    let mut results = Vec::new();
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

fn search_with_ripgrep(root: &str, query: &str) -> Result<Vec<SearchResult>, String> {
    let output = Command::new("rg")
        .args([
            "--json",
            "--line-number",
            "--smart-case",
            "--hidden",
            "--glob", "!.git",
            "--glob", "!node_modules",
            "--glob", "!dist",
            "--glob", "!target",
            "--glob", "!.next",
            "--glob", "!coverage",
            "--glob", "!.turbo",
            "--glob", "!.cache",
            "--glob", "!build",
            "--glob", "!out",
            query,
            root,
        ])
        .output()
        .map_err(|e| format!("Failed to run rg: {}", e))?;

    if !output.status.success() && output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rg failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();

    for line in stdout.lines() {
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        if event.get("type").and_then(|t| t.as_str()) != Some("match") {
            continue;
        }

        let data = &event["data"];
        let path = data["path"]["text"].as_str().unwrap_or_default().to_string();
        let line_number = data["line_number"].as_u64().unwrap_or(0) as usize;
        let line_text = data["lines"]["text"]
            .as_str()
            .unwrap_or_default()
            .trim_end_matches('\n')
            .to_string();

        let matched_fragment = data["submatches"]
            .as_array()
            .and_then(|items| items.first())
            .and_then(|item| item["match"]["text"].as_str())
            .map(|text| text.to_string())
            .unwrap_or_else(|| extract_matched_fragment(&line_text, query));

        results.push(SearchResult {
            path,
            line_number,
            line_content: line_text,
            matched_fragment,
        });

        if results.len() >= 300 {
            break;
        }
    }

    Ok(results)
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

fn run_git_command_bytes(args: &[&str], cwd: &str) -> Result<Vec<u8>, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git command: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Git command failed: {}", stderr));
    }

    Ok(output.stdout)
}

fn git_code_to_status(code: char) -> Option<String> {
    match code {
        'M' => Some("M".to_string()),
        'A' => Some("A".to_string()),
        'D' => Some("D".to_string()),
        'R' => Some("R".to_string()),
        'C' => Some("C".to_string()),
        'U' => Some("U".to_string()),
        '?' => Some("?".to_string()),
        _ => None,
    }
}

fn parse_porcelain_z_entry(entry: &str) -> Option<(char, char, String, bool)> {
    if entry.len() < 4 {
        return None;
    }

    let mut chars = entry.chars();
    let index_status = chars.next()?;
    let worktree_status = chars.next()?;
    let _space = chars.next()?;
    let path = chars.as_str().to_string();
    let expects_rename_target = matches!(index_status, 'R' | 'C');

    Some((index_status, worktree_status, path, expects_rename_target))
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

    let output = run_git_command_bytes(&["status", "--porcelain=v1", "-z"], &path)?;
    let mut files = Vec::new();
    let text = String::from_utf8_lossy(&output);
    let mut entries = text.split('\0').filter(|entry| !entry.is_empty());

    while let Some(entry) = entries.next() {
        let Some((index_status, worktree_status, file_path, expects_rename_target)) =
            parse_porcelain_z_entry(entry)
        else {
            continue;
        };

        let final_path = if expects_rename_target {
            entries.next().unwrap_or(&file_path).to_string()
        } else {
            file_path
        };

        let status = if index_status == '?' && worktree_status == '?' {
            git_code_to_status('?')
        } else if worktree_status != ' ' {
            git_code_to_status(worktree_status)
        } else {
            None
        };

        if let Some(status) = status {
            files.push(ChangedFile {
                path: final_path,
                status,
            });
        }
    }

    Ok(files)
}

#[tauri::command]
async fn get_file_diff(path: String, file: String, staged: Option<bool>, commit: Option<String>) -> Result<FileDiff, String> {
    if !is_git_repo(&path) {
        return Err("Not a git repository".to_string());
    }

    let owned_commit = commit.unwrap_or_default();
    let output = if !owned_commit.is_empty() {
        run_git_command(&["show", &owned_commit, "--", &file], &path)?
    } else {
        let mut args = vec!["diff"];
        if staged.unwrap_or(false) {
            args.push("--staged");
        }
        args.push("--");
        args.push(&file);
        run_git_command(&args, &path)?
    };
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
            if let Some(end) = line[2..].find("@@") {
                let header = &line[2..(end + 2)];
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

// Git blame command
#[tauri::command]
async fn get_file_blame(path: String, file: String) -> Result<FileBlame, String> {
    if !is_git_repo(&path) {
        return Err("Not a git repository".to_string());
    }

    let output = run_git_command(&["blame", "--porcelain", &file], &path)?;
    let mut lines = Vec::new();
    let mut line_number = 0usize;
    let mut current_commit: Option<String> = None;
    let mut current_author: Option<String> = None;
    let mut current_time: Option<String> = None;

    for line in output.lines() {
        if line.starts_with("\t") {
            // This is the actual line content
            line_number += 1;
            let content = line[1..].to_string();
            let hash = current_commit.clone().unwrap_or_default();
            let short_hash = if hash.len() >= 8 {
                hash[..8].to_string()
            } else {
                hash.clone()
            };
            lines.push(BlameLine {
                line_number,
                content,
                commit_hash: hash.clone(),
                short_hash,
                author: current_author.clone().unwrap_or_default(),
                time: current_time.clone().unwrap_or_default(),
            });
        } else if line.starts_with(" ") {
            // Line content indicator - skip
            continue;
        } else {
            // Header line with commit info
            let parts: Vec<&str> = line.split_whitespace().collect();
            if !parts.is_empty() {
                let hash = parts[0].to_string();
                if hash.len() >= 8 && !line.starts_with("author ") && !line.starts_with("committer ") {
                    current_commit = Some(hash.clone());
                }
            }
            if line.starts_with("author ") && !line.starts_with("author-mail ") {
                current_author = Some(line[7..].to_string());
            }
            if line.starts_with("author-time ") {
                if let Ok(timestamp) = line[12..].parse::<i64>() {
                    current_time = Some(format_timestamp(timestamp));
                }
            }
        }
    }

    Ok(FileBlame { path: file, lines })
}

fn format_timestamp(timestamp: i64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    use std::time::SystemTime;

    let system_time = UNIX_EPOCH + Duration::from_secs(timestamp as u64);
    let now = SystemTime::now();
    let duration = now.duration_since(system_time).ok();

    if let Some(d) = duration {
        let secs = d.as_secs();
        if secs < 60 {
            return "just now".to_string();
        } else if secs < 3600 {
            return format!("{}m ago", secs / 60);
        } else if secs < 86400 {
            return format!("{}h ago", secs / 3600);
        } else if secs < 604800 {
            return format!("{}d ago", secs / 86400);
        }
    }

    // Fallback to date string
    let datetime: chrono::DateTime<chrono::Local> = system_time.into();
    datetime.format("%Y-%m-%d").to_string()
}

// Git stage/unstage commands
#[tauri::command]
async fn stage_file(path: String, file: String) -> Result<(), String> {
    if !is_git_repo(&path) {
        return Err("Not a git repository".to_string());
    }

    run_git_command(&["add", &file], &path).map(|_| ())
}

#[tauri::command]
async fn unstage_file(path: String, file: String) -> Result<(), String> {
    if !is_git_repo(&path) {
        return Err("Not a git repository".to_string());
    }

    run_git_command(&["reset", "HEAD", &file], &path).map(|_| ())
}

#[tauri::command]
async fn commit(path: String, message: String) -> Result<String, String> {
    if !is_git_repo(&path) {
        return Err("Not a git repository".to_string());
    }

    run_git_command(&["commit", "-m", &message], &path)?;
    let output = run_git_command(&["rev-parse", "--short", "HEAD"], &path)?;
    Ok(output.trim().to_string())
}

#[tauri::command]
async fn get_staged_files(path: String) -> Result<Vec<StagedFile>, String> {
    if !is_git_repo(&path) {
        return Ok(vec![]);
    }

    let output = run_git_command_bytes(&["diff", "--cached", "--name-status", "-z"], &path)?;
    let mut files = Vec::new();
    let text = String::from_utf8_lossy(&output);
    let mut entries = text.split('\0').filter(|entry| !entry.is_empty());

    while let Some(entry) = entries.next() {
        if entry.len() < 2 {
            continue;
        }

        let mut chars = entry.chars();
        let status_code = chars.next().unwrap_or('M');
        let _tab = chars.next();
        let file_path = chars.as_str().to_string();
        let final_path = if matches!(status_code, 'R' | 'C') {
            entries.next().unwrap_or(&file_path).to_string()
        } else {
            file_path
        };

        if let Some(status) = git_code_to_status(status_code) {
            files.push(StagedFile {
                path: final_path,
                status,
            });
        }
    }

    Ok(files)
}

// File system operations - all paths must be within project root
fn is_path_within_project(project_root: &str, target_path: &str) -> Result<(), String> {
    let root = Path::new(project_root).canonicalize()
        .map_err(|_| format!("Invalid project root: {}", project_root))?;
    let target = Path::new(target_path).canonicalize()
        .map_err(|_| format!("Invalid path: {}", target_path))?;

    if !target.starts_with(&root) {
        return Err(format!("Path '{}' is outside project root '{}'", target_path, project_root));
    }
    Ok(())
}

// For paths that may not exist yet (e.g., new file/directory), check the parent directory
fn is_parent_within_project(project_root: &str, target_path: &str) -> Result<(), String> {
    let root = Path::new(project_root).canonicalize()
        .map_err(|_| format!("Invalid project root: {}", project_root))?;
    let path = Path::new(target_path);

    // Get the parent directory (or use the path itself if it's the root)
    let parent = path.parent()
        .ok_or_else(|| format!("Path '{}' has no parent directory", target_path))?;

    // If parent doesn't exist, try to find the first existing ancestor
    let mut check_path = parent;
    while !check_path.exists() {
        check_path = check_path.parent()
            .ok_or_else(|| format!("Cannot determine project boundary for '{}'", target_path))?;
    }

    let canonical_parent = check_path.canonicalize()
        .map_err(|_| format!("Invalid path: {}", check_path.display()))?;

    if !canonical_parent.starts_with(&root) {
        return Err(format!("Path '{}' is outside project root '{}'", target_path, project_root));
    }
    Ok(())
}

#[tauri::command]
async fn create_file(project_root: String, path: String) -> Result<(), String> {
    // Ensure the parent directory is within the project
    is_parent_within_project(&project_root, &path)?;
    let path_obj = Path::new(&path);

    // Create parent directories if they don't exist
    if let Some(parent) = path_obj.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }

    fs::write(&path, "").map_err(|e| format!("Failed to create file: {}", e))
}

#[tauri::command]
async fn create_directory(project_root: String, path: String) -> Result<(), String> {
    // Ensure the parent directory is within the project
    is_parent_within_project(&project_root, &path)?;
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory: {}", e))
}

#[tauri::command]
async fn rename_path(project_root: String, old_path: String, new_path: String) -> Result<(), String> {
    // old_path must exist and be within project
    is_path_within_project(&project_root, &old_path)?;
    // new_path may not exist yet, check its parent directory
    is_parent_within_project(&project_root, &new_path)?;
    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}", e))
}

#[tauri::command]
async fn delete_path(project_root: String, path: String) -> Result<(), String> {
    is_path_within_project(&project_root, &path)?;
    let path_obj = Path::new(&path);

    if path_obj.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| format!("Failed to delete directory: {}", e))
    } else {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

#[tauri::command]
async fn refresh_tree(root: String) -> Result<FileNode, String> {
    read_dir_recursive(&root)
}

// Persistence - using simple JSON files in app's config directory

fn get_config_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app_handle.path().app_config_dir()
        .map(|dir| {
            fs::create_dir_all(&dir).ok();
            dir
        })
        .map_err(|_| "Failed to get config directory".to_string())
}

#[tauri::command]
async fn save_recent_projects(app_handle: tauri::AppHandle, projects: Vec<RecentProject>) -> Result<(), String> {
    let config_dir = get_config_dir(&app_handle)?;
    let file_path = config_dir.join("recent_projects.json");

    let json = serde_json::to_string(&projects).map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(file_path, json).map_err(|e| format!("Failed to write: {}", e))
}

#[tauri::command]
async fn load_recent_projects(app_handle: tauri::AppHandle) -> Result<Vec<RecentProject>, String> {
    let config_dir = get_config_dir(&app_handle)?;
    let file_path = config_dir.join("recent_projects.json");

    if !file_path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(file_path).map_err(|e| format!("Failed to read: {}", e))?;
    let projects: Vec<RecentProject> = serde_json::from_str(&content).map_err(|e| format!("Failed to parse: {}", e))?;

    // Filter out projects that no longer exist
    let valid_projects: Vec<RecentProject> = projects
        .into_iter()
        .filter(|p| Path::new(&p.path).exists())
        .collect();

    Ok(valid_projects)
}

#[tauri::command]
async fn save_session(app_handle: tauri::AppHandle, state: SessionState) -> Result<(), String> {
    let config_dir = get_config_dir(&app_handle)?;
    let file_path = config_dir.join("session.json");

    // Filter out tabs for files that no longer exist
    let valid_tabs: Vec<String> = state.open_tabs
        .into_iter()
        .filter(|p| Path::new(p).exists())
        .collect();

    let filtered_state = SessionState {
        project_root: state.project_root.filter(|p| Path::new(p).exists()),
        open_tabs: valid_tabs,
        active_tab_path: if Path::new(&state.active_tab_path).exists() {
            state.active_tab_path
        } else {
            String::new()
        },
        open_folders: state.open_folders.into_iter().filter(|p| Path::new(p).exists()).collect(),
    };

    let json = serde_json::to_string(&filtered_state).map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(file_path, json).map_err(|e| format!("Failed to write: {}", e))
}

#[tauri::command]
async fn load_session(app_handle: tauri::AppHandle) -> Result<SessionState, String> {
    let config_dir = get_config_dir(&app_handle)?;
    let file_path = config_dir.join("session.json");

    if !file_path.exists() {
        return Ok(SessionState {
            project_root: None,
            open_tabs: vec![],
            active_tab_path: String::new(),
            open_folders: vec![],
        });
    }

    let content = fs::read_to_string(file_path).map_err(|e| format!("Failed to read: {}", e))?;
    let state: SessionState = serde_json::from_str(&content).map_err(|e| format!("Failed to parse: {}", e))?;

    // Filter out invalid paths
    let valid_state = SessionState {
        project_root: state.project_root.filter(|p| Path::new(p).exists()),
        open_tabs: state.open_tabs.into_iter().filter(|p| Path::new(p).exists()).collect(),
        active_tab_path: if Path::new(&state.active_tab_path).exists() {
            state.active_tab_path
        } else {
            String::new()
        },
        open_folders: state.open_folders.into_iter().filter(|p| Path::new(p).exists()).collect(),
    };

    Ok(valid_state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CloseGuard::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let guard = window.state::<CloseGuard>();
                if guard.allow_next_close.swap(false, Ordering::SeqCst) {
                    return;
                }
                if !guard.has_unsaved_changes.load(Ordering::SeqCst) {
                    return;
                }

                api.prevent_close();

                let app = window.app_handle().clone();
                let label = window.label().to_string();
                std::thread::spawn(move || {
                    let should_close = app
                        .dialog()
                        .message("You have unsaved changes. Close anyway?")
                        .title("Unsaved Changes")
                        .buttons(MessageDialogButtons::OkCancelCustom(
                            "Close".to_string(),
                            "Cancel".to_string(),
                        ))
                        .blocking_show();

                    if !should_close {
                        return;
                    }

                    let guard = app.state::<CloseGuard>();
                    guard.allow_next_close.store(true, Ordering::SeqCst);

                    if let Some(window) = app.get_webview_window(&label) {
                        let _ = window.close();
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_folder, read_file, write_file, set_unsaved_changes_flag, search_in_project,
            get_current_branch, get_branches, switch_branch,
            get_git_history, get_working_tree_changes, get_file_diff, get_commit_files,
            get_file_blame, stage_file, unstage_file, commit, get_staged_files,
            create_file, create_directory, rename_path, delete_path, refresh_tree,
            save_recent_projects, load_recent_projects, save_session, load_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
