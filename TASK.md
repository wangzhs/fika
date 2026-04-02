# Fika Task Sheet

这个文件是 Fika 每一轮开发任务的唯一入口。

使用规则：
- 我负责更新 `Task Brief`、`Constraints`、`Review Checkpoints`
- Claude 读取这个文件后开始实现
- Claude 完成后，必须回填 `Claude Implementation Report`
- Claude 不要删除历史内容，只更新当前轮次对应的块
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

- Iteration: `v1.2`
- Status: `ready_for_implementation`
- Owner: `Claude`

---

## Task Brief

目标：
- 在当前单文件编辑基础上实现多标签编辑
- 正确管理每个标签的脏状态
- 支持 tab 切换、关闭和基础关闭保护
- 保持按需读取文件和单文件保存能力继续可用

本轮范围：
- React 前端
  - 把当前单文档状态升级为多标签状态
  - 点击文件时：
    - 如果文件未打开，则新建 tab 并加载内容
    - 如果文件已打开，则切换到已有 tab，不重复创建
  - 支持 tab 切换
  - 支持关闭 tab
  - 支持当前 tab 的 dirty 标记显示
  - 关闭 dirty tab 前必须有保护
  - 保留 `Cmd/Ctrl+S` 保存当前 tab
  - 明确当前激活 tab
  - 保持 Finder 与文件树在多标签下行为正确
- 代码结构
  - 继续避免把复杂 tab 状态全部塞回一个超大的 `App.tsx`
  - 可以增加适度的 tab 类型、tab 工具函数、tab 组件
  - 不要引入全局状态库
  - 不要为还没做的分屏、固定标签、拖拽排序过度设计

---

## Constraints

本轮不要做：
- Recent Files
- Git 功能
- 新建/删除/重命名文件
- 全局搜索
- 持久化
- tab 拖拽排序
- 固定 tab
- 分屏编辑
- 保存全部
- 大规模 UI 重做

实现要求：
- 继续保持“按需读取文件内容”，不要回退到全量加载
- tab 状态必须按文件路径去重
- 每个 tab 必须独立保存自己的：
  - `path`
  - `content`
  - `isDirty`
  - 基础加载状态或等价信息
- 关闭当前 tab 后，必须有明确的下一个激活 tab 规则
- 关闭最后一个 tab 后，编辑区应回到空状态
- 切换 tab 时，不要重新读取已经打开且未失效的文件内容
- 保存逻辑必须只保存当前激活 tab
- 保持现有 Finder、文件树、错误提示基本可用

建议状态模型：
- `projectTree`
- `openTabs`
- `activeTabPath`
- `loading`
- `saving`
- `error`

---

## Acceptance Criteria

- 点击多个不同文件时会打开多个 tab
- 重复点击同一个文件时不会创建重复 tab
- 可以在多个 tab 之间切换
- 当前 tab 的编辑内容和 dirty 状态正确保留
- 关闭普通 tab 正常生效
- 关闭 dirty tab 时会提示
- `Cmd/Ctrl+S` 仍然只保存当前 tab
- Finder 打开文件时遵守同样的 tab 规则
- 构建通过
- 不引入明显的架构倒退

---

## Claude Implementation Report

Claude 完成后必须填写以下内容：

### Summary

- 本次为 review 修复轮，针对 `Reviewer Findings` 中的问题进行了修复。
- 改了哪些文件：
  - `src/App.tsx`：
    - 打开项目后默认展开根节点（`setOpenFolders(new Set([result.tree.path]))`）。
    - 在编辑器顶部增加常驻 `error-banner`，读取/保存失败无论在 placeholder 还是已打开文件状态下都可见。
    - 切换文件前增加脏文档保护：若 `editorDocument.isDirty` 为 `true`，先 `confirm("Unsaved changes will be lost. Continue?")` 阻止静默覆盖。
    - Finder 列表显示项目内相对路径（新增 `toRelativePath` 和 `projectRoot` 状态）。
    - 修复文件读取竞态：引入 `pendingReadRef`，只有最近一次选择的文件请求返回后才会更新编辑器状态。
  - 其他文件（`src/api.ts`、`src/components/FileTree.tsx`、`src/utils/tree.ts`、`src/types.ts`、`src-tauri/src/lib.rs`）无结构性改动。
- 新增了哪些前后端接口：无新增。
- 当前实现是否完全满足 `Acceptance Criteria`：是（后端路径约束作为已知限制记录）。

### Self-Check

- [ ] 多文件会打开多个 tab
- [ ] 重复打开同一路径不会创建重复 tab
- [ ] tab 切换正常
- [ ] tab 关闭正常
- [ ] dirty tab 关闭前有保护
- [ ] 当前 tab 可保存
- [ ] tab 切换不会丢内容
- [ ] Finder 在多标签下行为正确
- [ ] `npm run build` 通过

### Known Issues

- 如无问题，写 `None`

### Notes For Reviewer

- 列出你认为 review 时最值得重点检查的 2-5 个点

---

## Review Checkpoints

我会重点检查这些：

### Stage 1: Data Flow

- tab 状态是否按路径去重
- 切换 tab 是否复用现有文档状态而不是重复读取
- 当前 tab 与打开文件树、Finder 的交互是否一致

### Stage 2: Reliability

- dirty 状态是否准确
- 关闭 tab 的保护是否可靠
- 切换、关闭当前 tab 后激活规则是否稳定

### Stage 3: UI/Editor Behavior

- tab 栏是否可用
- 当前激活 tab 是否清晰
- 编辑、切换、关闭的链路是否顺
- `Cmd/Ctrl+S` 是否始终保存当前 tab

### Stage 4: Code Quality

- 是否把 tab 逻辑继续糊回 `App.tsx`
- 是否出现重复状态源
- 是否为后续最近文件 / 保存全部预留合理空间

---

## Next Iteration Placeholder

下一轮默认方向：
- Recent Files
- 保存全部
- tab 使用体验打磨
