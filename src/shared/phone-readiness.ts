import type { PhoneDevice } from "./phones";

export interface ReadinessCheck { id: string; status: "ready" | "blocked" | "unknown"; message: string; nextStep?: string; }
export interface PhoneRuntimeEvidence {
  responding?: boolean;
  bootCompleted?: boolean | null;
  sdk?: number | null;
  app?: { status: "installed" | "missing" | "unknown"; packageName?: string; versionName?: string | null; versionCode?: string | null };
}

/** Report each independent layer. Historical state on an offline transport is
 * not evidence of current permissions or ownership. */
export function phoneReadiness(device: PhoneDevice, runtime: PhoneRuntimeEvidence = {}, backend: "app" | "basic" = "app") {
  const checks: ReadinessCheck[] = [];
  const add = (id: string, status: ReadinessCheck["status"], message: string, nextStep?: string) => checks.push({ id, status, message, ...(nextStep ? { nextStep } : {}) });
  const online = device.connection === "device";
  const companion = online && device.companion === "ready" && !!device.state;
  const state = backend === "basic" ? (online ? device.basic : undefined) : companion ? device.state : undefined;
  add("transport", online ? "ready" : "blocked", online ? "ADB 当前将此设备登记为在线。" : `当前连接：${device.connection}。`,
    online ? undefined : device.connection === "unauthorized" ? "在设备确认 Android 调试授权。" : "重新发现并验证此物理设备的 USB/Wi-Fi 路由。");
  if (runtime.responding !== undefined) add("device-response", runtime.responding ? "ready" : "blocked",
    runtime.responding ? "本次设备只读命令已响应。" : "ADB 列表显示在线，但本次设备只读命令全部失败或超时。",
    runtime.responding ? undefined : "检查设备是否唤醒及当前调试地址；通过 ppilot phone wireless-discover/diagnose 核查，不把缓存在线状态当作可控制。");
  add("boot", runtime.bootCompleted === false ? "blocked" : runtime.bootCompleted === true || companion ? "ready" : "unknown",
    runtime.bootCompleted === false ? "Android 仍在启动。" : runtime.bootCompleted === true || companion ? "Android 已响应。" : "尚未确认系统启动状态。",
    runtime.bootCompleted === false ? "等待系统启动完成后再次运行 readiness。" : undefined);
  if (backend === "app") {
    const missing = runtime.app?.status === "missing" || device.appInstallation?.status === "missing";
    add("companion", companion ? "ready" : "blocked", companion ? "配套 App 当前连接正常。" : missing ? "未安装配套 App。" : "配套 App 尚未连接。",
      companion ? undefined : `ppilot phone ${missing ? "update" : "connect"} --device ${JSON.stringify(device.id)}`);
    for (const [key, label] of [["accessibility", "无障碍服务"], ["overlay", "顶部胶囊"], ["notifications", "状态通知"]] as const) {
      const ready = companion && state?.permissions[key] === true;
      add(key, ready ? "ready" : companion ? "blocked" : "unknown", ready ? `${label}已就绪。` : `${label}${companion ? "未开启" : "尚未确认"}。`,
        ready ? undefined : `在配套 App 的权限准备中开启${label}。`);
    }
  }
  const session = state?.sessionId && ["viewing", "controlling", "executing", "paused"].includes(state.phase) ? {
    sessionId: state.sessionId, generation: state.generation, controller: state.controller, task: state.task,
    phase: state.phase, mode: state.mode, startedAt: state.startedAt
  } : null;
  // Both routes remain exclusive. A basic request must see App ownership too.
  const other = online ? (backend === "basic" ? device.state : device.basic) : undefined;
  const otherSession = other?.sessionId && ["viewing", "controlling", "executing", "paused"].includes(other.phase);
  add("ownership", session || otherSession ? "blocked" : "ready", session || otherSession ? "此设备已有活动或暂停会话。" : "没有已知活动会话。",
    session || otherSession ? "继续原有会话或明确结束后再开始；不要通过另一条路由绕过占用。" : undefined);
  if (state?.readiness?.unlocked === false) add("screen", "unknown", "屏幕当前锁定，画面和输入能力需核验。", "解锁目标设备后重新观察。");
  const ready = checks.every(c => c.status !== "blocked");
  const usable = online && runtime.responding !== false && (backend === "basic" || companion && state?.permissions.accessibility === true);
  return {
    target: "phone" as const, id: device.id, hardwareId: device.hardwareId ?? null, transport: device.transport, backend,
    checkedAt: new Date().toISOString(), connection: device.connection, readyToStart: ready, checks, session,
    runtime: { responding: runtime.responding ?? null, bootCompleted: runtime.bootCompleted ?? null, sdk: runtime.sdk ?? null,
      app: runtime.app || { status: device.appInstallation?.status || "unknown", versionName: companion ? device.state?.readiness?.appVersion || null : null } },
    capabilities: {
      observe: usable ? "available" : "unavailable",
      nativeSelectors: usable && backend === "app" ? "available" : "unavailable",
      screenshot: !usable ? "unavailable" : backend === "basic" ? "available" : runtime.sdk == null ? "unconfirmed" : runtime.sdk >= 30 ? "available" : "unavailable",
      input: usable && (backend === "basic" || state?.permissions.overlay && state?.permissions.notifications) ? "available" : "unavailable",
      unicodeText: usable && backend === "app" ? "available" : "unavailable"
    },
    nextSteps: checks.filter(c => c.status !== "ready" && c.nextStep).map(c => c.nextStep!),
    automaticResume: false, automaticBackendSwitch: false
  };
}
