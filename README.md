# Fika

A lightweight, cross-platform code browser for developers who love IntelliJ IDEA's shortcuts and interface but don't want the heaviness.

## Philosophy

- **Read and navigate code**, not run it.
- **Keyboard-first** with IntelliJ IDEA keybindings.
- **Instant** — open any folder in milliseconds.
- **Minimal** — no build system, no debugger, no plugin bloat.

## Target User

You write code in the terminal or with AI CLI tools. You want a fast, focused desktop app just for:
- Browsing project files
- Searching and jumping to files/symbols
- Reading code with syntax highlighting
- Reviewing Git changes (diff, log, blame)

## Core Requirements

### 1. File & Project Navigation (IDEA-style)
- [ ] `Ctrl+Shift+N` / `Cmd+Shift+N` — Find file by name
- [ ] `Ctrl+N` / `Cmd+N` — Find class/symbol
- [ ] `Ctrl+O` / `Cmd+O` — Open folder from system dialog
- [ ] Project tool window on the left with collapsible file tree
- [ ] Breadcrumb navigation above editor
- [ ] File tree remembers expand/collapse state

### 2. Code Viewer
- [ ] Syntax highlighting for common languages
- [ ] Line numbers
- [ ] Read-only by default (this is a browser, not an editor)
- [ ] Darcula-like dark theme as default
- [ ] Clean, dense IDE layout with thin separators

### 3. Git Integration
- [ ] Diff viewer with side-by-side or unified diff
- [ ] Commit log / history
- [ ] Blame annotations
- [ ] Stage/unstage and simple commit actions (optional for v1)

### 4. Performance & Platform
- [ ] macOS and Windows support
- [ ] Open 10k+ file projects without choking
- [ ] Skip `node_modules`, `.git`, hidden folders automatically

### 5. Explicitly Out of Scope (for now)
- No run / debug / build integration
- No LSP-based autocomplete or refactoring
- No plugin marketplace
- No complex project setup wizard

## License

MIT (planned open source)
