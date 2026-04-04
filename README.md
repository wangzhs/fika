# Fika

[简体中文](./README.zh-CN.md)

Fika is a lightweight desktop code editor for developers who want a dense, keyboard-first workflow without the surface area of a full IDE.

It focuses on the core loop:

- open a project fast
- browse and edit files
- search and jump quickly
- review Git history and diffs

## What Fika is

- A desktop editor for reading and editing local codebases
- A focused workspace for search, navigation, and Git review
- A good fit for terminal-first and AI-assisted development workflows

## What Fika is not

- No run / debug / build orchestration
- No full LSP refactoring suite
- No plugin marketplace
- No heavy project setup flow

## Current Features

### Project and files

- Open folders from the system dialog
- Open projects in a new window
- Recent projects
- Project tree with folder expand/collapse state
- Drag files or folders into the app to open them
- Multi-tab editing
- Save current file / save all
- Unsaved state handling on tab close and app quit

### Navigation and search

- Find file
- Recent files
- In-file search
- Project-wide text search
- Back / forward navigation history
- Breadcrumbs

### Editor and preview

- Syntax highlighting for common languages
- Markdown preview
- Image preview
- Dense dark UI tuned for desktop use

### Git

- Current branch display
- Branch switching
- Working tree changes
- File diff
- History for repository, folder, or file
- Blame
- Stage / unstage
- Commit
- Revert a single file to the Git version

### Distribution

- macOS and Windows bundles
- In-app update flow
- GitHub Release based updater pipeline

## Keyboard Shortcuts

- `Cmd/Ctrl + O` open folder
- `Cmd/Ctrl + W` close current tab
- `Cmd/Ctrl + S` save current file
- `Cmd/Ctrl + Shift + S` save all
- `Cmd/Ctrl + Shift + N` find file
- `Cmd/Ctrl + E` recent files
- `Cmd/Ctrl + F` find in current file
- `Cmd/Ctrl + Shift + F` search in project
- `Cmd + Shift + P` toggle Markdown preview on Markdown files
- `Cmd/Ctrl + D` compare the selected Git item in Git views

## Screenshots

Add screenshots here once the UI settles.

## Development

### Prerequisites

- Node.js 20.19+ recommended
- Rust toolchain
- Tauri prerequisites for your platform

### Run locally

```bash
npm install
npm run tauri dev
```

### Build

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

### Bundle

```bash
npm run bundle:mac
npm run bundle:windows
```

There is also a local helper script:

```bash
./scripts/package.sh mac
./scripts/package.sh windows
```

## Updates and Releases

Updater and release notes are documented in:

- [UPDATER.md](./UPDATER.md)

Local-only release helpers are intentionally kept out of the repository history.

## Roadmap

Fika is still being actively refined. The current focus is:

- polish the editing workflow
- tighten macOS and Windows desktop behavior
- improve release and updater reliability
- keep the UI fast and focused

## License

MIT
