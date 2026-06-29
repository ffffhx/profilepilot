# ProfilePilot 功能路线图

> 本文件由一次多代理深度调研自动生成（35 个子代理 · ~300 万 token · 5 阶段：读码 → 联网调研 → 多视角发散 → 三评委打分 → Top 详设）。
> 候选 65 个 → 精选并详设 11 个。所有改动点都贴着真实文件 / 函数 / 字段，可直接开工。
>
> **不是给用户看的承诺，而是给你（维护者）挑选用的菜单。** 没有任何代码被改动——我没有动正在进行中的「副本池」分支，避免和未提交的工作冲突。

---

## 一、一句话主线

把 ProfilePilot 从「一个管理 Chrome Profile 的 GUI」升级为 **「agent 可编程的本机真实 Chrome 控制平面」**。

调研里反复出现的三个事实，决定了最高价值的方向：

1. **Chrome 136+（2025-05）拒绝在默认 user-data-dir 上开 `--remote-debugging-port`**——所有框架（browser-use / chrome-devtools-mcp / agent-browser / Selenium / Skyvern）都踩了这个坑，通用解法就是「把 Profile 克隆到独立目录再开端口」。**这正是 ProfilePilot 的核心能力**，等于天然站在风口上。
2. **Chrome 144+ 新的内建调试开关让 `/json/version` 返回 404**，即使端口是开的；可靠解法是给框架完整的 `ws://127.0.0.1:PORT/devtools/browser/<uuid>`，从 `DevToolsActivePort` 文件读出来。**目前 ProfilePilot 只暴露 http 简写，恰好踩在这个雷上。**
3. 所有 agent 框架消费 Profile 的入口几乎只有一个：**一个 CDP URL**。它们的差别只在于要 `http://host:port` 还是完整 `ws://`。谁把这一步做到「零摩擦、第一次就连上」，谁就赢。

围绕这条主线，11 个详设归为 4 个主题：

| 主题 | 解决的问题 | 对应功能 |
| --- | --- | --- |
| 🔌 **Agent 接入零摩擦** | 让任何框架第一次就连上 | 完整 ws:// 端点+连接代码生成、CDP 健康徽章、DevToolsActivePort 端口兜底 |
| 🤖 **可编程控制面** | 不用点 GUI 就能驱动 | 本地 HTTP API、profilepilot CLI、（未来）MCP server |
| 🛡️ **安全与可逆** | 一次误操作不丢登录态 | 用完即弃启动、删除/回收二次确认、自动安全快照 |
| 📊 **可观测 / 规模化** | 管 20+ Profile 不靠肉眼 | 舰队筛选排序栏、富元数据（备注/颜色/状态） |

---

## 二、推荐分批（Wave）

按「依赖关系 + 性价比」排，而不是单纯按分数。

### Wave 0 — 快速赢（每个 S，强依赖已有代码，1～2 天能清一批）
> 这些几乎没有架构风险，大量复用现成 helper，且直击 agent 接入痛点。建议优先。

1. **完整 `ws://` CDP 端点 + 一键连接代码生成**（合并 #1+#3，~6-9h）— 最高价值，直接消除 Chrome 144 的 404 坑
2. **CDP 健康徽章**（#5，4-7h）— 一眼看出「真能驱动」还是「端口连不上/不符」
3. **DevToolsActivePort 端口兜底**（#9，5-8h）— 让 `--remote-debugging-port=0` 自动分配的端口也能被识别
4. **删除/回收/重置 二次确认硬化**（#7，4-7h）— 防一次误点清空登录态
5. **富元数据：备注 / 颜色 / 生命周期状态**（#11，5-8h）— 复用现成 projectTag 模式
6. **舰队筛选 + 排序栏**（#8，6-9h）— 纯渲染层，0 主进程改动

### Wave 1 — 高杠杆（M）
7. **用完即弃 clean-room 启动**（#6，10-16h）— 复用副本池流水线，关窗即自动清理
8. **自动安全快照**（#10，6-9h）— 在「先关后写」的窗口里顺手快照，sync/agent 跑挂了能一键回滚

### Wave 2 — 战略平台（L，把产品从工具变平台）
9. **本地 HTTP 控制 API**（#4，16-24h）— Ollama 式 127.0.0.1 REST，脚本/CI/agent 无需 GUI
10. **profilepilot CLI**（#cli，10-16h，依赖 #9）— `agent-browser --cdp $(profilepilot url myprofile)`
11. **（未来）MCP server**（排名第 6，未详设）— 把上面的能力直接暴露给 Claude Code / Cursor

> 依赖提示：#1 与 #3 共享同一个新字段 `cdpWebSocketUrl`，应合并实现；CLI(#10) 依赖 HTTP API(#9)；用完即弃(#6)、自动快照(#10-snapshot)、富元数据(#11) 都建议**叠在副本池分支之上**，先把副本池合掉再做。

---

## 三、11 个 Build-Ready 详设

> 每个都含：是什么 / 为什么 / 工时 / 关键改动 / 怎么验证。完整逐行设计（含 file→change 清单、边界情况、风险）见生成时的 `designs.txt`（如需我可随时贴出某一个的全文）。

### ⭐ 详设 1+3：完整 `ws://` CDP 端点 + 一键连接代码生成 〔composite 8.48 / 8.33，S，~6-9h〕

**是什么**：在 Profile 详情侧栏加一个「Connect · 一键接入」面板。对任何 CDP 运行中的独立 Profile，输出可直接粘贴的连接代码——browser-use / Stagehand / Playwright（内置 `contexts()[0]` 坑的注释）/ Puppeteer / agent-browser，每段都预填好**确切的** `ws://127.0.0.1:PORT/devtools/browser/<uuid>`，一键复制。

**为什么**：当前 `PublicProfile.cdpUrl` 只有 http 简写，不含 browser uuid——这正是触发 Chrome 144+ `/json/version` 404 的元凶。框架用户要逐一踩「空 context / 用错 cdpUrl 字段 / 144 的 404」三个坑。这是用户量最大、最高频的摩擦点。

**关键改动**：
- `shared/types.ts` + `renderer/types.ts`：`PublicProfile` 加 `cdpWebSocketUrl: string | null`（运行态字段，**不持久化**，uuid 每次启动都变）。
- `main/profile-manager.ts`：加内存缓存 `cdpWebSocketUrlByPort: Map<number,string>`；在 `launchStoredIsolatedProfile` 里 `waitForCdp` 成功后立刻 `requestCdpVersionInfo` 抓一次（这一刻 /json/version 必然可用，绕过 144）；`getState` 里对运行中的 isolated Profile 兜底解析（缓存优先，并行、700ms 超时、按端口剪枝）。
- 兜底：解析失败时退回 http base，并提示「重启 Profile 以重新抓取端点」。
- `renderer/render/connect.ts`（新）：纯函数 `buildConnectSnippet(profile, framework)` + `renderConnectPanel`；复用现成 `navigator.clipboard` + toast。
- **无新 IPC**——字段搭现有 `getState` 的便车。

**验证**：CDP 启动一个 Profile → 详情出现 Connect 面板 → Playwright 片段显示真实 uuid → 切换框架 chip → 复制粘贴到 scratch 项目，`connectOverCDP` 第一次就连到已登录 context。

---

### 详设 4：本地 HTTP 控制 API（loopback 优先）〔composite 8.03，L，16-24h〕

**是什么**：主进程内跑一个零依赖 `node:http` 服务，把现有 `IPC_CHANNELS` 暴露成 JSON REST。默认 off、绑 127.0.0.1、无鉴权（同 Ollama）；选择绑到局域网时强制 bearer token。`GET /` 返回 `ProfilePilot is running` + 版本。新增「控制 API」设置弹窗，配置持久化到 `control-api.json`。

**为什么**：调研里 Kameleo(:5050) / AdsPower / Ollama(:11434) 全都有本地 API——这是「自动化工具」的标配契约。让脚本/agent/CI 无需点 GUI 就能 list/launch/clone Profile 并拿到 CDP 端点。

**关键改动**：
- 新 `main/control-api.ts`（`ControlApiServer` 类，复用单例 `profileManager`）+ `main/control-api-settings.ts`。
- 路由：`GET /profiles`→getState；`POST /profiles/:id/launch?cdp=9223`→返回 cdpPort + http + 完整 ws；`GET /profiles/:id/cdp`→live view；clone-group 路由复用副本池方法；`POST /profiles/:id/tag`。
- 安全：Host 头白名单（防 DNS rebinding）、拒绝带 Origin 的请求、token 用 `timingSafeEqual`、限制 body 大小、局域网必须带 token 才启动。
- 2 个新 IPC（仅供设置弹窗读状态/写配置）。

**验证**：开启后 `curl 127.0.0.1:3737/` → running；`curl .../profiles | jq` 对得上 GUI；`POST .../launch?cdp=9223` → 返回 ws 端点且 GUI 3s 内显示运行中。

---

### 详设 5(cli)：profilepilot CLI 伴侣〔composite 7.95，M，10-16h，依赖 HTTP API〕

**是什么**：零依赖 Node CLI（`bin/profilepilot.mjs`，package.json `bin` 注册），通过本地 HTTP API 驱动 ProfilePilot。子命令：`list / launch <id> [--cdp [port]] / url <id> / tabs <id> / clone <src> -n N / refresh <group> / tag <id> <label> / doctor`。默认人类可读、`--json` 机器可读。

**头号用法**：`agent-browser --cdp $(profilepilot url myprofile)`——一行 shell 把已登录的隔离 Chrome 端点喂给任何 CDP 工具。

**关键改动**：
- `bin/profilepilot.mjs`（ESM，用 Node>=20 的全局 fetch）：从 `http-api.json` 发现 API + token；客户端做 name→id 解析；`url` 用 `process.stdout.write` 不带换行（`$()` 安全）；退出码分层（0 ok / 2 用法 / 3 不可达 / 4 未找到 / 5 远程错）。
- `package.json` 加 `bin`，把 `bin/**` 加进 `build.files`。
- 主进程加 3 个小方法 `getCdpEndpoints / getCdpTabs / doctor` + IPC，给 CLI 和 GUI 复用。

**验证**：`profilepilot doctor` → 显示 API 可达 + 版本 + 计数；`profilepilot url <name>` → 打印纯净 ws；`agent-browser --cdp $(...) snapshot -i` 连上；`npm link` 后全局可用。

---

### 详设 5：每行 Session/CDP 健康徽章〔composite 7.78，S，4-7h〕

**是什么**：给运行中的 Profile 行加一个轻量徽章，区分四态：🟢 可驱动 / 🔴 不可达 / 🟡 端口不符（固定/AGENTS.md 端口 ≠ 实际运行端口）/ ⚪ 检测中。

**为什么**：进程扫描能看到端口，不代表端口真活着。「端口不符」尤其致命——agent 照着 AGENTS.md 连，结果连到死端口白白烧步数。

**关键改动**：
- 新 `main/cdp-health.ts`：`probeCdpHealth`（复用 `requestCdpTargets` = /json/list，700ms 超时）+ `CdpHealthCache`（15s TTL，fire-and-forget，**绝不阻塞 getState**，按端口剪枝）。
- `PublicProfile.cdpHealth`（运行态派生，不持久化）；端口不符**零网络成本**纯同步算出。
- 渲染层加 `.cdp-health` pill + hover HUD 提示。**无新 IPC**，搭 getState 便车，3s 轮询自动刷新。

**验证**：CDP 启动 → 几秒后 🟢；占用端口造成不符 → 🟡；`kill -9` Chrome 但 PID 残留 → ~15s 内 🔴。

---

### 详设 6：用完即弃 clean-room 启动（copy-on-run）〔composite 7.65，M，10-16h〕

**是什么**：一键「启动一份一次性副本」。复用副本池流水线（createProfile → syncAccount(full) → 可选 migrateExtensions → 固定端口 → CDP 启动）从源 Profile 拉一份一致登录态的隔离副本，标记 `disposable`，**关窗/进程退出即自动移到废纸篓**。源 Profile 只读、永不被写。

**为什么**：QA / agent 每次都想要「干净、一致、零残留」的起点；调研里 Playwright/Skyvern 都强调「一个 agent 一个独立 user-data-dir」。这把它做成一键。

**关键改动**：
- `StoredProfile.disposable?` + `PublicProfile.disposable`；`setStoredCloneMeta` 扩展 disposable。
- 主进程 reaper：`setInterval(2500)` 看 disposable Profile「曾运行→消失」就 `deleteProfile`（`seenRunningDisposables` 守卫，防创建窗口期误删；启动时 `includeUnseen` 扫孤儿）。
- 从持久副本池聚合里排除 disposable；「提升为正式 Profile」清除标记。
- 2 个新 IPC（launch / promote）。

**验证**：🧪 用完即弃启动 → 新行带 🧪 pill → `agent-browser` 驱动它，源不受影响 → 关窗 ~2.5s 后行消失、目录进废纸篓 → 「提升为正式」后关窗不再清理。

---

### 详设 7：危险操作二次确认硬化〔composite 7.58，S，4-7h〕

**是什么**：在现有 confirm 流水线里给三个不可逆操作加摩擦——(1) 删除**仍有登录态**的 Profile 要求**输入 Profile 名称**确认；(2) `recycleIdleClones` days=0（立刻清空所有空闲副本，含刚建的）要求勾选「我知道这会立刻全部移废纸篓」；(3) 重置**正被 CDP 工具驱动**的副本直接**硬阻止**并提示是哪个工具(pid)。

**为什么**：登录态是用户的核心资产，一次误点代价极高。`cdpClients` 已经有了，登录态判断只需新增一个派生布尔 `hasLoginState`。**无新 IPC**。

**关键改动**：
- `account-sync.ts` 加 `hasLoginStateArtifacts`（查 Cookies/Login Data/Web Data 是否存在）。
- `ConfirmModalView` 加 `requireTypeMatch / requireAck / blocked` 三个可选门。
- 渲染层用**命令式** enable/disable 确认按钮（避免每次按键 re-render 丢光标，照搬现有 draft-count 模式）。
- 可选：`resetClone` 主进程侧也加 `CLONE_BEING_DRIVEN` 兜底（防弹窗打开后工具才连上）。

**验证**：删有登录态的 Profile → 按钮禁用直到输对名字；新建空 Profile → 无需输入；days=0 → 出红字+勾选框；重置被驱动副本 → 永久禁用并提示工具名。

---

### 详设 8：舰队筛选 + 排序栏〔composite 7.45，M，6-9h〕

**是什么**：Profiles 表上方一个**纯渲染层**工具栏：文本搜索（名/目录/标签）、快筛 chip（运行中 / 空闲 / 有 CDP / 驱动中 / 系统 / 独立）、标签 chip（由 projectTag 派生）、「某源的副本」chip（由 clonedFromProfileId 派生）、排序下拉（运行优先 / 名称 / 最近启动 / 副本分组）。

**为什么**：管 20+ 副本 + 原生 Profile 时，肉眼扫不过来。所有筛选字段 `PublicProfile` 上**已经有了**——**0 主进程 / IPC / 存储改动**。

**关键改动**：
- 新 `renderer/render/fleet-filter.ts`（谓词 + 比较器 + 工具栏渲染）。
- `state.ts` 加 8 个筛选字段；`main.ts` 加若干 data-action + 防抖搜索（搜索框聚焦时跳过 3s 轮询，防丢光标）。
- `state-actions.ts` 加 `normalizeFleetFilters`（标签/副本源被删后自动清掉失效 chip）。

**验证**：搜索实时过滤不丢焦点；chip 互斥（运行中↔空闲）；标签/副本源 chip 生效；排序改变行序；无匹配显示空态 + 清除筛选。

---

### 详设 9：DevToolsActivePort 端口兜底〔composite 7.4，M，5-8h〕

**是什么**：现在只从 `ps` 命令行正则抓 `--remote-debugging-port=<n>`。`--remote-debugging-port=0`（自动分配）和 Chrome 144 内建开关有真实 TCP 端点但 argv 里没有，导致 `cdpPort` 为 null、行显示「未开启」却其实可驱动。兜底：扫描后对仍为 null 的运行中 Chrome 读 `<user-data-dir>/DevToolsActivePort`（第 1 行端口、第 2 行 ws 路径），用进程的 `listeningPorts` 校验存活，再填上端口。

**为什么**：现代 agent 启动方式越来越多用自动端口；不兜底就会「明明能驱动却显示未开启」。native Profile 故意排除（保留「系统 Chrome 不支持端口式 CDP」立场）。

**关键改动**：
- `RuntimeProfile` + `PublicProfile` + `ExternalChromeInstance` 加 `cdpPortSource: "argv"|"active-port"|null`（UI 显示「auto」标签）。
- `process-scan.ts` 加 `readDevToolsActivePort` + `attachDevToolsActivePortFallback`（pids>0 且 cdpPort=null 才读，跳过 native:，端口须在 listeningPorts 里）。
- 外部实例分支用 `/json/version` 做存活闸（无 listeningPorts map）。

**验证**：手动用 `--remote-debugging-port=0` 启动某 Profile 的 Chrome → 行从「未开启」变绿 + auto 标签，地址与 `DevToolsActivePort` 第 1 行一致；退出 Chrome 后下次轮询回到「未开启」（拒绝陈旧文件）。

---

### 详设 10：风险操作前自动安全快照〔composite 7.4，M，6-9h〕

**是什么**：一个 opt-in 安全策略：在 mutating/agent 操作（CDP 启动、syncAccount、migrateExtensions、resetClone）**之前**，把目标 Profile 的登录态文件集复制成带版本的快照到 `<dataDir>/snapshots`，每 Profile 保留 N 份（默认 3）。让任何 sync/agent 跑变成一键可回滚。

**为什么**：「我那次 sync/跑完之后登录就坏了」是最痛的不可逆场景。复用现有「先关后写」的一致性窗口，**不额外关 Chrome**；快照原语复用 account-sync 的 copy 机制（accountSyncCopySpecs + Local State）。

**关键改动**：
- 新 `main/snapshots.ts`（策略归一化、快照 key、relativePaths）。
- `profile-manager.ts`：`captureSnapshot` / `pruneSnapshots` / `maybeAutoSnapshot`（**best-effort，绝不 rethrow**，失败只 warn 不影响主操作）；在 4 个「先关后写」缝隙插桩；`Registry` 加 `autoSnapshotPolicy` + `snapshots`。
- 5 个新 IPC（set-policy / list / create / restore / delete）；恢复前再拍一张「恢复前自动备份」。删除 Profile 时连快照一起清。

**验证**：开策略 → 跑一次 sync → busy 出现「正在创建安全快照」→ 详情有快照行 → 模拟登录坏掉 → 「恢复上一个自动快照」→ 重启 Profile 登录回来；跑 4 次只留最新 3 份；关策略后不再拍。

---

### 详设 11：富 Profile 元数据（备注 / 颜色 / 生命周期状态）〔composite 7.4，S，5-8h〕

**是什么**：把现有只有 `projectTag` 的元数据，扩展出三个纯展示字段——自由文本 `notes`、颜色 `colorLabel` 枚举、生命周期 `status` 枚举（预热/活跃/封禁/闲置），**对独立 Profile 和系统 Profile 都生效**（像 name override 一样）。表格名字格内显示色点+状态 pill+备注图标，详情面板可编辑，可按状态/颜色筛选。

**为什么**：管 40 个 Profile 的舰队时，需要记「这个号是干嘛的、健康吗」，不该靠外部文档。复用现成 projectTag 持久化路径，**零自动化/登录态风险**（只动 profiles.json 元数据）。

**关键改动**：
- 枚举 `ProfileStatus` / `ProfileColorLabel`；`StoredProfile` + `NativeProfileMetadata` + `PublicProfile` 加三字段；`ProfileMetadataPatch` + 1 个新 IPC `setProfileMetadata`（分 native/isolated，照搬 renameProfile）。
- `fs-util.ts` 加归一化/sanitize（notes 截断 280、非法枚举回退 none）。
- 渲染层：名字格 meta 行（**不加第 6 列**，避免重蹈 commit 3ff0b22 的溢出）+ 编辑弹窗 + 筛选栏。

**验证**：编辑标注（状态=活跃、绿色、备注、tag）→ 行显示对应 pill → 重启后持久化 → 按 tag+状态筛选 → 系统 Profile 同样可标注（隐藏 projectTag 字段）。

---

## 四、附录 A：其余高分候选（12～40 名，未详设但值得收藏）

按分数。括号为 (composite, effort, 评委保留数)。

- **ProfilePilot Doctor / 诊断面板**（7.55, M）— `flutter doctor` 式环境自检：Chrome 路径、端口占用、数据目录、权限，给可复制的修复建议。和 CLI `doctor` 子命令共用。
- **storageState 导出/导入桥**（7.25, M）— 导出 Playwright 兼容的 `storageState.json`（cookies+localStorage+IndexedDB），让登录态在 ProfilePilot 与测试套件间互通。调研显示这是 QA 的标准工作流。
- **长操作完成 / CDP 断连 桌面通知**（7.25, S）— 原生通知，长任务跑完或 agent 把端口跑断时提醒。
- **Connections 面板：谁在驱动每个 CDP 端口**（7.17, M）— 把 cdpClients 做成一个总览面板（工具名+pid+端口+一键踢）。
- **首次运行引导清单**（7.15, M）— 缩短「装好→第一次让 agent 驱动」的时间。
- **命名快照 + 时间旅行恢复**（7.0-7.25, L）— 自动快照(#10)的「完全体」：手动命名还原点、跨时间点恢复、状态 diff。
- **副本池/Profile 多选批量操作**（6.85, M）— 多选表格行，一个动作作用于全部（调研里所有竞品的核心交互）。
- **定时刷新登录态**（6.8, M）— 给副本组/Profile 设定时 refresh，防登录态过期。
- **配置 bundle 导出/导入**（6.75, M）— 只导 registry 元数据（不含 user-data），可 git 版本化、跨机迁移配置。
- **同步保存的密码（Login Data）作为可选类目**（6.72, S）— account-sync 增一个 opt-in 类目。
- **按站点重置状态（保留登录）**（6.57, S）— 用 CDP `Storage.clearDataForOrigin`（排除 cookies），Lighthouse 同款。
- **Profile 模板 / 预设**（6.55, M）— 预设「干净测试号」「带某些扩展」等模板一键造。
- **Cmd+K 命令面板**（6.45, M）— 动作 20+ 时性价比凸显；上下文感知（对当前选中 Profile 给对的动作）。
- **预启动 seed 面板**（6.32, M）— 启动前注入 cookies/localStorage/flags。
- **活动 / 历史时间线**（6.32, L）— 操作审计与回看。
- **截图捕获 + 失败留存录制**（6.12, M）— agent 跑挂时自动留证。

## 五、附录 B：调研中顺手挖出的真实 Bug / 技术债（code-grounded）

> 这些是读码代理在分析时发现的、**有 file:line 证据**的现存问题。和「加功能」无关，但很多是低成本高回报的修复，单独列出。**部分关乎数据安全，建议优先看。**

### 🔴 可能影响登录态/数据安全
- **关原生 Profile 会退出整个 Chrome**：`requestGracefulClose` 对任何 native+macOS 用 AppleScript `tell application "Google Chrome" to quit`——关一个原生 Profile 会杀掉所有窗口。（`profile-manager.ts:402-413`）
- **account-sync 不关源 Profile**：只关目标。运行中的源 Cookies/WAL/SHM 可能被读到半刷新态，和实时写入竞争。（对比 migrateExtensions 会关源）（`profile-manager.ts:1259-1262`）
- **跨机/跨用户同步 = 静默不可解密**：Cookies/Login 是按 OS keychain 加密的字节，原样复制后只在同一 macOS 用户 keychain 下能解密；跨用户/跨机复制得到无法解密的 cookie 且**无任何检查或警告**。（account-sync 全程无 SafeStorage 校验）
- **成功 sync 无持久回滚**：`.previous` 备份只活在原子替换窗口内、成功即删；一次「成功但不想要」的覆盖无法恢复。（→ 正是详设 #10 要补的）（`replacePathWithStagedCopy:829-831`）
- **无 Chrome 版本偏斜防护**：把新 schema 的源库复制进旧 Chrome 目标可能损坏 Profile；从不检查 `Last Version`/`First Run`。
- **扩展静默安装不重算 `super_mac`**：`writeProtectedExtensionInstallRecord` 注入 `protection.macs` 但不重算整体 HMAC `super_mac`；Chrome 启动校验失败可能**静默清空所有受保护偏好**，把刚写的安装记录也丢掉。（`extension-migration.ts:139-171`）

### 🟡 跨平台缺口（Windows 基本不可用）
- 运行态/PID/端口检测全靠 `ps`/`lsof`，Windows 上 `getRuntime` catch 返回空——所有 Profile 显示未运行、CDP 信息全丢。（`profile-manager.ts:2097,2149`；`process-scan.ts:94/137/203`）
- 窗口「显示/置顶」macOS 专属，其它平台直接抛 `FOCUS_UNSUPPORTED`。（`chrome-launch.ts:160-162`）
- 删除原生 Profile 的「Chrome 是否运行」安全闸在 Windows 上被绕过（`isChromeRunning` 恒 false）。
- CDP 客户端检测（驱动中）也是 lsof，Windows 上「连接」列永远显示空闲。
- 非 macOS 删除不进系统回收站，进 `<dataDir>/trash` 且**永不清理**、无限增长。（`profile-manager.ts:2428-2429`）

### 🟡 逻辑/正确性
- **`isDefault` 硬编码 `dirName==='Default'`**，没读 Chrome 实际 last_used；有效默认是 Profile N 的用户会被误标、且被错误地标成可删。（`chrome-launch.ts:578`）
- **`fixedCdpPort` 无跨 Profile 唯一性检查**：两个 Profile 能绑同一端口，冲突只在启动时才暴露。（`setAgentBrowserConfig:324`、`setStoredCloneMeta:1748`）
- **删源副本会变孤儿**：`deleteIsolatedProfile` 不清子副本的 `clonedFromProfileId`，导致 `refreshClones` 抛 NO_CLONES、`resetClone` 抛 PROFILE_NOT_FOUND，且 UI 无修复入口。
- **`clearAgentBrowserConfig` 忽略 profileId 参数**，全局删除端点块——从一个 Profile 清理会误删指向另一个 Profile 的端点；registry 里的 fixedCdpPort 又被故意留下，造成 registry/AGENTS.md 漂移。（`profile-manager.ts:330-333`）
- **CDP 客户端按端口匹配忽略 host**：连到「远程主机的同号端口」的 ESTABLISHED 连接会被误判为本地驱动者。（`process-scan.ts:240-247`）
- **lsof 客户端标签被截断到 9 字符**（缺 `+c 0`）：`agent-browser` 显示成 `agent-brow`，区分不出 Playwright/自定义 node 脚本。（`process-scan.ts:203`）
- **`launchClones` 用固定端口无回退**：端口被别的 app 占了就静默 drop 那个副本，而不是重绑空闲端口。
- **`recycleIdleClones` 是全局的**，无视当前选中的 `clonePoolSourceId`——在「按源」的弹窗里点清理却删了所有源的空闲副本。
- **扩展数据目录是 6 个 legacy 硬编码模式**，漏掉现代 MV3 存储（Service Worker / Cache Storage / leveldb / blob_storage），这些扩展状态静默不迁移。（`extension-scan.ts:301-310`）
- **`writeJsonFileAtomic` 失败不清 tmp 文件**（无 try/finally rm，也无 fsync），失败时在数据目录留 `.tmp-<ts>`。（`fs-util.ts:228-232`）

### 🟢 架构/可维护性
- **每次状态变化全量重建 `appRoot.innerHTML`**，毁掉焦点/滚动/动画——代码里到处是手动 workaround（setTimeout 重新聚焦、miniScrollTop 存恢复、命令式补 DOM）。这是渲染层的中心脆弱点。（`render-root.ts:38`）
- **单个 ~980 行的 click handler**，顺序相关的 early-return，每加功能就插一个 `if (action===...)`；建议改成 dispatch table。（`main.ts:49-1031`）
- **主弹窗没有 Esc 关闭、无焦点陷阱**。（`main.ts:1126-1147`）
- **渲染层硬编码了用户专属绝对路径**作为 CLAUDE.md 兜底：`"/Users/bytedance/.codex/AGENTS.md"`，对其他用户会显示错路径。（`modals.ts:178`）
- **`shared/types.ts` 与 `renderer/types.ts` 手工镜像同步**：`PublicProfile`/`ProfileManagerApi` 两份，漏改一处就编译挂——几乎每个详设都提醒「两个文件都要改」。
- **没有 Tray、没有应用 Menu**：从 mini 窗恢复只能靠 dock activate 或全局快捷键；快捷键硬编码不可配、注册失败只 console.warn。（`main.ts`）
- **`migrateExtensions/launchClones/recycleIdleClones` 没注册到 activeOperations**，无法取消/暂停，尽管基础设施已存在。
- **agent 指令目标硬编码 2 条**（`~/.codex/AGENTS.md`、`~/.claude/CLAUDE.md`），不支持项目级 AGENTS.md / Cursor / Windsurf。（`global-instructions.ts:12-39`）
- **3 个近重复的原子写函数** + 重复的 CLAUDE.md shell 写逻辑，漂移风险。

## 六、附录 C：被打低分 / 否决的方向（说明为什么不做）

- **代理库 / 批量代理轮询分配**（5.15, mission fit 仅 3.5）、**per-profile 代理绑定**（6.05, fit 5）——评委判定**偏离使命**：ProfilePilot 明确「不做指纹伪装、不做规模化养号」，代理是反检测/多账号运营的核心，做深了会让产品定位漂移。可保留「单 Profile 手动设代理 + 启动前测连通」这种轻量、对 QA/调试有用的子集，但别做代理池。
- **加密 vault / safeStorage 信封加密**（4.95）、**离线密钥扫描**（4.7）、**LAN CDP 桥**（4.82）——价值有但**可行性/风险分低**（Windows DPAPI 非 app 隔离、safeStorage 静默明文回退等坑多），ROI 不如 Wave 0。
- **Windows parity 大推**（5.55, effort XL）——价值高（fit 7.5）但工作量极大（feasibility 3）。建议**增量做**：先把 #9（DevToolsActivePort，跨平台友好）这类顺手的补上，而不是一次性大改。
- **HAR 网络抓取 / webhooks+SSE / 防篡改哈希链日志 / 书签历史合并**——要么太重、要么偏离核心，先搁置。

---

*生成方式：5 阶段动态工作流。完整逐行设计与所有 65 个候选的打分明细在生成会话里，可随时索取。*
