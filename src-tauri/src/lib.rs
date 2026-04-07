use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Manager, RunEvent, WindowEvent,
};
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
struct CloseGuard {
    has_unsaved_changes: AtomicBool,
    allow_next_close: AtomicBool,
}

#[derive(Default)]
struct AppLifecycle {
    is_quitting: AtomicBool,
}

#[derive(Serialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
    pub has_children: Option<bool>,
    pub children_loaded: Option<bool>,
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

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SearchOptions {
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
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
    pub old_path: Option<String>,
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
    pub old_path: Option<String>,
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
    #[serde(default)]
    pub pinned_tab_paths: Vec<String>,
    #[serde(default)]
    pub editor_view_states: HashMap<String, EditorViewStateSnapshot>,
    #[serde(default)]
    pub auto_save_mode: String,
    pub active_tab_path: String,
    pub open_folders: Vec<String>,
    pub recent_file_paths: Vec<String>,
    pub selected_tree_path: String,
    pub bottom_panel_tab: String,
    pub is_bottom_panel_open: bool,
    pub bottom_panel_height: u32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct EditorViewStateSnapshot {
    pub selection_anchor: usize,
    pub scroll_top: u32,
}

#[derive(Serialize)]
struct OpenTarget {
    kind: String,
    root: String,
    file_path: Option<String>,
}

#[derive(Serialize)]
struct AvailableUpdate {
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
}

const MENU_OPEN_FOLDER: &str = "file_open_folder";
const MENU_OPEN_RECENT: &str = "file_open_recent";
const MENU_OPEN_FOLDER_NEW_WINDOW: &str = "file_open_folder_new_window";
const MENU_CLOSE_TAB: &str = "file_close_tab";
const MENU_CHECK_FOR_UPDATES: &str = "help_check_for_updates";

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

    let tree = match read_dir_shallow(&root) {
        Ok(t) => t,
        Err(e) => return Err(format!("Failed to read folder: {}", e)),
    };

    Ok(Some(FolderResult { root, tree }))
}

fn should_skip_entry(name: &str, is_dir: bool) -> bool {
    is_dir && (name.starts_with('.') || name == "node_modules" || name == "target" || name == "dist")
}

fn directory_has_visible_children(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = path.is_dir();
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_entry(&name, is_dir) {
            continue;
        }
        return true;
    }

    false
}

fn read_dir_shallow(dir: &str) -> Result<FileNode, String> {
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
                has_children: Some(false),
                children_loaded: Some(true),
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
            if should_skip_entry(&name, true) {
                continue;
            }
            children.push(FileNode {
                name,
                path: path_str,
                is_dir: true,
                children: None,
                has_children: Some(directory_has_visible_children(&path)),
                children_loaded: Some(false),
            });
        } else {
            children.push(FileNode {
                name,
                path: path_str,
                is_dir: false,
                children: None,
                has_children: Some(false),
                children_loaded: Some(true),
            });
        }
    }

    children.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    let has_children = !children.is_empty();

    Ok(FileNode {
        name: std::path::Path::new(dir)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| dir.to_string()),
        path: dir.to_string(),
        is_dir: true,
        children: Some(children),
        has_children: Some(has_children),
        children_loaded: Some(true),
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
async fn confirm_discard_file(handle: tauri::AppHandle, file: String) -> Result<bool, String> {
    let confirmed = handle
        .dialog()
        .message(format!(
            "Revert this file to the Git version?\n\n{}\n\nThis will discard local changes for this file.",
            file
        ))
        .title("Revert File")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Revert".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show();

    Ok(confirmed)
}

#[tauri::command]
async fn search_in_project(root: String, query: String, options: Option<SearchOptions>) -> Result<Vec<SearchResult>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }

    let options = options.unwrap_or_default();

    if let Ok(results) = search_with_ripgrep(&root, &query, &options) {
        return Ok(results);
    }

    let mut results = Vec::new();
    search_recursive(Path::new(&root), &query, &options, &mut results);
    Ok(results)
}

fn search_recursive(dir: &Path, query: &str, options: &SearchOptions, results: &mut Vec<SearchResult>) {
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
            search_recursive(&path, query, options, results);
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
                    if let Some(matched_fragment) = line_matches_query(line, query, options) {
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

fn search_with_ripgrep(root: &str, query: &str, options: &SearchOptions) -> Result<Vec<SearchResult>, String> {
    let mut args: Vec<&str> = vec![
        "--json",
        "--line-number",
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
    ];

    if options.regex {
        args.push("--regexp");
    } else {
        args.push("--fixed-strings");
    }

    if options.case_sensitive {
        args.push("--case-sensitive");
    } else {
        args.push("--smart-case");
    }

    if options.whole_word && !options.regex {
        args.push("--word-regexp");
    }

    args.push(query);
    args.push(root);

    let output = Command::new("rg")
        .args(args)
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

fn is_word_char(ch: Option<char>) -> bool {
    matches!(ch, Some(c) if c.is_ascii_alphanumeric() || c == '_')
}

fn line_matches_query(line: &str, query: &str, options: &SearchOptions) -> Option<String> {
    if options.regex {
        let pattern = if options.case_sensitive {
            regex::Regex::new(query).ok()?
        } else {
            regex::RegexBuilder::new(query).case_insensitive(true).build().ok()?
        };
        let matched = pattern.find(line)?;
        return Some(line[matched.start()..matched.end()].to_string());
    }

    let haystack = if options.case_sensitive {
        line.to_string()
    } else {
        line.to_lowercase()
    };
    let needle = if options.case_sensitive {
        query.to_string()
    } else {
        query.to_lowercase()
    };

    let found_index = haystack.find(&needle)?;
    let before_char = line[..found_index].chars().last();
    let after_char = line[found_index + query.len()..].chars().next();

    if options.whole_word && (is_word_char(before_char) || is_word_char(after_char)) {
        return None;
    }

    Some(line[found_index..found_index + query.len()].to_string())
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
async fn get_git_history(path: String, max_count: Option<usize>, file: Option<String>) -> Result<Vec<Commit>, String> {
    if !is_git_repo(&path) {
        return Ok(vec![]);
    }

    let count = max_count.unwrap_or(50);
    let format = "%H|%h|%s|%an|%ar";
    let count_arg = format!("-n{}", count);
    let format_arg = format!("--format={}", format);
    let output = if let Some(file_path) = file.filter(|value| !value.trim().is_empty()) {
        run_git_command(
            &["log", &count_arg, &format_arg, "--", &file_path],
            &path,
        )?
    } else {
        run_git_command(
            &["log", &count_arg, &format_arg],
            &path,
        )?
    };

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

fn parse_name_status_z(output: &[u8]) -> Vec<ChangedFile> {
    let text = String::from_utf8_lossy(output);
    let mut files = Vec::new();
    let mut entries = text.split('\0').filter(|entry| !entry.is_empty());

    while let Some(status_entry) = entries.next() {
        let mut chars = status_entry.chars();
        let status_code = chars.next().unwrap_or('M');
        if chars.next().is_some() {
            continue;
        }
        let Some(file_path) = entries.next() else {
            break;
        };
        let (old_path, final_path) = if matches!(status_code, 'R' | 'C') {
            let new_path = entries.next().unwrap_or(file_path).to_string();
            (Some(file_path.to_string()), new_path)
        } else {
            (None, file_path.to_string())
        };

        if let Some(status) = git_code_to_status(status_code) {
            files.push(ChangedFile {
                path: final_path,
                old_path,
                status,
            });
        }
    }

    files
}

#[tauri::command]
async fn get_working_tree_changes(path: String) -> Result<Vec<ChangedFile>, String> {
    if !is_git_repo(&path) {
        return Ok(vec![]);
    }

    let tracked_output = run_git_command_bytes(&["diff", "--name-status", "-z"], &path)?;
    let mut files = parse_name_status_z(&tracked_output);

    let untracked_output = run_git_command(&["ls-files", "--others", "--exclude-standard"], &path)?;
    for line in untracked_output.lines() {
        let file_path = line.trim();
        if file_path.is_empty() {
            continue;
        }
        files.push(ChangedFile {
            path: file_path.to_string(),
            old_path: None,
            status: "?".to_string(),
        });
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
async fn get_commit_files(path: String, commit: String, file: Option<String>) -> Result<CommitFiles, String> {
    if !is_git_repo(&path) {
        return Err("Not a git repository".to_string());
    }

    let output = if let Some(file_path) = file.filter(|value| !value.trim().is_empty()) {
        run_git_command_bytes(&["show", "--name-status", "-z", "--format=", &commit, "--", &file_path], &path)?
    } else {
        run_git_command_bytes(&["show", "--name-status", "-z", "--format=", &commit], &path)?
    };
    let files = parse_name_status_z(&output)
        .into_iter()
        .map(|file| ChangedFile {
            path: std::path::Path::new(&path).join(&file.path).to_string_lossy().to_string(),
            old_path: file
                .old_path
                .map(|old_path| std::path::Path::new(&path).join(old_path).to_string_lossy().to_string()),
            status: file.status,
        })
        .collect();

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
async fn discard_file_changes(path: String, file: String) -> Result<(), String> {
    if !is_git_repo(&path) {
        return Err("Not a git repository".to_string());
    }

    let file_path = Path::new(&path).join(&file);
    if !file_path.exists() {
        return Ok(());
    }

    let untracked_output =
        run_git_command(&["ls-files", "--others", "--exclude-standard", "--", &file], &path)?;
    if !untracked_output.trim().is_empty() {
        if file_path.is_dir() {
            fs::remove_dir_all(&file_path)
                .map_err(|e| format!("Failed to remove file: {}", e))?;
        } else {
            fs::remove_file(&file_path)
                .map_err(|e| format!("Failed to remove file: {}", e))?;
        }
        return Ok(());
    }

    run_git_command(
        &["restore", "--source=HEAD", "--staged", "--worktree", "--", &file],
        &path,
    )
    .map(|_| ())
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
    let files = parse_name_status_z(&output)
        .into_iter()
        .map(|file| StagedFile {
            path: file.path,
            old_path: file.old_path,
            status: file.status,
        })
        .collect();

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
    read_dir_shallow(&root)
}

fn list_files_recursive(dir: &Path, files: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = path.is_dir();
        let name = entry.file_name().to_string_lossy().to_string();

        if should_skip_entry(&name, is_dir) {
            continue;
        }

        if is_dir {
            list_files_recursive(&path, files);
        } else {
            files.push(path.to_string_lossy().to_string());
        }
    }
}

#[tauri::command]
async fn list_project_files(root: String) -> Result<Vec<String>, String> {
    if let Ok(output) = Command::new("rg")
        .args([
            "--files",
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
            root.as_str(),
        ])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let normalized_root = Path::new(&root)
                .canonicalize()
                .unwrap_or_else(|_| Path::new(&root).to_path_buf());
            let files = stdout
                .lines()
                .map(|line| normalized_root.join(line).to_string_lossy().to_string())
                .collect();
            return Ok(files);
        }
    }

    let mut files = Vec::new();
    list_files_recursive(Path::new(&root), &mut files);
    Ok(files)
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

fn sanitize_window_label(label: &str) -> String {
    label
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn session_file_path(app_handle: &tauri::AppHandle, window_label: &str) -> Result<std::path::PathBuf, String> {
    let config_dir = get_config_dir(app_handle)?;
    Ok(config_dir.join(format!("session-{}.json", sanitize_window_label(window_label))))
}

fn workspace_file_path(app_handle: &tauri::AppHandle, project_root: &str) -> Result<std::path::PathBuf, String> {
    let config_dir = get_config_dir(app_handle)?;
    let workspace_dir = config_dir.join("workspaces");
    fs::create_dir_all(&workspace_dir).map_err(|e| format!("Failed to create workspace directory: {}", e))?;

    let mut hasher = DefaultHasher::new();
    project_root.hash(&mut hasher);
    Ok(workspace_dir.join(format!("{:016x}.json", hasher.finish())))
}

fn empty_session_state(project_root: Option<String>) -> SessionState {
    SessionState {
        project_root,
        open_tabs: vec![],
        pinned_tab_paths: vec![],
        editor_view_states: HashMap::new(),
        auto_save_mode: "off".to_string(),
        active_tab_path: String::new(),
        open_folders: vec![],
        recent_file_paths: vec![],
        selected_tree_path: String::new(),
        bottom_panel_tab: "diff".to_string(),
        is_bottom_panel_open: false,
        bottom_panel_height: 260,
    }
}

fn filter_session_state(state: SessionState) -> SessionState {
    let project_root = state.project_root.filter(|p| Path::new(p).exists());
    let active_tab_path = if Path::new(&state.active_tab_path).exists() {
        state.active_tab_path
    } else {
        String::new()
    };
    let selected_tree_path = if Path::new(&state.selected_tree_path).exists() {
        state.selected_tree_path
    } else {
        active_tab_path.clone()
    };
    let bottom_panel_tab = match state.bottom_panel_tab.as_str() {
        "diff" | "log" | "blame" => state.bottom_panel_tab,
        _ => "diff".to_string(),
    };
    let auto_save_mode = match state.auto_save_mode.as_str() {
        "off" | "after_delay" => state.auto_save_mode,
        _ => "off".to_string(),
    };
    let editor_view_states = state
        .editor_view_states
        .into_iter()
        .filter(|(path, _)| Path::new(path).exists())
        .collect();

    SessionState {
        project_root,
        open_tabs: state.open_tabs.into_iter().filter(|p| Path::new(p).exists()).collect(),
        pinned_tab_paths: state.pinned_tab_paths.into_iter().filter(|p| Path::new(p).exists()).collect(),
        editor_view_states,
        auto_save_mode,
        active_tab_path,
        open_folders: state.open_folders.into_iter().filter(|p| Path::new(p).exists()).collect(),
        recent_file_paths: state.recent_file_paths.into_iter().filter(|p| Path::new(p).exists()).collect(),
        selected_tree_path,
        bottom_panel_tab,
        is_bottom_panel_open: state.is_bottom_panel_open,
        bottom_panel_height: state.bottom_panel_height.max(160),
    }
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
async fn save_session(
    app_handle: tauri::AppHandle,
    window_label: String,
    state: SessionState,
) -> Result<(), String> {
    let file_path = session_file_path(&app_handle, &window_label)?;
    let filtered_state = filter_session_state(state);
    let json = serde_json::to_string(&filtered_state).map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(&file_path, json).map_err(|e| format!("Failed to write: {}", e))?;

    if let Some(project_root) = &filtered_state.project_root {
        let workspace_path = workspace_file_path(&app_handle, project_root)?;
        let workspace_json = serde_json::to_string(&filtered_state).map_err(|e| format!("Failed to serialize workspace: {}", e))?;
        fs::write(workspace_path, workspace_json).map_err(|e| format!("Failed to write workspace: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
async fn load_session(app_handle: tauri::AppHandle, window_label: String) -> Result<SessionState, String> {
    let file_path = session_file_path(&app_handle, &window_label)?;

    if !file_path.exists() {
        return Ok(empty_session_state(None));
    }

    let content = fs::read_to_string(file_path).map_err(|e| format!("Failed to read: {}", e))?;
    let state: SessionState = serde_json::from_str(&content).map_err(|e| format!("Failed to parse: {}", e))?;
    Ok(filter_session_state(state))
}

#[tauri::command]
async fn load_workspace(app_handle: tauri::AppHandle, project_root: String) -> Result<SessionState, String> {
    let file_path = workspace_file_path(&app_handle, &project_root)?;

    if !file_path.exists() {
        return Ok(empty_session_state(Some(project_root)));
    }

    let content = fs::read_to_string(file_path).map_err(|e| format!("Failed to read workspace: {}", e))?;
    let state: SessionState = serde_json::from_str(&content).map_err(|e| format!("Failed to parse workspace: {}", e))?;
    Ok(filter_session_state(state))
}

#[tauri::command]
async fn get_open_target(path: String) -> Result<OpenTarget, String> {
    let target = Path::new(&path);
    if !target.exists() {
      return Err(format!("Path does not exist: {}", path));
    }

    let canonical = target
      .canonicalize()
      .map_err(|e| format!("Failed to resolve path '{}': {}", path, e))?;

    if canonical.is_dir() {
      return Ok(OpenTarget {
        kind: "directory".to_string(),
        root: canonical.to_string_lossy().to_string(),
        file_path: None,
      });
    }

    let parent = canonical
      .parent()
      .ok_or_else(|| format!("File has no parent directory: {}", canonical.display()))?;

    Ok(OpenTarget {
      kind: "file".to_string(),
      root: parent.to_string_lossy().to_string(),
      file_path: Some(canonical.to_string_lossy().to_string()),
    })
}

fn build_runtime_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let endpoint = option_env!("FIKA_UPDATER_ENDPOINT")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("https://github.com/wangzhs/fika/releases/latest/download/latest.json");
    let pubkey = option_env!("FIKA_UPDATER_PUBKEY")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(include_str!("../updater.pub").trim());

    let endpoint = endpoint
        .parse()
        .map_err(|e| format!("Invalid updater endpoint: {}", e))?;

    app.updater_builder()
        .pubkey(pubkey)
        .endpoints(vec![endpoint])
        .map_err(|e| format!("Failed to configure updater endpoints: {}", e))?
        .build()
        .map_err(|e| format!("Failed to build updater: {}", e))
}

#[tauri::command]
async fn check_for_updates(app: tauri::AppHandle) -> Result<Option<AvailableUpdate>, String> {
    let updater = build_runtime_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Failed to check for updates: {}", e))?;

    Ok(update.map(|update| AvailableUpdate {
        current_version: update.current_version,
        version: update.version,
        date: update.date.map(|date| date.to_string()),
        body: update.body,
    }))
}

#[tauri::command]
async fn install_update(app: tauri::AppHandle) -> Result<Option<AvailableUpdate>, String> {
    let updater = build_runtime_updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Failed to check for updates: {}", e))?;

    let Some(update) = update else {
        return Ok(None);
    };

    let metadata = AvailableUpdate {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update.date.map(|date| date.to_string()),
        body: update.body.clone(),
    };

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Failed to install update: {}", e))?;

    Ok(Some(metadata))
}

fn build_app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        pkg_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, MENU_OPEN_FOLDER, "Open Folder…", true, Some("CmdOrCtrl+O"))?,
            &MenuItem::with_id(
                app,
                MENU_OPEN_RECENT,
                "Open Recent…",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                MENU_OPEN_FOLDER_NEW_WINDOW,
                "Open Folder in New Window…",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, MENU_CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[&MenuItem::with_id(
            app,
            MENU_CHECK_FOR_UPDATES,
            "Check for Updates…",
            true,
            None::<&str>,
        )?],
    )?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
}

fn eval_in_focused_window(app: &tauri::AppHandle, script: &str) {
    let target = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.webview_windows().into_values().next());

    if let Some(window) = target {
        let _ = window.eval(script);
    }
}

#[cfg(target_os = "macos")]
fn show_and_focus_primary_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    let target = app
        .webview_windows()
        .into_values()
        .find(|window| window.label() == "main")
        .or_else(|| app.webview_windows().into_values().next());

    if let Some(window) = target {
        let _ = window.show();
        let _ = window.set_focus();
        Some(window)
    } else {
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(CloseGuard::default())
        .manage(AppLifecycle::default())
        .menu(|app| build_app_menu(app))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN_FOLDER => eval_in_focused_window(app, "window.__FIKA_OPEN_FOLDER__?.()"),
            MENU_OPEN_RECENT => {
                eval_in_focused_window(app, "window.__FIKA_SHOW_RECENT_PROJECTS__?.()")
            }
            MENU_OPEN_FOLDER_NEW_WINDOW => {
                eval_in_focused_window(app, "window.__FIKA_OPEN_FOLDER_NEW_WINDOW__?.()")
            }
            MENU_CLOSE_TAB => eval_in_focused_window(app, "window.__FIKA_CLOSE_ACTIVE_TAB__?.()"),
            MENU_CHECK_FOR_UPDATES => {
                eval_in_focused_window(app, "window.__FIKA_CHECK_FOR_UPDATES__?.()")
            }
            _ => {}
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let lifecycle = window.state::<AppLifecycle>();
                if !lifecycle.is_quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if let Some(webview_window) = window.app_handle().get_webview_window(window.label()) {
                        let _ = webview_window.eval("window.__FIKA_CLEAR_PROJECT__?.()");
                    }
                    let _ = window.hide();
                    return;
                }

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
            open_folder, read_file, write_file, set_unsaved_changes_flag, confirm_discard_file, search_in_project,
            list_project_files,
            get_current_branch, get_branches, switch_branch,
            get_git_history, get_working_tree_changes, get_file_diff, get_commit_files,
            get_file_blame, stage_file, unstage_file, discard_file_changes, commit, get_staged_files,
            create_file, create_directory, rename_path, delete_path, refresh_tree,
            save_recent_projects, load_recent_projects, save_session, load_session, load_workspace, get_open_target,
            check_for_updates, install_update
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let guard = app_handle.state::<CloseGuard>();
            let lifecycle = app_handle.state::<AppLifecycle>();

            if !guard.has_unsaved_changes.load(Ordering::SeqCst) {
                lifecycle.is_quitting.store(true, Ordering::SeqCst);
                return;
            }

            api.prevent_exit();
            let app = app_handle.clone();
            std::thread::spawn(move || {
                let should_quit = app
                    .dialog()
                    .message("You have unsaved changes. Quit anyway?")
                    .title("Unsaved Changes")
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Quit".to_string(),
                        "Cancel".to_string(),
                    ))
                    .blocking_show();

                if !should_quit {
                    return;
                }

                let lifecycle = app.state::<AppLifecycle>();
                lifecycle.is_quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            });
        }
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let paths: Vec<String> = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .map(|path| path.to_string_lossy().to_string())
                .collect();

            if paths.is_empty() {
                return;
            }

            if let Some(window) = show_and_focus_primary_window(app_handle) {
                let _ = window.emit("fika://open-system-paths", paths);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows, ..
        } => {
            if !has_visible_windows {
                let _ = show_and_focus_primary_window(app_handle);
            }
        }
        _ => {}
    });
}
