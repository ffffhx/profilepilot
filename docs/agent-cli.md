# ProfilePilot CLI（`ppilot`）

本机控制按目标分为四组：`ppilot browser`（浏览器）、`ppilot electron`（Electron 应用）、`ppilot desktop`（Windows 原生窗口和系统对话框）、`ppilot phone`（安卓手机）。`ppilot desktop` 不依赖 ClipRelay，macOS 暂不支持此入口；操作流程见[本机桌面控制指引](../skills/profilepilot/references/desktop.md)。配套工具中的 CLI 卡片可点击展开，查看各组用途和命令入口。

Profile 的增删改查、配置与启停归入 `ppilot browser profile <操作>`，例如 `ppilot browser profile list --json`。原来的 `ppilot profile <操作>` 保留兼容。Electron 使用 `ppilot electron list` 查询已接入 Gateway 的应用，再以 `ppilot electron --session TASK --cdp PORT snapshot -i` 操作其页面；PORT 必须是该应用的 Agent 逻辑端口。它与浏览器共用页面引擎和接管机制，但不会选择浏览器 Profile，也不包含原生菜单、托盘或系统对话框控制。

ProfilePilot CLI 的命令名是 `ppilot`，提供 Profile 管理、浏览器操作和内置 Agent 对话等入口。本文介绍内置 Agent 对话与任务命令：它们使用 ProfilePilot 的模型配置、任务记录和浏览器连接。对话命令启动时会连接本机服务；服务未运行时，使用安装 CLI 时保存的启动信息在后台独立启动。任务同时显示在桌面界面，可通过任务 ID 找回。

在桌面应用“配套工具”中点击“安装 ProfilePilot CLI”，同时安装命令工具和 Agent 使用指引（内部 skill ID 为 `profilepilot`）。更新时两者一起检查，已有 CLI 在应用启动时同步配套指引；详情中可查看各组件和客户端的状态。Windows 提供 `ppilot.ps1` / `ppilot.cmd` 启动器，macOS 使用 `ppilot` shell 启动器；安装后新开终端即可运行 `ppilot`。模型也可以在终端的 `/login`、`/config` 中配置。开发环境可用 `node dist/main/profilepilot-cli.cjs` 替代命令名（先执行 `npm run build`）。

在浏览器页面的 Profile“更多”菜单中设置默认 Profile，在手机页面的设备“更多”菜单中设置默认设备。CLI 与界面共用设置：`ppilot browser default --json`、`ppilot browser profile default --json` 和 `ppilot phone default` 可查询；`profile default <名称或ID>`、`phone default --device <ID>` 可设置，`--clear` 可清除。手机普通命令可用 `--device default` 解析当前设备 ID。用户当次指定的目标优先；默认目标不可用时提示处理，不自动换目标。后台操作、用户接管和会话规则统一由 Skill 说明，已有个人文件在更新时保留。

还没保存过个人偏好时，使用 Agent 使用指引自带的 `templates/` 通用默认（后台操作、用户接管与确认时机），新安装即可生效。保存后写入 `local/` 下的同名文件，个人文件优先于模板；更新 ProfilePilot CLI 时模板随指引刷新，个人文件保留且不会被覆盖。

两类个人偏好在更新和移除时保留。移除只归档本应用管理的指引，外部维护的 Skill 或链接保持不变；其版本不一致会在详情中提示，不会被标为全部就绪。

## 控制命令发现与恢复

浏览器扩展诊断使用 `ppilot browser --profile PROFILE_ID doctor`。工具端服务、扩展连接、版本能力与任务控制权分别报告：离线或尚未上报状态时，版本与能力标为尚无法确认，不据此要求更新；收到实际版本与能力且不兼容时才提示更新。安装配对成功是历史结果，不代表扩展当前在线。

使用 `ppilot <入口> schema <命令>` 或 `ppilot <入口> <命令> --help` 查询窄范围契约，例如 `ppilot phone schema action`、`ppilot desktop action --help`。浏览器需按实际连接选择 `--connection extension|gateway`；不同路由的专属命令不要混用。JSON 文件与 stdin 都接受 UTF-8 BOM；手机支持 `--params-stdin`，不能与 `--params-file` 同时使用。PowerShell 的元素引用写作 `'@e123'`。

`ppilot doctor --route electron|desktop|gpui --session TASK` 返回推荐入口、可用操作、控制权状态和下一条命令，也可通过 `--electron NAME_OR_ID`、`--window ID`、`--gpui TARGET_ID` 指定实际目标。Electron `register` 只登记；连接准备使用 `inspect`/`connect`，不会因未登记自动改走桌面控制。足够完成任务的专用 Skill/API 仍优先。

手机恢复结果区分参数错误、未满足前置条件、会话占用、用户接管和在途结果未知。`not-executed` 表示本次操作未发送执行；`unknown` 要先核查结果。浏览器 `NATIVE_FRAME_SESSION_STALE` 与元素过期分开：观察允许一次同目标只读缓存重建，不重放动作或自动交还用户控制权。

浏览器和 Electron 页面动作执行成功后，默认等待 500 ms，再在同一次响应中返回 `actionOutcome: completed`、`observationStatus` 和新的 `observation`。下一步直接使用其中的 `version`、元素引用和页面内容，无需固定追加一次 `observe`。扩展连接保留当前 frame/分页范围及后续读取游标；Gateway 使用当前 frame 的语义快照。等待不代表异步业务已经完成，也不保存弹窗历史；结果尚未出现时仍可按需等待或读取。若观察失败或用户接管，返回 `observationStatus: unavailable`，动作仍标记为已执行，不能为获取快照而重复动作。纯读取、底层 CDP/eval、控制权交接和关闭操作不附加页面观察。

desktop、phone（Android App/basic/iPhone）和 GPUI 的普通输入也默认等待 500 ms 并返回 `actionOutcome`、`observationStatus`、`observation`。desktop 返回 UIA 树及版本；Android App 返回有数量/深度上限的无障碍树；basic 返回 PNG 文件路径及尺寸；iPhone 返回 WDA 树；GPUI 返回树及 `observation.version`。树观察不能替代 desktop/iPhone 坐标输入所需的新截图。各入口支持 `--no-observe`；phone JSON 也可设置 `observeAfter: false`。流程执行、ADB 协议适配及连续跟随控制自行管理观察时机，不在每次底层输入后加等待。Remote 优先使用目标端已有反馈，否则同一会话等待并读取同一目标；其 `--no-observe` 只跳过本机追加读取。所有入口都保留“动作完成、观察失败”的区别，不因读取失败重放输入；短等待不能保证捕获瞬时弹窗或等待异步业务完成。

## 使用统计

控制命令的路由前可加 `--task-kind real|verification`、`--task-id TASK`、`--operation-id STEP`；恢复步骤可加 `--recovery-of STEP`，例如 `ppilot --task-kind verification --task-id ui-check desktop status`。路由后的文本和脚本参数不会被重新解释为统计选项。同一任务/逻辑操作保持相同标识，未标注的任务类型保留为 `unspecified`。

`ppilot trace report --since 14d --task-kind verification --json` 只读汇总各入口的调用、显式操作首次成功率、首次有效操作前的命令数、显式关联恢复耗时和需要用户处理的原因。记录只含白名单元数据与哈希标识，不含正文、URL、图片、凭据或任意错误消息。CLI 统计排除服务端事件，避免双计数；每个入口保留两个 2 MiB 文件，缺失/轮转/窗口边界可能使历史不完整，不能当成完整任务成功率。完整使用约定见[诊断指引](../skills/profilepilot/references/cli-diagnostics.md)。

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
