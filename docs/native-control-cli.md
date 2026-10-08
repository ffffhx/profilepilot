# ppilot browser CLI

浏览器控制统一使用 `ppilot browser`，支持扩展和 Gateway 两种连接，不调用内置模型。在应用中安装一次 CLI 即可使用；Windows 与 macOS 的安装包都内置浏览器驱动，无需另外安装 agent-browser 或 Wrapper。ProfilePilot Skill 提供连接和会话规则。

| 连接 | 适用目标 | 命令示例 |
| --- | --- | --- |
| 扩展（默认） | 日常 Chrome 的已有页面和登录态 | `ppilot browser status` |
| Gateway | 托管 Chrome、已登记的 Electron 应用 | `ppilot browser --session task --cdp PORT snapshot -i` |

`--cdp` 自动选择 Gateway，PORT 必须是目标的 Agent 逻辑端口；也可在命令前显式指定 `--connection extension` 或 `--connection gateway`。路由选项必须放在命令前。两种连接的会话彼此独立；失败、占用或用户接管不会触发自动切换。Gateway 保留 snapshot/click/fill 等驱动命令，status/handoff/resume/complete/release 直接放在同一前缀后，不再需要 `profilepilot` 子命令。查询 `ppilot browser --connection gateway profiles` 获得托管目标；手动调用使用固定的 `--session 任务名`，Agent 主机可自动提供会话身份。

旧 `agent-browser` 和其 Wrapper 继续兼容，属于可选的“其他工具兼容”；新调用统一使用 `ppilot browser`。以下介绍默认的扩展连接。

## 扩展连接

扩展连接通过独立浏览器服务使用当前 Profile 中的扩展，不要求桌面 App 运行。普通扩展命令会自动启动服务。

服务复用安装包自带的 Electron 主进程运行时和系统加密存储，不创建窗口、托盘或模型任务。Windows 通过隐藏的 WMI/CIM 进程启动，macOS 通过独立会话启动并禁止显示 Dock 图标。App 和 CLI 连接同一个服务；退出 App 保留 CLI 会话，仅停止属于 App 的浏览器任务。已有配对凭据和扩展监听端口继续复用。

首次连接可运行 `ppilot browser connect --profile native:Default`，在对应 Chrome Profile 打开返回的安装页 URL；或用 `pair --profile native:Default` 生成配对码，在扩展中粘贴。Profile 目录必须与实际目标一致。`service status` 只检查服务，`service start` 显式启动；结束所有浏览器会话后才能 `service stop`。扩展侧栏的内置 AI 对话仍需要 App，外部 Agent 的浏览器操作不需要。

```sh
ppilot browser --help
ppilot browser status
ppilot browser --profile native:Default tabs
ppilot browser --profile native:Default --session research claim --tab 123
ppilot browser --session research observe
```

`status` 返回实际已配对 Profile 和控制权，不从窗口标题猜登录身份。多个 Profile 已连接时必须明确 `--profile`；仅一个连接时可省略。`claim` 默认选择最后使用窗口的当前普通网页；也可 `--tab ID` 或 `--new-tab`。一个 Profile 由一个任务会话独占，现有任务或用户接管不会被新调用抢占。

## 观察、动作与读取

`observe` 返回 DOM、元素引用和 `version`。每次动作使用最新观察的版本，然后重新观察确认。动作校验所需的 guard、DOM 内部状态保留在应用内，CLI 只输出公开页面内容和可操作的 refs；原有 ref/version 用法不变。下面的 ref/version 应替换为刚返回的值。

`fast.candidates[].semantics` 保留控件的 `effect`、`enterEffect`、搜索/菜单/切换/下载标记和 `command`，帮助调用方识别按钮的实际用途与副作用；页面正文、准确链接和分页信息照常返回。

```sh
ppilot browser --session research action --params-file action.json
ppilot browser --session research observe
```

`action.json`：

```json
{"kind":"fill","ref":"e1","value":"hello","version":"最新观察的 version"}
```

Windows PowerShell 与 macOS shell 都可使用 `--params-file`，避免 shell 对 JSON 引号的处理差异。文件和 `--params-stdin` 接受 UTF-8（带或不带 BOM）；文件读取失败与 JSON 语法错误会分别说明原因。`read --params-file read.json` 接受 `frameId`、`cursor`、`query`、`limit`、`textLimit`，用于 iframe、Shadow DOM 和长页面分页；具体 frames/page/nextCursor 直接来自观察结果。

Windows 安装同时提供 `ppilot.ps1` 和 `ppilot.cmd`。PowerShell 5.1/7 中直接运行 `ppilot` 会优先使用 `.ps1`，保留网址里的 `&`、中文和 JSON 引号，并为本次传入的管道文本使用 UTF-8；不会修改全局 shell 编码。可用 `(Get-Command ppilot).Source` 确认入口。显式调用旧的 `ppilot.cmd` 仍受宿主 cmd 的参数解释影响，复杂网址请使用参数文件。Windows PowerShell 5.1 若绕过 `.ps1` 直接把中文管道传给原生命令，需要在调用作用域设置 `$OutputEncoding = [Text.UTF8Encoding]::new($false)`，或改用 UTF-8 参数文件。

```sh
ppilot browser --session research screenshot --output page.png
ppilot browser --session research open https://example.com
ppilot browser --session research switch 123
ppilot browser --session research newTab
```

`open --params-file navigation.json` 支持 `{"url":"https://example.com/?q=AI&sort=new"}`；`switch --params-file tab.json` 支持 `{"tabId":123}`。显式位置参数优先于文件中的对应字段。

坐标 `pointer` 需要 `observe` 时传 `{"screenshot":true}`，并使用同一观察的 version 和视口坐标。默认输入不会切换标签页或聚焦窗口。冻结/丢弃标签页、系统对话框及浏览器内部页受 Chrome 限制；失败会清楚返回，不通过切前台或重放点击猜测结果。

## 调试与历史

```sh
ppilot browser --session research debug
ppilot browser --session research cdp Performance.getMetrics
ppilot browser --session research events --params-file events.json
ppilot browser --session research history --params-file history.json
```

`debug` 默认启用 Runtime、Network、Log、Performance；`events.json` 可为 `{"since":0,"limit":100}`，后续使用返回 cursor。事件保留最多 1000 条/8 MiB，`dropped:true` 表示已有丢失，`hasMore:true` 表示需要继续翻页。Network 请求/响应体可按事件 requestId 用 `cdp Network.getResponseBody` 读取。

`history.json` 可为 `{"query":"example","startTime":0,"endTime":1790000000000,"maxResults":100}`；时间为毫秒时间戳。搜索的是目标 Profile 浏览历史，不限当前标签页后退列表。

CDP 不再受项目窄白名单限制，子 frame 使用 `--cdp-session ID`；任务会话仍使用 `--session NAME`。可用域由 Chrome `debugger` API 本身决定，扩展无法开放其未提供的域。[Chrome debugger 官方说明](https://developer.chrome.com/docs/extensions/reference/api/debugger)

## 下载和控制权

```sh
ppilot browser --session research download --params-file download.json
ppilot browser --session research handoff
ppilot browser --session research resume
ppilot browser --session research observe
ppilot browser --session research complete
```

`download.json` 可为 `{"url":"https://example.com/report.csv","filename":"report.csv","timeoutMs":60000}`。HTTP(S) 地址用明确的 download ID 跟踪，完成后检查实际文件、登记任务产物并返回可读路径；同名文件由 Chrome uniquify。等待上限 300000ms，超时结果包含已有 ID/token，只能查询或继续等待，不能重复触发。`{"operation":"wait","id":123}`、`search`、`cancel` 操作只接受当前会话的下载。

JavaScript/blob/data 下载使用页面 ref 点击并监听 Page 与 downloads 事件。Chrome 两套事件没有共同 GUID/tabId；同地址并发或无法唯一关联时会拒绝登记，不能承诺所有此类下载都能自动归属。支持明确 URL 时优先使用 URL。[Chrome downloads 官方说明](https://developer.chrome.com/docs/extensions/reference/api/downloads)

`handoff` 保留会话并停输入，`resume` 是显式交还；交还前的观察引用全部失效。`complete` 正常结束，`release` 提前结束。断线、超时与服务重启均不会重放动作。`--request-id ID` 可取得同一次请求的结果；不得用同一个 ID 提交不同参数。

错误以 JSON `{ok:false,code,error}` 返回。退出码：64 输入无效、69 未连接、75 用户接管/会话冲突/旧观察/超时需核查、1 其他浏览器错误。正常返回为 `{ok:true,result}`。

`status` 的 `connected:true` 表示配对连接正常；`taskTabs:true` 还要求扩展版本至少 0.2.0，并提供 tabs、cdp、cdpSessions、history、downloads、sidePanel 能力。旧版仍保留连接和 owner，但 `claim` 会提前返回 `NATIVE_EXTENSION_UPDATE_REQUIRED`（退出码 1），提示更新扩展，不发送控制命令或重新配对。

开发时可运行 `node dist/main/native-control/cli.js`；`--root` 或 `PROFILEPILOT_NATIVE_ROOT` 指向测试的 browser-tasks 目录。普通使用不需要了解本机端口和认证文件。服务未运行时自动启动服务；扩展未连接时明确报错，不会启动另一个 Chrome Profile。

## 验收

```sh
node --test tests/native-control.test.js
node scripts/verify-native-control.mjs
node scripts/verify-browser-service.mjs
```

脚本创建一次性隔离 Profile，通过 Gateway 加载扩展并配对，释放 Gateway lease 后验证真实直接 CLI；不操作日常 Profile。`PP_CONTROL_BUILD` 可指向独立编译目录。Windows 真机已覆盖观察/动作/截图、网络与控制台事件、性能、历史、下载落盘、接管与 WebSocket 断线；macOS 需要在真机执行同一入口，不能用 Windows 结果代替。
