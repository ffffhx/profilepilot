# ProfilePilot CLI（`ppilot`）

ProfilePilot CLI 的命令名是 `ppilot`，提供 Profile 管理、浏览器操作和内置 Agent 对话等入口。本文介绍内置 Agent 对话与任务命令：它们使用 ProfilePilot 的模型配置、任务记录和浏览器连接。对话命令启动时会连接本机服务；服务未运行时，使用安装 CLI 时保存的启动信息在后台独立启动。任务同时显示在桌面界面，可通过任务 ID 找回。

在桌面应用“配套工具”中点击“安装 ProfilePilot CLI”，同时安装命令工具和 Agent 使用指引（内部 skill ID 为 `profilepilot`）。更新时两者一起检查，已有 CLI 在应用启动时同步配套指引；详情中可查看各组件和客户端的状态。Windows 提供 `ppilot.ps1` / `ppilot.cmd` 启动器，macOS 使用 `ppilot` shell 启动器；安装后新开终端即可运行 `ppilot`。模型也可以在终端的 `/login`、`/config` 中配置。开发环境可用 `node dist/main/profilepilot-cli.cjs` 替代命令名（先执行 `npm run build`）。

在“配套工具 → 控制偏好”中，通过“浏览器”和“手机”两个 Tab 编辑 Agent 的操作指引。切换 Tab 保留草稿，保存只作用于当前 Tab；可选择同步到其他 Agent。浏览器偏好继续使用 `local/browser-routing.md`，手机偏好使用 `local/phone-control.md`，Agent 按任务目标读取对应文件。偏好不代替设备授权或暂停/接管机制。

两类个人偏好在更新和移除时保留。移除只归档本应用管理的指引，外部维护的 Skill 或链接保持不变；其版本不一致会在详情中提示，不会被标为全部就绪。

## 连续对话

```sh
ppilot
ppilot --profile "工作 Profile"
ppilot --resume <任务ID>
```

直接运行 `ppilot` 进入全屏对话。第一次用方向键、输入名称搜索和 Enter 选择可用 Profile，之后自动沿用保存的选择。`/profile` 可更换；`--profile` 可指定本次选择，`--resume` 可回到已有任务。

输入任务后会显示执行进度。Agent 提问时直接回答；请求确认时明确选择同意或拒绝；人工操作浏览器后明确交还再继续。任务完成后可以继续补充要求，沿用同一个任务及 SDK 会话。

输入 `/` 显示可搜索菜单，方向键选择、Tab 补全、Enter 执行。输入框固定在底部，回复增量显示，Markdown、代码和 diff 按终端宽度排版，工具结果可以展开。`chat` 需要交互终端；自动化脚本请使用下面的命令。

| 命令 | 用途 |
| --- | --- |
| `/help` | 快捷键帮助 |
| `/clear`、`/resume` | 新对话、搜索恢复历史会话 |
| `/rename`、`/branch`、`/rewind` | 重命名、分支、回到先前用户消息并编辑重发 |
| `/model`、`/plan`、`/permissions` | 模型、计划模式、权限模式与会话授权 |
| `/context`、`/compact` | 上下文/用量、调用模型压缩上下文 |
| `/tasks`、`/agents` | 任务选择、计划/进程/真实子任务状态 |
| `/background` | 当前任务继续在后台运行，终端可处理其他会话 |
| `/profile` | 默认浏览器选择 |
| `/attach`、`/attachments` | 添加文件/图片、查看和移除待发送附件 |
| `/theme`、`/config`、`/login`、`/status` | 主题、配置、隐藏输入凭据、连接检查 |
| `/transcript` | 展开/收起工具输出 |
| `/pause`、`/continue`、`/cancel` | 暂停、继续、取消当前任务 |
| `/exit` | 退出；任务仍在执行时选择暂停或留在后台 |

`/resume` 在交互界面中打开历史选择器；继续当前任务请输入消息或用 `/continue`。非交互的 `ppilot resume <任务ID>` 保留原含义。

### 输入和快捷键

| 按键/输入 | 行为 |
| --- | --- |
| Enter | 发送；执行中输入的消息排队 |
| Ctrl+J、Shift+Enter、反斜杠后 Enter | 换行；Shift+Enter 需要终端发送对应按键序列 |
| ↑ / ↓ | 多行移动；到边界后浏览历史；空输入时 ↑ 可取回排队消息 |
| Ctrl+R | 搜索当前工作目录的持久输入历史 |
| Ctrl+S | 暂存/恢复输入草稿 |
| Ctrl+G | 在 VISUAL/EDITOR 中编辑，退出后返回 CLI；默认 Windows Notepad、macOS vi |
| Ctrl+O、Ctrl+T、Ctrl+B | 工具详情、任务菜单、当前任务转入后台 |
| Shift+Tab、Alt+M | Manual → Accept edits → Plan |
| Alt+P | 选择模型 |
| Alt+V / Ctrl+V | 读取剪贴板图片（终端自身拦截 Ctrl+V 时使用 Alt+V） |
| `@路径` | 文件候选；带空格使用 `@"目录/文件"` |
| `!命令` | 在启动 CLI 的工作目录执行用户明确输入的终端命令 |
| PgUp / PgDn、Ctrl+End | 滚动、回到最新输出 |
| Ctrl+L | 重绘界面 |
| `?`（空输入时） | 显示/收起快捷键 |

大段粘贴保留完整正文，以粘贴块显示；粘贴中的 Enter、Tab 和命令不会提前提交。文件引用与图片在提交前导入任务附件。历史按工作目录保存，草稿持久化默认关闭；本地 CLI 配置不保存模型密钥，密钥沿用应用的系统加密存储。

### 会话和权限

Manual 模式逐次确认写操作；Accept edits 允许编辑，发送、提交等外部操作仍需确认；Plan 模式只读观察和规划。授权菜单只有在后端能确定具体范围时才提供本会话允许，规则可在 `/permissions` 撤销，分支不会继承规则。

回退会改变后续模型上下文并保留原输入供编辑。浏览器上已经执行的动作、外部命令和文件修改不会被撤销，回执仍保留供核查。`/compact` 使用配置的模型生成摘要，产生正常模型用量；原会话记录保留，后续执行使用压缩上下文。

执行中的 Ctrl+C 或 Esc 暂停当前任务，并保留 CLI；空闲时第一次 Ctrl+C 清除输入/提示退出，短时间内第二次退出。空输入双 Esc 打开会话回退。`/exit` 在任务执行中提供暂停后退出和继续后台执行两种选择。

## 提交任务和查看进度

[ppilot browser CLI](native-control-cli.md) 使用 `ppilot browser` 子命令；运行 `ppilot browser --help` 查看说明。例如 `ppilot browser status` 查询扩展连接；后续 claim、observe、action 等命令使用显式会话。该路径不调用模型，接管、旧观察或不确定超时返回专用错误，不自动重放动作。指导 Agent 使用这些工具的说明随 ProfilePilot CLI 一起安装和更新。

```sh
ppilot run --profile "工作 Profile" "打开指定网站，整理页面信息" --follow
ppilot run --profile "工作 Profile" --prompt-file ./prompt.txt --json
ppilot list --json
ppilot show <任务ID> --json
ppilot watch <任务ID>
```

`run` 默认提交后立即返回任务 ID；加 `--follow` 会持续显示进度，直到任务完成、暂停或等待用户。`--prompt-file` 读取 UTF-8 文件（兼容 BOM），`--prompt-file -` 从标准输入读取，可传递多行任务。

创建任务时可指定 `--authorization "授权范围"`、`--minutes 30`、`--actions 200`、`--budget 5`（美元估算上限）。这些设置与桌面任务使用相同的校验和执行规则。

## 回答、确认和继续

```sh
ppilot reply <任务ID> --decision <问题ID> --message "补充的信息" --follow
ppilot reply <任务ID> --decision <确认ID> --approve --follow
ppilot reply <任务ID> --decision <确认ID> --reject --follow
ppilot resume <任务ID> --message "继续处理剩下的内容" --follow
ppilot send <任务ID> "补充要求"
ppilot pause <任务ID>
ppilot takeover <任务ID>
ppilot cancel <任务ID>
```

问题或确认 ID 来自 `show`/`watch` 输出中的 `pending.id`。确认必须对应当前卡片；过期的 ID 会被拒绝。交还浏览器也需要明确确认，或执行 `resume`。执行中的补充要求使用 `send`；已完成的任务使用 `resume --message` 继续。

非交互 `watch` / `run --follow` 中的 Ctrl+C 仅退出跟随，后台任务保留；全屏对话的中断行为见上文。`pause`、`cancel` 不会撤销已完成的外部动作。恢复时会重新核查浏览器和执行记录。

## 脚本输出和退出码

普通命令加 `--json` 返回 JSON；`watch --json` 和 `--follow --json` 按行输出 JSON（NDJSON），适合逐行消费。事件带 ID，进度按游标分页读取。

| 退出码 | 含义 |
| --- | --- |
| 0 | 命令成功，或跟随的任务已完成 |
| 1 | 命令失败，或跟随的任务失败/取消 |
| 2 | 参数不正确 |
| 3 | 跟随的任务需要用户输入、暂停或仅部分完成 |
| 69 | 无法连接桌面应用 |
| 130 | 用户中断终端连接 |

`run` 提交成功的退出码只说明任务已接受。脚本要判断任务结果，应使用 `--follow` 或之后查询任务状态。

任务查询省略截图、网页快照、资料全文和凭据。较长事件会分页返回；超大的任务展示字段会附截断标记。完整记录保存在桌面应用中。CLI 沿用本机管理服务的认证和 Windows named pipe / macOS Unix socket，模型和浏览器由共享任务服务管理。
