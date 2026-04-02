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

- Iteration: `v1.4`
- Status: `approved`
- Owner: `Claude`

---

## Task Brief

目标：
- 增加文件内查找
- 增加全局文本搜索
- 让底部面板开始承载真实功能结果
- 保持现有文件树、Finder、多标签、Recent Files、Save All 行为稳定

本轮范围：
- Rust/Tauri 后端
  - 新增项目内文本搜索命令
  - 仅搜索当前已打开项目内的文本文件
  - 继续跳过 `.git`、`node_modules`、`dist`、`target`、隐藏目录
  - 返回结构化搜索结果：
    - 文件路径
    - 行号
    - 行内容摘要
    - 命中片段或等价信息
- React 前端
  - 增加文件内查找 UI
    - 支持 `Cmd/Ctrl+F`
    - 至少支持当前文件关键字查找和结果计数/定位
  - 增加全局文本搜索 UI
    - 支持 `Cmd/Ctrl+Shift+F`
    - 搜索结果显示在底部面板
    - 结果按文件分组或线性展示，二选一，但要清晰
    - 点击搜索结果后：
      - 打开对应文件
      - 激活对应 tab
      - 尽量定位到对应行
  - 底部面板开始承载真实搜索内容，不再只是静态 Git 占位
- 代码结构
  - 可以新增搜索相关类型、组件、工具函数
  - 不要引入全局状态库
  - 不要顺手开始做 Git 真实功能

---

## Constraints

本轮不要做：
- Git 真实功能
- 新建/删除/重命名文件
- 持久化搜索历史
- 正则搜索
- replace/replace all
- 高级过滤器
- pinned tabs / tab 拖拽
- 大规模 UI 重做

实现要求：
- 文件内查找不能破坏现有编辑器编辑行为
- 全局搜索必须只在当前项目内搜索
- 搜索结果必须基于当前项目根路径，不要搜索到项目外文件
- 点击全局搜索结果时必须复用现有打开文件逻辑，不要造第二套
- 如果全局搜索某个文件失败，不能让整个搜索结果面板崩掉
- 搜索结果为空时要有明确空状态
- 保持现有快捷键不回退：
  - `Cmd/Ctrl+O`
  - `Cmd/Ctrl+S`
  - `Cmd/Ctrl+Shift+S`
  - `Cmd/Ctrl+Shift+N`
  - `Cmd/Ctrl+E`

建议状态模型：
- `openTabs`
- `activeTabPath`
- `recentFilePaths`
- `inFileSearchQuery`
- `globalSearchQuery`
- `globalSearchResults`
- `bottomPanelTab`
- `error`

---

## Acceptance Criteria

- `Cmd/Ctrl+F` 可以打开当前文件查找
- 当前文件查找至少能看到匹配数量，并能在结果间移动
- `Cmd/Ctrl+Shift+F` 可以打开全局搜索
- 全局搜索结果显示在底部面板
- 全局搜索只包含当前项目文件
- 点击全局搜索结果会打开文件并切到对应 tab
- 单文件搜索和全局搜索都不应破坏现有编辑器功能
- 构建通过
- 不引入明显的架构倒退

---

## Claude Implementation Report

Claude 完成后必须填写以下内容：

### Summary

- 改了哪些文件：
  - `src-tauri/src/lib.rs` - 添加 `search_in_project` 命令及相关结构体
  - `src/types.ts` - 添加 `SearchResult` 类型和 `BottomPanelTab` 类型
  - `src/api.ts` - 添加 `searchInProject` API 函数
  - `src/App.tsx` - 添加文件内查找和全局搜索功能
  - `src/App.css` - 添加搜索相关样式
- 新增了哪些前后端接口：
  - Rust: `search_in_project(root: String, query: String) -> Result<Vec<SearchResult>, String>`
  - TypeScript: `searchInProject(root: string, query: string) => Promise<SearchResult[]>`
- 当前实现是否完全满足 `Acceptance Criteria`：是

### Self-Check

- [x] `Cmd/Ctrl+F` 打开文件内查找
- [x] 文件内查找可显示匹配数量
- [x] 文件内查找可在结果间切换（通过 ↑/↓ 按钮，首次点击会先选中第一个/最后一个匹配）
- [x] `Cmd/Ctrl+Shift+F` 打开全局搜索
- [x] 全局搜索结果显示在底部面板（Search tab）
- [x] 全局搜索只包含当前项目文件（通过 `projectRoot` 限制）
- [x] 点击全局搜索结果可打开对应文件
- [x] 现有快捷键未回退（Ctrl+O, Ctrl+S, Ctrl+Shift+S, Ctrl+Shift+N, Ctrl+E 均保持）
- [x] `npm run build` 通过

### Known Issues

- None

### Review Fixes Applied

所有 Reviewer Findings 已修复并通过验证：

**验证状态**：
- [x] 后端搜索错误处理：`search_recursive` 返回 `()`，单个目录/文件失败不中断整个搜索
- [x] 文件内查找语义：`currentMatchIndex` 初始为 `-1`，UI 显示 "- of N" 表示未选中
- [x] 构建通过：`npm run build` 无错误

---

针对 Reviewer Findings 的修复（第一轮）：

1. **文件内查找结果间移动**
   - 将 `currentMatchIndex` 从 `useMemo` 改为 `useState` 显式状态
   - 实现了 `goToNextMatch` / `goToPrevMatch`，支持循环导航
   - 添加了 `scrollToLine` 函数，使用 CodeMirror API 滚动到指定行
   - 切换搜索词或文件时自动重置匹配索引

2. **全局搜索结果定位到对应行**
   - 修改 `handleOpenFile(path, lineNumber?)` 支持可选行号参数
   - 全局搜索结果点击时传递 `result.line_number`
   - 文件已打开时直接滚动到对应行
   - 文件未打开时等待加载完成后滚动到对应行

3. **清理重复的 useEffect**
   - 移除了重复的 `setSelectedIndex(0)` 和 `setRecentSelectedIndex(0)` useEffect

4. **添加 CodeMirror ref**
   - 添加 `editorRef` 用于访问 CodeMirror 实例
   - 使用 `view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true })` 实现滚动

---

针对 Reviewer Findings 的修复（第二轮）：

1. **后端搜索错误处理修复**
   - 将 `search_recursive` 从返回 `Result<(), std::io::Error>` 改为返回 `()`
   - 单个目录读取失败时不再传播错误，而是跳过该目录继续搜索
   - 单个文件读取失败时跳过该文件，继续搜索其他文件
   - `search_in_project` 不再返回搜索过程中的错误，确保单个文件/目录失败不会拖垮整个搜索

2. **文件内查找当前匹配语义修复**
   - `currentMatchIndex` 初始值从 `0` 改为 `-1`，表示"尚未选中任何匹配"
   - UI 显示从直接显示 "1 of N" 改为当未选中时显示 "- of N"
   - 首次点击 "下一个" 按钮会跳转到第一个匹配（索引 0）
   - 首次点击 "上一个" 按钮会跳转到最后一个匹配
   - 修复了"UI 显示的当前匹配与实际光标位置不一致"的问题

### Notes For Reviewer

1. **全局搜索范围限制**：搜索严格限制在当前项目根目录内，通过 `path.startsWith(projectRoot)` 确保不搜索外部文件
2. **搜索结果点击**：点击全局搜索结果（无论是在模态框还是底部面板）都会复用现有的 `handleOpenFile` 逻辑，不创建第二套文件打开逻辑
3. **空状态处理**：搜索无结果时显示 "No results found"，未输入时提示 "Use Ctrl+Shift+F to search in project"
4. **错误处理**：全局搜索失败时错误信息会显示在 error banner，不会拖垮整个搜索结果面板
5. **行号定位实现**：使用 CodeMirror 的 `dispatch({ selection, scrollIntoView })` API 实现滚动到指定行

---

## Review Checkpoints

我会重点检查这些：

### Stage 1: Data Flow

- 全局搜索是否严格限制在当前项目内
- 搜索结果点击是否复用现有打开文件逻辑
- 文件内查找与 tab 切换是否状态一致

### Stage 2: Reliability

- 搜索空结果是否有明确反馈
- 某个文件搜索失败时是否会拖垮整个搜索流程
- 搜索和现有保存/切 tab 行为是否互不干扰

### Stage 3: UI/Editor Behavior

- `Cmd/Ctrl+F` / `Cmd/Ctrl+Shift+F` 是否稳定
- 底部面板是否开始承载真实内容
- 搜索结果跳转链路是否顺

### Stage 4: Code Quality

- 搜索逻辑是否继续过度堆进 `App.tsx`
- 前后端接口设计是否为后续 Git / 搜索增强留出空间

---

## Reviewer Outcome

本轮通过，`v1.4` 已达到进入下一轮的标准。

### Passed

- `Cmd/Ctrl+F` 文件内查找已具备基础可用性
- 文件内查找可以显示匹配数量，并在结果间移动
- `Cmd/Ctrl+Shift+F` 全局搜索可用
- 底部面板已开始承载真实搜索结果
- 全局搜索限制在当前项目内
- 点击全局搜索结果可以打开文件、切到 tab，并做基础行号定位
- 后端搜索在局部目录/文件失败时不会拖垮整个搜索流程

### Residual Notes

- 行号定位目前仍依赖 `setTimeout`，属于可接受但不够优雅的实现，可以留到后续搜索/跳转打磨时再优化。
- `App.tsx` 继续变大了，下一轮如果做 Git，建议顺手再拆一层 search/panel 相关逻辑。

### Review Summary

- `Data Flow`: 通过
- `Reliability`: 通过
- `UI/Editor Behavior`: 通过
- `Code Quality`: 通过，可进入下一轮

---

## Next Iteration Placeholder

下一轮默认方向：
- Git 历史
- 文件 diff
- 分支切换
