# Agent Overlay 工程设计

本文记录 ProfilePilot 的「AI 操作可见化 + 人工接管」实现，读者是后续维护者。当前实现主要落在：

- `src/main/profile-manager.ts`
- `src/main/agent-overlay.ts`
- `src/main/overlay-script.ts`
- `src/main/session-tail.ts`
- `src/main/session-context.ts`
- `src/main/process-scan.ts`
- `src/shared/types.ts`
- `src/renderer/main.ts`

## 背景与用户故事

ProfilePilot 允许 agent-browser、Codex、Claude Code 等工具通过 CDP 操作真实 Chrome Profile。问题是人打开同一个浏览器时，很难判断当前是谁在操作、操作到哪一步、是否还能安全接手。

目标用户故事：

1. 当 AI 经 agent-browser/CDP 操作某个 Profile 时，人打开浏览器页面即可看到一个状态条。
2. 状态条展示 agent、项目、会话、当前动作、计划进度、下一步和最近消息。
3. 多个 agent 会话同时连接同一 Profile 时，状态条展示会话列表，并把最近活跃会话作为主会话。
4. 人需要接管时，可以在页面里二次点击确认，ProfilePilot 结束对应 AI 驱动连接，Chrome 页面保持打开。
5. 接管事件进入持久历史，并通过主 UI toast/通知区反馈。

## 架构

```mermaid
flowchart TD
  Renderer[Renderer loadState 轮询<br/>主窗口 3s / mini 2.5s] --> GetState[ProfileManager.getState]
  GetState --> Runtime[扫描运行态 Profile / 外部实例]
  Runtime --> Clients[getCdpClientsByPort<br/>lsof ESTABLISHED + session context]
  Clients --> Filter[排除 Chrome 自身与 ProfilePilot 自连接]
  Filter --> Ports[agentOverlayPorts<br/>只保留 agent-browser / Codex / Claude Code / 带 agent 字段的客户端]
  GetState --> Sync[AgentOverlayManager.sync]
  Ports --> Sync

  Sync --> Tailers[SessionTailer per session]
  Tailers --> Activity[AgentActivity<br/>Claude jsonl / Codex rollout 增量解析]
  Sync --> BrowserCdp[Browser CDP 连接<br/>/json/version browser websocket]
  BrowserCdp --> TargetObserver[Target.setDiscoverTargets]
  TargetObserver --> PageTargets[/json/list page targets]
  PageTargets --> Injectable{可注入页面?}
  Injectable -- 否 --> Skip[跳过 chrome:// / devtools / extension 等]
  Injectable -- 是 --> PageCdp[Page CDP 连接]
  PageCdp --> Inject[Page.addScriptToEvaluateOnNewDocument<br/>Runtime.addBinding<br/>Runtime.evaluate bootstrap]
  Inject --> Shadow[页面 closed Shadow DOM 状态条<br/>aria-hidden=true]

  Activity --> Payload[OverlayPayload 全量构建]
  Sync --> Payload
  Payload --> Push[Runtime.evaluate<br/>__ppAgentOverlayUpdate(payload)]
  Push --> Shadow

  Shadow -- stop binding --> Binding[Runtime.bindingCalled<br/>__ppAgentOverlaySignal]
  Binding --> Drivers[findStopDrivers]
  Drivers --> Stop[ProfileManager.stopAgentOverlaySession]
  Stop --> Disconnect[disconnectCdpClient / terminateCdpClient<br/>SIGTERM 后 SIGKILL 兜底]
  Disconnect --> Takeover[AgentTakeoverEvent]
  Takeover --> Registry[profiles.json takeoverHistory<br/>最多 50 条]
  Takeover --> UiEvent[IPC profiles:agent-takeover]
  UiEvent --> Notice[Renderer toast / 最近接管 / 历史弹窗]
```

## 运行链路

### 1. 发现 AI 驱动连接

`ProfileManager.getState()` 是入口。渲染层在主窗口每 3 秒、mini 窗口每 2.5 秒调用一次。主进程在已有运行态扫描基础上收集所有可用 CDP 端口，然后调用 `getCdpClientsByPort()` 查找连接到这些端口的外部客户端。

当前客户端发现依赖 `lsof -nP -iTCP -sTCP:ESTABLISHED -Fpcn`。它只认「客户端本地随机端口 -> 远端 CDP 端口」这一侧，随后排除 Chrome 自身进程与 ProfilePilot 自己的只读观测连接。`resolveClientContexts()` 再用进程命令行、cwd、agent-browser socket、Claude/Codex 会话档案补齐 `agent/project/title/session/lastActive/note`。

进入 overlay 的客户端由 `isAgentOverlayClient()` 判断：只要 `client.agent` 有值，或 `label` 是 `agent-browser`、`Codex`、`Claude Code`，就会被纳入。

### 2. 同步端口状态

`AgentOverlayManager.sync({ enabled, ports })` 维护一个按 CDP 端口索引的 `PortOverlay`：

- 开关关闭时，停止所有 `SessionTailer`，拆掉页面注入，清空端口状态。
- 开关开启时，新增、更新、删除端口状态，并把仍处于 `takenOver` keepalive 窗口的端口保留一小段时间。
- 如果同端口重新出现 AI 客户端，`takenOver` 状态会清除，下一轮 push 回到 `active`。
- 每次 sync 都会尝试建立 browser 级 CDP 观察连接、同步 page targets、向已注入页面推送 payload。

`takenOver` keepalive 当前是 7 秒，用于 AI 进程被杀后仍让页面短暂显示「已接管」。

### 3. 页面注入与推送

对每个可注入 page target，`AgentOverlayManager` 会：

1. 连接该 target 的 `webSocketDebuggerUrl`。
2. `Page.enable`。
3. `Page.addScriptToEvaluateOnNewDocument`，保证后续导航也会安装 overlay。
4. `Runtime.enable`。
5. `Runtime.addBinding({ name: "__ppAgentOverlaySignal" })`，供页面向主进程发 `hide/stop` 信号。
6. `Runtime.evaluate` 立即执行 bootstrap，让当前页面也显示状态条。
7. 通过 `Runtime.evaluate` 调用 `window.__ppAgentOverlayUpdate(payload)` 推送后续状态。

页面端脚本创建一个 fixed host，并挂 closed Shadow DOM。host 设置 `aria-hidden="true"`，减少 agent 通过 accessibility snapshot 读页面时把 overlay 当作业务页面内容的概率。状态条仍是视觉元素，所以截图里会看见它，这是该特性的目标行为。

不可注入页面会被跳过：`chrome:`, `devtools:`, `chrome-extension:`, `edge:`, `about:chrome`, `view-source:chrome`。

### 4. 会话活动解析

`SessionTailer` 只对带 `session` 的客户端启动。当前能定位的会话格式：

- `cc-<uuid>`：定位到 `~/.claude/projects/**/<uuid>.jsonl`。
- `cx-<uuid>`：定位到 `~/.codex/sessions/**/rollout-*.jsonl`，优先使用正在被 Codex 进程打开的 rollout。

读取策略：

- 启动后每 2 秒轮询，同时尽量注册 `fs.watch`。
- 文件不存在时不报错，下一轮继续尝试。
- 文件缩短时重置 offset。
- 首次接入超过 50 MiB 的文件只读尾部 2 MiB。
- 按 JSONL 增量解析，半行缓存到下一次读取。

Claude 解析 assistant 消息：

- `text` 更新 `lastMessage`。
- `TodoWrite` 更新 `todoDone/todoTotal/currentStep/nextStep`。
- `Bash` 中发现 agent-browser 命令时更新 `currentAction`。
- 其它 tool_use 在没有 currentAction 时兜底为 `使用 <tool>`。

Codex 解析 rollout：

- assistant message 更新 `lastMessage`。
- function/tool/shell 调用里发现 agent-browser 命令时更新 `currentAction`。
- `plan` / `update_plan` 或 `functions.update_plan` 更新 todo 进度。

agent-browser 命令会被归纳成人话动作，例如打开站点、点击元素、填写输入框、截图、读取页面结构、滚动、刷新等。动作文本最长 60 字，消息/步骤最长 120 字。

### 5. 人工接管

页面按钮是二次确认：

- 第一次点击进入确认态，3 秒内第二次点击才会发送 `stop`。
- 单会话时，页面 payload 会带上 `session`，主进程优先停止该 session 对应的 agent-browser daemon。
- 多会话时，页面不带 session，主进程会停止同端口所有 agent-browser daemon；如果没有 agent-browser，则按 pid 去重停止所有 overlay 客户端。

接管不是暂停 Chrome，也不是抢占页面锁。当前语义是结束持有 CDP 连接的 AI 驱动进程：

1. `Runtime.bindingCalled` 收到 `action=stop`。
2. `AgentOverlayManager.findStopDrivers()` 找到要停止的 `CdpClientInfo`。
3. `ProfileManager.stopAgentOverlaySession()` 对 Profile 或外部实例再次校验该客户端仍连接着当前端口。
4. `disconnectCdpClient()` / `terminateCdpClient()` 对客户端 pid 发送 `SIGTERM`，2.5 秒未退出则 `SIGKILL`，再等 1.5 秒。
5. 成功后记录 `AgentTakeoverEvent`，写入 `profiles.json`，最多保留 50 条。
6. 主进程发 `profiles:agent-takeover`，渲染层合并历史、显示 toast 和「最近接管」通知。
7. overlay payload 切到 `takenOver`，页面显示「已接管，AI 已停止操作」，5 秒后自动收起。

从 AI 端看，这会表现为 agent-browser daemon 消失或 CDP/WebSocket 工具调用失败。Chrome 进程和页面本身不关闭。

## 关键设计决策

### CDP 注入，而不是浏览器扩展

当前需求只在「ProfilePilot 已经能看到 CDP 端口，且 AI 正通过该端口操作」时生效。CDP 注入复用现有连接面，不需要打包扩展、不需要用户安装权限、不污染 Profile 的扩展列表，也能随开关即时拆卸。

代价是它只覆盖可通过 CDP 注入脚本的普通页面。Chrome 内建页面、DevTools、扩展页面等无法注入；端口失联时也只能静默拆掉本端状态，无法在页面内继续更新。

### `aria-hidden` 防止 agent 快照污染

状态条是给人看的，不应该被 agent 当成网页正文继续操作。页面 host 设置 `aria-hidden="true"`，Shadow DOM 使用 closed mode，事件也会 stopPropagation，降低 accessibility snapshot 和页面事件被污染的风险。

这不是安全边界：视觉截图仍会包含 overlay，页面脚本也仍可能观察到 fixed host 的存在。它的目标是降低常见 agent 页面快照的噪声。

### Payload 字段全集稳定，页面端全量替换

`OverlayPayload` 的字段全集固定。主进程通过 `normalizeOverlayPayload()` 把缺失或空值归一成 `null` / `[]` / 默认状态；页面端 `__ppAgentOverlayUpdate()` 只遍历 `KNOWN_STATE_FIELDS`，逐项覆盖本地状态，而不是 `Object.assign` 增量合并。

这个取舍来自陈旧字段串台的教训：如果上一轮有 `nextStep`，下一轮没有该字段，增量 merge 会让旧 `nextStep` 留在 UI 上。当前设计要求新增字段时同步更新：

1. `OverlayPayload` / `OverlaySessionPayload` 类型。
2. `normalizeOverlayPayload()`。
3. `overlay-script.ts` 的 `STATE_DEFAULTS`、`KNOWN_STATE_FIELDS`、归一化逻辑和渲染逻辑。
4. `tests/agent-overlay-payload.test.js`。

### 主会话按 `lastActive` 排序

同一个 CDP 端口可能有多个客户端。主会话选择规则是：

1. 先按 `lastActive` 降序。
2. 有 `lastActive` 的排在没有的前面。
3. 时间相同按 pid 升序。

`payload.sessions` 也使用同一顺序，并按 `session` 去重；没有 `session` 时按 `label:pid` 去重。这样 UI 的主标题、主 action 和会话列表都指向最近活跃的 agent。

### 接管语义是杀驱动 daemon

ProfilePilot 没有实现浏览器内的协作锁。接管的可验证动作是结束 AI 持有的 CDP 客户端进程：

- 对 agent-browser，通常是结束会话级 daemon。
- 单会话优先按 `session` 精确匹配。
- 多会话默认全停同端口 agent-browser，避免接管后另一个 agent 继续抢页面。
- 如果没有 agent-browser，则回退到停止 overlay 识别到的客户端 pid。

这保持了行为简单可审计，但也意味着如果某个工具自动重启 daemon，下一轮 `getState()` 会重新发现连接，overlay 会回到 `active`。

### 开关与降级路径

`agentOverlayEnabled` 存在 registry 中，旧配置缺省视为开启。关闭开关会立即 `sync({ enabled:false, ports:[] })`，停止 tailer 并 teardown 页面 overlay。

降级行为：

- 会话文件缺失：`SessionTailer` 不报错，`AgentActivity` 只保留 agent/project/session/sessionTitle 和 `lastActive` 等基础字段。
- 非 `cc-<uuid>` / `cx-<uuid>` session：不会 tail 会话文件，但仍可显示连接基础信息。
- CDP 端口失联：`requestCdpTargets()` 失败时拆掉该端口已知页面；browser/page CDP 连接断开会从 manager 状态删除。
- 页面不可注入：跳过，不显示 overlay。
- binding 不存在：页面按钮 disabled；例如注入未完成或 CDP binding 已断。
- 外部 Chrome 实例：可显示 overlay 并接管，但 profileId 是 `external:<userDataDir>`，依赖运行态发现，不具备 registry 内 Profile 的完整元数据。

## 数据契约

### `AgentActivity`

定义在 `src/shared/types.ts`，由 `AgentOverlayManager.getActivity()` 返回给 `PublicProfile.agentActivity`，也用于构建 overlay payload。

| 字段 | 类型 | 含义 | 来源 |
| --- | --- | --- | --- |
| `agent` | `string?` | 工具名，如 `Claude Code`、`Codex`、`agent-browser` | `CdpClientInfo.agent`、session 前缀或 label |
| `project` | `string?` | 项目/工作目录名 | session context 或 tailer base |
| `session` | `string?` | agent-browser session 名 | socket/session context |
| `sessionTitle` | `string?` | 会话标题或首句 | session context |
| `currentAction` | `string?` | 当前浏览器动作摘要 | session-tail 解析 agent-browser 命令 |
| `currentStep` | `string?` | 当前计划步骤 | Claude TodoWrite / Codex plan |
| `nextStep` | `string?` | 下一计划步骤 | Claude TodoWrite / Codex plan |
| `todoDone` | `number?` | 已完成步骤数 | Todo/plan 状态 |
| `todoTotal` | `number?` | 总步骤数 | Todo/plan 状态 |
| `lastMessage` | `string?` | assistant 最近文本消息 | Claude/Codex 会话档案 |
| `updatedAt` | `string?` | 活动更新时间 ISO | tailer 当前时间或 `client.lastActive` |

### `AgentTakeoverEvent`

共享类型定义在 `src/shared/types.ts`。主进程持久化的字段如下：

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `profileId` | `string` | Profile public id，外部实例为 `external:<userDataDir>` |
| `profileName` | `string` | 接管时展示名 |
| `session` | `string?` | 被停止的 session 名 |
| `agent` | `string?` | 被停止的 agent 名 |
| `at` | `string` | 接管发生时间 ISO |

历史写入 `Registry.takeoverHistory`，`normalizeTakeoverHistory()` 最多保留最后 50 条。`getTakeoverHistory()` 返回时会反转为新到旧。渲染层本地类型目前兼容可选 `sessionTitle`，但主进程不会持久化该字段。

### `OverlayPayload`

这是通过 `Runtime.evaluate` 推给页面的完整状态。所有字段每次都应出现，空值使用 `null` 或空数组。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `state` | `"active" \| "takenOver"` | overlay 当前状态 |
| `profileName` | `string` | Profile 展示名 |
| `agent` | `string \| null` | 主会话 agent |
| `project` | `string \| null` | 主会话项目 |
| `session` | `string \| null` | 主会话 session |
| `sessionTitle` | `string \| null` | 主会话标题 |
| `currentAction` | `string \| null` | 主会话当前动作；有主客户端但没有解析结果时为「AI 正在操作浏览器」 |
| `currentStep` | `string \| null` | 当前计划步骤 |
| `nextStep` | `string \| null` | 下一计划步骤 |
| `todoDone` | `number \| null` | 已完成步骤数，必须是有限数字 |
| `todoTotal` | `number \| null` | 总步骤数，必须是有限数字 |
| `lastMessage` | `string \| null` | 最近 assistant 文本 |
| `updatedAt` | `string \| null` | 主会话更新时间 ISO |
| `startedAt` | `string \| null` | 当前端口会话组最早开始时间 ISO |
| `sessions` | `OverlaySessionPayload[]` | 去重后的会话列表，按活跃度排序 |

### `OverlaySessionPayload`

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `agent` | `string \| null` | 该会话 agent |
| `project` | `string \| null` | 该会话项目 |
| `session` | `string \| null` | session 名 |
| `sessionTitle` | `string \| null` | 会话标题 |
| `lastActive` | `string \| null` | 客户端最后活动时间，优先 `client.lastActive`，其次 `activity.updatedAt` |
| `startedAt` | `string \| null` | manager 在当前端口状态里首次看到该 session/client 的时间 |

## 已知边界与后续方向

- 外部实例：当前可以被 overlay 和接管，但依赖运行态发现；没有 registry 生命周期和完整历史上下文。
- Windows 支持：CDP 客户端发现依赖 `lsof`/`ps`，Windows 运行态能力在现有代码里仍有限。
- Firefox 不支持：实现完全基于 Chromium CDP。
- i18n：overlay 页面文案、动作摘要、toast/历史均为中文硬编码。
- 注入范围：不支持 Chrome 内建页、DevTools、扩展页等受限目标。
- 会话识别：只有能归属到 `cc-<uuid>` / `cx-<uuid>` 的 session 才能解析完整活动；其它命名 session 只能显示基础连接信息。
- 自动重连的 agent：接管只杀当前驱动进程；如果外部 supervisor 自动重启，ProfilePilot 会重新识别为 active。
- 可访问性污染防护不是安全边界：`aria-hidden` 和 closed Shadow DOM 是降噪手段，不阻止页面脚本或视觉截图看到 overlay。
- 后续可考虑：把 takeover event 增加 `sessionTitle`，补充国际化资源，做 Windows 客户端发现适配，为外部实例提供更稳定的元数据映射。
