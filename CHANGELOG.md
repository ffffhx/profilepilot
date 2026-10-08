# ProfilePilot 更新日志

这里记录用户能够感知的新功能、改进、修复和不兼容变更。开发中的内容先写入 `Unreleased`，正式发布时再归入对应版本。

## [Unreleased]

### 新增

- 五个常驻工作区：Agent、浏览器、本地应用、手机和配套工具，切换时保留页面与草稿。
- 逐步高亮的新手引导：实际定位 Tab、按钮与内容，支持章节跳转、跳过和重新查看。
- 独立浏览器服务、统一 `ppilot` CLI、Agent 使用指引与浏览器 / 手机控制偏好。
- Android 11+ 手机控制与移动工作区：USB / Wi-Fi 连接、任务提交、进度与结果、确认与接管。
- 发布固定签名的 `ProfilePilot-android.apk` 及 SHA-256 校验文件，桌面安装包附带相同 APK。
- 增加本地结构化诊断日志，自动脱敏并滚动保留，方便定位主进程、Gateway 和管理操作问题。
- 管理 CLI 增加 `profilepilot logs`，支持按级别、时间范围筛选、持续追踪及 JSON 输出。
- 管理 CLI 增加 `profilepilot doctor`，统一检查桌面应用连接、版本、运行环境和最近错误。

### 改进

- 官网和 README 更新当前工作区、上手步骤、真实截图与 Android 下载入口。
- 发布流程分别使用 Apple Silicon 与 Intel 构建机，明确安装 Electron 运行时；所有平台测试通过后发布。
- Windows 终端直接加载基础 PowerShell 模块，避免干净环境中的首次命令执行长时间等待模块扫描。
- Android 发布版不包含 debug 测试页面。开发版与发布版签名不同，不能直接互相覆盖安装；切换前保存所需资料并准备重新配对。
- CLI 与桌面应用统一从 `package.json` 获取版本，避免发布时出现版本不一致。
- GitHub Release 改为直接使用本文件中的对应版本说明。

## [0.1.0] - 2026-06-08

### 新增

- 首个公开版本。
- 支持管理本机 Chrome Profile、独立 Profile、扩展和代理路由。
- 提供 ProfilePilot Gateway，让 Agent 在明确的 Session 和控制权边界内复用真实浏览器环境。
- 支持 agent-browser、Playwright CLI 和 Chrome DevTools MCP 集成。

[Unreleased]: https://github.com/ffffhx/profilepilot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ffffhx/profilepilot/releases/tag/v0.1.0
