# ProfilePilot 更新日志

这里记录用户能够感知的新功能、改进、修复和不兼容变更。开发中的内容先写入 `Unreleased`，正式发布时再归入对应版本。

## [Unreleased]

### 新增

- 增加本地结构化诊断日志，自动脱敏并滚动保留，方便定位主进程、Gateway 和管理操作问题。
- 管理 CLI 增加 `profilepilot logs`，支持按级别、时间范围筛选、持续追踪及 JSON 输出。
- 管理 CLI 增加 `profilepilot doctor`，统一检查桌面应用连接、版本、运行环境和最近错误。

### 改进

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
