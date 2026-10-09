# 共享任务工作流

ProfilePilot 在 Agent → 模板中发现本机已安装的工作流。选择工作流、填写参数后可直接创建任务，或保存为可重复使用的参数模板。业务说明和脚本来自同一份 Skill，Codex、Claude Code 使用自己的工具执行。

## 安装与发现

首批工作流位于相邻的 `my-agent-skills` 仓库：`job-search`、`price-trend`、`xianyu-monitor`。Windows 在该仓库运行 `powershell -NoProfile -File scripts/install-workflows.ps1`；其他平台使用该仓库的 skills CLI 安装方式。安装器使用仓库 → `~/.agents/skills` → 客户端目录两级链接，拒绝覆盖外部同名目录。

发现顺序为 `~/.agents/skills`、`$CODEX_HOME/skills`（未设置则 `~/.codex/skills`）、`~/.claude/skills`。相同真实目录去重，同名工作流使用较优先目录。测试可用 `PROFILEPILOT_SKILL_ROOTS` 覆盖，多个路径用系统路径分隔符分开。安装或更新后点击“刷新工作流”。

## 包格式

`SKILL.md` 保存跨客户端业务步骤；`references/` 保存数据约定；`scripts/` 放确定性的分析与导出程序。`agents/profilepilot.json` 是 ProfilePilot 专用的表单扩展，包含 `schemaVersion: 1`、`id`、`version`、`title`、`description`、`goal` 和 `inputs`。目录名、Skill 的 `name` 和表单 `id` 必须一致。

每个参数包含 `key`、`label`、`type`（text / textarea / select），以及可选 `required`、`placeholder`、`default`、`options`。任务保存 `{id, parameters}`；创建时校验参数并捕获 Skill 内容哈希及快照，运行中的任务不受全局 Skill 更新影响。重试和分支沿用原快照，新建任务加载当前版本。

快照最多 200 个文件、2 MB，只包含入口、agents、references、scripts、assets 和 requirements.txt。资源链接不能越出 Skill 目录。账户凭据、数据库和运行产物放在包外。

## 执行与产物

任务上下文包含所选 Skill 的说明、参数、快照路径和版本。现有 `Read` 可读取其快照资源，`terminal_run` 在任务目录执行脚本。Skill 不改变终端或浏览器的授权规则。

`register_outputs` 将任务工作目录中的 HTML、PNG、SVG、CSV、JSON、Markdown、TXT、PDF 复制到持久产物目录。同一批保持文件名与同级链接，单个文件上限 50 MB，一批最多 20 个；路径不能越出任务目录。HTML 引用同级文件时一并登记。plan 模式不执行脚本或登记产物。

Python 脚本要求 3.10+。求职报告和闲鱼适配器只用标准库；价格图需要 `price-trend/requirements.txt` 的 Matplotlib。依赖缺失时由任务使用自己的虚拟环境安装。

闲鱼适配器已对接现有项目的 API 与 `price_snapshots` 数据表。数据库以只读方式打开；创建和启动默认 dry-run，只有 `--apply` 执行请求。任务是否启用、是否设 cron 沿用原项目语义。

价格分析保留真实采样日期、来源、市场、币种、成色和价格类型；不同口径不混算。来源月均价不能转成每日观测；缺失时段断线。交付离线 HTML、PNG/SVG、CSV、归一化数据及覆盖报告。历史来源覆盖不足时只交付实际覆盖，不能从实时查询补出两年历史。

## 本地验证与预览

在 ProfilePilot 仓库执行：

```text
npm run build
node --test tests/task-skills.test.js tests/browser-tasks.test.js tests/browser-task-ipc.test.js
node scripts/e2e-task-skills.mjs
node scripts/start-workflow-preview.mjs
```

E2E 使用隔离的用户数据，验证工作流发现、必填参数、保存与恢复、页面切换、工作流切换和任务快照；不调用模型或执行真实求职/监控任务。共享脚本在 my-agent-skills 中执行 `python -X utf8 -m unittest discover -s tests -v`。

预览启动器要求已构建且 `artifacts/shared-skills/ram-report/report.html` 已生成，启动独立的 ProfilePilot 窗口和 `http://127.0.0.1:18765/` 报告服务。该服务仅供本地预览，不随安装包发布。2026-10-08 的验收报告使用 MemRadar 的 G.Skill Flare X5 32GB DDR5-6000 CL36 美国 USD 月均报价，区间 2024-10 至 2026-09；来源声明和局限见报告，不代表中国大陆报价。
