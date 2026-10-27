import type { AndroidSetupAction, AndroidSetupSnapshot } from "./android-setup";
import type { ScreenCameraState, ScreenCameraCapabilities, ScreenCameraSource, ScreenCameraStart, ScreenCameraCommand } from "./screen-camera";

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
  screenCamera?: ScreenCameraState;
  /** An active visual-follow lease owns capture; sidebar previews must wait. */
  visualFollowActive?: boolean;
  /** A host-owned task or action is using this physical phone's capture path. */
  taskCaptureActive?: boolean;
  /** Read-only package detection on an authorized debug transport. */
  appInstallation?: { status: "installed" | "missing" | "unknown"; checkedAt: number };
  /** Explicit desktop-owned session; does not imply companion permissions. */
  basic?: PhoneSessionState;
  id: string;
  transportId?: string;
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
export interface PhonesSnapshot {
  devices: PhoneDevice[]; adbAvailable: boolean; error: string; computer: string;
  companionApp?: { packageName: string; name: string; variant: "debug" | "release" };
}
export interface PhoneScreenFrame { mime: "image/png"; base64: string; width: number; height: number; capturedAt: number; }
export interface PhoneVideoPacket { codec: string; key: boolean; timestamp: number; data: Uint8Array; width?: number; height?: number; screenWidth?: number; screenHeight?: number; }
export interface PhoneVideoSession { sessionId: string; generation: number; }
export interface PhoneWirelessService { name: string; kind: "pairing" | "connect"; address: string; source?: "phone" | "mdns" | "adb"; reachable?: boolean; reason?: string; }
export interface PhoneNearbyApp { id: string; name: string; ip: string; version: string; variant: "debug" | "release"; wirelessDebugging: "enabled" | "disabled" | "unconfirmed"; }
export interface PhoneWirelessDiscovery { services: PhoneWirelessService[]; error: string; apps?: PhoneNearbyApp[]; appError?: string; phoneIps?: string[]; }
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
export interface PhoneBasicModeInput { id: string; sessionId: string; generation: number; mode: "view" | "control"; }
export type PhoneSetting = "accessibility" | "overlay" | "notifications" | "developerOptions" | "usbDebugging" | "wirelessDebugging";
export interface PhonesApi {
  followCommand(command: import("./game-follow").FollowCommand): Promise<any>;
  cameraProbe(id: string): Promise<ScreenCameraCapabilities>;
  cameraSources(): Promise<ScreenCameraSource[]>;
  cameraStart(input: ScreenCameraStart): Promise<ScreenCameraState>;
  cameraCommand(input: ScreenCameraCommand): Promise<any>;
  basicStart(id: string, mode: "view" | "control", controller: string, task: string): Promise<PhoneDevice>;
  basicControl(id: string, command: "pause" | "resume" | "stop"): Promise<PhoneDevice>;
  basicSetMode(input: PhoneBasicModeInput): Promise<PhoneDevice>;
  basicPerform(input: PhoneActionInput): Promise<PhoneActionResult>;
  cloudPair(url?: string): Promise<{ id: string; uri: string; qrCode: string; expiresAt: number }>;
  cloudForget(id: string): Promise<void>;
  snapshot(): Promise<PhonesSnapshot>;
  inspect(id: string): Promise<PhonesSnapshot>;
  listEmulators(): Promise<string[]>;
  androidSetupSnapshot(): Promise<AndroidSetupSnapshot>;
  androidSetupCatalog(): Promise<AndroidSetupSnapshot>;
  androidSetupStart(action: AndroidSetupAction): Promise<AndroidSetupSnapshot>;
  androidSetupCancel(id: string): Promise<AndroidSetupSnapshot>;
  connectEmulator(name: string): Promise<PhoneDevice>;
  discoverWireless(id?: string): Promise<PhoneWirelessDiscovery>;
  pairWireless(address: string, code: string): Promise<{ address: string }>;
  connectWireless(address: string): Promise<PhoneDevice>;
  autoConnectWireless(id: string): Promise<PhoneDevice>;
  connect(id: string): Promise<PhoneDevice>;
  disconnect(id: string): Promise<PhoneDevice>;
  prepare(id: string): Promise<PhoneDevice>;
  preview(id: string): Promise<PhoneActionResult>;
  screen(id: string): Promise<PhoneScreenFrame>;
  videoStart(id: string, basic?: PhoneVideoSession): Promise<{ streamId: string }>;
  videoRead(streamId: string): Promise<{ packets: PhoneVideoPacket[]; error: string }>;
  videoStop(streamId: string): Promise<void>;
  openSettings(id: string, setting: PhoneSetting): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  start(id: string, mode: "view" | "control", controller: string, task: string): Promise<PhoneDevice>;
  control(id: string, command: "pause" | "resume" | "stop"): Promise<PhoneDevice>;
  perform(input: PhoneActionInput): Promise<PhoneActionResult>;
  onChanged(listener: (snapshot: PhonesSnapshot) => void): () => void;
}
/** Match the companion's heartbeat-based connection, independently of task ownership. */
export function phoneAppConnected(device: PhoneDevice, now = Date.now()): boolean {
  return device.connection === "device" && device.companion === "ready" && !!device.state
    && device.confirmedAt !== null && now - device.confirmedAt < 8000
    && device.state.readiness?.computerConnected !== false;
}
export function phoneStatus(device: PhoneDevice): string {
  if (device.pending) return device.pending;
  if (device.connection === "unauthorized") return device.transport === "emulator" ? "等待模拟器确认调试连接" : "等待手机授权 USB 调试";
  if (device.connection !== "device") return "连接中断 · 状态待确认";
  if (device.companion === "pairing") return "等待手机配对";
  if (device.companion !== "ready" && device.state?.phase === "disconnected") return "连接中断 · 状态待确认";
  if (!phoneAppConnected(device) || !device.state) return "可连接";
  if (device.state.phase === "executing" && device.state.mode === "view") return "正在查看 · 获取页面";
  if (device.state.phase === "controlling") return device.state.task.trim() ? "任务进行中" : "控制会话进行中";
  return ({ idle: "已连接，未控制", viewing: "屏幕查看中", executing: "控制中 · 执行任务", paused: "已暂停 · 手机可自行操作", stopped: "已结束", disconnected: "连接中断 · 已停止接受指令" })[device.state.phase];
}
export const phoneActive = (device: PhoneDevice): boolean => !!device.state && ["viewing", "controlling", "executing"].includes(device.state.phase) && device.companion === "ready" && device.connection === "device";
