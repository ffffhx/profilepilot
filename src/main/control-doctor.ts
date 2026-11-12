import path from "node:path";
import { randomUUID } from "node:crypto";
import { browserServiceRoot, readBrowserServiceConnection, serviceRequest } from "./browser-service/connection";
import { requestNativeControl } from "./native-control/cli";
import { nativeExtensionReady } from "./tasks/native-compatibility";
import { RUNNING_CONTROL_BUILD } from "./runtime-identity";
import { NativeControlError } from "./native-control/errors";
import { controlRecovery } from "../shared/control-recovery";
import { readExtensionConnectionDiagnostics } from './extension-connection-diagnostics';
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from './profilepilot-management-protocol';
import { electronRouting, desktopRouting, gpuiRouting, unavailableRouting, type ControlRoute } from './control-routing';

export interface ControlDoctorTarget {
  profileId?: string; deviceId?: string; electronId?: string; windowId?: string; gpuiTarget?: string;
  sessionId?: string; route?: ControlRoute;
}

/** Read-only discovery shares the normal management authorization boundary. */
export async function createApplicationDoctor(target: ControlDoctorTarget,
  request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>) {
  const call = async (command: ProfilePilotManagementCommand) => {
    try {
      const response = await request(command);
      return response.ok ? { data: response.data as any } : { error: response.error };
    } catch (error) { return { error: { code: 'CONTROL_DISCOVERY_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } }; }
  };
  const selectedRoute = target.route || (target.electronId ? 'electron' : target.windowId ? 'desktop' : target.gpuiTarget ? 'gpui' : target.profileId ? 'browser' : target.deviceId ? 'phone' : undefined);
  const [electron, desktop, gpui] = await Promise.all([
    !selectedRoute || selectedRoute === 'electron' ? call(target.electronId ? { action: 'local-app', method: 'inspect', selector: target.electronId } : { action: 'local-app', method: 'list' }) : undefined,
    !selectedRoute || selectedRoute === 'desktop' ? call({ action: 'desktop', method: target.windowId ? 'doctor' : 'status', ...(target.windowId ? { windowId: target.windowId } : {}), ...(target.sessionId ? { session: target.sessionId } : {}) }) : undefined,
    !selectedRoute || selectedRoute === 'gpui' ? call({ action: 'gpui', method: 'status' }) : undefined
  ]);
  const listing = gpui?.data?.backend && selectedRoute === 'gpui' ? await call({ action: 'gpui', method: 'list' }) : undefined;
  const electronApps = electron?.data?.app ? [electron.data.app] : electron?.data?.apps || [];
  const result = {
    ...(electron ? { electron: { ...electron, targets: electronApps.map((app: any) => ({ id: app.id, routing: electronRouting(app, target.sessionId) })),
      ...(!electronApps.length ? { routing: electron.error && electron.error.code !== 'LOCAL_APP_NOT_FOUND'
        ? unavailableRouting('electron', electron.error.message) : electronRouting() } : {}) } } : {}),
    ...(desktop ? { desktop: { ...desktop, routing: desktopRouting(desktop.data, target.sessionId, target.windowId) } } : {}),
    ...(gpui ? { gpui: { ...gpui, ...(listing ? { discovery: listing } : {}), routing: gpui.error ? unavailableRouting('gpui', gpui.error.message)
      : listing?.error ? unavailableRouting('gpui', listing.error.message) : gpuiRouting(gpui.data, listing?.data?.apps || [], target.gpuiTarget, target.sessionId) } } : {})
  };
  return { selectedRoute: selectedRoute || null, readOnly: true, automaticClaim: false, automaticResume: false, ...result };
}

export interface DoctorCheck { id: string; status: "ok" | "warning" | "error"; message: string; nextStep?: string; }
export function browserReadiness(snapshot: any, expectedVersion?: string, profileId?: string, sessionId?: string) {
  const profiles: any[] = Array.isArray(snapshot?.profiles) ? snapshot.profiles : [];
  const sessions: any[] = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  return profiles.filter(p => !profileId || p.profileId === profileId).map(p => {
    const checks: DoctorCheck[] = [];
    const add = (id: string, status: DoctorCheck["status"], message: string, nextStep?: string) => checks.push({ id, status, message, ...(nextStep ? { nextStep } : {}) });
    add("connection", p.connected ? "ok" : "error", p.connected ? "扩展当前已连接。" : "扩展当前未连接。", p.connected ? undefined : "先检查 connectionDiagnostics，并从扩展弹窗导出连接诊断及保留 Chrome 扩展错误；不要先清除配对或重新加载。");
    const compatible = nativeExtensionReady(p);
    const capabilitiesKnown = !!p.connected && typeof p.extensionVersion === "string" && Array.isArray(p.capabilities);
    add("capabilities", !capabilitiesKnown ? "warning" : compatible ? "ok" : "error", !capabilitiesKnown ? "尚无法确认扩展版本与能力。" : compatible ? "扩展满足控制协议与基础能力。" : "扩展版本或能力不兼容。", !capabilitiesKnown ? "待扩展连接并上报状态后重新检查。" : compatible ? undefined : "更新指定 Profile 的扩展并重新检查。");
    const versionKnown = !!p.connected && !!p.extensionVersion;
    const aligned = versionKnown && !!expectedVersion && expectedVersion === p.extensionVersion;
    add("extension-version", aligned ? "ok" : "warning", `实际扩展 ${versionKnown ? p.extensionVersion : "尚未确认"}；当前构建配套 ${expectedVersion || "未知"}。`, !versionKnown ? "待扩展连接并上报版本后重新检查。" : aligned ? undefined : "核对实际运行扩展版本，必要时通过安装入口加载配套版本；新于配套版本时检查兼容性。");
    add("installation", p.installationMode === "temporary" ? "warning" : p.installationType ? "ok" : "warning",
      p.installationMode === "temporary" ? "扩展为临时安装，重启 Chrome 后需重新验证；不会自动重载。" : `安装类型：${p.installationType || "尚未确认"}。`);
    if (p.controlIssue) add("control", "error", p.controlIssue.message, controlRecovery(p.controlIssue.code).instruction);
    else if (p.ownerSessionId) add("ownership", p.ownerSessionId === sessionId && p.ownership === "agent" && !p.pausedByBrowser ? "ok" : "warning",
      `占用会话：${p.ownerSessionId}；控制者：${p.ownership === "agent" ? "Agent" : "用户"}。`,
      p.ownerSessionId === sessionId ? "检查暂停原因；明确交还后恢复并重新观察。" : "查看 owner，等待原任务释放或明确交接。");
    const usable = !!p.connected && compatible && !p.controlIssue;
    return { profileId: p.profileId, connected: !!p.connected, extensionVersion: p.extensionVersion || null,
      installationType: p.installationType || null, installationMode: p.installationMode || null, capabilities: p.capabilities || [],
      owner: sessions.find(s => s.sessionId === p.ownerSessionId) || (p.ownerSessionId ? { sessionId: p.ownerSessionId, ownership: p.ownership } : null),
      debuggerDiagnostic: p.debuggerDiagnostic,
      readyToClaim: usable && !p.ownerSessionId, readyToObserve: usable && p.ownerSessionId === sessionId && p.ownership === "agent" && !p.pausedByBrowser,
      observationVerified: false, checks };
  });
}

export async function createBrowserDoctor(options: { root?: string; profileId?: string; sessionId?: string } = {}) {
  const root = options.root ? path.resolve(options.root) : browserServiceRoot();
  const checks: DoctorCheck[] = [];
  let service: any = null, snapshot: any = { profiles: [], sessions: [] };
  try {
    const connection = readBrowserServiceConnection(root);
    if (!connection) throw new Error("浏览器服务发现文件不存在。");
    // A file/PID alone is not evidence that the expected service is responsive.
    service = (await serviceRequest(connection, "ping", [], 3000)).result;
    snapshot = await requestNativeControl({ requestId: randomUUID(), method: "status" }, root, 3000);
    checks.push({ id: "browser-service", status: "ok", message: `浏览器服务已响应（PID ${service.pid}）。` });
    const aligned = RUNNING_CONTROL_BUILD.buildId && service.build?.buildId === RUNNING_CONTROL_BUILD.buildId;
    checks.push({ id: "service-build", status: aligned ? "ok" : "warning", message: aligned ? "CLI 与正在运行的浏览器服务构建一致。" : "服务与 CLI 构建不同，或旧服务没有提供构建标识。",
      ...(aligned ? {} : { nextStep: "核对运行路径；明确结束现有会话后更新/重启服务，不能因诊断而中断其他任务。" }) });
  } catch (error) {
    checks.push({ id: "browser-service", status: "error", message: error instanceof Error ? error.message : String(error), nextStep: "运行 ppilot browser service start 后重新检查。" });
  }
  const profiles = browserReadiness(snapshot, RUNNING_CONTROL_BUILD.extensionVersion, options.profileId, options.sessionId);
  if (!profiles.length) checks.push({ id: "profile", status: "error", message: options.profileId ? "指定 Profile 尚未连接。" : "没有已连接的扩展 Profile。", nextStep: "使用 ppilot browser connect --profile native:实际目录名。" });
  const cliVerified = RUNNING_CONTROL_BUILD.cliSha256 && RUNNING_CONTROL_BUILD.entrySha256 === RUNNING_CONTROL_BUILD.cliSha256;
  checks.push({ id: "cli-build", status: cliVerified ? "ok" : "warning", message: cliVerified ? "正在执行的 CLI 字节与构建清单一致。" : "当前 CLI 没有可验证的构建清单或文件不匹配。", ...(cliVerified ? {} : { nextStep: "构建后通过 ProfilePilot CLI 安装入口同步 CLI 与配套指引。" }) });
  const all = [...checks, ...profiles.flatMap(p => p.checks)];
  return { target: "browser", connection: "extension", checkedAt: new Date().toISOString(),
    status: all.some(c => c.status === "error") ? "error" : all.some(c => c.status === "warning") ? "warning" : "ok",
    cli: RUNNING_CONTROL_BUILD, service, profiles, checks, diagnosticsDirectory: path.join(root, "control-diagnostics"),
    connectionDiagnostics: readExtensionConnectionDiagnostics(root, options.profileId), observationVerified: false };
}

export function parseBrowserDoctorArgs(args: string[]) {
  const result: { profileId?: string; sessionId?: string; root?: string; timeoutMs?: number } = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i], split = token.indexOf("=");
    const arg = split < 0 ? token : token.slice(0, split);
    if (["doctor", "readiness", "wait-control", "--json"].includes(arg)) continue;
    const field = ({ "--profile": "profileId", "--session": "sessionId", "--root": "root" } as const)[arg as "--profile"];
    const value = split < 0 ? args[++i] : token.slice(split + 1);
    if (!value || value.startsWith("--")) throw new NativeControlError("NATIVE_INVALID_REQUEST", `${arg} 需要参数。`);
    if (field) { if (result[field]) throw new NativeControlError("NATIVE_INVALID_REQUEST", `重复参数：${arg}`); result[field] = value; }
    else if (arg === "--timeout" && /^\d+$/.test(value) && +value >= 1 && +value <= 60000) result.timeoutMs = +value;
    else throw new NativeControlError("NATIVE_INVALID_REQUEST", `诊断不支持参数：${arg}；wait-control 的 --timeout 范围为 1–60000 毫秒。`);
  }
  return result;
}

export async function waitForBrowserControl(options: ReturnType<typeof parseBrowserDoctorArgs>) {
  if (!options.profileId) throw new NativeControlError("NATIVE_INVALID_REQUEST", "wait-control 需要 --profile 指定等待的目标。");
  const deadline = Date.now() + (options.timeoutMs ?? 30000);
  for (;;) {
    const snapshot = await requestNativeControl({ requestId: randomUUID(), method: "status" }, options.root, 3000);
    const profile = snapshot.profiles.find((p: any) => p.profileId === options.profileId);
    if (!profile?.connected) throw new NativeControlError("NATIVE_DISCONNECTED", "等待期间目标扩展未连接，请检查 doctor。");
    if (profile.controlIssue) throw new NativeControlError(profile.controlIssue.code, profile.controlIssue.message);
    if (!profile.ownerSessionId || profile.ownerSessionId === options.sessionId && profile.ownership === "agent" && !profile.pausedByBrowser) return { available: true, profileId: options.profileId, claimed: false, resumed: false };
    if (profile.ownerSessionId === options.sessionId && (profile.ownership !== "agent" || profile.pausedByBrowser)) throw new NativeControlError("NATIVE_USER_IN_CONTROL", "当前会话已交给用户，等待不会自动恢复控制。");
    if (Date.now() >= deadline) throw new NativeControlError("NATIVE_SESSION_CONFLICT", `等待结束，目标仍由 ${profile.ownerSessionId} 占用；未执行 claim 或 resume。`);
    await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
  }
}
