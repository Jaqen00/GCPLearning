# GCPLearning

GCP学习辅助工具是一个基于 Electron、React 和 TypeScript 构建的桌面应用，用于辅助网络课程学习流程。  
它面向国家药品监督管理局高级研修学院相关 GCP 课程的学习场景，提供独立学习窗口、课程状态识别、播放控制、进度续播与自动推进等能力，帮助用户更顺畅地完成课程学习。

> 本软件仅作为课程播放与操作管理的辅助工具，不能替代真实学习。请以认真学习课程内容为前提合理使用，勿将其用于脱离学习目的的滥用场景。

## 项目背景

在 GCP 课程学习过程中，用户往往会遇到这些问题：

- 课程页面层级较深，进入学习流程较繁琐
- 登录状态可能失效，需要反复确认当前会话是否可用
- 单节课程播放结束后，需要手动切换下一节
- 已有观看轨迹时，恢复进度不够准确，容易从错误位置继续
- 学习窗口与主控操作混在一起时，观看体验不够清晰

这个项目的目标不是替用户“学习”，而是把这些重复、机械、容易出错的播放管理动作整理成一个更清晰的桌面工具：

- 主控界面负责展示当前学习状态与播放设置
- 独立学习窗口负责课程播放，减少界面干扰
- 支持自动推进下一节
- 支持根据观看轨迹恢复到更合理的续播位置
- 支持在独立学习窗口中持续播放，便于用户在不干扰主控界面的情况下继续其他正常操作

核心原则仍然是：**辅助学习流程，而不是替代学习本身。**

## 主界面预览

![GCP学习辅助工具主界面](docs/images/main-ui.png)

## 功能概览

- 独立学习窗口播放课程页面，避免主控界面挤压播放区域
- 自动检测登录状态，并在需要时提示用户先完成登录
- 自动进入课程、识别播放页并监控学习状态
- 支持暂停学习、继续学习、自动推进下一节
- 支持播放页自动静音
- 支持根据观看轨迹恢复到历史学习断点附近继续播放
- 本地保存登录相关 cookie，尽量复用上一次登录状态

## 普通用户如何使用

如果你只是想直接使用软件，而不是自己编译，建议直接前往 GitHub Releases 页面下载对应系统的安装包或可运行文件：

- [前往 Releases 页面下载](https://github.com/Jaqen00/GCPLearning/releases)

一般情况下：

- macOS 用户下载 `.dmg`
- Windows 用户下载 `.exe`

下载后按系统提示完成安装或运行即可。

### 基本使用流程

1. 打开主控界面
2. 点击“开始学习”
3. 程序会自动唤起独立学习窗口
4. 如果当前未登录，请先在学习窗口中完成登录
5. 登录成功后，程序会继续自动进入课程并辅助播放

### 使用提醒

- 请始终以认真学习课程内容为前提使用本工具
- 本工具主要用于辅助播放和操作管理，不建议脱离真实学习场景使用
- 登录状态和播放相关数据仅保存在本机本地目录中

## 技术栈

- Electron
- React
- TypeScript
- electron-vite

## 自行构建

如果你希望自己在本地运行、调试或构建安装包，可以按下面的方式操作。

### 1. 安装依赖

```bash
npm install
```

### 2. 启动开发模式

```bash
npm run dev
```

### 3. 启动生产预览

```bash
npm run preview
```

### 4. 构建应用资源

```bash
npm run build
```

## 安装包构建

当前项目已经接入 `electron-builder`，可以构建直接安装的桌面应用。

本地构建目录版：

```bash
npm run dist:dir
```

本地构建 mac 安装包：

```bash
npm run dist:mac
```

本地构建 Windows 安装包：

```bash
npm run dist:win
```

构建产物默认输出到：

```text
release/
```

如果你只是普通用户，通常**不需要自行构建**，直接从 Releases 下载即可。

## GitHub 发布流程

仓库已预留 GitHub Actions 工作流：

- 手动触发：`workflow_dispatch`
- 自动触发：推送 `v*` 标签时

工作流会分别在：

- `macos-latest` 上构建 `dmg`
- `windows-latest` 上构建 `nsis exe`

发布方式支持两种：

- 手动触发时，可以选择只生成 Artifacts，或者直接创建 Release
- 推送 `v*` 标签时，会自动构建并创建更完整的 Release

示例标签发布流程：

```bash
git tag v0.1.0
git push origin v0.1.0
```

手动触发时建议填写：

- `create_release`: `true`
- `release_version`: 例如 `0.1.0`
- `release_name`: 可选，例如 `GCP学习辅助工具 v0.1.0`
- `release_notes`: 可选，自定义补充发布说明

## 发布说明

当前仓库已经接入：

- `electron-builder`
- GitHub Actions 构建工作流
- GitHub Release 发布流程

因此项目既支持：

- 普通用户直接从 Releases 页面下载安装包
- 开发者本地自行构建
- 维护者通过 GitHub Actions 在线构建并发布版本

## 打包资源

打包图标资源建议放在：

```text
build/
```

常用命名：

- `build/icon.icns`
- `build/icon.ico`

当前仓库已经生成了一套基础图标资源：

- [build/icon.icns](build/icon.icns)
- [build/icon.ico](build/icon.ico)

## 项目结构

```text
.
├── electron
│   ├── main          # Electron 主进程逻辑
│   └── preload       # 预加载脚本 / IPC 桥接
├── shared            # 主进程与前端共享类型和逻辑
├── src               # React 主控界面
├── docs/images       # README 配图等资源
└── out               # 构建输出目录
```

## 说明与提醒

- 本项目定位为课程学习辅助工具，不是绕开学习过程的工具
- 如果后续用于正式分发，建议补充 macOS 签名 / notarization 与 Windows 代码签名
- 欢迎在合法、合规、合理的前提下继续完善本项目
