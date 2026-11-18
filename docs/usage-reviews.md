# 使用复盘

设置 → 使用复盘提供每日工具建议与每周工作流整理。新安装默认关闭，开启后默认按本地时区每天 21:00 运行、周日整理；时间、时区、星期和来源可以修改。立即运行不改变自动安排。

每份报告最多包含三条工具建议和一个工作流候选，附观察、建议、验证方法和来源片段。没有可靠发现时可以没有建议。采纳、不适用、已有方案与备注持久保存，供之后的分析和去重使用；采纳不代表修改已实施。工作流可以导出为本地 Markdown 草稿，不会安装 Skill、修改 AGENTS.md 或执行原对话中的命令。

## 数据与模型

- 工具调用复用 `control-diagnostics` 的有限容量元数据，覆盖 browser、electron、desktop、phone（含 Android/iPhone）、gpui、remote 等已有路由。排除显式标记的 verification 调用，保留 unspecified 的不确定性；不能据此推断全天任务成功率。
- ProfilePilot 来源读取保存的任务对话；Codex 来源读取 `CODEX_HOME/sessions`（默认 `~/.codex/sessions`），Claude Code 来源读取 `CLAUDE_CONFIG_DIR/projects`（默认 `~/.claude/projects`）。不读取云端聊天、隐藏推理、图片和附件正文，也不跟随对话中出现的路径或指令。
- 每个外部来源最多检查最近修改的 60 个会话文件，单文件读取最多末尾 1 MiB。每会话取首条和末尾记录，来源各有字符预算；报告标出缺失、截断与样本限制。长会话的前文可能未覆盖。
- 常见凭据格式被脱敏，网址查询参数被移除；这不等于完全匿名化。选中的对话片段会发给现有 Agent 配置的模型服务，产生模型用量。模型只返回受校验的 JSON，没有工具执行权限；无记录时不调用模型。
- 模型引用不存在的证据、只有调用计数却生成工作流、格式不完整等结果会被拒绝。单会话工作流始终标为初步候选。建议的原因与收益仍需后续验证。

DeepSeek 与 Kimi 的有界复盘请求关闭额外思考，输出预算保留给完整 JSON；这只影响复盘请求，不修改日常 Agent 配置。DeepSeek 参数依据其 [Anthropic 兼容接口文档](https://api-docs.deepseek.com/guides/anthropic_api/)。

数据位于应用任务数据目录的 `usage-reviews/`：`index.json` 保存安排、反馈和最近 90 份报告索引；独立 JSON 保存报告与有限证据，`drafts/` 保存导出的草稿。不会把个人记录写入代码仓库。旧报告文件保留在本地，当前界面只展示最近 90 份。

## 调度与恢复

调度由应用后台任务服务运行，每分钟检查到期工作，关闭应用后暂停。重新启动时合并补跑最近一周内未覆盖的日报，并生成最近一期到期周报，不逐天重复计费。报告显示实际覆盖时间。每日、每周分别按本地日期持久去重；同一时间只进行一次分析。

每次模型请求最长 90 秒；失败按一小时退避，同一自动周期最多尝试三次，也可以手动重试。退出应用会取消请求，保留失败状态，启动后重新检查。损坏的索引不覆盖，复盘停用并报告错误，其他任务继续可用。

日期使用 IANA 时区与 `Intl` 计算，支持 Windows/macOS 和夏令时；文件与原子写入使用 Node 路径接口。模型设置、系统凭据存储和应用退出复用现有机制。

## 验证入口

```text
npm run check
node --test tests/usage-review.test.js tests/browser-task-ipc.test.js tests/task-management.test.js tests/task-shutdown.test.js
npm run build
node scripts/e2e-usage-reviews.mjs
```

界面验收使用隔离数据、本地模型响应夹具和后台语义操作，记录实例身份并清理自身进程。真实模型质量需要在使用中结合反馈继续验证。

本机认证管理 API 提供 `task.review.status`、`task.review.configure`、`task.review.run`、`task.review.report`、`task.review.feedback`，与界面共用服务。`run` 返回运行状态，之后通过 status/report 查询结果；连接超时不自动重放。没有新增或改变设备控制 CLI 的命令与授权行为。
