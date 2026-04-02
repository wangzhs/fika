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

- Iteration: `v1.1`
- Status: `approved`
- Owner: `Claude`

---

## Task Brief

目标：
- 把项目从“打开文件夹时加载整个项目所有文件内容”改成“只加载文件树，文件内容按需读取”
- 补齐单文件保存能力
- 为后续多标签编辑预留合理状态结构

本轮范围：
- Rust/Tauri 后端
  - 重构 `open_folder` 或等价接口，只返回项目根路径、文件树、必要元数据
  - 不再返回所有文件内容
  - 新增 `read_file(path)` 命令
  - 新增 `write_file(path, content)` 命令
  - 继续忽略 `.git`、`node_modules`、`dist`、`target` 和隐藏目录
  - 对二进制文件、不可读文件、编码异常做基本防御，不要让前端崩掉
- React 前端
  - 打开项目后只保存文件树
  - 点击文件时调用 `read_file` 按需加载内容
  - 保持当前单标签查看体验可用
  - 增加保存当前文件能力，至少支持 `Cmd/Ctrl+S`
  - 正确处理读取失败、保存失败的错误提示
- 代码结构
  - 不要继续把所有逻辑堆在一个巨大的 `App.tsx`
  - 可以适度抽出 `types`、`api`、文件树相关逻辑
  - 不要在这一轮过度设计

---

## Constraints

本轮不要做：
- 多标签编辑
- Recent Files
- Find File 重构
- Git 功能
- 新建/删除/重命名文件
- 全局搜索
- 持久化
- 大规模 UI 重做

实现要求：
- 打开项目时不能再把所有文件内容读到前端
- 前端必须区分“文件树元数据”和“文件内容”
- 保存逻辑必须走后端 `write_file`
- 状态设计不要和“单文件预览器”强耦合，后续要能平滑升级到 tabs
- 保持现有 UI 基本可用

建议状态模型：
- `projectTree`
- `activeFilePath`
- `editorDocument` 或等价结构
- `loading`
- `saving`
- `error`

---

## Acceptance Criteria

- 打开项目时不会一次性读取所有文件内容
- 点击一个文件时才读取内容并显示
- 修改内容后可以保存回磁盘
- 重新点击同一个文件仍能正常加载
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

- [x] 打开项目时只加载文件树
- [x] 点击文件时按需读取
- [x] 可以保存当前文件
- [x] `Cmd/Ctrl+S` 已接入
- [x] 读取失败时有错误处理（placeholder / 已打开状态均可见）
- [x] 保存失败时有错误处理（placeholder / 已打开状态均可见）
- [x] `npm run build` 通过
- [x] 文件树默认展开根节点
- [x] 脏文档切换前有保护提示
- [x] Finder 显示相对路径
- [x] 文件读取竞态已修复

### Known Issues

- 后端 `read_file` / `write_file` 尚未对访问路径做项目根目录约束，当前接受前端传入的任意绝对路径。这在本地桌面应用中属于已知限制，后续应增加以已打开项目根目录为边界的校验。

### Notes For Reviewer

1. `src/App.tsx:86` 打开文件夹后显式把根节点路径加入 `openFolders`，确保文件树默认展开。
2. `src/App.tsx:284-289` 的 `error-banner` 在 breadcrumb 和 code-editor 之间独立渲染，不依赖 `editorDocument` 是否为空。
3. `src/App.tsx:154` 使用 `confirm()` 做最低限度的脏文档保护，符合本轮“不强制复杂交互”的要求。
4. `src/App.tsx:160-175` 通过 `pendingReadRef` 做竞态保护，确保快速切换文件时只有最后一次选择会生效。
5. Finder 列表现在显示相对路径，但底层仍传递绝对路径给 `handleSelectFile`，保证文件读取正确性。

---

## Review Checkpoints

我会重点检查这些：

### Stage 1: Data Flow

- 后端是否真的移除了“全量文件内容返回”
- `read_file` / `write_file` 是否是单文件读写
- 前端是否把文件树与文件内容分离建模

### Stage 2: Reliability

- 二进制文件或不可读文件是否会导致空白异常或崩溃
- 错误提示是否明确
- 路径处理在 macOS 路径下是否合理

### Stage 3: UI/Editor Behavior

- 打开文件、编辑、保存的链路是否顺
- `Cmd/Ctrl+S` 是否稳定
- 当前单文件体验是否没有被重构坏

### Stage 4: Code Quality

- 是否继续把逻辑堆在 `App.tsx`
- 是否为了这轮任务做了过度设计
- 是否为下一轮 tabs 保留了合理扩展空间

---

## Reviewer Findings

本轮没有通过 review。先不要进入下一轮 tabs，必须先修完下面的问题。

### Must Fix

1. 文件树默认不可用，打开项目后根节点是折叠的。
当前实现里打开项目后执行 `setOpenFolders(new Set())`，而 `FileTree` 只有在 `openFolders.has(node.path)` 时才渲染子节点，导致用户打开项目后看不到任何文件列表，只能手动点根节点展开。这是明显的交互回退。
定位：
- `src/App.tsx:66`
- `src/components/FileTree.tsx:33-56`

2. 错误状态在编辑器打开后不可见，导致“读取失败/保存失败有错误处理”这个验收标准实际上没有完成。
现在 `error` 只在 `editorDocument` 为空时显示在 placeholder 中；一旦文件已经打开，后续保存失败、重新读取失败、编码错误等都不会在编辑区显式显示，用户无法知道失败原因。
定位：
- `src/App.tsx:97-99`
- `src/App.tsx:265-291`

3. 切换文件会直接丢弃未保存内容，没有任何保护。
当前 `handleSelectFile` 在读取新文件后直接用新内容覆盖 `editorDocument`，如果当前文件 `isDirty` 为 `true`，未保存改动会被静默覆盖。这对一个已经支持编辑和保存的应用来说风险太高，不能带着这个行为进入下一轮。
定位：
- `src/App.tsx:72-85`
- `src/App.tsx:272-275`

### Should Fix

1. Finder 现在显示的是绝对路径，不是项目内相对路径，体验比上一版更差。
`collectFilePaths` 直接返回 `FileNode.path`，而后端文件树里文件路径是绝对路径。这个虽然不阻塞功能，但会让查找文件结果过长，不符合 IDE 使用习惯。
定位：
- `src/utils/tree.ts:3-11`
- `src/App.tsx:186-198`

2. 文件读取存在竞态，快速连续点两个文件时，先返回的旧请求可能覆盖后点开的文件。
`handleSelectFile` 没有做请求序号或路径一致性保护。这个问题在小项目里不一定立刻暴露，但属于典型 UI 数据流漏洞，建议这轮一起补掉。
定位：
- `src/App.tsx:72-85`

3. 后端读写接口对项目根路径没有任何约束。
当前前端传什么绝对路径，后端就读写什么路径。对本地桌面应用这不一定是立即阻塞问题，但至少应该限制在已打开项目根目录内，或者在这轮明确记录为已知限制，不能写成“完全满足 Acceptance Criteria”。
定位：
- `src-tauri/src/lib.rs:95-118`

### Review Summary

- `Data Flow`: 基本方向是对的，后端已经去掉了全量文件内容返回。
- `Reliability`: 未通过，错误展示和竞态处理还不够。
- `UI/Editor Behavior`: 未通过，根节点折叠和静默丢失未保存内容都属于明显问题。
- `Code Quality`: 有所改善，但当前实现还不能作为下一轮 tabs 的稳定基线。

---

## Claude Follow-up Task

Claude 下一轮只修 review 问题，不要开始多标签。

需要完成：
- 打开项目后默认展开根节点，文件树可直接使用
- 让读取失败和保存失败在“文件已打开”和“文件未打开”两种状态下都可见
- 处理未保存内容保护
  - 最低要求：切换文件前，如果当前文档是 dirty，必须阻止覆盖并给出明确提示
  - 如果要做得更好，可以做确认弹窗，但本轮不强制要求复杂交互
- 修正 Finder 的路径显示，优先显示项目内相对路径
- 修正文件读取竞态，确保后一次选择的文件不会被先返回的旧请求覆盖
- 更新 `Claude Implementation Report`

本轮完成后，再让我重新 review，确认通过后才能进入 `v1.2` 多标签编辑。

---

## Reviewer Outcome

本轮返工后，前一次 review 提出的阻塞问题已经处理到可接受水平，`v1.1` 通过。

### Resolved

- 打开项目后根节点已默认展开，文件树可直接使用
- 错误信息已在“无文件打开”和“文件已打开”两种状态下可见
- 切换文件前已有未保存保护，不再静默覆盖 dirty 内容
- Finder 已改为显示项目内相对路径
- 文件读取增加了基础竞态保护，后发起的读取不会被旧请求覆盖

### Remaining Known Limitation

- 后端 `read_file` / `write_file` 仍未限制在当前项目根目录内。这一项暂时记录为已知限制，不阻塞进入 `v1.2`，但在后续文件系统能力继续扩展前需要补上。

### Review Summary

- `Data Flow`: 通过
- `Reliability`: 通过
- `UI/Editor Behavior`: 通过
- `Code Quality`: 通过，当前结构可以作为下一轮多标签编辑的基线

### Next Step

- 可以进入 `v1.2`
- 下一轮主题：多标签编辑、脏状态、tab 关闭与切换

---

## Next Iteration Placeholder

下一轮默认方向：
- 多标签编辑
- 脏状态
- tab 关闭与切换
