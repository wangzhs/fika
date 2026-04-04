# Fika

[English](./README.md)

Fika 是一个轻量桌面代码编辑器，适合喜欢高密度、键盘优先工作流，但不想背上完整 IDE 复杂度的开发者。

它主要解决这几个核心动作：

- 快速打开项目
- 浏览和编辑文件
- 快速搜索和跳转
- 查看 Git 历史和差异

## Fika 是什么

- 一个面向本地代码库的桌面编辑器
- 一个专注于导航、搜索和 Git 审查的工作区
- 适合终端优先和 AI 辅助开发工作流

## Fika 不是什么

- 不负责 run / debug / build 编排
- 不提供完整 LSP 重构能力
- 不做插件市场
- 不做复杂项目初始化流程

## 当前功能

### 项目与文件

- 从系统对话框打开项目
- 在新窗口打开项目
- 最近项目
- 左侧项目树和文件夹展开状态
- 支持把文件或文件夹拖进应用直接打开
- 多标签编辑
- 保存当前文件 / 全部保存
- 关闭标签和退出应用时处理未保存状态

### 导航与搜索

- 文件查找
- 最近文件
- 文件内查找
- 项目内全文搜索
- 前进 / 后退跳转历史
- 面包屑导航

### 编辑器与预览

- 常见语言语法高亮
- Markdown 预览
- 图片预览
- 面向桌面场景的高密度暗色 UI

### Git

- 当前分支展示
- 分支切换
- 工作区改动查看
- 文件 diff
- 仓库 / 文件夹 / 文件历史
- Blame
- Stage / Unstage
- Commit
- 单文件回退到 Git 版本

### 分发

- macOS 和 Windows 安装包
- 应用内检查更新
- 基于 GitHub Release 的自动更新链路

## 快捷键

- `Cmd/Ctrl + O` 打开项目
- `Cmd/Ctrl + W` 关闭当前标签
- `Cmd/Ctrl + S` 保存当前文件
- `Cmd/Ctrl + Shift + S` 全部保存
- `Cmd/Ctrl + Shift + N` 按文件名查找文件
- `Cmd/Ctrl + E` 最近文件
- `Cmd/Ctrl + F` 当前文件内查找
- `Cmd/Ctrl + Shift + F` 项目内全文搜索
- `Cmd + Shift + P` 在 Markdown 文件里切换编辑 / 预览
- `Cmd/Ctrl + D` 在 Git 视图中对当前选中项执行对比

## 截图

等界面再稳定一点后补。

## 开发

### 环境要求

- 推荐 Node.js 20.19+
- Rust toolchain
- 对应平台的 Tauri 环境

### 本地运行

```bash
npm install
npm run tauri dev
```

### 构建检查

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

### 打包

```bash
npm run bundle:mac
npm run bundle:windows
```

也可以使用辅助脚本：

```bash
./scripts/package.sh mac
./scripts/package.sh windows
```

## 更新与发布

自动更新和发布说明见：

- [UPDATER.md](./UPDATER.md)

本地专用的发版辅助脚本不会进入仓库历史。

## 路线

Fika 仍在持续打磨中，当前重点是：

- 继续优化编辑体验
- 收紧 macOS 和 Windows 的桌面行为
- 提高发布与自动更新稳定性
- 保持界面快速、克制、聚焦

## 许可证

MIT
