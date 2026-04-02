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

- Iteration: `v1.final`
- Status: `fixed_again_for_review`
- Owner: `Claude`

---

## Task Brief

目标：
- 把 Fika 收口成一个真正可用的 `v1`
- 补齐“最小版 IDEA”剩余的核心闭环
- 不再继续拆 `v1.6 / v1.7 / v1.8 / v1.9`

本轮范围：
- Rust/Tauri 后端
  - 继续优先使用系统 `git` 命令封装
  - 至少支持：
    - `git blame` 当前文件
    - stage / unstage 单文件
    - commit
    - 最近项目持久化
    - 会话恢复持久化
    - 新建文件 / 新建目录
    - 重命名文件 / 目录
    - 删除文件 / 目录
    - 刷新文件树
  - 返回结构化数据，不要让前端直接解析原始 git 输出
- React 前端
  - 底部面板中补齐：
    - `Blame` 显示当前文件真实 blame
    - `Diff / Log` 保持不回退
  - 增加 Changes 区域的 stage / unstage 入口
  - 增加 commit 输入和提交入口
  - 增加最近项目入口
  - 应用重开后恢复：
    - 上次项目
    - 上次打开的 tabs
    - 当前激活 tab
    - 侧边栏展开状态
  - 项目树支持：
    - 新建文件
    - 新建目录
    - 重命名
    - 删除
    - 刷新
  - 增加跳转历史：
    - back
    - forward
  - 至少支持这条链路：
    - 打开最近项目
    - 编辑多个文件
    - 新建/重命名/删除文件
    - 搜索并跳转
    - 后退 / 前进
    - 看 Git 历史 / diff / blame
    - stage / unstage
    - commit
    - 退出后再次打开，恢复现场
- 代码结构
  - 可以新增 api、types、组件、hooks、持久化工具
  - 不要引入全局状态库
  - 不要开始做终端、运行、调试、LSP

---

## Constraints

本轮不要做：
- merge / rebase / cherry-pick
- 远程仓库操作
- stash
- 新建分支
- 全局搜索高级过滤
- Search Everywhere 完整版
- split editor
- terminal
- run / debug
- LSP / autocomplete / refactor
- 大规模 UI 重做

实现要求：
- 所有 Git 操作必须限制在当前项目根目录内
- 文件系统操作必须限制在当前项目根目录内
- 如果当前项目不是 git 仓库，要有明确空状态或错误提示
- 点击 diff / log 结果时必须复用现有文件打开逻辑，不要造第二套
- blame 至少包含：
  - commit short hash
  - author
  - time
  - line number / line text 关联
- commit 失败、stage 失败、文件操作失败都不能把整个 UI 打坏
- 如果存在 dirty tabs：
  - 删除 / 重命名 / 切换项目 / 恢复会话时要有明确策略
- 会话恢复不能恢复不存在的文件
- 最近项目不能混入无效路径
- 保持现有快捷键不回退

建议状态模型：
- `currentBranch`
- `branches`
- `gitHistory`
- `gitChanges`
- `blame`
- `navigationHistory`
- `recentProjects`
- `sessionState`
- `bottomPanelTab`
- `error`

---

## Acceptance Criteria

- 当前分支可见
- `Log` 面板显示真实 history
- `Diff` 面板显示真实 working tree changed files
- `Blame` 面板显示当前文件真实 blame
- 点击 changed file 可查看真实 diff
- 可对 changed file 做 stage / unstage
- 可输入 commit message 并提交
- 项目树可新建文件 / 新建目录 / 重命名 / 删除 / 刷新
- 有最近项目入口
- 应用重开后可恢复上次项目与 tabs
- 有 back / forward 跳转历史
- 非 git 项目有明确空状态
- 搜索能力和现有编辑器功能不回退
- 构建通过

---

## Claude Implementation Report

Claude 完成后必须填写以下内容：

### Summary (Review Fixes)

- 改了哪些文件：
  - `src-tauri/src/lib.rs` -
    - 给文件系统操作添加项目根目录边界校验
    - 新增 `is_parent_within_project()` 用于校验待创建路径的父目录是否在项目根目录内
    - `create_file` / `create_directory` 使用父目录校验，支持路径尚不存在的场景
    - `rename_path`：`old_path` 保持完整路径校验（必须存在），`new_path` 使用父目录校验（支持新路径尚不存在）
    - `delete_path` 保持完整路径校验（要求路径存在）
    - 添加 `Deserialize` derive 到 `RecentProject` 和 `SessionState`
    - 修正 `line.find("@@", 2)` 为 `line[2..].find("@@")`
  - `src/api.ts` - 更新文件操作接口，添加 `projectRoot` 参数
  - `src/App.tsx` -
    - 统一打开项目入口到 `handleOpenFolderWithSession`
    - 添加最近项目快捷键 `Ctrl+Shift+O` 和按钮 title 更新
    - 添加防抖保存会话逻辑 (500ms debounce)
    - 调整函数定义顺序解决依赖问题
- 修复的阻塞问题：
  1. ✅ 文件系统操作现在强制校验路径必须在项目根目录内
  2. ✅ 会话保存已接上 (500ms debounce)
  3. ✅ 所有打开项目入口统一走 `handleOpenFolderWithSession`
  4. ✅ 最近项目入口已真正可达
  5. ✅ 新建文件/目录的边界校验不再依赖 `canonicalize(target_path)`，改为校验父目录
  6. ✅ **本轮修复**：`rename_path` 对 `new_path` 使用父目录校验，支持重命名到尚不存在的新路径

### Self-Check (Review Fixes)

- [x] 文件系统操作有项目根目录边界校验（新建文件/目录校验父目录，重命名/删除校验完整路径）
- [x] 会话保存已真正接上 (debounce 500ms)
- [x] 所有打开项目入口统一到 `handleOpenFolderWithSession`
- [x] 最近项目入口真正可达 (按钮 + 快捷键)
- [x] Rust `cargo check` 通过
- [x] `npm run build` 通过

### Known Issues

- `goBack/goForward` 仍使用 `setTimeout(100)` 解除 `isNavigating`，建议后续改为更明确的导航来源标记
- `handleRename/handleDelete` 对目录场景只刷新树，未处理目录下已打开文件 tab 的路径同步或关闭策略

### Notes For Reviewer (Review Fixes)

1. **文件系统操作边界校验**：
   - **新建文件/目录**：使用 `is_parent_within_project()` 校验父目录是否在项目根目录内
     - 逐级向上查找第一个存在的祖先目录进行校验
     - 解决 `canonicalize(target_path)` 在路径不存在时失败的问题
   - **重命名**：`old_path` 使用 `is_path_within_project()` 校验（必须存在），`new_path` 使用 `is_parent_within_project()` 校验（支持尚不存在的新路径）
   - **删除**：使用 `is_path_within_project()` 校验完整路径（要求路径必须存在）
   - 所有文件操作都接收 `project_root` 参数，拒绝项目根目录外的操作

2. **会话保存实现**：
   - 使用 500ms debounce，避免高频写盘
   - 监听 `projectRoot`, `openTabs`, `activeTabPath`, `openFolders` 变化
   - 后端 `save_session` 会自动过滤掉已不存在的文件路径

3. **打开项目入口统一**：
   - 所有入口 (`Cmd/Ctrl+O`、标题栏 📂 按钮、最近项目列表) 都走 `handleOpenFolderWithSession`
   - 统一处理 dirty tabs 确认、最近项目记录、导航历史清理

4. **最近项目入口可达性**：
   - 标题栏 📚 按钮，title 显示快捷键 `Ctrl+Shift+O`
   - 全局快捷键 `Cmd/Ctrl+Shift+O` 可直接打开最近项目弹层

---

## Review Checkpoints

我会重点检查这些：

### Stage 1: Data Flow

- Git 命令是否严格限制在当前项目根目录
- 文件系统操作是否严格限制在当前项目根目录
- blame / stage / commit 是否使用结构化数据
- diff / log / blame 点击是否复用现有文件打开逻辑

### Stage 2: Reliability

- 非 git 项目是否有清晰降级行为
- commit / stage / 文件操作失败时是否会破坏当前状态
- 会话恢复是否会跳过失效路径
- 最近项目是否会自动清理无效路径

### Stage 3: UI/Editor Behavior

- 当前分支展示是否清晰
- `Log` / `Diff` / `Blame` 是否承载真实 Git 内容
- stage / unstage / commit 链路是否顺
- 文件树操作是否顺
- back / forward 是否顺
- 恢复会话后编辑器状态是否一致

### Stage 4: Code Quality

- git 逻辑是否继续过度堆进 `App.tsx`
- 文件系统 / 持久化 / Git 状态是否开始分层
- 前后端接口是否为后续优化留出空间

---

## Reviewer Findings

这轮 `v1.final` 通过。

确认通过的点：

1. 文件系统边界校验已经收口：
   - 新建文件 / 目录使用父目录校验
   - 重命名对 `old_path` 做存在校验，对 `new_path` 做父目录校验
   - 删除保持完整路径校验

2. 会话保存和恢复已经闭环。

3. 打开项目入口已经统一，最近项目入口也已可达。

4. `cargo check` 和 `npm run build` 都通过。

保留的非阻塞问题：

1. `goBack/goForward` 仍依赖 `setTimeout(100)` 解除 `isNavigating`。
2. 目录重命名 / 删除时，对其下已打开文件 tab 的处理还不完整。

---

## Reviewer Outcome

- Result: `approved`
- Next step: 可以提交并推远端，作为 `v1.final`
