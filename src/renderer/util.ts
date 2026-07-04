import { dateFormatter, store } from "./state";
import { BusyProgressStep, CdpPortSuggestion, ProfileExtensionInfo, PublicProfile } from "./types";

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
  return `端口 ${suggestion.preferredPort} 已被占用${owner}，已自动改用 ${suggestion.port}。`;
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
  return profile.source === "native"
    ? "系统 Profile（Google Chrome User Data 下的子 Profile）"
    : "工具独立 Profile（独立 User Data Dir）";
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
