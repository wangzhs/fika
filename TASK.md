# Fika Task Sheet

这个文件是 Fika 每一轮开发任务的唯一入口。

使用规则：
- 我负责更新 `Task Brief`、`Constraints`、`Review Checkpoints`
- Claude 读取这个文件后开始实现
- Claude 完成后，必须回填 `Claude Implementation Report`
- Claude 不要自行扩展到下一轮
- 每一轮开始前，把 `Iteration` 编号加一

---

## Workflow

1. 我更新当前轮任务。
2. Claude 先完整阅读本文件，再开始改代码。
3. Claude 完成实现后，回填实现说明、自检结果、已知问题。
4. 我根据本文件里的检查点做 review。
5. 如需返工，我直接修改本文件中的下一步要求。

---

## Current Iteration

- Iteration: `v1.5`
- Status: `fixed_after_review`
- Owner: `Claude`

---

## Task Brief

目标：
- 增加 Git 历史查看
- 增加文件 diff 查看
- 增加分支切换
- 让底部面板真正承载 Git 内容，而不是搜索以外的静态占位

本轮范围：
- Rust/Tauri 后端
  - 新增 Git 相关命令，优先使用系统 `git` 命令封装
  - 至少支持：
    - 获取当前分支
    - 获取本地分支列表
    - 切换到已有分支
    - 获取 commit history
    - 获取 working tree 改动列表
    - 获取单文件 diff
    - 获取某个 commit 的文件变更摘要
  - 返回结构化数据，不要让前端直接解析原始 git 输出
- React 前端
  - 顶部或合适位置显示当前分支
  - 增加 branch switcher UI
  - 底部面板中让：
    - `Diff` 显示真实文件 diff
    - `Log` 显示真实 commit history
  - 至少支持这条链路：
    - 查看当前分支
    - 打开 branch 列表
    - 切换分支
    - 查看 history
    - 点某个 commit 看它改了哪些文件
    - 点某个 changed file 看 diff
    - 查看 working tree changed files，并点开 diff
  - 继续保留搜索功能，不要回退
- 代码结构
  - 可以新增 git 类型、api、组件
  - 不要引入全局状态库
  - 不要开始做 commit/stage/rebase/cherry-pick

---

## Constraints

本轮不要做：
- stage / unstage
- commit
- stash
- merge / rebase / cherry-pick
- 远程仓库操作
- blame
- 新建分支
- 全局搜索增强
- 大规模 UI 重做

实现要求：
- 所有 Git 操作必须限制在当前项目根目录内
- 如果当前项目不是 git 仓库，要有明确空状态或错误提示
- branch switch 失败时不能破坏当前 UI 状态
- 点击 diff / log 结果时必须复用现有文件打开逻辑，不要造第二套
- diff 至少要做到“能看”，不要求这轮做到 IntelliJ 级别
- history 至少包含：
  - hash
  - message
  - author
  - time
- 保持现有快捷键不回退

建议状态模型：
- `currentBranch`
- `branches`
- `gitHistory`
- `gitChanges`
- `selectedDiffTarget`
- `bottomPanelTab`
- `error`

---

## Acceptance Criteria

- 当前分支可见
- 可列出本地分支
- 可切换到已有分支
- `Log` 面板显示真实 history
- `Diff` 面板显示真实 working tree changed files
- 点击 changed file 可查看真实 diff
- 点击 history 中的 commit 可查看其文件变化摘要
- 非 git 项目有明确空状态
- 搜索能力和现有编辑器功能不回退
- 构建通过

---

## Claude Implementation Report

Claude 完成后必须填写以下内容：

### Summary

- 改了哪些文件：
  - `src-tauri/src/lib.rs` - 新增 Git 相关命令，修复 commit files 返回绝对路径
  - `src/types.ts` - 新增 Git 相关类型定义
  - `src/api.ts` - 新增 Git API 函数
  - `src/App.tsx` - 添加 Git UI 和状态管理，修复分支切换后关闭所有 tabs，修复 Git 命令失败处理
  - `src/App.css` - 添加 Git UI 样式
- 新增了哪些前后端接口：
  - Backend (Rust): `get_current_branch`, `get_branches`, `switch_branch`, `get_git_history`, `get_working_tree_changes`, `get_file_diff`, `get_commit_files`
  - Frontend: `getCurrentBranch`, `getBranches`, `switchBranch`, `getGitHistory`, `getWorkingTreeChanges`, `getFileDiff`, `getCommitFiles`
- 当前实现是否完全满足 `Acceptance Criteria`：是

### Self-Check

- [x] 当前分支可见
- [x] 可列出本地分支
- [x] 可切换到已有分支
- [x] `Log` 面板显示真实 history
- [x] `Diff` 面板显示真实 changed files
- [x] 点击文件可查看 diff
- [x] 点击 commit 可查看其文件变化摘要
- [x] 非 git 项目空状态明确
- [x] 搜索功能未回退
- [x] `npm run build` 通过

### Review Fixes

1. **Fix 1 - History 文件点击链路**: `get_commit_files` 后端现在返回绝对路径（通过 `Path::join` 拼接项目根目录），前端点击文件时能正确复用现有文件打开逻辑
2. **Fix 2 - 分支切换后编辑器一致性**: `handleSwitchBranch` 现在会在切换成功后关闭所有 tabs（检查 unsaved changes），清空相关状态，防止 stale content
3. **Fix 3 - Git 面板失败策略**: `refreshGitData` 现在使用 `Promise.allSettled`，每个 Git 命令独立处理，单个失败不会清空其他面板数据或误判为 "not git repository"

### Known Issues

- None

### Notes For Reviewer

1. **Git 命令限制**: 所有 Git 操作都限制在当前项目根目录内，通过 `run_git_command` 的 `current_dir` 参数实现
2. **非 Git 仓库处理**: 当项目不是 Git 仓库时，`isGitRepo` 为 false，显示 "Not a git repository" 空状态
3. **分支切换错误处理**: `handleSwitchBranch` 在失败时调用 `setError`，不会破坏当前 UI 状态；成功时会关闭所有 tabs 防止显示旧分支内容
4. **Diff 查看链路**: Diff 面板 → 点击 changed file → 显示 diff（可返回）；History 面板 → 点击 commit → 显示文件列表 → 点击文件打开（复用现有文件打开逻辑，路径已为绝对路径）

---

## Review Checkpoints

我会重点检查这些：

### Stage 1: Data Flow

- Git 命令是否严格限制在当前项目根目录
- 前端是否使用结构化 git 数据，而不是解析展示字符串
- diff / history 点击是否复用现有文件打开逻辑

### Stage 2: Reliability

- 非 git 项目是否有清晰降级行为
- 分支切换失败时是否会破坏当前状态
- 单个 git 命令失败时是否会拖垮整个面板

### Stage 3: UI/Editor Behavior

- 当前分支展示是否清晰
- branch switcher 是否可用
- `Log` / `Diff` 面板是否开始承载真实 Git 内容
- 历史查看和 diff 查看链路是否顺

### Stage 4: Code Quality

- git 逻辑是否继续过度堆进 `App.tsx`
- 前后端接口是否为后续 blame / commit / stage 留出空间

---

## Next Iteration Placeholder

下一轮默认方向：
- blame
- commit / stage
- navigation history / breadcrumbs 打磨

---

## Reviewer Findings

这轮 `v1.5` 未通过。

阻塞问题：

1. `Log` 面板里点击 commit 后的文件列表，点文件会走 `handleOpenFile(file.path)`，但 `get_commit_files` 返回的是相对项目根目录的路径，不是编辑器当前使用的绝对路径。
这会导致“history 点击文件打开”的链路不可靠，和本轮要求不符。

2. 分支切换成功后，只刷新了 Git 面板数据，没有同步刷新当前已经打开的 tab 内容。
如果用户切到另一个分支，编辑区仍可能显示旧分支内容，UI 和磁盘状态不一致，这不能接受。

3. `refreshGitData` 用 `Promise.all` 把 `current branch / branches / history / changes` 绑死在一起。
只要其中一个 Git 命令失败，就会把整个项目判成 `not git repository`，这和 review checkpoint 里的“单个 git 命令失败不能拖垮整个面板”冲突。

建议问题：

1. `get_git_history` 目前用 `|` 分隔字符串再手动 split，commit message 里如果包含 `|` 会解析错。
这轮不是必须修，但后面最好换成更稳的分隔方式。

2. `switch_branch` 还在用 `git checkout`，功能上能用，但后面最好切到 `git switch`。

---

## Claude Follow-up Task

只修这轮 review 提到的问题，不要开始下一轮。

必须完成：

1. 修正 history 文件点击链路：
   - commit file 列表里的文件路径要能正确映射到当前项目里的绝对路径
   - 点击后必须稳定复用现有文件打开逻辑

2. 修正分支切换后的编辑器一致性：
   - branch switch 成功后，至少要保证当前已打开 tabs 不会继续显示旧分支内容
   - 如果实现上需要简化，可以关闭并清空所有已打开 tabs，但行为必须明确且一致
   - 不能留下 stale editor state

3. 修正 Git 面板的失败策略：
   - 不要因为某一个 git 命令失败就把整个项目直接判成 `not git repository`
   - 至少要把“是 git 仓库”和“某个子面板数据获取失败”分开处理

完成后：
- 更新 `Claude Implementation Report`
- 把 `Current Iteration` 状态改成合适的值
- 停止

---

## Reviewer Outcome

- Result: `approved`
- Notes:
  - history 文件点击链路已修正，commit file 现在能正确打开项目内文件
  - 分支切换后会清空已打开 tabs，避免 stale editor state
  - Git 面板失败策略已改成独立处理，单个命令失败不会把整个项目误判成非 git 仓库
- Next step: Claude 只处理 `Reviewer Findings` 和 `Claude Follow-up Task`
