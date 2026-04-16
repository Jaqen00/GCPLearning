# GCPLearning

GCP学习辅助工具是一个基于 Electron、React 和 TypeScript 构建的桌面应用，用于辅助网络课程学习流程。  
它会在独立学习窗口中打开课程页面，帮助用户完成学习窗口唤起、课程状态识别、播放控制、进度续播和自动推进等操作。

> 本软件仅用于辅助课程播放与操作管理，请以认真学习课程内容为前提，合理使用，避免滥用。

## 主界面预览

![GCP学习辅助工具主界面](docs/images/main-ui.png)

## 当前功能

- 独立学习窗口播放课程页面，避免主控界面挤压播放区域
- 自动检测登录状态，并在需要时提示用户先完成登录
- 自动进入课程、识别播放页并监控学习状态
- 支持暂停学习、继续学习、自动推进下一节
- 支持播放页自动静音
- 支持根据观看轨迹恢复到历史学习断点附近继续播放
- 本地保存登录相关 cookie，尽量复用上一次登录状态

## 技术栈

- Electron
- React
- TypeScript
- electron-vite

## 本地开发

先安装依赖：

```bash
npm install
```

启动开发模式：

```bash
npm run dev
```

启动生产预览：

```bash
npm run preview
```

构建应用资源：

```bash
npm run build
```

## 安装包构建

当前项目已经接入 `electron-builder`，可生成直接安装的桌面应用。

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

## 使用说明

1. 打开主控界面后，点击“开始学习”
2. 程序会自动唤起独立学习窗口
3. 如果当前未登录，请先在学习窗口中完成登录
4. 登录成功后，程序会继续自动进入课程并辅助播放

## 说明与提醒

- 登录状态和播放相关数据仅保存在本机本地目录中
- 应用当前以辅助学习流程为目标，不建议脱离真实学习场景使用
- 后续可以继续接入安装包打包、自动更新和 GitHub Actions 发布流程
