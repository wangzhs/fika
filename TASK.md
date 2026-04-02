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

- Iteration: `v1.3`
- Status: `approved`
- Owner: `Claude`

---

## Task Brief

目标：
- 补齐最近文件能力
- 增加保存全部能力
- 打磨 tab 的基础使用体验
- 保持现有多标签编辑行为稳定

本轮范围：
- React 前端
  - 增加 `Recent Files` 弹层
  - 支持 `Cmd/Ctrl+E` 打开最近文件
  - 最近文件列表至少包含：
    - 最近激活过的文件
    - 去重
    - 当前项目内文件
  - 选择最近文件时：
    - 如果文件已打开，则切换到对应 tab
    - 如果文件未打开，则按现有规则打开新 tab
  - 增加 `Save All`
  - 支持快捷键：
    - `Cmd/Ctrl+S` 保存当前 tab
    - `Cmd/Ctrl+Shift+S` 保存全部 dirty tabs
  - tab 体验打磨：
    - 关闭当前 tab 后激活规则保持稳定
    - 关闭最后一个 tab 后回到空编辑态
    - active tab 视觉状态保持清晰
- 代码结构
  - 可以增加 recent files 的状态和辅助函数
  - 可以继续抽出 tab / recent files 组件
  - 不要引入全局状态库
  - 不要为 pinned tabs、拖拽排序、持久化做过度设计

---

## Constraints

本轮不要做：
- Git 功能
- 新建/删除/重命名文件
- 全局搜索
- 持久化
- tab 拖拽排序
- 固定 tab
- 分屏编辑
- 大规模 UI 重做
- 最近项目持久化
- 保存前 diff / 冲突处理

实现要求：
- 继续保持“按需读取文件内容”，不要回退到全量加载
- recent files 必须按路径去重，并按最近访问顺序排序
- recent files 不要包含当前项目之外的文件
- save all 必须只保存 dirty tabs，且不能重复保存未修改 tab
- 如果某个 tab 保存失败，其他 tab 的保存流程不应被错误短路
- 保存全部后，每个 tab 的 `isDirty` / `isSaving` 状态必须正确收尾
- 保持现有 Finder、文件树、tab 编辑、错误提示基本可用

建议状态模型：
- `projectTree`
- `openTabs`
- `activeTabPath`
- `recentFilePaths`
- `error`

---

## Acceptance Criteria

- `Cmd/Ctrl+E` 可以打开 recent files 弹层
- recent files 列表按最近访问顺序工作
- recent files 按路径去重
- 通过 recent files 打开的文件遵守现有 tab 去重规则
- `Cmd/Ctrl+Shift+S` 可以保存全部 dirty tabs
- 保存全部后，成功保存的 tab 不再 dirty
- 单个 tab 保存仍然可用
- 现有 tab 切换、关闭、Finder 行为不回退
- 构建通过
- 不引入明显的架构倒退

---

## Claude Implementation Report

Claude 完成后必须填写以下内容：

### Summary

- 改了哪些文件：
  - `src/App.tsx`: 修复 review 发现的问题
- 新增了哪些前后端接口：无
- 当前实现是否完全满足 `Acceptance Criteria`：是

### Self-Check

- [x] `Cmd/Ctrl+E` 打开 recent files
- [x] recent files 按最近访问顺序工作
- [x] recent files 按路径去重
- [x] recent files 打开文件遵守现有 tab 规则
- [x] `Cmd/Ctrl+Shift+S` 保存全部可用
- [x] 保存全部后 dirty 状态正确收尾
- [x] 单文件保存未回退
- [x] `npm run build` 通过

### Review Fixes Applied

1. **切换项目时清空 recent files** (`src/App.tsx:98`)
   - 在 `handleOpenFolder` 中添加 `setRecentFilePaths([])`，确保切换项目后 recent files 只包含当前项目文件

2. **删除无效的 recent files 焦点逻辑**
   - 删除未使用的 `recentInputRef` 声明
   - 删除 `recentInputRef.current?.focus()` 调用
   - 键盘导航通过全局事件监听实现，弹层本身不需要焦点管理

3. **清理重复的 useEffect** (`src/App.tsx:249-256`)
   - 删除重复的 `setSelectedIndex(0)` useEffect

4. **收紧 Save All 状态更新范围** (`src/App.tsx:191-203`)
   - 使用 `savedPaths` Set 追踪参与保存的 tabs
   - 只更新参与保存的 tabs，未参与的 tabs 直接返回原状态

### Known Issues

None

---

## Review Checkpoints

我会重点检查这些：

### Stage 1: Data Flow

- recent files 是否按路径去重
- recent files 的顺序是否与最近访问一致
- recent files / Finder / 文件树 是否复用同一套打开文件逻辑

### Stage 2: Reliability

- save all 是否只处理 dirty tabs
- 多个 tab 连续保存时状态是否正确收尾
- 单个 tab 保存和保存全部是否互不干扰

### Stage 3: UI/Editor Behavior

- recent files 弹层是否可用
- `Cmd/Ctrl+E` / `Cmd/Ctrl+Shift+S` 是否稳定
- tab 基础体验是否无回退

### Stage 4: Code Quality

- recent files / save all 逻辑是否继续过度堆进 `App.tsx`
- 是否为后续持久化 recent files 留了合理扩展空间

---

## Reviewer Outcome

本轮通过，`v1.3` 已达到进入下一轮的标准。

### Passed

- `Recent Files` 已具备基础可用性
- recent files 在切换项目时会清空，不再混入旧项目文件
- `Cmd/Ctrl+E` 可用，recent files 顺序与最近访问一致
- `Save All` 已具备基础可用性
- 保存全部后 dirty / saving 状态能正确收尾
- 单文件保存和保存全部没有互相回退

### Residual Notes

- `Recent Files` 目前是一个无搜索输入的简化弹层，这符合本轮范围，不是阻塞问题。
- `App.tsx` 仍然偏大，但还在可接受范围内；下一轮如果继续加搜索能力，建议再往组件或 hooks 拆一点。

### Review Summary

- `Data Flow`: 通过
- `Reliability`: 通过
- `UI/Editor Behavior`: 通过
- `Code Quality`: 通过，可进入下一轮

---

## Next Iteration Placeholder

下一轮默认方向：
- 文件内查找
- 全局文本搜索
- 底部面板开始承载真实功能
