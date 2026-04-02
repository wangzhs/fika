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
- Status: `ready_for_implementation`
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

- 改了哪些文件：
- 新增了哪些前后端接口：
- 当前实现是否完全满足 `Acceptance Criteria`：

### Self-Check

- [ ] 打开项目时只加载文件树
- [ ] 点击文件时按需读取
- [ ] 可以保存当前文件
- [ ] `Cmd/Ctrl+S` 已接入
- [ ] 读取失败时有错误处理
- [ ] 保存失败时有错误处理
- [ ] `npm run build` 通过

### Known Issues

- 如无问题，写 `None`

### Notes For Reviewer

- 列出你认为 review 时最值得重点检查的 2-5 个点

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

## Next Iteration Placeholder

下一轮默认方向：
- 多标签编辑
- 脏状态
- tab 关闭与切换
