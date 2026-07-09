import { dateFormatter, store } from "./state";
import { AgentActivity, BusyProgressStep, CdpClientInfo, CdpPortSuggestion, ProfileExtensionInfo, PublicProfile } from "./types";

export function renderBusyBanner(): string {
  if (!store.busyState) {
    return "";
  }

  return `
    <div class="busy-banner relative flex items-center gap-2.5 overflow-hidden mt-0 mb-[14px] mx-0 border-solid border border-accent-line rounded-lg bg-[linear-gradient(180deg,rgba(56,225,160,0.12),rgba(56,225,160,0.05))] text-accent-bright px-[13px] py-[11px] text-[13px] font-bold [box-shadow:inset_0_1px_0_rgba(111,242,192,0.12),var(--glow-accent)] ${store.busyState.paused ? "paused" : ""}" role="status" aria-live="polite">
      <span class="sync-spinner" aria-hidden="true"></span>
      <span data-busy-message>${escapeHtml(store.busyState.message)}</span>
      ${store.busyState.stepIndex && store.busyState.stepCount ? `<span class="busy-step-count ml-auto text-accent font-mono text-[12px] tabular-nums" data-busy-count>${store.busyState.stepIndex}/${store.busyState.stepCount}</span>` : ""}
    </div>
  `;
}

export function renderOperationProgress(key: string, title: string): string {
  const activeBusyState = store.busyState?.key === key ? store.busyState : null;
  if (!activeBusyState) {
    return "";
  }

  return `
    <div class="operation-progress ${activeBusyState.paused ? "paused" : ""}" role="status" aria-live="polite">
      <div class="operation-progress-head">
        <span class="sync-spinner" aria-hidden="true"></span>
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span data-busy-message>${escapeHtml(activeBusyState.message)}</span>
        </div>
        ${activeBusyState.stepIndex && activeBusyState.stepCount ? `<em data-busy-count>${activeBusyState.stepIndex}/${activeBusyState.stepCount}</em>` : ""}
      </div>
      ${activeBusyState.steps?.length ? renderOperationProgressSteps(activeBusyState.steps) : ""}
    </div>
  `;
}

export function renderOperationProgressSteps(steps: BusyProgressStep[]): string {
  return `
    <ol class="operation-progress-steps">
      ${steps
        .map(
          (step) => `
            <li class="${step.status}">
              <span aria-hidden="true"></span>
              <strong>${escapeHtml(step.label)}</strong>
            </li>
          `
        )
        .join("")}
    </ol>
  `;
}

export function renderButtonLabel(isLoading: boolean, idleLabel: string, loadingLabel: string): string {
  if (!isLoading) {
    return escapeHtml(idleLabel);
  }

  return `<span class="inline-spinner" aria-hidden="true"></span><span>${escapeHtml(loadingLabel)}</span>`;
}

export function formatCdpPortSuggestionNote(suggestion: CdpPortSuggestion): string {
  if (suggestion.preferredAvailable) {
    return `已检测端口 ${suggestion.port} 可用。`;
  }

  const owner = suggestion.preferredOwner ? `，占用者：${suggestion.preferredOwner}` : "";
  // 端口被占＝面向 agent 的硬停信号：把稳定码 + 一句可照做的 action 一并给出。
  const guidance = suggestion.signal?.action ? ` [${suggestion.signal.code}] ${suggestion.signal.action}` : "";
  return `端口 ${suggestion.preferredPort} 已被占用${owner}，已自动改用 ${suggestion.port}。${guidance}`;
}

export function formatErrorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const ipcPrefix = /^Error invoking remote method '[^']+':\s*/;
  const classPrefix = /^(ProfileManagerError|Error):\s*/;
  const cleaned = rawMessage.replace(ipcPrefix, "").replace(classPrefix, "").trim();
  if (cleaned.includes("ENOENT") && cleaned.includes(".profilepilot-sync-")) {
    return "同步临时文件已被系统清理或上次任务中断，请重新点击同步，ProfilePilot 会先恢复临时状态再继续。";
  }

  return cleaned || "操作失败，请稍后重试。";
}

export function profileStatusLabel(profile: PublicProfile): string {
  return profile.running ? "运行中" : "未运行";
}

export function sourceLabel(profile: PublicProfile): string {
  return profile.source === "native" ? "系统" : "独立";
}

export function sourceDetail(profile: PublicProfile): string {
  if (profile.source === "native") {
    return "系统 Profile（Google Chrome User Data 下的子 Profile）";
  }
  if (profile.source === "isolated-sub") {
    return "隔离目录内的子 Profile（Chrome 额外账户，与父实例共享目录）";
  }
  return "工具独立 Profile（独立 User Data Dir）";
}

export function extensionInstallTypeLabel(extension: ProfileExtensionInfo): string {
  if (extension.fromWebStore) {
    return "商店";
  }

  if (extension.installType === "local") {
    return "本地";
  }

  if (extension.installType === "profile") {
    return "Profile";
  }

  if (extension.installType === "component") {
    return "组件";
  }

  return "未知";
}

export function renderDiffItem(label: string, reason: string, status: string): string {
  return `
    <span class="diff-item ${diffStatusClass(status)}">
      <strong>${escapeHtml(label)}</strong>
      <em>${escapeHtml(reason)}</em>
    </span>
  `;
}

export function diffStatusClass(status: string): string {
  if (status === "same") {
    return "same";
  }
  if (status === "source_missing" || status === "unsupported") {
    return "muted";
  }
  if (status === "needs_install_page" || status === "manual_load_required") {
    return "warn";
  }

  return "changed";
}

export function listeningPortsNote(profile: PublicProfile): string {
  if (!profile.running) {
    return "Profile 未运行时不会占用本机 TCP 监听端口。";
  }

  if (!profile.listeningPorts.length) {
    return "未发现该 Profile 关联进程正在监听本机 TCP 端口。";
  }

  if (profile.cdpPort && profile.listeningPorts.includes(profile.cdpPort)) {
    return `其中 ${profile.cdpPort} 是 ProfilePilot 以 CDP 模式启动并验证过的调试端口。`;
  }

  if (profile.source === "native") {
    return "这些只是系统 Chrome 主进程占用的本机 TCP 端口；它们不是 ProfilePilot 已验证的 CDP 地址。";
  }

  return "这些端口由该独立 Profile 的 Chrome 进程占用；只有通过 CDP 启动并显示 CDP 地址的端口才可用于调试连接。";
}

export function launchButtonTitle(profile: PublicProfile): string {
  return profile.running ? "这个 Profile 已经在运行中" : "启动这个 Profile";
}

// 系统默认 Profile 用的是 Chrome 默认数据目录，从 Chrome 136 起会静默拒绝
// --remote-debugging-port，所以无法像独立 Profile 那样开 CDP 调试端口。
export const NATIVE_CDP_UNSUPPORTED_NOTE =
  "这是系统 Chrome Profile，没法由 ProfilePilot 开端口式 CDP 调试。Agent 仍可连接，但需要你先在网页里完成一次授权。";

export function cdpLaunchButtonTitle(profile: PublicProfile): string {
  if (profile.source === "native") {
    return NATIVE_CDP_UNSUPPORTED_NOTE;
  }

  if (profile.running) {
    return profile.cdpUrl
      ? `CDP 已开启：${profile.cdpUrl}`
      : "需要先关闭这个 Profile，再用 CDP 模式重新启动；CDP 端口只能在启动 Chrome 时指定";
  }

  return "启动这个 Profile，并开启本机 CDP 监听端口";
}

export function focusButtonTitle(profile: PublicProfile): string {
  return profile.running ? "把这个 Profile 的 Chrome 窗口显示到最前面" : "这个 Profile 当前未运行";
}

export function closeButtonTitle(profile: PublicProfile): string {
  return profile.running ? "关闭这个 Profile 的 Chrome 实例" : "这个 Profile 当前未运行";
}

export function deleteButtonTitle(profile: PublicProfile): string {
  if (profile.isDefault) {
    return "Default 本机 Chrome Profile 受保护，不能删除";
  }
  if (!profile.deletable) {
    return "这个 Profile 不能删除";
  }
  if (profile.running) {
    return "删除这个 Profile，会先关闭它的 Chrome 窗口";
  }

  return "删除这个 Profile";
}

export function closeConfirmCopy(profile: PublicProfile): { title: string; body: string; confirmLabel: string } {
  if (profile.source === "native" && profile.isDefault) {
    return {
      title: `关闭 ${profile.name}`,
      body: "这会退出当前本机 Google Chrome 实例。未保存的网页内容可能会丢失。",
      confirmLabel: "确认关闭"
    };
  }

  return {
    title: `关闭 ${profile.name}`,
    body: "这会结束这个 Profile 对应的 Chrome 实例。未保存的网页内容可能会丢失。",
    confirmLabel: "确认关闭"
  };
}

export function deleteConfirmCopy(profile: PublicProfile): { title: string; body: string; confirmLabel: string } {
  if (profile.source === "isolated-sub") {
    return {
      title: `删除子 Profile ${profile.name}`,
      body: profile.running
        ? "这是隔离目录里 Chrome 额外新建的子 Profile。删除会先关闭它所在的整个隔离实例（含同目录下其它 Profile 的窗口），未保存内容可能丢失；随后把该子 Profile 目录移到废纸篓，并从该目录的 Chrome Profile 列表中摘除。"
        : "这是隔离目录里 Chrome 额外新建的子 Profile。删除会把它的目录移到废纸篓，并从该目录的 Chrome Profile 列表中摘除。",
      confirmLabel: profile.running ? "关闭实例并删除" : "确认删除"
    };
  }

  if (profile.running) {
    return {
      title: `删除 ${profile.name}`,
      body: "删除会先关闭这个 Profile 的 Chrome 窗口，未保存的网页内容可能会丢失；随后会把 Profile 目录移到废纸篓。",
      confirmLabel: "关闭并删除"
    };
  }

  return {
    title: `删除 ${profile.name}`,
    body: "这个 Profile 的目录会移到废纸篓。",
    confirmLabel: "确认删除"
  };
}

export function formatDate(value: string | null): string {
  if (!value) {
    return "从未";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "未知";
  }

  return dateFormatter.format(date);
}

// 会话档案最后活动时间（ISO）→ 相对时间。用来区分“活会话”和“残留连接”：
// 一个连着 CDP 但会话档案很久没动的，多半是残留进程，而非有人正在驱动。
// 刚刚 / n分钟前 / n小时前 / n天前；解析不出时返回空串。
export function formatRelativeTime(value?: string | null): string {
  if (!value) {
    return "";
  }
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) {
    return "";
  }
  const min = Math.floor((Date.now() - then) / 60000);
  if (min < 1) {
    return "刚刚";
  }
  if (min < 60) {
    return `${min}分钟前`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}小时前`;
  }
  return `${Math.floor(hr / 24)}天前`;
}

// CDP 客户端 → 卡片正文可见的会话身份文案「项目 · 标题」。工具名在读数/药丸里已给，
// 这里只补项目和会话标题（最近活动时间另外拼，避免被截断吃掉）；都解析不出时返回空串。
export function cdpSessionText(client: CdpClientInfo): string {
  return [client.project, client.title].filter(Boolean).join(" · ");
}

// 连接列表 → 人话工具清单：同名去重计数（agent-browser ×2、Claude Code）。
// pid 是进程细节，面向用户的汇总不带它；需要精确区分时（断连按钮）才单独补。
export function cdpClientToolSummary(clients: CdpClientInfo[]): string {
  const counts = new Map<string, number>();
  for (const client of clients) {
    const tool = client.agent || prettyCdpClientLabel(client.label);
    counts.set(tool, (counts.get(tool) || 0) + 1);
  }
  return [...counts.entries()].map(([tool, count]) => (count > 1 ? `${tool} ×${count}` : tool)).join("、");
}

export function isAgentDrivenCdpClient(client: CdpClientInfo): boolean {
  const label = client.label.toLowerCase();
  return Boolean(
    client.agent ||
      client.project ||
      client.session ||
      client.title ||
      label.startsWith("agent-browser") ||
      label === "codex" ||
      label === "claude code"
  );
}

export function agentDrivenCdpClients(clients: CdpClientInfo[]): CdpClientInfo[] {
  return clients.filter(isAgentDrivenCdpClient);
}

// 争用警示·短版（药丸 tooltip / 悬浮窗用）：一眼看懂发生了什么，细节和建议留给详情栏。
export function contentionNoticeShort(profile: PublicProfile): string {
  const info = profile.cdpContention;
  if (!info?.level) {
    return "";
  }
  if (info.level === "contention") {
    const churn = info.churn;
    return `⚠ 疑似多会话在抢同一个标签页${churn ? `（90 秒内被改写 ${churn.changes} 次）` : ""}`;
  }
  return `⚠ ${info.activeClientCount} 个活跃会话共用此 Profile，可能互抢标签页`;
}

// 争用判定 → 完整警示（详情栏横幅用）：带被抢标签页读数和处置建议。
// contention=观察到实际抢写（带被抢标签页的读数）；risk=两个活跃会话共用、还没抓到抢写现场。
// 有面向 agent 的稳定信号时，处置建议直接换成「[稳定码] 一句可照做的 action」——对标 ego：
// 给 agent 的不是现象，而是稳定码 + 一句可照做的指令。
export function contentionNotice(profile: PublicProfile): string {
  const info = profile.cdpContention;
  if (!info?.level) {
    return "";
  }
  const signal = info.signal;
  if (info.level === "contention") {
    const churn = info.churn;
    const tabName = churn ? churn.title || hostOf(churn.url) : "";
    const detail = churn ? `：「${tabName}」90 秒内 URL 被改写 ${churn.changes} 次、往返翻转 ${churn.flipBacks} 次` : "";
    // 按 tab 粒度点名归属：这个被抢的标签页在窗口内被哪些 owner 会话驱动过（≥2 个才有意义）。
    const owners = churn && churn.owners.length >= 2 ? `（争抢方：${churn.owners.join("、")}）` : "";
    const guidance = signal?.action ? ` [${signal.code}] ${signal.action}` : "建议把其中一个会话挪到独立 Profile/副本。";
    return `⚠ 疑似多个会话正在抢同一个标签页${detail}${owners}。${guidance}`;
  }
  const guidance = signal?.action ? ` [${signal.code}] ${signal.action}` : "建议给第二个会话克隆一个副本。";
  return `⚠ ${info.activeClientCount} 个活跃会话共用此 Profile，可能互相抢标签页/焦点。${guidance}`;
}

// 面向 agent 的信号 → 塌缩成一行硬停引导 `[CODE] action`（对标 ego 的 hard-stop collapse：
// 硬停时丢弃现象、只留一句 owned guidance）。非硬停 / 无信号返回空串。
export function contentionHardStopGuidance(profile: PublicProfile): string {
  const signal = profile.cdpContention?.signal;
  if (!signal || !signal.hardStop || !signal.action) {
    return "";
  }
  return `[${signal.code}] ${signal.action}`;
}

function cleanActivityText(value?: string | null): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function activityCount(value?: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function hasAgentActivity(profile: PublicProfile): boolean {
  return Boolean(profile.agentActivity) && profile.cdpClients.length > 0;
}

export function agentActivityLeadText(activity?: AgentActivity | null): string {
  if (!activity) {
    return "";
  }
  return (
    cleanActivityText(activity.currentAction) ||
    cleanActivityText(activity.currentStep) ||
    cleanActivityText(activity.lastMessage) ||
    ""
  );
}

export function agentActivityProgressText(activity?: AgentActivity | null): string {
  if (!activity) {
    return "";
  }
  const done = activityCount(activity.todoDone);
  const total = activityCount(activity.todoTotal);
  if (done !== null && total !== null && total > 0) {
    return `${done}/${total}`;
  }
  if (done !== null) {
    return `${done}`;
  }
  if (total !== null && total > 0) {
    return `0/${total}`;
  }
  return "";
}

export function agentActivityTooltipText(activity?: AgentActivity | null, messageMaxLength = 96): string {
  if (!activity) {
    return "";
  }
  const lines: string[] = [];
  const currentAction = cleanActivityText(activity.currentAction);
  const progress = agentActivityProgressText(activity);
  const currentStep = cleanActivityText(activity.currentStep);
  const nextStep = cleanActivityText(activity.nextStep);
  const lastMessage = cleanActivityText(activity.lastMessage);

  if (currentAction) {
    lines.push(`当前动作：${currentAction}`);
  }
  if (progress) {
    lines.push(`进度：第 ${progress} 步`);
  }
  if (currentStep) {
    lines.push(`当前步骤：${currentStep}`);
  }
  if (nextStep) {
    lines.push(`下一步：${nextStep}`);
  }
  if (lastMessage) {
    lines.push(`AI 最近说：${truncateText(lastMessage, messageMaxLength)}`);
  }
  return lines.join("\n");
}

// 把 URL 收成一个简短的“航点”：优先域名；chrome:// 等特殊协议退回主机名/路径；解析失败截断原串。
export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname) {
      return parsed.hostname;
    }
    const tail = parsed.pathname.replace(/^\/+/, "").split("/")[0];
    return `${parsed.protocol}${tail}` || url;
  } catch {
    return url.length > 56 ? `${url.slice(0, 56)}…` : url;
  }
}

// 当前页的展示标签：只显示域名（URL 主机名）。
export function liveAddrLabel(profile: PublicProfile): string {
  return profile.livePrimaryUrl ? hostOf(profile.livePrimaryUrl) : "";
}

// CDP 客户端标签来自 lsof 的进程名，像 agent-browser-darwin-arm64、chrome-devtools.exe，
// 展示时去掉平台/架构后缀和 .exe，留下工具本名。
export function prettyCdpClientLabel(label: string): string {
  return (
    label
      .replace(/\.exe$/i, "")
      .replace(/-(?:darwin|linux|win32|windows|macos)(?:-(?:arm64|x64|amd64|aarch64|ia32))?$/i, "") || label
  );
}

// CDP 地址固定是 127.0.0.1，端口才是拿去 --cdp 连接的关键信息，
// 展示时只取 :端口；解析不出端口时退回去掉协议的完整地址兜底。
export function cdpPortLabel(url: string): string {
  const match = /:(\d+)(?:[/?#]|$)/.exec(url);
  return match ? `:${match[1]}` : url.replace(/^https?:\/\//, "");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
