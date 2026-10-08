export const PHONE_CHANNEL = "phones:request";
export const PHONE_CHANGED = "phones:changed";
export const PHONE_PROTOCOL = 1;
export const PHONE_DEBUG_REASONS = ["system-value", "computer-read", "usb-connection", "masked-zero", "missing", "denied", "error", "invalid"] as const;
export type PhoneDebugReason = typeof PHONE_DEBUG_REASONS[number];
export type PhonePhase = "idle" | "viewing" | "controlling" | "executing" | "paused" | "stopped" | "disconnected";
export interface PhoneSessionState {
  protocol: 1;
  statusDeviceId?: string;
  instanceId: string;
  sessionId: string | null;
  generation: number;
  phase: PhonePhase;
  mode: "view" | "control";
  computer: string;
  controller: string;
  task: string;
  startedAt: number | null;
  lastAction: string;
  permissions: { overlay: boolean; notifications: boolean; accessibility: boolean };
  readiness?: {
    unlocked: boolean; computerConnected: boolean; usbConnected: boolean; wifiConnected: boolean;
    developerOptions: "enabled" | "disabled" | "unconfirmed"; usbDebugging: "enabled" | "disabled" | "unconfirmed"; wirelessDebugging: "enabled" | "disabled" | "unconfirmed";
    accessibilityService: "running" | "enabled" | "disabled" | "unknown";
    debugReasons?: Partial<Record<"developerOptions" | "usbDebugging" | "wirelessDebugging", PhoneDebugReason>>;
    appVersion?: string;
    network?: { wifiIpv4: string[]; adbEndpoints: { address: string; ageMs: number }[] };
  };
}
export interface PhoneCloudStatus {
  channelId?: string;
  paired: boolean;
  reportedAt: number | null;
  report: { deviceId: string; name: string; permissions: PhoneSessionState["permissions"]; readiness: NonNullable<PhoneSessionState["readiness"]> } | null;
}
export interface PhoneDevice {
  id: string;
  /** Verified hardware identity shared by USB and wireless routes. */
  hardwareId?: string;
  name: string;
  model: string;
  transport: "usb" | "wifi" | "emulator" | "cloud";
  cloud?: PhoneCloudStatus;
  connection: "device" | "offline" | "unauthorized" | "missing";
  companion: "unknown" | "unavailable" | "pairing" | "ready";
  state: PhoneSessionState | null;
  confirmedAt: number | null;
  pending: string | null;
  error: string;
}
export interface PhonesSnapshot { devices: PhoneDevice[]; adbAvailable: boolean; error: string; computer: string; }
export interface PhoneWirelessService { name: string; kind: "pairing" | "connect"; address: string; source?: "phone" | "mdns"; reachable?: boolean; reason?: string; }
export interface PhoneWirelessDiscovery { services: PhoneWirelessService[]; error: string; phoneIps?: string[]; }
export interface PhoneSelector {
  resourceId?: string; text?: string; description?: string; className?: string; packageName?: string;
  enabled?: boolean; checked?: boolean; editable?: boolean; clickable?: boolean; scrollable?: boolean;
}
export type PhoneAction =
  | { kind: "tap"; x: number; y: number }
  | { kind: "swipe"; x: number; y: number; toX: number; toY: number; duration?: number }
  | { kind: "text"; text: string }
  | { kind: "key"; key: "back" | "home" | "recents" }
  | { kind: "snapshot" }
  | { kind: "screenshot"; format?: "png" }
  | { kind: "find" | "click"; selector: PhoneSelector }
  | { kind: "fill"; selector: PhoneSelector; text: string }
  | { kind: "scroll"; selector: PhoneSelector; direction: "forward" | "backward" };
export interface PhoneActionInput { id: string; sessionId: string; generation: number; requestId: string; action: PhoneAction; }
export interface PhoneActionResult { state: PhoneSessionState; result: unknown; }
export type PhoneSetting = "accessibility" | "overlay" | "notifications" | "developerOptions" | "usbDebugging" | "wirelessDebugging";
export interface PhonesApi {
  cloudPair(url?: string): Promise<{ id: string; uri: string; qrCode: string; expiresAt: number }>;
  cloudForget(id: string): Promise<void>;
  snapshot(): Promise<PhonesSnapshot>;
  listEmulators(): Promise<string[]>;
  connectEmulator(name: string): Promise<PhoneDevice>;
  discoverWireless(id?: string): Promise<PhoneWirelessDiscovery>;
  pairWireless(address: string, code: string): Promise<{ address: string }>;
  connectWireless(address: string): Promise<PhoneDevice>;
  autoConnectWireless(id: string): Promise<PhoneDevice>;
  prepare(id: string): Promise<PhoneDevice>;
  preview(id: string): Promise<PhoneActionResult>;
  openSettings(id: string, setting: PhoneSetting): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  start(id: string, mode: "view" | "control", controller: string, task: string): Promise<PhoneDevice>;
  control(id: string, command: "pause" | "resume" | "stop"): Promise<PhoneDevice>;
  perform(input: PhoneActionInput): Promise<PhoneActionResult>;
  onChanged(listener: (snapshot: PhonesSnapshot) => void): () => void;
}
export function phoneStatus(device: PhoneDevice): string {
  if (device.pending) return device.pending;
  if (device.connection === "unauthorized") return device.transport === "emulator" ? "等待模拟器确认调试连接" : "等待手机授权 USB 调试";
  if (device.connection !== "device") return "连接中断 · 状态待确认";
  if (device.companion === "pairing") return "等待手机配对";
  if (device.companion !== "ready" && device.state?.phase === "disconnected") return "连接中断 · 状态待确认";
  if (device.companion !== "ready" || !device.state) return "已连接 · 配套 App 未就绪";
  if (device.state.phase === "executing" && device.state.mode === "view") return "正在查看 · 获取页面";
  if (device.state.phase === "controlling") return device.state.task.trim() ? "任务进行中" : "控制会话进行中";
  return ({ idle: "已连接，未控制", viewing: "屏幕查看中", executing: "控制中 · 执行任务", paused: "已暂停 · 手机可自行操作", stopped: "已结束", disconnected: "连接中断 · 已停止接受指令" })[device.state.phase];
}
export const phoneActive = (device: PhoneDevice): boolean => !!device.state && ["viewing", "controlling", "executing"].includes(device.state.phase) && device.companion === "ready" && device.connection === "device";
