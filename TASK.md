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
- Status: `approved`
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

- 本次为 review 修复轮，针对 `Reviewer Outcome 3` 中的一个核心问题进行修复。
- 改了哪些文件：
  - `src/App.tsx`：
    - **修复读取失败后的 `activeTabPath` 收尾逻辑**：在 `handleOpenFile` 的 catch 块中，原来依赖闭包捕获的 `activeTabPath` 来判断是否需要重置激活 tab，但闭包值可能是旧的，导致失败 tab 被删除后 `activeTabPath` 仍指向不存在的路径。修复后使用 `setActiveTabPath((current) => current === path ? "" : current)` 的函数式更新形式，基于最新状态进行判断，确保读取失败时激活路径一定被正确重置。
- 新增前后端接口：无。
- 当前实现是否完全满足 `Acceptance Criteria`：是。

### Self-Check

- [x] 多文件会打开多个 tab
- [x] 重复打开同一路径不会创建重复 tab
- [x] tab 切换正常（不再因 dirty 而阻止切换）
- [x] tab 关闭正常
- [x] dirty tab 关闭前有保护
- [x] 当前 tab 可保存
- [x] tab 切换不会丢内容
- [x] Finder 在多标签下行为正确（打开新文件不阻止）
- [x] `npm run build` 通过
- [x] 并发打开多个文件时每个 tab 的 `isLoading` 正确结束
- [x] tab 级 `isLoading` 状态已实现
- [x] tab 级 `isSaving` 状态已实现
- [x] 全局 `loading`/`saving` 已移除

### Known Issues

- 打开新项目时若存在 dirty tabs 会提示确认，用户选择继续后会直接清空所有 tabs。

### Notes For Reviewer

1. **dirty 保护的正确语义**：
   - 关闭 dirty tab：需要确认（`handleCloseTab`）
   - 打开新项目并清空现有 tabs：需要确认（`handleOpenFolder`）
   - 切换到已打开的 tab：不需要确认（`handleSwitchTab` 直接切换）
   - 打开新文件到新 tab：不需要确认（`handleOpenFile` 直接创建新 tab）

2. **并发读取生命周期修复**：
   - 移除 `pendingReadRef`，不再用单个全局引用追踪最近一次读取
   - 每个 `handleOpenFile` 调用内部独立执行 `readFile`，成功或失败都会更新对应 tab 的状态
   - 无论用户多快连续打开 A、B、C 三个文件，三个 tab 的 `isLoading` 都会在各自读取完成后正确设为 `false`

3. **读取失败时的激活 tab 状态保证**：
   - 原问题：`readFile` 失败时 catch 块依赖闭包中的 `activeTabPath`，可能是旧值，导致失败 tab 被移除后 `activeTabPath` 仍指向已删除路径
   - 修复方案：使用 `setActiveTabPath((current) => current === path ? "" : current)` 函数式更新，基于 React 最新状态判断
   - 保证：读取失败后 `activeTabPath` 一定指向仍然存在的 tab，或为空字符串，不会出现指向不存在路径的状态

4. **tab 加载/保存状态表示**：
   - `EditorDocument.isLoading`：新 tab 创建时 `true`，`readFile` 完成后 `false`
   - `EditorDocument.isSaving`：保存开始时 `true`，`writeFile` 完成后 `false`
   - UI 和编辑锁定均使用 `activeTab.isLoading` / `activeTab.isSaving`

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

## Reviewer Findings

本轮没有通过 review。先不要进入下一轮。

### Must Fix

1. 打开“新文件”时没有 dirty 保护，导致当前未保存内容会在视觉上被直接切走。
现在 `handleOpenFile` 只有“已存在 tab 直接切换”和“新建 tab 并加载”两条路径，但在打开未打开过的新文件前没有检查当前激活 tab 是否 dirty。结果是：当前 tab 改了一半，点另一个未打开文件，界面会立刻切到一个空白新 tab 并开始加载，这与上一轮已经建立的“切换文件前有保护”行为不一致，也不符合编辑器直觉。
定位：
- `src/App.tsx:90-128`

2. 新 tab 在文件内容加载完成前就先插入 `openTabs`，会造成不稳定的中间态。
当前实现先插入 `{ path, content: "", isDirty: false }` 再异步读取。如果读取较慢，用户会看到一个空白 tab；如果这时切到别的 tab，再回来，行为会依赖单一的全局 `loading` 和 `pendingReadRef`，状态模型不稳。任务要求里明确提到每个 tab 应该有独立的基础加载状态或等价信息，但当前 `EditorDocument` 没有承载这部分，导致“正在加载的 tab”和“内容为空的已打开 tab”不可区分。
定位：
- `src/App.tsx:99-111`
- `src/App.tsx:48-51`
- `src/types.ts:12-16`

3. `loading` 和 `saving` 仍然是全局布尔值，不足以支撑多标签状态。
当前界面一旦任意文件在加载，所有 tab 对应的编辑器都会进入 `editable={!loading}` 的全局锁定状态；保存也是全局 `saving`。这会让多标签模型和实际 UI 行为脱节，也和本轮要求的“每个 tab 必须独立保存自己的基础加载状态或等价信息”不一致。
定位：
- `src/App.tsx:48-49`
- `src/App.tsx:102`
- `src/App.tsx:134`
- `src/App.tsx:364`

### Should Fix

1. `TabBar` 仍然大量使用 inline style，组件虽然拆出来了，但样式没有进入现有 CSS 体系，后面继续扩展会比较难维护。
这不是阻塞功能的问题，但建议趁这一轮把 tab 栏样式并入 `App.css` 或独立样式文件。
定位：
- `src/components/TabBar.tsx:13-53`

2. 打开新项目时没有对“已有 dirty tabs”做任何保护。
现在 `handleOpenFolder` 会直接清空 `openTabs`。虽然本轮主任务是多标签，不一定强制要求这里做复杂交互，但至少应记录为已知限制，不能默认当作完整 IDE 行为。
定位：
- `src/App.tsx:74-88`

### Review Summary

- `Data Flow`: 部分通过，去重和基本 tab 切换逻辑是对的。
- `Reliability`: 未通过，dirty 保护范围不完整，加载状态模型不稳。
- `UI/Editor Behavior`: 未通过，打开新文件时会出现空白中间态和全局 loading 锁定。
- `Code Quality`: 未通过，当前状态设计还不足以作为后续 Recent Files / Save All 的稳定基线。

---

## Claude Follow-up Task

Claude 下一轮只修本次 review 问题，不要进入下一轮功能。

需要完成：
- 在打开未打开过的新文件前，也要对当前 dirty tab 做保护，不能只在关闭 tab 时保护
- 调整 tab 状态模型，让“正在加载的 tab”可区分，不要只依赖全局 `loading`
- 调整保存状态模型，避免继续完全依赖全局 `saving`
- 至少做到“当前激活 tab 的加载/保存状态”与其他 tab 可区分，不能因为一个 tab 读取中就把整个编辑器模型锁成单全局状态
- 如果保留“先插入 tab 再加载内容”的策略，就必须显式表示 `isLoading` 或等价状态，并让 UI 行为自洽
- 在 `Claude Implementation Report` 里明确说明：
  - dirty 保护覆盖了哪些入口
  - tab 的加载状态如何表示
  - 保存状态如何表示
- 更新 `Claude Implementation Report`

本轮完成后，再让我重新 review。

---

## Reviewer Outcome

本次返工仍未通过，而且 `Claude Implementation Report` 与实际代码不一致。

### Blocking

1. 上一轮要求修的 3 个核心问题实际没有落地。
当前代码里仍然是：
- 打开新文件前没有 dirty 保护
- `EditorDocument` 里没有 tab 级 `isLoading` / `isSaving` 或等价状态
- `loading` / `saving` 仍然是全局布尔值

定位：
- `src/App.tsx:90-128`
- `src/App.tsx:41-51`
- `src/App.tsx:131-148`
- `src/types.ts:12-16`

2. `Claude Implementation Report` 没有更新成这次返工后的真实状态。
报告仍然在描述第一次实现多标签时的内容，没有回答上次明确要求的这几个点：
- dirty 保护覆盖了哪些入口
- tab 的加载状态如何表示
- 保存状态如何表示

### Required Next Action

Claude 下一次必须先修实现，再修报告，不要只改 `TASK.md` 状态。

必须完成：
- 真正补上打开新文件前的 dirty 保护
- 真正引入 tab 级加载状态，或提供等价且可验证的状态模型
- 真正让保存状态至少能区分当前激活 tab，而不是继续只用单全局布尔值
- 更新 `Claude Implementation Report`，内容必须和代码一致

如果下次 review 里代码仍然没有覆盖这些点，我会直接把任务拆得更细，不再接受“报告声称已完成”。

---

## Reviewer Outcome 2

本次返工比上一版更接近目标，但仍未通过。主要问题已经从“状态没做出来”变成“多标签语义做错了”。

### Blocking

1. 多标签模式下，不应该因为当前 tab 是 dirty 就阻止“切换 tab”或“打开另一个文件”。
现在实现里：
- `handleSwitchTab` 会在当前 tab dirty 时弹确认，阻止切换
- `handleOpenFile` 在打开新文件前也会调用相同保护

这和多标签编辑的基本语义冲突。因为切换 tab 或打开新文件并不会丢失当前 tab 的内容，dirty 内容本来就应该保留在原 tab 里。现在这种行为相当于把“单文档覆盖式切换”的保护逻辑错误搬到了多标签模型里。
定位：
- `src/App.tsx:69-77`
- `src/App.tsx:97-107`
- `src/App.tsx:154-161`

正确行为应当是：
- 切换到已打开 tab：不需要 dirty 确认
- 打开新文件到新 tab：不需要 dirty 确认
- 关闭 dirty tab：需要确认
- 打开新项目并清空现有 tabs：可以确认

2. 并发打开多个新文件时，先发起的 tab 可能永久停留在 `isLoading: true`。
当前仍然使用单个 `pendingReadRef` 追踪最近一次读取。假设先打开 A，再很快打开 B：
- A tab 被创建并设为 `isLoading: true`
- B 打开后把 `pendingReadRef.current` 改成 B
- A 的请求返回时，因为 `pendingReadRef.current !== "A"`，直接 `return`
- 结果 A tab 的 `isLoading` 不会被清掉，可能永久卡住

这对多标签是阻塞问题，因为“同时快速打开多个文件”正是 tab 场景下的高频行为。
定位：
- `src/App.tsx:48`
- `src/App.tsx:112-128`

正确方向应当是：
- 不要用单个全局 `pendingReadRef` 管理所有 tab 的读取生命周期
- 至少要按路径管理读取完成与失败，保证每个 tab 自己的 `isLoading` 最终会落回 `false`

### Should Fix

1. `Claude Implementation Report` 现在虽然比上一轮更接近真实代码，但“当前实现是否完全满足 Acceptance Criteria: 是” 这个结论仍然不成立。
因为上面的两个阻塞问题会直接影响：
- “可以在多个 tab 之间切换”
- “Finder 打开文件时遵守同样的 tab 规则”
- “当前 tab 的编辑内容和 dirty 状态正确保留”

### Review Summary

- `Data Flow`: 部分通过，tab 级状态已经开始形成。
- `Reliability`: 未通过，并发打开文件时 loading 生命周期不正确。
- `UI/Editor Behavior`: 未通过，多标签切换语义错误。
- `Code Quality`: 比上一版好，但还不能作为 `v1.2` 的合格交付。

### Required Next Action

Claude 下一次只修这两个问题，不要再扩展范围：

- 去掉“切换 tab / 打开新文件前的 dirty 确认”，保留“关闭 dirty tab / 打开新项目前”的确认
- 修正多文件并发打开时每个 tab 的 `isLoading` 生命周期，不能再依赖单个全局 `pendingReadRef`
- 更新 `Claude Implementation Report`，确保结论和代码一致

本轮修完后，再让我重新 review。

---

## Reviewer Outcome 3

本次返工大部分问题已经修正，但还有一个阻塞 bug，`v1.2` 还不能过。

### Blocking

1. 打开新文件读取失败时，`activeTabPath` 可能残留为一个已经被移除的 tab。
现在 `handleOpenFile` 里先 `setActiveTabPath(path)`，然后异步 `readFile(path)`。如果读取失败，catch 里会把这个 tab 从 `openTabs` 删除，但是否重置 `activeTabPath` 取决于闭包里的旧 `activeTabPath`：

- 新开文件时，闭包里的 `activeTabPath` 往往还是打开前的旧值
- catch 中 `if (activeTabPath === path)` 可能不会成立
- 结果：失败 tab 被删了，但 `activeTabPath` 仍然指向这个已不存在的路径
- 后续 `activeTab` 会变成 `null`，UI 进入不一致状态

定位：
- `src/App.tsx:88-121`

正确方向：
- 读取失败后，不能依赖旧闭包里的 `activeTabPath` 判断
- 应该基于最新状态明确决定失败 tab 被移除后的激活目标
- 至少要保证：失败后 `activeTabPath` 一定指向仍然存在的 tab，或为空字符串

### Review Summary

- `Data Flow`: 通过
- `Reliability`: 未通过，失败路径里的 tab 激活状态仍不稳定
- `UI/Editor Behavior`: 接近通过，但读取失败会破坏当前 tab 选择状态
- `Code Quality`: 可接受，只剩失败分支收尾问题

### Required Next Action

Claude 下一次只修这个失败路径问题，不要再改别的功能。

需要完成：
- 修复 `handleOpenFile` 读取失败后的 `activeTabPath` 收尾逻辑
- 更新 `Claude Implementation Report`，明确说明失败读取时如何保证激活 tab 状态正确

修完后再让我重新 review。

---

## Reviewer Outcome Final

本次返工后，`v1.2` 通过。

### Passed

- 多标签去重、切换、关闭逻辑已经成立
- dirty 保护语义已修正：
  - 切换 tab 不再错误拦截
  - 打开新文件到新 tab 不再错误拦截
  - 关闭 dirty tab 和打开新项目时仍会确认
- tab 级 `isLoading` / `isSaving` 已落地
- 并发打开多个文件时，每个 tab 的 `isLoading` 生命周期可以独立结束
- 读取失败后，`activeTabPath` 不会再残留为不存在的路径

### Residual Notes

- 当前读取失败后的处理是把激活 tab 清空为 `""`，不会自动恢复到之前那个 tab。这个行为是一致的，但不是最优体验；可以放到后续 tab 体验打磨里再优化。
- `TabBar` 仍然使用 inline style，这不是阻塞项。

### Review Summary

- `Data Flow`: 通过
- `Reliability`: 通过
- `UI/Editor Behavior`: 通过
- `Code Quality`: 通过，可进入下一轮

### Next Step

- 可以进入下一轮
- 建议方向仍然是：
  - Recent Files
  - 保存全部
  - tab 使用体验打磨

---

## Next Iteration Placeholder

下一轮默认方向：
- Recent Files
- 保存全部
- tab 使用体验打磨
