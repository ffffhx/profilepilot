import type { StartupSettings } from "./startup-settings";

export interface StoredProfile {
  id: string;
  name: string;
  dirName: string;
  createdAt: string;
  lastLaunchedAt: string | null;
  lastCdpPort?: number | null;
  fixedCdpPort?: number | null;
  // 独立 Profile 的 Bifrost 专属入口。启动时自动恢复临时端口绑定，
  // 再通过 Chrome --proxy-server 把该 Profile 的流量送入这套规则视图。
  bifrostProxy?: ProfileBifrostProxyConfig | null;
  // 独立 Profile 的“直连上游代理”入口（如 Clash Verge 的某个 mixed listener）。
  // 与 bifrostProxy 互斥：一个 Profile 要么走 Bifrost 规则视图，要么直连某个上游代理。
  upstreamProxy?: ProfileUpstreamProxyConfig | null;
  // 显式直接联网：启动 Chrome 时注入 --no-proxy-server，不跟随系统代理。
  // 与 bifrostProxy / upstreamProxy 互斥。
  directConnection?: boolean;
  // 该独立 Profile 是从哪个源 Profile 克隆出来的（存源的 public id，可为 native:/isolated:）。
  // 用来定义“副本组”：批量刷新登录态、重置、回收都按这个字段聚合。
  clonedFromProfileId?: string | null;
  // 纯展示用的项目标签，标记这个副本当前在干哪个项目的活。
  projectTag?: string | null;
  // Profile 级 Agent 策略：禁用后 Gateway 拒绝任何新 Agent Session，
  // 运行时候选清单仍保留该 Profile，但标记为不可选。
  agentAccessDisabled?: boolean;
  migratedExtensions?: StoredMigratedExtension[];
}

export interface ProfileBifrostProxyConfig {
  listenerPort: number;
  // rules / groupRules 是这个 Profile 管理的完整规则集合；停用项继续保留，
  // 这样可以在专属入口 Tooltip 中原地重新启用。
  rules: string[];
  groupRules: string[];
  disabledRules?: string[];
  disabledGroupRules?: string[];
}

// 直连上游代理配置：把该 Profile 的流量整体交给一个已有代理入口，不经过 Bifrost 规则视图。
export interface ProfileUpstreamProxyConfig {
  // 规范化后的上游地址，形如 "http://127.0.0.1:7897" / "socks5://127.0.0.1:7891"。
  server: string;
  // 可选的 Chrome --proxy-bypass-list，逗号分隔（如 "localhost,127.0.0.1,*.local"）。
  bypassList?: string | null;
}

// 面向渲染层的统一代理配置视图（union）。底层持久化仍是 bifrostProxy / upstreamProxy 两个互斥字段，
// 但 UI、IPC 用这个判别式联合来表达“这个 Profile 当前是哪种分流模式”。
export type ProfileProxyConfig =
  | ({ kind: "bifrost" } & ProfileBifrostProxyConfig)
  | ({ kind: "upstream" } & ProfileUpstreamProxyConfig)
  | { kind: "direct" };

// Bifrost `status --format json` 里单个临时入口端口的绑定信息；
// name 归属（profilepilot:<id>）用于渲染层判定该 Profile 分流入口的三态健康度。
export interface BifrostPortBindingInfo {
  port: number;
  host: string | null;
  name: string | null;
  status: string | null;
}

export type BifrostRuleDestinationKind = "local" | "ppe" | "boe" | "mixed" | "other";

export interface BifrostRuleDestination {
  kind: BifrostRuleDestinationKind;
  label: string;
  details: string[];
}

export interface BifrostActiveRuleInfo {
  name: string;
  ruleCount: number;
}

export interface SystemProxyRoute {
  protocol: "http" | "https";
  kind: "direct" | "http" | "https" | "socks4" | "socks5" | "quic" | "unknown";
  endpoint: string | null;
}

export interface SystemProxySnapshot {
  mode: "direct" | "proxy" | "mixed" | "unknown";
  routes: SystemProxyRoute[];
}

export interface BifrostSnapshot {
  installed: boolean;
  running: boolean;
  version: string | null;
  binaryPath: string | null;
  mainPort: number | null;
  ports: BifrostPortBindingInfo[];
  localRules: string[];
  error: string | null;
  // 上游代理入口探活结果：key 是规范化后的上游地址（scheme://host:port），value 是 TCP 可达性。
  // 直连上游代理入口（upstream 模式）的 TCP 可达性：key 是规范化后的地址（scheme://host:port）。
  // 渲染层据此给 Clash 直连徽标着色。
  upstreamHealth?: Record<string, boolean>;
  // Profile 引用规则的语义化去向。key 使用 local:<name> / group:<group-id>/<name>，
  // UI 据此直接展示“本地 :3001 / PPE / BOE”，而不是让用户从规则名猜。
  ruleDestinations?: Record<string, BifrostRuleDestination>;
  // Bifrost 主入口当前启用的规则视图及其聚合去向；系统代理指向 mainPort 时直接展示。
  mainRules?: BifrostActiveRuleInfo[];
  mainRuleDestination?: BifrostRuleDestination | null;
  // Chromium 按系统设置解析出的实际 HTTP / HTTPS 代理路由。
  systemProxy?: SystemProxySnapshot;
}

export interface LaunchProfileOptions {
  // Bifrost 不可用时的直连逃生口：本次启动跳过代理注入，不修改已保存的分流配置。
  bypassProxy?: boolean;
  // Bifrost 未运行时由 ProfilePilot 启动 daemon，再恢复专属入口并继续启动。
  startBifrost?: boolean;
}

export interface ProfileAgentSettings {
  agentAccessDisabled: boolean;
}

export interface StoredMigratedExtension {
  id: string;
  sourceProfileId: string;
  sourceExtensionId: string;
  name: string;
  version: string;
  path: string;
  migratedAt: string;
  includeData: boolean;
}

export interface NativeProfileMetadata {
  lastLaunchedAt: string | null;
  name?: string | null;
}

export interface AccountSyncRecord {
  sourceProfileId: string;
  targetProfileId: string;
  syncedAt: string;
  copiedCount: number;
  skippedCount: number;
  launchedTarget: boolean;
  sourceFingerprints?: Record<string, string | null>;
}

export interface Registry {
  profiles: StoredProfile[];
  nativeProfiles?: Record<string, NativeProfileMetadata>;
  accountSyncRecords?: Record<string, AccountSyncRecord>;
  takeoverHistory?: AgentTakeoverEvent[];
  // AI 操作可见化 overlay 总开关。旧配置缺省视为开启。
  agentOverlayEnabled?: boolean;
  miniProfileIds?: string[];
  // 悬浮窗里 Profile 行的自定义排序（拖拽调整）；不在列表里的 Profile 排在末尾，保持自然顺序。
  miniProfileOrder?: string[];
  // 主窗口 Profile 表格的自定义排序（拖拽调整，含数据目录级与目录内两级）；
  // 语义同 miniProfileOrder：存完整显示顺序的 profile 公开 id，未列出的排末尾、保持自然顺序。
  mainProfileOrder?: string[];
  // 全局快捷键 ⌘⌥N 直启的槽位映射：键为槽位号 "1"~"9"，值为该槽位绑定的 profile 公开 id。
  // 一个槽位至多一个 profile，一个 profile 至多占一个槽位（改绑时会顶掉旧的）。
  quickLaunchSlots?: Record<string, string>;
}

export type BrowserDriverKind = "agent-browser" | "playwright-cli" | "chrome-devtools-mcp";
export type AgentSkillKey = BrowserDriverKind | "profilepilot-cli";

// 当前持有该 Profile CDP 端口持久连接的客户端（agent-browser / Playwright / DevTools 等）。
export interface CdpClientInfo {
  pid: number;
  label: string;
  // Gateway 验证过的驱动器身份；不再需要从进程名猜工具。
  driverKind?: BrowserDriverKind;
  // 同一个命名 Session 异常残留多个 daemon 时，把其它 PID 折叠到主连接上。
  // UI 不再误报成多个 Agent/会话，但会明确展示 daemon 重复故障。
  duplicatePids?: number[];
  // 能解析出来时，标注这条连接背后是哪个 AI 工具的哪个会话（用于悬停 tooltip）：
  // agent=工具名（Codex / Claude Code），project=项目目录名，title=会话首句/标题。
  agent?: string;
  project?: string;
  branch?: string;
  title?: string;
  // 使用方自报的命名 session（agent-browser --session <名>）；tooltip 里单独一行。
  session?: string;
  // 跨默认 Codex home / CODEX_HOME / Orca home 归一后的稳定身份。
  canonicalSessionId?: string;
  sessionRepresentations?: SessionRepresentation[];
  sessionDiagnostics?: SessionIdentityDiagnostic[];
  // 会话档案最后活动时间（ISO）＝该会话最近一次动静，用来区分活会话与残留连接。
  lastActive?: string;
  // 归属可信度说明：agent-browser 走共享 daemon 时归属是按其启动目录推测的（或推测不出），
  // 这里给出人话解释，UI 拼进 tooltip；精确归属时为空。
  note?: string;
}

export interface AgentBrowserSessionActivity {
  version: 1;
  session: string;
  command: string;
  cdpPort: number;
  pid: number;
  daemonPid?: number;
  agent?: string;
  cwd?: string;
  project?: string;
  branch?: string;
  updatedAt: string;
  expiresAt: string;
}

export interface AgentActivity {
  agent?: string;
  project?: string;
  branch?: string;
  session?: string;
  sessionTitle?: string;
  currentAction?: string;
  currentStep?: string;
  nextStep?: string;
  todoDone?: number;
  todoTotal?: number;
  lastMessage?: string;
  updatedAt?: string;
}

export interface AgentTakeoverEvent {
  profileId: string;
  profileName: string;
  session?: string;
  sessionTitle?: string;
  agent?: string;
  at: string;
}

export type AgentControlNoticeReason =
  | "user_takeover"
  | "agent_complete"
  | "user_stop"
  | "user_disconnect"
  | "user_return"
  | "driver_disconnected"
  | "driver_reconnected"
  | "driver_reconnect_exhausted";

export interface TakeoverAgentConnectionFailure {
  pid: number;
  label: string;
  session?: string;
  agent?: string;
  error: string;
}

export interface TakeoverAgentConnectionsResult {
  profileId: string;
  profileName: string;
  session?: string;
  targetCount: number;
  successCount: number;
  failureCount: number;
  allStopped: boolean;
  takeovers: AgentTakeoverEvent[];
  failures: TakeoverAgentConnectionFailure[];
}

export interface TakeoverAgentConnectionsResponse extends TakeoverAgentConnectionsResult {
  state: AppState;
}

export interface TakeoverAgentConnectionsRequest {
  session?: string;
  pids?: number[];
  reason?: AgentControlNoticeReason;
}

export interface AgentOverlayRevealEvent {
  profileId: string;
  profileName: string;
  at: string;
}

// AI 对某个 tab / Profile 的归属（借鉴 ego-lite 的三值枚举，取代散落的布尔+时间窗）：
// agent＝AI 正在驱动；agentDelegatedToUser＝用户主动接管但 Session 仍保持；
// user＝Session 已结束 / 无 AI 驱动。任务完成后直接进入 user 并释放 Session。
export type Ownership = "agent" | "agentDelegatedToUser" | "user";

export interface AgentControlNotice {
  version: 1;
  // 单调递增的控制权版本。等待方先读当前版本再订阅文件事件，避免快速“接管→交还”丢事件。
  controlVersion: number;
  code: string;
  reason: AgentControlNoticeReason;
  ownership: Ownership;
  // requested＝已禁止新命令、仍在等待当前命令收敛；quiesced＝执行面已安静，可开放用户输入。
  handoffState?: "requested" | "quiesced";
  // Agent 主动交给用户处理的未完成事项；存在时 complete 必须拒绝释放 Session。
  pendingUserAction?: string;
  message: string;
  action?: string;
  hardStop: boolean;
  profileId: string;
  profileName: string;
  pid: number;
  label: string;
  session?: string;
  sessionTitle?: string;
  agent?: string;
  at: string;
  expiresAt: string;
}

// tab 争用观测里“最抖”的那个标签页：观察窗口内 URL 变化次数与往返翻转（A→B→A）次数。
export interface CdpContentionChurn {
  title: string;
  url: string;
  changes: number;
  flipBacks: number;
  // 观察窗口内“驱动过这个 tab”的 owner 会话标识（AGENT_BROWSER_SESSION，如 cc-/cx-<uuid>；
  // 无命名 session 的连接退化成 pid:<pid>）。≥2 个不同 owner＝这个 tab 被多会话争抢。
  owners: string[];
}

// 面向 agent 的稳定信号（借鉴 ego-lite 的 EGO_* 契约模型，详见 main/agent-signals.ts）：
// code 是持久契约（跨版本不漂移），message 给人看，action 是一句机器可照做的指令，
// hardStop=是否属于「必须停手、按 action 处理」的硬停。UI 在 hardStop 时优先突出 action。
export interface ProfilePilotSignalInfo {
  code: string;
  message: string;
  action?: string;
  hardStop: boolean;
}

// 多会话争用判定（主进程算好给 UI 直接用）：
// level=contention：观察到同一标签页 URL 短时间反复往返改写 + ≥2 条驱动连接 → 疑似正在抢 tab；
// level=risk：≥2 条连接且其中 ≥2 个会话最近都有活动 → 有争用风险（还没观察到实际抢写）；
// level=null：单连接 / 一活一残留等正常情况。
export interface CdpContentionInfo {
  // 最近活动时间落在活跃窗口内的连接数（解析不出 lastActive 的连接不计入）。
  activeClientCount: number;
  // 争用观察者是否已连上该端口（没连上时 churn 恒为 null，判定只能靠活跃连接数）。
  observing: boolean;
  // 仅 level=contention 时给出：被抢写的标签页与其抖动读数。
  churn: CdpContentionChurn | null;
  level: "contention" | "risk" | null;
  // 面向 agent 的稳定信号（由 level 映射而来）：带 code + 一句可照做的 action + hardStop。
  // level=null 时为 null；UI 优先展示 hardStop 信号的 action。
  signal: ProfilePilotSignalInfo | null;
}

// 实时观测：一个正在以 CDP 运行的 Profile 当前“飞在哪”。
export interface CdpLiveTab {
  targetId: string;
  title: string;
  url: string;
  faviconUrl: string | null;
  // /json/list 里排在最前、被当作主标签（也是截图来源）的那一个。
  primary: boolean;
}

export interface CdpLiveView {
  port: number;
  capturedAt: string;
  tabCount: number;
  tabs: CdpLiveTab[];
  primaryTitle: string | null;
  primaryUrl: string | null;
  // 主标签页的一帧 JPEG 画面（data: URL）；关掉截图或抓取失败时为 null。
  screenshot: string | null;
  screenshotError: string | null;
  // 整体读取失败（端口没响应、浏览器已关闭等）时的原因；成功时为 null。
  error: string | null;
}

export interface CdpLiveViewOptions {
  screenshot?: boolean;
  targetId?: string;
}

export type ProfileSource = "native" | "isolated" | "isolated-sub";

export interface GatewayAgentTarget {
  targetId: string;
  title: string;
  url: string;
}

// Gateway 管理端口的权威控制状态。连接/接管 UI 必须优先使用它；本地 lease、activity
// 和 lsof 仅用于非 Gateway 端口的兼容展示，不能覆盖这里的状态。
export interface GatewayProfileControlState {
  publicPort: number;
  ownership: "agent" | "user";
  sessionStatus: "active" | "stopped";
  agentHealth: "online" | "waiting" | "offline";
  driverState: "disconnected" | "connecting" | "connected" | "reconnecting" | "parked";
  reconnectAttempt: number | null;
  reconnectDeadlineAt: string | null;
  connectionActive: boolean;
  ownerSessionId: string | null;
  daemonInstanceId: string | null;
  daemonPid: number | null;
  driverKind: BrowserDriverKind | null;
  driverLabel: string | null;
  agent: string | null;
  project: string | null;
  branch: string | null;
  agentTarget: GatewayAgentTarget | null;
  pendingUserAction: string | null;
  updatedAt: string;
}

export type SessionRepresentationSource =
  | "default-codex-home"
  | "configured-codex-home"
  | "orca-codex-home"
  | "claude-home";

export interface SessionRepresentation {
  source: SessionRepresentationSource;
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface SessionIdentityDiagnostic {
  code: "SESSION_CORE_UNAVAILABLE" | "SESSION_REPRESENTATION_NOT_FOUND";
  severity: "warning" | "error";
  message: string;
}

export interface CanonicalSessionIdentity {
  canonicalSessionId: string;
  engine: "codex" | "claude";
  nativeSessionId: string;
  representations: SessionRepresentation[];
  diagnostics: SessionIdentityDiagnostic[];
}

// agent-browser wrapper 用来做候选排他的同一份租约占用状态。Gateway 当前没有
// 活动连接时，UI 仍必须展示这份预留，不能把 Profile 误标为“空闲”。
export interface AgentBrowserProfileOccupancy {
  cdpPort: number;
  profileId: string;
  profileName: string;
  session: string;
  ownership: "agent" | "user";
  agent: string | null;
  project: string | null;
  command: string | null;
  holderPid: number;
  daemonPid: number | null;
  updatedAt: string;
}

export interface PublicProfile {
  id: string;
  source: ProfileSource;
  name: string;
  dirName: string;
  path: string;
  userDataDir: string;
  profileDataPath: string;
  createdAt: string | null;
  lastLaunchedAt: string | null;
  userName: string | null;
  isDefault: boolean;
  deletable: boolean;
  running: boolean;
  // 只描述目标 Chrome 进程是否是系统前台应用，不改变逻辑控制权，也不主动抢焦点。
  windowActivation: "foreground" | "background" | "not_running" | "unknown";
  pids: number[];
  // Chromium 应用主进程 PID。macOS Input Guard 只挂这些 PID，避免误挂 renderer/helper。
  browserPids?: number[];
  cdpPort: number | null;
  cdpUrl: string | null;
  fixedCdpPort: number | null;
  bifrostProxy: ProfileBifrostProxyConfig | null;
  upstreamProxy: ProfileUpstreamProxyConfig | null;
  directConnection: boolean;
  listeningPorts: number[];
  pinnedToMini: boolean;
  // 全局快捷键 ⌘⌥N 直启的槽位（1~9）；未指派为 null。可在主窗口「更多」菜单里改绑。
  quickLaunchSlot: number | null;
  // 副本池字段：克隆来源、来源名（已解析）、作为源时有多少副本指向它、项目标签。
  clonedFromProfileId: string | null;
  clonedFromName: string | null;
  cloneCount: number;
  projectTag: string | null;
  agentAccessDisabled: boolean;
  // 正驱动这个 Profile 的 CDP 客户端（持久连接到其调试端口的外部工具）；空数组=没有工具连接。
  cdpClients: CdpClientInfo[];
  // 由 ProfilePilot Gateway 管理时的权威控制状态；普通/旧式 CDP 端口为 null。
  gatewayControl: GatewayProfileControlState | null;
  // 与 agent-browser 自动候选筛选共用的排他占用状态；null 才表示未被租约预留。
  agentBrowserOccupancy: AgentBrowserProfileOccupancy | null;
  // 实时观测摘要：当前主标签页 URL 与打开的标签数（不含截图，随 getState 轮询刷新）；未运行/无 CDP 时为 null。
  livePrimaryUrl: string | null;
  liveTabCount: number | null;
  // 多会话争用判定：≥2 条驱动连接时才可能非 null 的 level；无 CDP/单连接时为 null 或 level=null。
  cdpContention: CdpContentionInfo | null;
  // 正在驱动这个 Profile 的 agent 的实时活动（会话 tail 解析结果）；无 agent 驱动时为 null。
  agentActivity: AgentActivity | null;
}

export interface NativeChromeProfile {
  dirName: string;
  name: string;
  userName: string | null;
  path: string;
  userDataDir: string;
  isDefault: boolean;
}

export interface ExternalChromeInstance {
  userDataDir: string;
  label: string;
  browser: string;
  pid: number;
  startedAt: string | null;
  cdpPort: number | null;
  cdpUrl: string | null;
  cdpClients?: CdpClientInfo[];
  agentActivity?: AgentActivity | null;
  headless: boolean;
}

// 会话识别 shell 集成（~/.zshenv 托管块）的状态。
// installed=注入已生效（含用户手写版本）；managed=由本工具的标记块提供，可一键移除。
export interface ShellIntegrationStatus {
  supported: boolean;
  installed: boolean;
  managed: boolean;
  path: string;
  error: string | null;
}

export type AgentToolAvailability = "installed" | "missing" | "error";

export interface AgentToolDiagnostic {
  key: BrowserDriverKind;
  label: string;
  availability: AgentToolAvailability;
  executablePath: string | null;
  version: string | null;
  source: "binary" | null;
  installCommand: string;
  verifyCommand: string;
  error: string | null;
}

export interface AgentWrapperDiagnostic {
  key: BrowserDriverKind;
  label: string;
  wrapperPath: string;
  launcherPath: string;
  wrapperInstalled: boolean;
  launcherInstalled: boolean;
}

export type AgentSkillHost = "shared" | "codex" | "claude";

export interface AgentSkillTargetDiagnostic {
  host: AgentSkillHost;
  label: string;
  path: string;
  installed: boolean;
  managed: boolean;
  upToDate: boolean;
}

export interface AgentSkillDiagnostic {
  key: AgentSkillKey;
  label: string;
  skillId: string;
  installed: boolean;
  managed: boolean;
  upToDate: boolean;
  installedTargetCount: number;
  managedTargetCount: number;
  targetCount: number;
  installPath: string;
  targets: AgentSkillTargetDiagnostic[];
  error: string | null;
}

export interface ProfilePilotCliDiagnostic {
  installed: boolean;
  bundleInstalled: boolean;
  launcherInstalled: boolean;
  upToDate: boolean;
  bundlePath: string;
  launcherPath: string;
  skill: AgentSkillDiagnostic;
  error: string | null;
}

export interface InputGuardPermissionDiagnostic {
  platform?: NodeJS.Platform;
  supported: boolean;
  granted: boolean;
  appName: string;
  appPath: string | null;
  inspectedAt: string;
  error: string | null;
}

export interface AgentIntegrationDiagnostic {
  inspectedAt: string;
  ready: boolean;
  shellIntegration: ShellIntegrationStatus;
  wrapperDirectory: string;
  tools: AgentToolDiagnostic[];
  wrappers: AgentWrapperDiagnostic[];
  skills: AgentSkillDiagnostic[];
  managementCli: ProfilePilotCliDiagnostic;
  inputGuard: InputGuardPermissionDiagnostic;
}

export interface AppState {
  platform?: NodeJS.Platform;
  appTitle: string;
  dataDir: string;
  profilesDir: string;
  profiles: PublicProfile[];
  nativeProfileCount: number;
  isolatedProfileCount: number;
  nativeChromeProfiles: NativeChromeProfile[];
  runningProfiles: PublicProfile[];
  currentProfile: PublicProfile | null;
  chromeLauncher: string;
  accountSyncRecords: AccountSyncRecord[];
  externalInstances: ExternalChromeInstance[];
  miniProfileIds: string[];
  miniProfileOrder: string[];
  mainProfileOrder: string[];
  agentOverlayEnabled: boolean;
  shellIntegration: ShellIntegrationStatus;
}

export type ProfileReadinessStatus = "pass" | "fail" | "unknown" | "not_applicable";
export type ProfileReadinessOverall = "ready" | "degraded" | "blocked";

export interface ProfileReadinessExtensionRequirement {
  id: string;
  name?: string;
  minVersion?: string;
}

export interface ProfileReadinessExpectation {
  requireRunning?: boolean;
  requireCdp?: boolean;
  requireAgentControl?: boolean;
  requireForeground?: boolean;
  requireBrowserAccount?: boolean;
  expectedLogicalPort?: number | null;
  expectedProxyKind?: "system" | "bifrost" | "upstream" | "direct";
  requiredBifrostRules?: string[];
  expectedTargetUrlIncludes?: string;
  expectedLoginLabel?: string;
  requiredExtensions?: ProfileReadinessExtensionRequirement[];
}

export interface ProfileReadinessRequest {
  profileId: string;
  expectation?: ProfileReadinessExpectation;
}

export interface ProfileReadinessCheck {
  id: string;
  code: string;
  label: string;
  status: ProfileReadinessStatus;
  required: boolean;
  expected: string | null;
  actual: string;
  evidence?: string | null;
  action: string | null;
}

export interface ProfileReadinessReceipt {
  version: 1;
  receiptId: string;
  generatedAt: string;
  overall: ProfileReadinessOverall;
  target: {
    profileId: string;
    profileName: string;
    expectedLogicalPort: number | null;
    expectedProxyKind: ProfileReadinessExpectation["expectedProxyKind"] | null;
    expectedTargetUrl: string | null;
    expectedLogin: string | null;
  };
  checks: ProfileReadinessCheck[];
  blockerCodes: string[];
  unknownCodes: string[];
  sessionIdentity: CanonicalSessionIdentity | null;
}

export interface DeleteProfileResult {
  deletedProfile: PublicProfile;
  trashPath: string | null;
  state: AppState;
}

export interface DeleteProfileOptions {
  quitChromeBeforeDelete?: boolean;
}

export interface ExtensionDataPath {
  label: string;
  relativePath: string;
  path: string;
}

export type ProfileExtensionInstallType = "web_store" | "local" | "profile" | "component" | "unknown";

export interface ProfileExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string | null;
  enabled: boolean;
  fromWebStore: boolean;
  installType: ProfileExtensionInstallType;
  storeUrl: string | null;
  path: string | null;
  hasLocalData: boolean;
  dataPaths: ExtensionDataPath[];
  canCopyLocally: boolean;
  canPersistInstall: boolean;
}

export interface ExtensionScanResult {
  profileId: string;
  profileName: string;
  profilePath: string;
  extensions: ProfileExtensionInfo[];
}

export interface ExtensionMigrationRequest {
  sourceProfileId: string;
  targetProfileId: string;
  extensionIds: string[];
  includeData: boolean;
  openInstallPages: boolean;
  onlyChanged?: boolean;
}

export type ExtensionMigrationDiffStatus =
  | "missing"
  | "version_changed"
  | "data_changed"
  | "same"
  | "needs_install_page"
  | "manual_load_required"
  | "unsupported";

export interface ExtensionMigrationDiffItem {
  id: string;
  name: string;
  sourceVersion: string;
  targetVersion: string | null;
  status: ExtensionMigrationDiffStatus;
  reason: string;
  willCopyLocally: boolean;
  willLoadViaCdp: boolean;
  willOpenInstallPage: boolean;
}

export interface ExtensionMigrationDiffTargetOnlyItem {
  id: string;
  name: string;
  version: string;
}

export interface ExtensionMigrationDiffResult {
  sourceProfileId: string;
  targetProfileId: string;
  includeData: boolean;
  items: ExtensionMigrationDiffItem[];
  targetOnlyItems: ExtensionMigrationDiffTargetOnlyItem[];
  summary: {
    missingCount: number;
    changedCount: number;
    sameCount: number;
    needsInstallPageCount: number;
    cdpLoadCount: number;
    manualLoadCount: number;
    unsupportedCount: number;
    targetOnlyCount: number;
  };
}

export interface ExtensionMigrationCopiedExtension {
  id: string;
  name: string;
  version: string;
  path: string;
  fromWebStore: boolean;
}

export interface ExtensionMigrationDataCopy {
  id: string;
  name: string;
  relativePath: string;
}

export interface ExtensionMigrationLoadedExtension {
  id: string;
  loadedId: string;
  name: string;
  version: string;
  path: string;
  via: "cdp_runtime";
}

export interface ExtensionMigrationSkippedExtension {
  id: string;
  name: string;
  reason: string;
}

export interface ExtensionMigrationManualLoadExtension {
  id: string;
  name: string;
  path: string;
}

export interface ExtensionMigrationResult {
  sourceProfileId: string;
  targetProfileId: string;
  selectedCount: number;
  copiedExtensions: ExtensionMigrationCopiedExtension[];
  loadedLocalExtensions: ExtensionMigrationLoadedExtension[];
  dataCopies: ExtensionMigrationDataCopy[];
  webStoreInstallUrls: string[];
  manualLoadExtensions: ExtensionMigrationManualLoadExtension[];
  skippedExtensions: ExtensionMigrationSkippedExtension[];
  openedInstallPages: boolean;
  reopenedTarget: boolean;
  reopenedSource: boolean;
  restoredTargetTabs: number;
  restoredSourceTabs: number;
  state: AppState;
}

export interface ExtensionDeleteResult {
  profileId: string;
  profileName: string;
  extensionId: string;
  extensionName: string;
  deletedPaths: string[];
  scan: ExtensionScanResult;
  state: AppState;
}

export interface AccountSyncRequest {
  sourceProfileId: string;
  targetProfileId: string;
  launchTarget: boolean;
  onlyChanged?: boolean;
}

export type AccountSyncDiffStatus = "changed" | "same" | "source_missing" | "target_missing";

export interface AccountSyncDiffItem {
  label: string;
  relativePath: string;
  status: AccountSyncDiffStatus;
  reason: string;
}

export interface AccountSyncDiffResult {
  sourceProfileId: string;
  targetProfileId: string;
  items: AccountSyncDiffItem[];
  summary: {
    changedCount: number;
    sameCount: number;
    sourceMissingCount: number;
    targetMissingCount: number;
    syncableCount: number;
  };
}

export interface AccountSyncCopiedItem {
  label: string;
  relativePath: string;
}

export interface AccountSyncSkippedItem {
  label: string;
  relativePath: string;
  reason: string;
}

export interface AccountSyncResult {
  sourceProfileId: string;
  targetProfileId: string;
  copiedItems: AccountSyncCopiedItem[];
  skippedItems: AccountSyncSkippedItem[];
  launchedTarget: boolean;
  restoredTargetTabs: number;
  state: AppState;
}

export interface CloneProfilesRequest {
  sourceProfileId: string;
  count: number;
  namePrefix?: string;
  basePort?: number | null;
  includeExtensions?: boolean;
  launchAfter?: boolean;
}

export interface ClonedProfileInfo {
  profileId: string;
  name: string;
  port: number | null;
  launched: boolean;
}

export interface CloneProfilesResult {
  sourceProfileId: string;
  created: ClonedProfileInfo[];
  state: AppState;
}

export interface RefreshClonesResult {
  sourceProfileId: string;
  refreshedCount: number;
  skippedCount: number;
  refreshed: Array<{ profileId: string; name: string; copiedCount: number }>;
  state: AppState;
}

export interface RecycleIdleClonesResult {
  days: number;
  deleted: Array<{ profileId: string; name: string }>;
  state: AppState;
}

export interface LaunchClonesResult {
  sourceProfileId: string;
  launched: Array<{ profileId: string; name: string; port: number | null }>;
  failed: Array<{ profileId: string; name: string; reason: string }>;
  state: AppState;
}

export type GlobalInstructionFileId = "codex-agents" | "claude-memory";
export type GlobalInstructionFileRole = "primary" | "reference";

export interface GlobalInstructionFile {
  id: GlobalInstructionFileId;
  title: string;
  fileName: string;
  path: string;
  role: GlobalInstructionFileRole;
  editable: boolean;
  referenceTargetPath: string | null;
  referenceShellContent: string | null;
  isReferenceShell: boolean | null;
  exists: boolean;
  content: string;
  sizeBytes: number;
  updatedAt: string | null;
  error: string | null;
  revision: string;
  sourceLabel: string;
  diagnostics: GlobalInstructionDiagnostic[];
}

export interface GlobalInstructionsSnapshot {
  readAt: string;
  files: GlobalInstructionFile[];
  canUndo: boolean;
  undoAvailableIds: GlobalInstructionFileId[];
  lastBackupAt: string | null;
}

export interface GlobalInstructionUpdateRequest {
  id: GlobalInstructionFileId;
  content: string;
  expectedRevision?: string;
}

export interface GlobalInstructionUndoRequest {
  id: GlobalInstructionFileId;
  expectedRevision?: string;
}

export interface GlobalInstructionDiagnostic {
  code: "REFERENCE_SHELL_DIVERGED" | "REFERENCE_SHELL_MISSING" | "PRIMARY_SOURCE_MISSING";
  severity: "info" | "warning";
  message: string;
}

export interface CdpPortSuggestion {
  preferredPort: number;
  port: number;
  preferredAvailable: boolean;
  preferredOwner: string | null;
  // 端口被占时的稳定信号（CDP_PORT_UNAVAILABLE）：带一句「改用建议端口重连」的可照做 action；
  // 端口可用时为 null。
  signal: ProfilePilotSignalInfo | null;
}

export interface OperationProgress {
  key: string;
  message: string;
  profileId?: string;
  step?: string;
  stepIndex?: number;
  stepCount?: number;
  paused?: boolean;
}

export type OperationProgressUpdate = Omit<OperationProgress, "key" | "profileId">;

export interface CancelOperationRequest {
  key: string;
  profileId?: string;
}

export type ControlOperationAction = "pause" | "resume";

export interface ControlOperationRequest {
  key: string;
  profileId?: string;
  action: ControlOperationAction;
}

export interface OperationPauseSignal {
  readonly paused: boolean;
  waitIfPaused(): Promise<void>;
}

export interface ProfileManagerApi {
  getStartupSettings(): Promise<StartupSettings>;
  setStartupEnabled(enabled: boolean): Promise<StartupSettings>;
  getState(): Promise<AppState>;
  onStateChanged(listener: (state: AppState) => void): () => void;
  getTakeoverHistory(): Promise<AgentTakeoverEvent[]>;
  createProfile(name: string): Promise<AppState>;
  renameProfile(id: string, name: string): Promise<AppState>;
  launchProfile(id: string, options?: LaunchProfileOptions): Promise<AppState>;
  launchProfileWithCdp(id: string, port?: number | null, options?: LaunchProfileOptions): Promise<AppState>;
  connectRunningSystemChrome(id: string): Promise<AppState>;
  suggestCdpPort(preferredPort?: number | null): Promise<CdpPortSuggestion>;
  getBifrostSnapshot(): Promise<BifrostSnapshot>;
  disableBifrostRule(ruleName: string): Promise<BifrostSnapshot>;
  setProfileProxy(id: string, config: ProfileProxyConfig | null): Promise<AppState>;
  setProfileAgentSettings(id: string, settings: ProfileAgentSettings): Promise<AppState>;
  setMiniProfilePinned(id: string, pinned: boolean): Promise<AppState>;
  setMiniProfileOrder(ids: string[]): Promise<AppState>;
  setMainProfileOrder(ids: string[]): Promise<AppState>;
  setQuickLaunchSlot(id: string, slot: number | null): Promise<AppState>;
  setMiniPanelPinned(pinned: boolean): Promise<void>;
  onMiniPanelPinnedChanged(listener: (pinned: boolean) => void): () => void;
  showMiniWindow(): Promise<void>;
  hideMiniWindow(): Promise<void>;
  showMainWindow(): Promise<void>;
  setMiniWindowPanelOpen(open: boolean): Promise<void>;
  resizeMiniPanel(height: number): Promise<void>;
  requestMiniWindowPanelClose(): Promise<void>;
  dragMiniWindow(screenX: number, screenY: number, phase: "start" | "move" | "end"): Promise<void>;
  isMiniWindowPointerInside(): Promise<boolean>;
  onMiniWindowPanelOpenChanged(listener: (open: boolean) => void): () => void;
  readGlobalInstructions(): Promise<GlobalInstructionsSnapshot>;
  writeGlobalInstruction(request: GlobalInstructionUpdateRequest): Promise<GlobalInstructionsSnapshot>;
  undoGlobalInstruction(request: GlobalInstructionUndoRequest): Promise<GlobalInstructionsSnapshot>;
  ensureClaudeInstructionShell(): Promise<GlobalInstructionsSnapshot>;
  inspectProfileReadiness(request: ProfileReadinessRequest): Promise<ProfileReadinessReceipt>;
  focusProfile(id: string): Promise<void>;
  isProfileFrontmost(id: string): Promise<boolean>;
  closeProfile(id: string): Promise<AppState>;
  focusExternalInstance(userDataDir: string): Promise<AppState>;
  closeExternalInstance(userDataDir: string): Promise<AppState>;
  // 结束某条 CDP 驱动连接：对该客户端进程发信号使其断开，不动 Chrome。
  disconnectCdpClient(profileId: string, pid: number): Promise<AppState>;
  // 暂停当前 AI 浏览器会话并写入接管历史；session 缺省时接管该 Profile 的全部 AI 会话。
  takeoverAgentConnections(
    profileId: string,
    sessionOrOptions?: string | TakeoverAgentConnectionsRequest
  ): Promise<TakeoverAgentConnectionsResponse>;
  resumeAgentConnections(
    profileId: string,
    sessionOrOptions?: string | TakeoverAgentConnectionsRequest
  ): Promise<TakeoverAgentConnectionsResponse>;
  // AI 操作可见化 overlay 总开关。
  setAgentOverlayEnabled(enabled: boolean): Promise<AppState>;
  // 启用/移除会话识别 shell 集成（~/.zshenv 托管块），返回刷新后的完整状态。
  setShellIntegrationEnabled(enabled: boolean): Promise<AppState>;
  inspectAgentIntegration(): Promise<AgentIntegrationDiagnostic>;
  setAgentWrapperEnabled(tool: BrowserDriverKind, enabled: boolean): Promise<AgentIntegrationDiagnostic>;
  setAgentSkillEnabled(tool: BrowserDriverKind, enabled: boolean): Promise<AgentIntegrationDiagnostic>;
  setProfilePilotCliEnabled(enabled: boolean): Promise<AgentIntegrationDiagnostic>;
  setProfilePilotCliSkillEnabled(enabled: boolean): Promise<AgentIntegrationDiagnostic>;
  requestInputGuardPermission(): Promise<AgentIntegrationDiagnostic>;
  openInputGuardSettings(): Promise<boolean>;
  prepareProfileForAgent(profileId: string): Promise<AppState>;
  openProfileFolder(id: string): Promise<AppState>;
  openProfileExtensionsPage(id: string): Promise<AppState>;
  openPath(path: string): Promise<boolean>;
  deleteProfile(id: string, options?: DeleteProfileOptions): Promise<DeleteProfileResult>;
  inspectAccountSyncDiff(request: AccountSyncRequest): Promise<AccountSyncDiffResult>;
  scanProfileExtensions(profileId: string): Promise<ExtensionScanResult>;
  inspectExtensionMigrationDiff(request: ExtensionMigrationRequest): Promise<ExtensionMigrationDiffResult>;
  migrateExtensions(request: ExtensionMigrationRequest): Promise<ExtensionMigrationResult>;
  deleteProfileExtension(profileId: string, extensionId: string): Promise<ExtensionDeleteResult>;
  syncAccount(request: AccountSyncRequest): Promise<AccountSyncResult>;
  cloneProfiles(request: CloneProfilesRequest): Promise<CloneProfilesResult>;
  refreshClones(sourceProfileId: string): Promise<RefreshClonesResult>;
  resetClone(profileId: string): Promise<AccountSyncResult>;
  recycleIdleClones(days: number): Promise<RecycleIdleClonesResult>;
  setProfileTag(profileId: string, tag: string): Promise<AppState>;
  launchClones(sourceProfileId: string): Promise<LaunchClonesResult>;
  cancelOperation(request: CancelOperationRequest): Promise<boolean>;
  controlOperation(request: ControlOperationRequest): Promise<boolean>;
  getCdpLiveView(port: number, options?: CdpLiveViewOptions): Promise<CdpLiveView>;
  onOperationProgress(listener: (progress: OperationProgress) => void): () => void;
  onAgentTakeover(listener: (event: AgentTakeoverEvent) => void): () => void;
  onAgentOverlayReveal(listener: (event: AgentOverlayRevealEvent) => void): () => void;
}
