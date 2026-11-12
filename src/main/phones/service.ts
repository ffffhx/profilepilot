import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { PHONE_PROTOCOL, phoneAppConnected, type PhoneDevice, type PhonesSnapshot, type PhoneSessionState, type PhoneAction, type PhoneActionInput, type PhoneActionResult } from "../../shared/phones";
import { groupPhoneDevices } from "../../shared/phone-devices";
import { defaultPhoneStatus } from "../../shared/default-targets";
import { DefaultTargetStore } from "../default-targets";
import { phoneReadiness, type PhoneRuntimeEvidence } from "../../shared/phone-readiness";
import type { PhoneSetting } from "../../shared/phones";
import type { PhoneScreenFrame } from "../../shared/phones";
import { Adb, parseAdbDevices, deviceShell, phoneRequest, validateDeviceId, type AdbRunner } from "./adb";
import { readCompanion, verifyCompanionApk } from "./companion";
import { phoneActionSchema, isPhoneRead } from "./actions";
import { observeAfterAction } from '../action-feedback';
import { discoverWireless, pairWireless, connectWireless, wirelessCandidates, wirelessAddress, probeWireless, type VerifiedWirelessEndpoint } from "./wireless";
import { discoverNearbyApps } from "./lan-discovery";
import { WirelessFailure, sanitizeWirelessOutput } from "./wireless-diagnostics";
import { readDebugSettings, type DebugSettings } from "./readiness";
import { AndroidEmulators, type EmulatorRuntime } from "./emulators";
import { AndroidSetup } from "./android-setup";
import type { AndroidSetupRuntime } from "../../shared/android-setup";
import { PhoneCloud } from "./cloud";
import { InternetPhoneHub } from "./internet-hub";
import { PhoneRegistry } from "./registry";
import type { PhoneNearbyApp } from "../../shared/phones";
import { readinessSchema } from "./readiness-schema";
import { phoneFailure, phoneErrorResult } from "./errors";
import { parseControlRecovery } from "../../shared/control-recovery";
import { inspectApk } from "./apk";
import { PhoneInspection } from "./inspection";
import { ManagedAdbJobs } from "./adb-jobs";
import { BasicPhoneControl } from "./basic";
import { captureAdbScreen } from "./screenshot";
import { defaultPatternLayout, detectPatternGrid, drawPattern, enterCredential, keyguardLocked, parsePatternLayout, parseRawScreencap, patternPoints, readScreenSize, screenAwake, swipeUpBouncer, validateCredential, validatePattern, wakeDevice, type PatternLayout } from "./screen-access";
import { createSecretStore, type SecretStore, type UnlockSecretKind } from "./secrets";
import { assembleScreenshot, SCREENSHOT_TRANSFER } from "./screenshot-transfer";
import { ScreenCamera, type CameraCapture } from "./screen-camera";
import type { ScreenCameraStart, ScreenCameraCommand, ScreenCameraLease } from "../../shared/screen-camera";
import { GameFollower } from "./game-follow";
import { FollowRecovery } from "./follow-recovery";
import { PhoneVideoStream } from "./screen-video";
import { IphonesService } from "./iphone";
import type { WdaRequest } from "./iphone-wda";
export { phoneActionSchema } from "./actions";
export type PhoneCommandSource = "desktop" | "external";

const sessionSchema = z.object({
  statusDeviceId: z.string().uuid().optional(),
  protocol: z.literal(PHONE_PROTOCOL), instanceId: z.string().min(1).max(100), sessionId: z.string().nullable(), generation: z.number().int().nonnegative(),
  phase: z.enum(["idle", "viewing", "controlling", "executing", "paused", "stopped", "disconnected"]), mode: z.enum(["view", "control"]),
  // Older companions omit both fields; absence means a manual pause and no display hold.
  pauseCause: z.enum(["manual", "screen", "permission", ""]).optional(), keepScreenOn: z.boolean().optional(),
  computer: z.string().max(120), controller: z.string().max(120), task: z.string().max(500), startedAt: z.number().nullable(), lastAction: z.string().max(300),
  permissions: z.object({ overlay: z.boolean(), notifications: z.boolean(), accessibility: z.boolean() }),
  readiness: readinessSchema.optional()
});
type SavedPhone = { statusDeviceId?: string; token: string; name?: string; installedHash?: string; hardwareId?: string; model?: string; transport?: PhoneDevice["transport"] };
const identitySchema = z.object({ hardwareId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), model: z.string().max(200), transport: z.enum(["usb", "wifi"]) });
type PhoneIdentity = z.infer<typeof identitySchema>;
type Route = { port: number; token: string; internetConnection?: string; success?: { sequence: number; at: number } };
type InstallJob = { abort: AbortController; done?: Promise<void>; result: { status: "running" | "installed" | "awaiting-user" | "failed" | "interrupted"; jobId?: string; phase?: string; sha256: string; bytes: number; error?: string; code?: string; recovery?: ReturnType<typeof phoneErrorResult>["recovery"] } };
export interface PhonesOptions {
  iphoneRequest?: WdaRequest;
  iphoneFetch?: typeof fetch;
  root: string;
  apkPath: string;
  cameraCapture?: CameraCapture;
  adb?: AdbRunner;
  emulators?: EmulatorRuntime;
  androidSetup?: AndroidSetupRuntime;
  request?: typeof phoneRequest;
  now?: () => number;
  computer?: string;
  /** Encrypted per-phone unlock credential; tests inject an in-memory store. */
  secrets?: SecretStore;
  probeWireless?: typeof probeWireless;
  discoverNearbyApps?: typeof discoverNearbyApps;
  onChanged?: (snapshot: PhonesSnapshot) => void;
}
export class PhonesService {
  readonly iphones: IphonesService;
  private companion: ReturnType<typeof readCompanion>;
  private devices = new Map<string, PhoneDevice>();
  private routes = new Map<string, Route>();
  private debugReadings = new Map<string, { route: Route; at: number; value: DebugSettings }>();
  private debugPending = new Map<string, Route>();
  private hardwareReadings = new Map<string, { at: number; id?: string }>();
  private saved: Record<string, SavedPhone>;
  private identities: Record<string, PhoneIdentity>;
  private patternLayouts: Record<string, PatternLayout> = {};
  private secrets: SecretStore;
  private adb: AdbRunner;
  private request: typeof phoneRequest;
  private timer?: NodeJS.Timeout;
  private connectionPulses = new Map<string, Promise<void>>();
  private refreshing?: Promise<PhonesSnapshot>;
  private operations = new Set<string>();
  private actions = new Set<string>();
  private screenReads = new Map<string, AbortController>();
  private screenVideos = new Map<string, AbortController>();
  private captureStarting = new Map<string, number>();
  private captureSessions = new Map<string, { instanceId: string; sessionId: string; generation: number; backend: "app" | "basic" }>();
  private inspections = new Set<AbortController>();
  private sequence = 0;
  private observations = new Map<string, { instanceId: string; sequence: number; generation: number }>();
  private reconcile = new Set<string>();
  private pairing = new Set<string>();
  private wrappers = new Map<string, { id: string; sessionId: string; instanceId: string; seenAt: number; closing: boolean; backend: "app" | "basic"; followSequence?: number; visualFollow?: boolean;
    recovery?: FollowRecovery<PhoneDevice>; recoveryGeneration?: number; recoveryMode?: "view" | "control" }>();
  private installs = new Map<string, InstallJob>();
  private closed = false;
  private wirelessBusy = false;
  private wirelessReconnect?: Promise<void>;
  private wirelessReconnectAbort = new AbortController();
  private wirelessScanAt = -Infinity;
  private wirelessAttempts = new Map<string, number>();
  private wirelessFailures = new Map<string, { at: number; address: string; code: string; message: string }>();
  private recentWireless = new Map<string, VerifiedWirelessEndpoint>();
  private wirelessAliasScanAt = -Infinity;
  private wirelessDisabled = new Set<string>();
  private appDisconnected = new Set<string>();
  private emulatorBusy = false;
  private emulators: EmulatorRuntime;
  readonly androidSetup: AndroidSetupRuntime;
  private adbAvailable = false;
  private adbSuspended = false;
  private hostBusy = false;
  private error = "";
  private cloud: PhoneCloud;
  readonly internet: InternetPhoneHub;
  private registry: PhoneRegistry;
  private nearby = new Map<string, { app: PhoneNearbyApp; at: number }>();
  private basic: BasicPhoneControl;
  readonly screenCamera: ScreenCamera;
  readonly gameFollower: GameFollower;
  readonly adbJobs: ManagedAdbJobs;
  private basicStarting = false;
  readonly computer: string;
  constructor(private options: PhonesOptions) {
    this.companion = readCompanion(options.apkPath);
    if (this.companion.variant === "debug") options = this.options = { ...options, root: path.join(options.root, "development") };
    this.adb = options.adb || new Adb(); this.request = options.request || phoneRequest; this.computer = (options.computer || os.hostname()).slice(0, 120);
    this.secrets = options.secrets || createSecretStore(path.join(options.root, "unlock-secrets.json"));
    this.adbJobs = new ManagedAdbJobs(this.adb, (lease, generation, mode, acquire) => this.authorizeAdb(lease, generation, mode, acquire), path.join(options.root, "adb-forwards.json"));
    this.basic = new BasicPhoneControl(this.adb, this.computer, () => this.changed(), () => this.now());
    this.gameFollower = new GameFollower(options.root, {
      startWrapper: (...args) => this.startWrapper(...args),
      pulseWrapper: lease => this.pulseWrapper(lease),
      syncWrapper: lease => this.wrapperState(lease, true),
      recoverWrapper: (lease, generation) => this.recoverFollow(lease, generation),
      stopWrapper: lease => this.stopWrapper(lease),
      live: (lease, generation, command) => this.followLive(lease, generation, command)
    });
    this.screenCamera = new ScreenCamera({ adb: this.adb, root: options.root,
      dexPath: path.join(path.dirname(options.apkPath), "profilepilot-screen-camera.dex"), capture: options.cameraCapture,
      authorize: input => this.authorizeCamera(input), changed: () => this.changed() });
    this.emulators = options.emulators || new AndroidEmulators();
    this.androidSetup = options.androidSetup || new AndroidSetup();
    fs.mkdirSync(options.root, { recursive: true });
    const disconnectedFile = path.join(options.root, "app-disconnected.json");
    if (fs.existsSync(disconnectedFile)) this.appDisconnected = new Set(z.array(z.string().min(1).max(240)).parse(JSON.parse(fs.readFileSync(disconnectedFile, "utf8"))));
    this.cloud = new PhoneCloud(options.root, () => this.changed(), undefined, undefined, this.companion.pairingScheme);
    this.registry = new PhoneRegistry(options.root);
    this.iphones = new IphonesService(options.root, this.computer, () => this.changed(), options.iphoneRequest, options.now, options.iphoneFetch);
    const file = path.join(options.root, "devices.json");
    this.saved = fs.existsSync(file) ? z.record(z.string(), z.object({ statusDeviceId: z.string().uuid().optional(), token: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().max(80).optional(), installedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), hardwareId: z.string().max(200).optional(), model: z.string().max(200).optional(), transport: z.enum(["usb", "wifi", "emulator"]).optional() })).parse(JSON.parse(fs.readFileSync(file, "utf8"))) : {};
    // Remember paired devices across app restarts, but never persist permissions,
    // screenshots or session authority as though they were current observations.
    for (const [id, saved] of Object.entries(this.saved)) {
      try { validateDeviceId(id); } catch { continue; }
      this.devices.set(id, { id, name: saved.name || saved.model || "Android 手机", model: saved.model || "Android 手机", transport: saved.transport || (id.startsWith("emulator-") ? "emulator" : /:|_adb-tls/.test(id) ? "wifi" : "usb"), connection: "missing", companion: "unavailable", state: null, confirmedAt: null, pending: null, error: "" });
      this.reconcile.add(id);
    }
    // A verified pattern geometry is layout evidence, never a credential.
    try {
      const patternFile = path.join(options.root, "pattern-layout.json");
      if (fs.existsSync(patternFile)) this.patternLayouts = z.record(z.string(), z.object({ cx: z.number(), cy: z.number(), stepX: z.number(), stepY: z.number() })).parse(JSON.parse(fs.readFileSync(patternFile, "utf8")));
    } catch { this.patternLayouts = {}; }
    // Remember verified basic-mode devices without creating companion credentials.
    const identitiesFile = path.join(options.root, "device-identities.json");
    this.identities = fs.existsSync(identitiesFile) ? z.record(z.string(), identitySchema).parse(JSON.parse(fs.readFileSync(identitiesFile, "utf8"))) : {};
    for (const [id, identity] of Object.entries(this.identities)) {
      try { validateDeviceId(id); } catch { continue; }
      const device = this.devices.get(id);
      if (device) Object.assign(device, identity, { name: this.saved[id]?.name || identity.model });
      else this.devices.set(id, { ...identity, id, name: identity.model, connection: "missing", companion: "unavailable", state: null, confirmedAt: null, pending: null, error: "" });
    }
    this.internet = new InternetPhoneHub({ root: options.root, computer: this.computer, pairingScheme: this.companion.pairingScheme,
      changed: () => this.changed(),
      connected: (id, name, connectionId) => { void this.internetConnected(id, name, connectionId).catch(() => {}); },
      disconnected: (id, connectionId) => {
        const route = this.routes.get(id), device = this.devices.get(id);
        if (device && (!route || route.internetConnection === connectionId))
          void this.disconnected(device, "手机外网连接已断开。", "missing").then(() => this.changed());
      } });
    for (const device of this.internet.status().devices) this.devices.set(device.id, {
      id: device.id, name: device.name, model: device.name, transport: "internet", connection: "missing", companion: "unavailable",
      state: null, confirmedAt: null, pending: null, error: "等待手机建立外网连接。"
    });
  }
  private async internetConnected(id: string, name: string, connectionId: string): Promise<void> {
    if (this.closed) return;
    let device = this.devices.get(id);
    if (!device) {
      device = { id, name, model: name, transport: "internet", connection: "device", companion: "unavailable", state: null,
        confirmedAt: null, pending: null, error: "" };
      this.devices.set(id, device);
    }
    device.connection = "device";
    if (this.appConnectionDisabled(device) || this.routes.get(id)?.internetConnection === connectionId) { this.changed(); return; }
    const route: Route = { port: 0, token: "", internetConnection: connectionId };
    this.routes.set(id, route); this.reconcile.add(id);
    try {
      const { state, result } = await this.rpc(id, "sync", {}, true);
      if (this.routes.get(id) !== route) return;
      // Re-establishing a transport never inherits a surviving controller lease.
      if ((result as { peerOwnsSession?: boolean })?.peerOwnsSession && ["viewing", "controlling", "executing"].includes(state.phase))
        await this.rpc(id, "pause", { instanceId: state.instanceId, sessionId: state.sessionId, generation: state.generation });
      if (this.routes.get(id) === route) this.reconcile.delete(id);
    } finally { this.changed(); }
  }
  startPolling(): void {
    if (this.closed || this.timer) return;
    this.cloud.start();
    void this.internet.start().catch(() => this.changed());
    const tick = () => {
      void this.iphones.refresh();
      // Discovery and package inspection can stall on another device. Keep
      // authenticated routes alive independently of those ADB operations.
      void this.pulseConnections();
      void this.refresh().then(() => this.reconnectWireless()).catch(() => {});
    };
    this.timer = setInterval(tick, 2000); this.timer.unref(); tick();
  }
  private async pulseConnections(): Promise<void> {
    if (this.closed) return;
    for (const [id, route] of this.routes) {
      const device = this.device(id);
      if (this.adbSuspended && device.transport !== "internet") continue;
      if (device.connection !== "device" || device.companion !== "ready" || this.reconcile.has(id)
          || this.operations.has(id) || this.appConnectionDisabled(device) || this.awaitingFollowRecovery(id)) continue;
      // A connection heartbeat must not extend an abandoned controller lease,
      // including when another transport addresses the same physical phone.
      const expired = [...this.wrappers].filter(([, owner]) =>
        (owner.id === id || device.hardwareId && this.devices.get(owner.id)?.hardwareId === device.hardwareId)
        && (owner.closing || this.now() - owner.seenAt >= 8000));
      if (expired.length) {
        for (const [lease, owner] of expired) if (!owner.closing) void this.stopWrapper(lease).catch(() => {});
        continue;
      }
      if (this.connectionPulses.has(id) || route.success && this.now() - route.success.at < 1500) continue;
      const pending = this.rpc(id, "sync", {}, true).then(() => {}, () => {}).finally(() => {
        this.connectionPulses.delete(id); this.changed();
      });
      this.connectionPulses.set(id, pending);
    }
    await Promise.allSettled([...this.connectionPulses.values()]);
  }
  snapshot(): PhonesSnapshot {
    const cloud = this.cloud.devices().sort((a, b) => (b.cloud?.reportedAt || 0) - (a.cloud?.reportedAt || 0));
    const registered = this.registry.devices();
    const registrationId = (device: PhoneDevice) => device.registration?.deviceId || device.cloud?.report?.deviceId;
    const identityByHardware = new Map(Object.values(this.saved).filter(s => s.hardwareId && s.statusDeviceId).map(s => [s.hardwareId, s.statusDeviceId]));
    const matched = new Set<string>();
    const devices: PhoneDevice[] = [...this.devices.values()].map(device => {
      const saved = this.saved[device.id];
      const hardwareId = device.hardwareId || saved?.hardwareId;
      const identity = device.state?.statusDeviceId || saved?.statusDeviceId || identityByHardware.get(hardwareId);
      if (identity) matched.add(identity);
      const visualFollowActive = [...this.wrappers.values()].some(owner => owner.id === device.id && owner.visualFollow && !owner.closing);
      const basic = this.basic.state(device.id);
      const taskCaptureActive = !!this.captureStarting.get(device.id) || this.actions.has(device.id);
      return structuredClone({ ...device, visualFollowActive, taskCaptureActive, screenCamera: this.screenCamera.snapshot(device.id), basic, hardwareId,
        unlockSecret: this.unlockSecretStatusFor(hardwareId || device.id),
        registration: identity ? [...registered, ...cloud].find(c => registrationId(c) === identity)?.registration : undefined,
        cloud: identity ? cloud.find(c => registrationId(c) === identity)?.cloud : undefined });
    });
    for (const group of groupPhoneDevices(devices)) {
      const failure = group.routes.map(route => this.wirelessFailures.get(route.hardwareId || route.id)).find(Boolean);
      if (failure && this.now() - failure.at < 300000 && !group.routes.some(route => route.connection === "device"))
        for (const route of group.routes) route.error = failure.message;
      if (group.routes.some(route => route.visualFollowActive)) for (const route of group.routes) route.visualFollowActive = true;
      const owners = group.routes.flatMap(route => { const owner = this.captureSessions.get(route.id); return owner ? [owner] : []; });
      const taskCaptureActive = group.routes.some(route => route.taskCaptureActive || route.connection === "device" && owners.some(owner => {
        const state = owner.backend === "basic" ? route.basic : route.state;
        return state?.instanceId === owner.instanceId && state.sessionId === owner.sessionId
          && state.generation >= owner.generation && ["viewing", "controlling", "executing"].includes(state.phase);
      }));
      if (taskCaptureActive) for (const route of group.routes) route.taskCaptureActive = true;
    }
    for (const device of cloud) {
      const identity = registrationId(device);
      if (identity && matched.has(identity)) continue;
      devices.push(device); if (identity) matched.add(identity);
    }
    devices.push(...registered.filter(c => !matched.has(c.registration!.deviceId)));
    devices.push(...this.iphones.devices());
    const savedDefault = new DefaultTargetStore(this.options.root).phone();
    const defaultDevice = defaultPhoneStatus(devices, savedDefault);
    if (savedDefault) savedDefault.name = devices.find(device => device.id === defaultDevice.deviceId)?.name || savedDefault.name;
    return { devices, defaultDevice, adbAvailable: this.adbAvailable, error: this.error, computer: this.computer,
      companionApp: { packageName: this.companion.packageName, name: this.companion.name, variant: this.companion.variant } };
  }
  setDefault(id: string | null): PhonesSnapshot {
    const defaults = new DefaultTargetStore(this.options.root);
    if (id === null) defaults.setPhone(null);
    else {
      const device = this.snapshot().devices.find(item => item.id === id);
      if (!device || device.transport === "cloud") throw new Error("请选择可控制的手机设备。");
      if (["wifi", "emulator"].includes(device.transport) && !device.hardwareId && !device.state?.statusDeviceId)
        throw new Error("请先连接设备并确认稳定的设备身份，再设为默认设备；临时端口不能作为默认目标。");
      defaults.setPhone({ id: device.id, name: device.name, hardwareId: device.hardwareId,
        statusDeviceId: device.state?.statusDeviceId || device.registration?.deviceId,
        udid: device.iphone?.udid });
    }
    this.changed();
    return this.snapshot();
  }
  cloudPair(url?: string) { return this.cloud.pair(url); }
  forgetInternet(id: string) {
    this.internet.forget(id); this.routes.delete(id); this.devices.delete(id); this.changed();
    return this.internet.status();
  }
  cloudForget(id: string) { return this.cloud.forget(id); }
  async discoverDevices() {
    const result = await (this.options.discoverNearbyApps || discoverNearbyApps)();
    this.nearby.clear();
    for (const app of result.apps) this.nearby.set(app.id, { app, at: this.now() });
    return result;
  }
  addNearby(id: string): PhoneDevice {
    const found = this.nearby.get(id);
    if (!found || this.now() - found.at > 30000) throw new Error("扫描结果已过期，请重新扫描并选择手机。");
    const registered = this.registry.add(found.app); this.changed();
    return this.snapshot().devices.find(d => d.registration?.deviceId === found.app.deviceId) || registered;
  }
  async addDeviceCode(code: string, url?: string): Promise<PhoneDevice> {
    const added = await this.cloud.addCode(code, url);
    return this.snapshot().devices.find(d => d.registration?.deviceId === added.registration?.deviceId) || added;
  }
  forgetRegistered(id: string): void { this.registry.forget(id); this.changed(); }
  private changed(): void { this.options.onChanged?.(this.snapshot()); }
  private captureRoutes(id: string): PhoneDevice[] {
    return groupPhoneDevices(this.snapshot().devices).find(group => group.routes.some(route => route.id === id))?.routes || [];
  }
  private cancelScreenReads(id: string, keepVideo = false): void {
    for (const routeId of new Set([id, ...this.captureRoutes(id).map(route => route.id)])) {
      this.screenReads.get(routeId)?.abort(); if (!keepVideo) this.screenVideos.get(routeId)?.abort();
    }
  }
  private reserveTaskCapture(id: string): () => void {
    validateDeviceId(id);
    this.captureStarting.set(id, (this.captureStarting.get(id) || 0) + 1);
    this.cancelScreenReads(id); this.changed();
    return () => {
      const remaining = (this.captureStarting.get(id) || 1) - 1;
      if (remaining) this.captureStarting.set(id, remaining); else this.captureStarting.delete(id);
      this.changed();
    };
  }
  private ownTaskCapture(id: string, state: PhoneSessionState, backend: "app" | "basic"): void {
    if (!state.sessionId || ["idle", "stopped", "disconnected"].includes(state.phase)) return;
    this.captureSessions.set(id, { instanceId: state.instanceId, sessionId: state.sessionId, generation: state.generation, backend });
    this.cancelScreenReads(id); this.changed();
  }
  private reconcileCaptureSession(id: string, state: PhoneSessionState): void {
    const routes = new Set([id, ...this.captureRoutes(id).map(route => route.id)]);
    for (const [routeId, owner] of this.captureSessions) {
      if (owner.backend !== "app" || !routes.has(routeId)) continue;
      if (routeId === id && owner.instanceId !== state.instanceId) this.captureSessions.delete(routeId);
      else if (owner.instanceId === state.instanceId && state.generation >= owner.generation) {
        if (state.sessionId !== owner.sessionId || ["idle", "stopped"].includes(state.phase)) this.captureSessions.delete(routeId);
        else owner.generation = state.generation;
      }
    }
  }
  private guardPreview(id: string, ownOperation = false, basicInput = false): PhoneDevice[] {
    const routes = this.captureRoutes(id);
    if (routes.some(route => route.visualFollowActive)) throw new Error("视觉跟随正在采集画面，请在视觉跟随窗口查看；结束后恢复手机预览。");
    if (routes.some(route => [route.basic, route.state].some(state => state && (state.phase === "paused" || state.phase === "disconnected" && !!state.sessionId))))
      throw new Error("手机会话已暂停或断开，确认会话状态后再刷新画面。");
    const ownBasicAction = basicInput && this.actions.has(id) && !routes.some(route => this.captureStarting.has(route.id)
      || route.id !== id && this.actions.has(route.id) || this.captureSessions.has(route.id));
    if (routes.some(route => route.taskCaptureActive) && !ownBasicAction) throw new Error("手机任务正在使用画面，任务结束后恢复预览。");
    if (routes.some(route => this.actions.has(route.id) && !(basicInput && route.id === id) || this.operations.has(route.id) && !(ownOperation && route.id === id)))
      throw new Error("手机正在处理操作，请稍后刷新画面。");
    return routes;
  }
  private assertNoBasic(): void {
    if (this.basicStarting || this.basic.active) throw phoneFailure("PHONE_SESSION_CONFLICT", "请先结束免安装控制，再连接 App 或开始 App 会话。");
  }
  private async authorizeCamera(input: ScreenCameraLease): Promise<{ instanceId: string; token: string }> {
    this.assertNoBasic();
    const device = this.connected(input.id);
    if (device.transport === "internet") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "此版本外网连接不支持虚拟摄像头。");
    if (this.closed || this.operations.has(input.id) || this.reconcile.has(input.id) || device.companion !== "ready") throw new Error("手机连接或控制状态已改变，请先确认手机会话");
    const { state } = await this.rpc(input.id, "sync");
    if (state.sessionId !== input.sessionId || state.generation !== input.generation || state.mode !== "control" || !["controlling", "executing"].includes(state.phase)) throw new Error("屏幕摄像头需要当前有效的手机控制会话；暂停后请重新开启摄像头");
    return { instanceId: state.instanceId, token: this.routes.get(input.id)!.token };
  }
  async cameraProbe(id: string) { if (this.connected(id).transport === "internet") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "此版本外网连接不支持虚拟摄像头。"); return this.screenCamera.probe(id); }
  async cameraStart(input: ScreenCameraStart) { return this.screenCamera.start(input); }
  async cameraCommand(input: ScreenCameraCommand) { return this.screenCamera.command(input); }
  async basicStart(id: string, mode: "view" | "control", controller: string, task: string, source: PhoneCommandSource = "desktop"): Promise<PhoneDevice> {
    if (this.device(id).transport === "internet") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "外网控制使用手机 App，不支持 basic 模式。");
    const input = z.object({ mode: z.enum(["view", "control"]), controller: z.string().trim().min(1).max(120), task: z.string().max(500) }).parse({ mode, controller, task });
    if (this.closed || this.basicStarting || this.operations.size || this.actions.size) throw new Error("手机正在处理操作，请稍后再开始免安装会话。");
    this.basicStarting = true;
    let releaseCapture = () => {};
    try {
      if (source === "external") releaseCapture = this.reserveTaskCapture(id);
      await this.refresh(); this.connected(id);
      // Treat an unresolved/paused App session as occupied, including aliases.
      if ([...this.devices.values()].some(d => d.state?.sessionId && !["idle", "stopped"].includes(d.state.phase))) throw phoneFailure("PHONE_SESSION_CONFLICT", "请先结束已有的手机 App 会话，再开始免安装控制。");
      if (this.closed) throw new Error("手机服务正在退出。");
      this.cancelScreenReads(id);
      this.basic.start(id, input.mode, input.controller, input.task);
      if (source === "external") this.ownTaskCapture(id, this.basic.state(id)!, "basic");
      return this.snapshot().devices.find(device => device.id === id)!;
    } finally { this.basicStarting = false; releaseCapture(); }
  }
  basicControl(id: string, command: "pause" | "resume" | "stop"): PhoneDevice {
    z.enum(["pause", "resume", "stop"]).parse(command);
    if (command !== "stop") this.connected(id); else this.device(id);
    this.cancelScreenReads(id); this.basic.control(id, command);
    if (command === "stop") this.captureSessions.delete(id);
    return this.snapshot().devices.find(device => device.id === id)!;
  }
  basicSetMode(input: { id: string; sessionId: string; generation: number; mode: "view" | "control" }): PhoneDevice {
    const parsed = z.object({ id: z.string(), sessionId: z.string().min(1), generation: z.number().int().nonnegative(), mode: z.enum(["view", "control"]) }).strict().parse(input);
    if (this.closed) throw new Error("手机服务正在退出。");
    this.connected(parsed.id);
    this.cancelScreenReads(parsed.id); this.basic.setMode(parsed);
    return this.snapshot().devices.find(device => device.id === parsed.id)!;
  }
  async basicPerform(input: PhoneActionInput): Promise<PhoneActionResult> {
    const parsed = z.object({ id: z.string(), sessionId: z.string().min(1), generation: z.number().int().nonnegative(), requestId: z.string().uuid(), action: phoneActionSchema, observeAfter: z.boolean().optional() }).strict().parse(input);
    if (this.closed) throw new Error("手机服务正在退出。");
    if (this.captureRoutes(parsed.id).some(route => this.actions.has(route.id) || this.operations.has(route.id))) throw new Error("手机上一项操作尚未结束。");
    this.connected(parsed.id);
    this.actions.add(parsed.id); this.cancelScreenReads(parsed.id, true); this.changed();
    try { return await this.basic.perform(parsed); }
    finally { this.actions.delete(parsed.id); this.changed(); }
  }
  listEmulators(): Promise<string[]> { return this.emulators.list(); }
  async connectEmulator(name: string): Promise<PhoneDevice> {
    if (this.emulatorBusy) throw new Error("正在启动模拟器，请稍候。");
    this.emulatorBusy = true;
    try {
      if (!(await this.emulators.list()).includes(name)) throw new Error("模拟器不存在，请重新选择虚拟设备。");
      const local = await this.emulators.connectLocal?.(name);
      if (local) {
        if (!/^127\.0\.0\.1:\d{4,5}$/.test(local)) throw new Error("本机模拟器连接地址无效");
        const output = await this.adb.run(["connect", local], 10000);
        if (!/connected to|already connected/i.test(output)) throw new Error("本机模拟器尚未连接");
        await this.refresh();
        if (this.devices.get(local)?.connection !== "device") await this.refresh();
        return this.connected(local);
      }
      const find = async () => {
        const candidates = parseAdbDevices(await this.adb.run(["devices", "-l"])).filter(device => device.transport === "emulator");
        for (const device of candidates) {
          const avd = await this.adb.run(["-s", device.id, "emu", "avd", "name"], 2000).catch(() => "");
          if (avd.split(/\r?\n/)[0]?.trim() === name) return device;
        }
        return undefined;
      };
      let found = await find();
      // Reuse the exact running AVD without touching its app or control session.
      if (!found) await this.emulators.launch(name);
      else await this.emulators.ensureVisible(name, found.id);
      const deadline = Date.now() + 90000;
      while (!found || found.connection !== "device") {
        if (this.closed) throw new Error("ProfilePilot 正在关闭，已停止等待模拟器连接。");
        if (Date.now() >= deadline) throw new Error("模拟器尚未连接。请检查模拟器窗口中的启动提示，启动完成后重新连接。");
        await new Promise(resolve => setTimeout(resolve, 1000));
        found = await find();
      }
      await this.refresh();
      // refresh() can join a desktop poll begun before this AVD connected.
      // Finish that poll and obtain one current snapshot before reporting failure.
      if (this.devices.get(found.id)?.connection !== "device") await this.refresh();
      return this.connected(found.id);
    } finally { this.emulatorBusy = false; }
  }
  private persist(): void {
    const file = path.join(this.options.root, "devices.json"), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file);
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private device(id: string): PhoneDevice { validateDeviceId(id); const device = this.devices.get(id); if (!device) throw phoneFailure("PHONE_DEVICE_NOT_FOUND", "手机不存在，请刷新设备列表。"); return device; }
  private liveAliases(device: PhoneDevice): PhoneDevice[] {
    const hardware = device.hardwareId || this.saved[device.id]?.hardwareId;
    return hardware ? [...this.devices.values()].filter(other => other.id !== device.id
      && other.connection === "device" && other.hardwareId === hardware) : [];
  }
  private connectionError(device: PhoneDevice): string {
    if (device.transport === "internet") return "手机外网连接已断开，请在手机 ProfilePilot 中检查外网控制连接。";
    if (device.transport === "emulator") return device.connection === "unauthorized"
      ? "请在模拟器窗口中确认此电脑的调试连接。" : "模拟器未连接，请先启动模拟器并确认调试连接。";
    if (device.transport === "wifi") {
      if (device.connection === "unauthorized") return "无线调试尚未授权此电脑，请在手机的无线调试页面完成配对。";
      const alternatives = this.liveAliases(device);
      return alternatives.length === 1 ? `原无线连接已失效；同一台手机当前在线地址为 ${alternatives[0].id}。请连接该地址并重新确认会话。`
        : "无线调试连接已离线，IP 或端口可能已变化。请重新发现当前连接地址；保持手机解锁并开启无线调试。";
    }
    return device.connection === "unauthorized" ? "请在手机上允许此电脑进行 USB 调试。"
      : "USB 连接已断开，请检查数据线并重新连接手机。";
  }
  private connected(id: string): PhoneDevice {
    const device = this.device(id);
    if (device.transport !== "internet" && (this.adbSuspended || this.hostBusy)) throw phoneFailure(this.hostBusy ? "PHONE_TARGET_BUSY" : "PHONE_SERVICE_UNAVAILABLE", "ADB 主机服务已停用或正在变更连接。");
    if (device.connection !== "device") throw phoneFailure(device.connection === "unauthorized" ? "PHONE_PAIRING_REQUIRED" : "PHONE_CONNECTION_REQUIRED", this.connectionError(device));
    return device;
  }
  refresh(): Promise<PhonesSnapshot> {
    if (this.adbSuspended) return Promise.resolve(this.snapshot());
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshOnce().finally(() => { this.refreshing = undefined; }); return this.refreshing;
  }
  private async refreshOnce(): Promise<PhonesSnapshot> {
    if (this.closed) return this.snapshot();
    // Desktop polling must not keep a crashed wrapper's session alive forever.
    for (const [lease, owner] of this.wrappers) {
      if (owner.closing || this.now() - owner.seenAt >= 8000) await this.stopWrapper(lease).catch(() => {});
    }
    try {
      const found = parseAdbDevices(await this.adb.run(["devices", "-l"])); this.adbAvailable = true; this.error = "";
      const ids = new Set(found.map(device => device.id));
      let metadataChanged = false;
      for (const device of this.devices.values()) if (device.transport !== "internet" && !ids.has(device.id)) await this.disconnected(device, "手机连接已断开。", "missing");
      for (const next of found) {
        const previous = this.devices.get(next.id);
        const device = previous || next;
        Object.assign(device, { model: next.model, transport: next.transport, transportId: next.transportId, connection: next.connection, name: this.saved[next.id]?.name || next.model });
        this.devices.set(device.id, device);
        const saved = this.saved[device.id];
        if (saved && (saved.model !== next.model || saved.transport !== next.transport)) { saved.model = next.model.slice(0, 200); saved.transport = next.transport; metadataChanged = true; }
        if (device.connection !== "device") { await this.disconnected(device, this.connectionError(device), device.connection); continue; }
        // Only this live, explicitly opted-in follower may reconcile its own
        // brief transport loss. Other wrappers retain the normal pause policy.
        if (this.awaitingFollowRecovery(device.id)) continue;
        if (this.operations.has(device.id)) continue;
        await this.identifyHardware(device);
        this.wirelessFailures.delete(device.hardwareId || device.id);
        if (device.transport === "wifi" && device.hardwareId) {
          try {
            const address = wirelessAddress(device.id);
            this.recentWireless.set(device.hardwareId, { hardwareId: device.hardwareId, address, at: this.now() });
            // Throttle failed attempts, not a new outage after a healthy link.
            this.wirelessAttempts.delete(address);
          }
          catch { /* mDNS aliases are not literal connection endpoints. */ }
        }
        await this.inspectInstallation(device);
        if (this.appConnectionDisabled(device)) continue;
        // Android assigns a new wireless port after reconnecting. Only reuse an
        // existing pairing after reading the physical identity on this route.
        const hardwareId = this.hardwareReadings.get(device.id)?.id;
        if (!this.saved[device.id] && hardwareId && device.appInstallation?.status === "installed") {
          // An existing authenticated transport already serves this phone.
          // Discovering a second one must not pause its live controller.
          if ([...this.devices.values()].some(other => other.id !== device.id && other.hardwareId === hardwareId
              && other.connection === "device" && other.companion === "ready" && this.routes.has(other.id))) continue;
          const alias = Object.values(this.saved).find(item => item.hardwareId === hardwareId)
            || this.saved[hardwareId];
          if (alias) {
            this.saved[device.id] = { ...alias, hardwareId, model: device.model, transport: device.transport };
            this.reconcile.add(device.id); metadataChanged = true;
          }
        }
        let polledRoute: Route | undefined;
        try {
          if (this.awaitingFollowRecovery(device.id)) continue;
          if (!this.routes.has(device.id) && this.saved[device.id]) await this.forward(device.id);
          if (this.routes.has(device.id)) {
            polledRoute = this.routes.get(device.id);
            const { state } = await this.rpc(device.id, "sync", {}, true);
            if (this.awaitingFollowRecovery(device.id)) continue;
            if (!["idle", "stopped"].includes(state.phase)) this.basic.close();
            // A new desktop process or a recovered link must not silently
            // inherit an old controller's authority, even within the phone TTL.
            if ((!previous || this.reconcile.has(device.id)) && ["viewing", "controlling", "executing"].includes(state.phase)) {
              await this.rpc(device.id, "pause", { instanceId: state.instanceId, sessionId: state.sessionId, generation: state.generation });
            }
            this.reconcile.delete(device.id);
          }
        } catch (error) {
          // rpc already invalidates its exact failed route. An old poll must
          // never remove a replacement forward or overwrite its newer state.
          if (this.routes.get(device.id) !== polledRoute) continue;
          if ((error as { code?: string }).code === "PAIRING_REQUIRED") { this.pairing.add(device.id); device.companion = "pairing"; device.error = (error as Error).message; }
          else {
            if (polledRoute) this.connectionEvent(device, polledRoute, "poll", "invalidated", error);
            await this.disconnected(device, (error as Error).message);
          }
        }
      }
      await this.rememberLiveWirelessAliases();
      if (metadataChanged) this.persist();
    } catch (error) {
      this.adbAvailable = false; this.error = (error as Error).message;
      for (const device of this.devices.values()) if (device.transport !== "internet") await this.disconnected(device, this.error, "offline");
    }
    this.changed(); return this.snapshot();
  }
  async inspect(id: string): Promise<PhonesSnapshot> {
    if (this.refreshing) await this.refreshing;
    this.device(id).appInstallation = undefined;
    return this.refresh();
  }
  async readiness(id: string, backend: "app" | "basic" = "app") {
    await this.refresh();
    const device = this.snapshot().devices.find(d => d.id === id);
    if (!device) throw Object.assign(new Error("未找到指定设备，请先运行 ppilot phone list。"), { code: "PHONE_INVALID_TARGET" });
    if (device.connection !== "device" || device.transport === "cloud") return phoneReadiness(device, {}, backend);
    if (device.transport === "internet") {
      if (backend !== "app") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "外网控制使用配套 App，不支持 ADB 基础模式。");
      const { state } = await this.rpc(id, "sync");
      return phoneReadiness({ ...this.device(id), state }, { responding: true, bootCompleted: true, sdk: state.readiness?.sdk });
    }
    const identity = device.hardwareId;
    const abort = new AbortController(); this.inspections.add(abort);
    try {
      const [boot, sdk, app] = await Promise.allSettled([
        this.adb.run(["-s", id, "shell", deviceShell(["getprop", "sys.boot_completed"])], 3000, undefined, abort.signal),
        this.adb.run(["-s", id, "shell", deviceShell(["getprop", "ro.build.version.sdk"])], 3000, undefined, abort.signal),
        new PhoneInspection(this.adb).app(id, this.companion.packageName, abort.signal)
      ]);
      abort.signal.throwIfAborted();
      const current = this.snapshot().devices.find(d => d.id === id);
      if (!current || current.connection !== "device" || current.hardwareId !== identity) throw Object.assign(new Error("检查期间设备身份或连接改变，请重新读取状态。"), { code: "PHONE_DISCONNECTED" });
      const runtime: PhoneRuntimeEvidence = {
        responding: [boot, sdk, app].some(result => result.status === "fulfilled"),
        bootCompleted: boot.status === "fulfilled" && /^(0|1)$/.test(boot.value.trim()) ? boot.value.trim() === "1" : null,
        sdk: sdk.status === "fulfilled" && /^\d+$/.test(sdk.value.trim()) ? Number(sdk.value.trim()) : null,
        app: app.status === "fulfilled" ? { status: app.value.status, packageName: app.value.packageName, versionCode: app.value.versionCode, versionName: app.value.versionName } : { status: "unknown" }
      };
      return phoneReadiness(current, runtime, backend);
    } finally { this.inspections.delete(abort); }
  }
  async inspectPhone(id: string, kind: "app" | "packages" | "diagnose", options: { packageName?: string; scope?: "all" | "user" | "system"; filter?: string } = {}) {
    await this.refresh();
    if (this.closed) throw new Error("手机服务正在退出。");
    const device = this.connected(id), identity = device.hardwareId;
    if (device.transport === "internet") {
      if (kind !== "app") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "外网通道支持 inspect 指定应用；全机 ADB 诊断不可用。");
      return { id, ...(await this.rpc(id, "package-inspect", { packageName: options.packageName || this.companion.packageName })).result as object };
    }
    const abort = new AbortController(); this.inspections.add(abort);
    try {
      const inspection = new PhoneInspection(this.adb);
      const result = kind === "app" ? await inspection.app(id, options.packageName || this.companion.packageName, abort.signal)
        : kind === "packages" ? await inspection.packages(id, options.scope, options.filter, abort.signal) : await inspection.diagnose(id, abort.signal);
      abort.signal.throwIfAborted();
      if (this.connected(id).hardwareId !== identity) throw new Error("手机身份已改变，请重新查询。");
      return result;
    } finally { this.inspections.delete(abort); }
  }
  async hostCommand(args: string[]) {
    const single = ["version", "host-features", "server-status", "start-server", "kill-server"].includes(args[0]) && args.length === 1;
    const mdns = args[0] === "mdns" && args.length === 2 && ["check", "services"].includes(args[1]);
    const reconnect = args.join(" ") === "reconnect offline";
    const keygen = args[0] === "keygen" && args.length === 2 && path.isAbsolute(args[1]);
    if (!single && !mdns && !reconnect && !keygen) throw new Error("不支持此主机命令；可用 version、host-features、server-status、start-server、kill-server、mdns check/services、reconnect offline、keygen <绝对路径>。");
    if (this.closed || this.hostBusy) throw new Error("ADB 主机服务正在处理另一项操作。");
    const mutates = ["kill-server", "reconnect"].includes(args[0]);
    if (mutates && (this.wrappers.size || this.basic.active || this.operations.size || this.actions.size || this.inspections.size
        || this.snapshot().devices.some(d => d.connection === "device" && d.state && ["viewing", "controlling", "executing", "paused"].includes(d.state.phase))))
      throw new Error("ADB 服务器由所有设备共享；请先结束现有手机任务，再改变主机连接。");
    if (keygen && (fs.existsSync(args[1]) || fs.existsSync(args[1] + ".pub"))) throw new Error("密钥输出路径已存在，不会覆盖。");
    if (this.adbSuspended && !["version", "keygen", "start-server", "kill-server"].includes(args[0])) throw new Error("ADB 服务器已停用，请先显式执行 start-server。");
    this.hostBusy = true;
    try {
      if (args[0] === "kill-server") {
        this.adbSuspended = true;
        if (this.refreshing) await this.refreshing;
        if (this.wirelessReconnect) await this.wirelessReconnect;
        // Remove owned forwards before stopping the shared server. Polling stays
        // suspended, so it cannot immediately restart the server behind the user.
        for (const device of this.devices.values()) if (device.transport !== "internet") await this.disconnected(device, "ADB 服务器已停止。", "missing");
      }
      const output = await this.adb.run(args, 12000);
      if (args[0] === "start-server") { this.adbSuspended = false; await this.refresh(); }
      return { args, output, checkedAt: this.now(), suspended: this.adbSuspended };
    } finally { this.hostBusy = false; }
  }
  async disconnectWireless(id: string) {
    const device = this.connected(id);
    if (device.transport !== "wifi") throw new Error("只能断开指定的 Wi-Fi 连接。");
    if (this.wirelessGroup(id).routes.some(d => d.state && ["viewing", "controlling", "executing", "paused"].includes(d.state.phase)
        || d.basic && !["stopped", "disconnected"].includes(d.basic.phase)) || this.operations.has(id) || this.actions.has(id)) throw new Error("请先结束这台手机的会话，再断开连接。");
    // Drop the App route first; neither this operation nor subsequent discovery
    // starts a control session or resumes old work.
    this.wirelessDisabled.add(device.hardwareId || id);
    await this.disconnected(device, "用户已断开 Wi-Fi。", "missing");
    const output = await this.adb.run(["disconnect", id], 10000);
    return { id, output };
  }
  private appConnectionDisabled(device: PhoneDevice): boolean {
    const hardware = device.hardwareId || this.saved[device.id]?.hardwareId;
    return this.appDisconnected.has(`route:${device.id}`) || !!hardware && this.appDisconnected.has(`hardware:${hardware}`);
  }
  private setAppDisconnected(id: string, disabled: boolean): void {
    const device = this.device(id), hardware = device.hardwareId || this.saved[id]?.hardwareId;
    const keys = new Set([`route:${id}`, ...this.captureRoutes(id).map(route => `route:${route.id}`)]);
    if (hardware) {
      keys.add(`hardware:${hardware}`);
      for (const [alias, saved] of Object.entries(this.saved)) if (saved.hardwareId === hardware) keys.add(`route:${alias}`);
      for (const [alias, identity] of Object.entries(this.identities)) if (identity.hardwareId === hardware) keys.add(`route:${alias}`);
    }
    for (const key of keys) { if (disabled) this.appDisconnected.add(key); else this.appDisconnected.delete(key); }
    const file = path.join(this.options.root, "app-disconnected.json"), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.appDisconnected]), { mode: 0o600 }); fs.renameSync(tmp, file);
  }
  /** Disconnect the App on every route for this phone, keeping discovery available. */
  async disconnect(id: string): Promise<PhoneDevice> {
    if (this.refreshing) await this.refreshing;
    await this.exclusive(id, "正在断开…", async () => {
      const routes = this.captureRoutes(id);
      if (routes.some(route => this.actions.has(route.id) || route.connection === "device" && [route.state, route.basic].some(state => state && ["viewing", "controlling", "executing", "paused"].includes(state.phase))))
        throw new Error("请先结束这台手机的会话，再断开连接。");
      this.setAppDisconnected(id, true);
      for (const route of routes) {
        const device = this.devices.get(route.id); if (!device) continue;
        this.screenCamera.stopFor(route.id, "手机连接已断开");
        this.pairing.delete(route.id);
        await this.disconnected(device, "");
        device.state = null; device.confirmedAt = null;
        this.observations.delete(route.id); this.captureSessions.delete(route.id);
      }
    });
    return structuredClone(this.device(id));
  }
  private async inspectInstallation(device: PhoneDevice): Promise<void> {
    if (device.appInstallation && this.now() - device.appInstallation.checkedAt < 30000) return;
    let status: "installed" | "missing" | "unknown" = "unknown";
    try {
      const output = (await this.adb.run(["-s", device.id, "shell", deviceShell(["pm", "path", this.companion.packageName])], 3000)).trim();
      if (/^package:\S+/m.test(output)) status = "installed";
      else if (!output) status = "missing";
    } catch { /* A failed query does not mean the App is missing. */ }
    device.appInstallation = { status, checkedAt: this.now() };
  }
  private async identifyHardware(device: PhoneDevice): Promise<void> {
    // An authorized debugging connection has an identity even without an App
    // pairing. Do not install the App or copy its credentials just to group routes.
    if (device.transport === "emulator") return;
    const cached = this.hardwareReadings.get(device.id);
    if (cached?.id || cached && this.now() - cached.at < 30000) return;
    const serial = (await this.adb.run(["-s", device.id, "shell", deviceShell(["getprop", "ro.serialno"])], 3000).catch(() => "")).trim();
    const id = /^[a-zA-Z0-9_-]{1,200}$/.test(serial) && !["unknown", "null"].includes(serial) ? serial : undefined;
    this.hardwareReadings.set(device.id, { at: this.now(), id });
    device.hardwareId = id;
    if (id && (device.transport === "usb" || device.transport === "wifi")) {
      const identity: PhoneIdentity = { hardwareId: id, model: device.model.slice(0, 200), transport: device.transport };
      if (JSON.stringify(this.identities[device.id]) !== JSON.stringify(identity)) {
        this.identities[device.id] = identity;
        const file = path.join(this.options.root, "device-identities.json"), tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.identities, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file);
      }
    }
  }
  private async disconnected(device: PhoneDevice, error: string, connection = device.connection): Promise<void> {
    for (const owner of this.wrappers.values()) {
      if (owner.id === device.id && owner.visualFollow && !owner.closing && this.now() - owner.seenAt < 8000
        && device.state?.instanceId === owner.instanceId && device.state.sessionId === owner.sessionId
        && device.state.generation === owner.recoveryGeneration && ["viewing", "controlling", "executing"].includes(device.state.phase)) owner.recovery?.lost();
    }
    this.screenReads.get(device.id)?.abort(); this.screenVideos.get(device.id)?.abort();
    if (connection !== "device") { this.basic.disconnect(device.id); this.hardwareReadings.delete(device.id); device.appInstallation = undefined; }
    this.debugReadings.delete(device.id); this.debugPending.delete(device.id);
    if (device.state && ["viewing", "controlling", "executing"].includes(device.state.phase)) this.reconcile.add(device.id);
    device.connection = connection; device.companion = "unavailable"; device.error = error;
    if (connection === "device" && this.pairing.has(device.id)) { device.companion = "pairing"; device.error = ""; }
    if (device.state && !["idle", "stopped"].includes(device.state.phase)) device.state = { ...device.state, phase: "disconnected" };
    // ADB drops USB forwards on unplug. A cached port is no longer a route
    // after any uncertain transport failure; rebuild only this device's route.
    const route = this.routes.get(device.id);
    if (route) {
      this.routes.delete(device.id);
      if (!route.internetConnection) await this.adb.run(["-s", device.id, "forward", "--remove", `tcp:${route.port}`]).catch(() => {});
    }
  }
  private async forward(id: string, signal?: AbortSignal): Promise<void> {
    const token = this.saved[id]?.token; if (!token) throw new Error("请先连接手机配套 App。");
    const port = Number(await this.adb.run(["-s", id, "forward", "tcp:0", `tcp:${this.companion.port}`], signal ? 2000 : 8000, undefined, signal));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("ADB 未返回有效的手机连接端口。");
    if (signal?.aborted) {
      void this.adb.run(["-s", id, "forward", "--remove", `tcp:${port}`]).catch(() => {});
      signal.throwIfAborted();
    }
    this.routes.set(id, { port, token });
  }
  private connectionEvent(device: PhoneDevice, route: Route, method: string, outcome: "invalidated" | "superseded", error: unknown): void {
    // Keep the first transport cause, rather than only a later ECONNREFUSED
    // against a removed forward. No tokens, request bodies or screen data.
    try {
      const file = path.join(this.options.root, "connection-events.json");
      const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
      const events = Array.isArray(previous) ? previous.slice(-63) : [];
      const fault = error as { message?: string; code?: string };
      events.push({ at: this.now(), device: device.id, port: route.port, method, outcome,
        phase: device.state?.phase, generation: device.state?.generation,
        code: String(fault.code || "").slice(0, 80), reason: String(fault.message || error).replace(/[a-f0-9]{64}/gi, "[redacted]").slice(0, 400) });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(events, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file);
    } catch { /* Diagnostics cannot interfere with control revocation. */ }
  }
  private async rpc(id: string, method: string, body: unknown = {}, background = false, signal?: AbortSignal): Promise<{ state: PhoneSessionState; result?: unknown }> {
    const route = this.routes.get(id); if (!route) throw phoneFailure("PHONE_CONNECTION_REQUIRED", "请先连接手机配套 App。");
    const sequence = ++this.sequence;
    const device = this.device(id);
    const reading = this.debugReadings.get(id);
    const ageMs = reading ? Math.max(0, this.now() - reading.at) : Infinity;
    const syncBody = { transport: device.transport, ...(reading?.route === route && ageMs < 6000 ? { debugSettings: { ...reading.value, ageMs } } : {}) };
    const action = (body as { action?: { kind?: string; format?: string } })?.action;
    const screenshot = method === "action" && action?.kind === "screenshot" && action.format === "png";
    const capturedImage = screenshot || method === "follow" && (body as { op?: string })?.op === "frame";
    const requestBody = method === "sync" ? syncBody : capturedImage ? { ...body as object, imageTransfer: SCREENSHOT_TRANSFER } : body;
    let raw: unknown;
    try { raw = route.internetConnection ? await this.internet.request(id, method, requestBody, signal)
      : await this.request(route.port, route.token, method, requestBody, signal); }
    catch (error) {
      if (this.routes.get(id) === route) {
        // Only a background observation can be superseded by newer, recent
        // authenticated evidence on this same forward. Never hide an uncertain
        // action result, reconnect a failed route, or resume a phone lease.
        if (background && method === "sync" && route.success && route.success.sequence > sequence
          && this.now() - route.success.at < 1500 && device.companion === "ready" && device.state && !this.reconcile.has(id)) {
          this.connectionEvent(device, route, method, "superseded", error);
          return { state: structuredClone(device.state) };
        }
        this.connectionEvent(device, route, method, "invalidated", error);
        await this.disconnected(device, (error as Error).message);
      }
      if ((error as { code?: string }).code?.startsWith("PHONE_")) throw error;
      throw phoneFailure(method === "sync" ? "PHONE_CONNECT_FAILED" : "PHONE_EXECUTION_UNCERTAIN", (error as Error).message, method === "sync" ? "not-executed" : "unknown");
    }
    signal?.throwIfAborted();
    if (this.routes.get(id) !== route) throw phoneFailure("PHONE_DISCONNECTED", "手机连接已改变，请重新读取状态；不要重放输入。", method === "sync" ? "not-executed" : "unknown");
    const parsed = z.object({ ok: z.boolean(), code: z.string().optional(), error: z.string().optional(), actionOutcome: z.enum(["not-executed", "completed", "unknown", "not-applicable"]).optional(), recovery: z.unknown().optional(), state: sessionSchema.optional(), result: z.unknown().optional() }).safeParse(raw);
    if (!parsed.success) throw phoneFailure("PHONE_RESPONSE_UNCERTAIN", "手机返回了无效响应，请核查当前状态，不重放操作。", method === "sync" ? "not-executed" : "unknown");
    const response = parsed.data;
    if (response.state) {
      // Polls may complete after a newer action. Within a service instance the
      // phone generation is monotonic; an older result cannot restore control.
      const previous = this.observations.get(id);
      const incoming = response.state;
      const accept = !previous || (previous.instanceId !== incoming.instanceId ? sequence >= previous.sequence : incoming.generation > previous.generation || incoming.generation === previous.generation && sequence >= previous.sequence);
      if (accept) {
        this.observations.set(id, { instanceId: incoming.instanceId, sequence, generation: incoming.generation });
        device.state = response.state; device.confirmedAt = this.now(); device.companion = "ready"; device.error = "";
        this.reconcileCaptureSession(id, incoming);
        const saved = this.saved[id];
        if (saved && incoming.statusDeviceId && saved.statusDeviceId !== incoming.statusDeviceId) {
          saved.statusDeviceId = incoming.statusDeviceId; this.persist();
        }
        this.pairing.delete(id);
        // Offline routes are history, not additional owners of this phone. Only
        // a newer authenticated observation of the same instance retires them.
        for (const alias of this.devices.values()) {
          if (alias.id === id || alias.connection === "device" || !alias.state
              || alias.state.instanceId !== incoming.instanceId || alias.state.generation > incoming.generation
              || !device.hardwareId || (alias.hardwareId || this.saved[alias.id]?.hardwareId) !== device.hardwareId) continue;
          alias.state = null; alias.confirmedAt = null;
        }
      }
    }
    if (!response.ok) {
      if (response.code === "PAIRING_REQUIRED") device.companion = "pairing";
      const code = response.code === "PAIRING_REQUIRED" ? "PHONE_PAIRING_REQUIRED" : response.code || "PHONE_REJECTED";
      const error = phoneFailure(code, response.error || "手机拒绝了操作。", response.actionOutcome || (response.code === "PAIRING_REQUIRED" ? "not-executed" : "unknown"));
      const recovery = parseControlRecovery(response.recovery);
      if (recovery?.cause === code) error.details.recovery = recovery;
      throw error;
    }
    if (!response.state) throw new Error("手机未返回控制状态。");
    if (sequence > (route.success?.sequence || 0)) route.success = { sequence, at: this.now() };
    if (method === "sync") this.refreshDebugSettings(id, route);
    if (capturedImage) {
      const owner = body as { instanceId: string; sessionId: string; generation: number };
      return assembleScreenshot({ state: response.state, result: response.result },
        { instanceId: owner.instanceId, sessionId: owner.sessionId, generation: owner.generation },
        page => this.rpc(id, "screenshot-chunk", page, false, signal),
        // A later-started poll may cache "executing" while this capture encodes.
        // Every returned page separately proves the same owner is now ready;
        // this cache only rejects revoked ownership, not that older busy phase.
        () => !signal?.aborted && !this.closed && this.routes.get(id) === route && device.companion === "ready" && !this.reconcile.has(id)
          && device.state?.instanceId === owner.instanceId && device.state.sessionId === owner.sessionId
          && device.state.generation === owner.generation && ["viewing", "controlling", "executing"].includes(device.state.phase));
    }
    return { state: response.state, result: response.result };
  }
  private refreshDebugSettings(id: string, route: Route): void {
    if (route.internetConnection) return;
    const reading = this.debugReadings.get(id);
    if (this.closed || this.debugPending.has(id) || reading?.route === route && this.now() - reading.at < 2000) return;
    const at = this.now();
    this.debugPending.set(id, route);
    // Diagnostics must not delay heartbeats or revoke a session when a setting is unavailable.
    void readDebugSettings(this.adb, id).then(value => {
      if (!this.closed && this.routes.get(id) === route) this.debugReadings.set(id, { route, at, value });
    }).finally(() => { if (this.debugPending.get(id) === route) this.debugPending.delete(id); });
  }
  private async exclusive<T>(id: string, label: string, work: () => Promise<T>): Promise<T> {
    if (this.closed) throw phoneFailure("PHONE_SERVICE_UNAVAILABLE", "手机服务正在退出。");
    if (this.captureRoutes(id).some(route => this.operations.has(route.id))) throw phoneFailure("PHONE_TARGET_BUSY", "此手机正在处理另一项操作。");
    const device = this.connected(id); this.operations.add(id); device.pending = label; this.changed();
    this.cancelScreenReads(id);
    try { return await work(); }
    catch (error) { device.error = (error as Error).message; throw error; }
    finally { this.operations.delete(id); device.pending = null; this.changed(); }
  }
  private wirelessGroup(id: string) {
    const group = groupPhoneDevices(this.snapshot().devices).find(item => item.routes.some(route => route.id === id));
    if (!group) throw new Error("手机不存在，请刷新设备列表。");
    return group;
  }
  private reconnectableWirelessGroups() {
    return groupPhoneDevices(this.snapshot().devices).filter(group =>
      !group.routes.some(device => this.wirelessDisabled.has(device.hardwareId || device.id)) &&
      !group.routes.some(device => {
        const failure = this.wirelessFailures.get(device.hardwareId || device.id);
        return failure?.code === "PHONE_WIFI_AUTH_REQUIRED" && this.now() - failure.at < 300000;
      }) &&
      group.routes.some(device => device.hardwareId || device.transport === "usb") &&
      !group.routes.some(device => device.transport === "emulator" || device.connection === "device" || device.connection === "unauthorized" || this.operations.has(device.id) ||
        [device.state, device.basic].some(state => state && ["viewing", "controlling", "executing", "paused"].includes(state.phase))));
  }
  private async rememberLiveWirelessAliases(): Promise<void> {
    // ADB may expose only an mDNS name after an automatic TLS connection. Resolve
    // that exact LIVE route before a server restart can empty the discovery cache.
    const aliases = [...this.devices.values()].filter(device => device.connection === "device" && device.transport === "wifi"
      && device.hardwareId && /\._adb-tls-connect\._tcp\.?$/.test(device.id));
    if (!aliases.length || this.closed || this.now() - this.wirelessAliasScanAt < 20000) return;
    this.wirelessAliasScanAt = this.now();
    const adb: AdbRunner = { run: (args, timeout, input) => this.adb.run(args, Math.min(timeout || 1500, 1500), input, this.wirelessReconnectAbort.signal) };
    const discovered = await discoverWireless(adb);
    if (this.closed) return;
    for (const device of aliases) {
      if (device.connection !== "device" || !device.hardwareId) continue;
      const matches = discovered.services.filter(service => service.kind === "connect"
        && `${service.name}._adb-tls-connect._tcp` === device.id.replace(/\.$/, ""));
      if (matches.length !== 1) continue;
      const address = matches[0].address;
      const ips = device.companion === "ready" && device.confirmedAt != null && this.now() - device.confirmedAt < 45000
        ? device.state?.readiness?.network?.wifiIpv4 || [] : [];
      if (ips.length && !ips.includes(address.split(":")[0])) continue;
      this.recentWireless.set(device.hardwareId, { hardwareId: device.hardwareId, address, at: this.now() });
      this.wirelessAttempts.delete(address);
    }
  }
  /** Background transport recovery; never installs, pairs, starts or resumes control. */
  reconnectWireless(): Promise<void> {
    if (this.wirelessReconnect) return this.wirelessReconnect;
    if (this.closed || this.adbSuspended || this.hostBusy || !this.adbAvailable || this.wirelessBusy || this.now() - this.wirelessScanAt < 10000 || !this.reconnectableWirelessGroups().length) return Promise.resolve();
    this.wirelessScanAt = this.now();
    const signal = this.wirelessReconnectAbort.signal;
    const adb: AdbRunner = { run: (args, timeout, input) => this.adb.run(args, timeout, input, signal) };
    this.wirelessReconnect = (async () => {
      const discovered = await discoverWireless(adb);
      if (this.closed || signal.aborted) return;
      for (const [address, at] of this.wirelessAttempts) if (this.now() - at >= 60000) this.wirelessAttempts.delete(address);
      let attempts = 0;
      for (const group of this.reconnectableWirelessGroups()) {
        const candidates = wirelessCandidates(discovered.services, group.routes, this.now(), this.recentWireless.values()).services.filter(candidate => candidate.kind === "connect");
        for (const candidate of candidates) {
          if (this.closed || signal.aborted || this.wirelessBusy || attempts >= 3) return;
          if (this.wirelessAttempts.has(candidate.address)) continue;
          this.wirelessAttempts.set(candidate.address, this.now()); attempts++;
          const probe = await (this.options.probeWireless || probeWireless)(candidate.address);
          // Recheck after network waits: USB may have arrived or the user may have started a session.
          const current = this.reconnectableWirelessGroups().find(item => item.routes.some(route => group.routes.some(old => old.id === route.id)));
          if (this.closed || signal.aborted || this.wirelessBusy || !current) break;
          if (!probe.reachable) continue;
          try {
            const connected = await this.wirelessOperation(() => this.connectWirelessAddress({ address: candidate.address }, adb));
            const expected = current.routes.map(device => device.hardwareId || (device.transport === "usb" ? device.id : ""));
            // Discovery is only a hint; never merge another device by IP or model.
            if (expected.includes(connected.hardwareId || "") && connected.hardwareId) break;
          } catch (error) {
            this.rememberWirelessFailure(current.routes, candidate.address, error);
            if ((error as { code?: string }).code === "PHONE_WIFI_AUTH_REQUIRED") break;
          }
        }
      }
    })().catch(() => {}).finally(() => { this.wirelessReconnect = undefined; });
    return this.wirelessReconnect;
  }
  async discoverWireless(id?: string) {
    const nearby = !id ? (this.options.discoverNearbyApps || discoverNearbyApps)().catch(() => ({ apps: [], appError: "局域网设备发现暂不可用，请检查网络权限和防火墙。" })) : undefined;
    // Nearby App discovery must not wait for disconnected ADB/companion routes.
    if (id) { await this.refresh(); await this.cloud.refresh(); }
    const scan = async () => {
      const discovered = await discoverWireless(this.adb);
      const groups = id ? [this.wirelessGroup(id)] : groupPhoneDevices(this.snapshot().devices);
      const knownHardware = groups.flatMap(group => group.routes.map(route => route.hardwareId).filter(Boolean));
      const selected = groups.map(group => wirelessCandidates(discovered.services, group.routes, this.now(), this.recentWireless.values()));
      const all = [...selected.flatMap(result => result.services), ...(!id ? discovered.services.filter(service =>
        !knownHardware.some(hardware => service.name.startsWith(`adb-${hardware}-`))) : [])];
      const candidates = all.filter((item, index) => all.findIndex(other => other.kind === item.kind && other.address === item.address) === index).slice(0, 16);
      const services = await Promise.all(candidates.map(async item => ({ ...item, ...await (this.options.probeWireless || probeWireless)(item.address) })));
      return { services, phoneIps: [...new Set(selected.flatMap(result => result.phoneIps))], error: discovered.error, ...(discovered.diagnostic ? { diagnostic: discovered.diagnostic } : {}) };
    };
    let result = await scan();
    if (!result.error && !result.services.some(item => item.reachable && item.kind === "connect")) {
      await new Promise(resolve => setTimeout(resolve, 700));
      result = await scan(); // Replace stale results, never accumulate expired endpoints.
    }
    return { ...result, ...(nearby ? await nearby : {}) };
  }
  autoConnectWireless(id: string): Promise<PhoneDevice> {
    for (const device of this.wirelessGroup(id).routes) {
      this.wirelessDisabled.delete(device.hardwareId || device.id);
      this.wirelessFailures.delete(device.hardwareId || device.id);
    }
    return this.wirelessOperation(async () => {
      const attempted = new Set<string>();
      const began = Date.now();
      let failure: Error | undefined;
      for (let round = 0; round < 2; round++) {
        const group = this.wirelessGroup(id);
        if (group.routes.some(device => device.state && ["viewing", "controlling", "executing", "paused"].includes(device.state.phase)))
          throw new Error("手机有进行中或暂停的会话，请先处理原会话；自动连接不会恢复或接管它。");
        const live = group.routes.find(device => device.transport === "wifi" && device.connection === "device" && device.companion === "ready");
        if (live) return structuredClone(live);
        const expected = group.routes.map(device => device.hardwareId || (device.transport === "usb" ? device.id : "")).filter(Boolean);
        if (!expected.length) throw new Error("这台手机尚未在此电脑确认设备身份，请先完成首次配对或手动连接。手机上报的地址可在手动连接中自动填入。");
        const result = await this.discoverWireless(id);
        if (result.error && !failure) failure = new Error(result.error);
        for (const candidate of result.services.filter(item => item.kind === "connect")) {
          if (!candidate.reachable) {
            if (!failure) failure = new WirelessFailure("connection", candidate.address, began, { stderr: sanitizeWirelessOutput(candidate.reason || "地址不可达") });
            continue;
          }
          if (attempted.has(candidate.address) || attempted.size >= 3) continue;
          attempted.add(candidate.address);
          try {
            const connected = await this.connectWirelessAddress({ address: candidate.address });
            // mDNS and reported IPs are discovery hints. Check hardware identity
            // before returning a device to automatic companion preparation.
            if (expected.length) {
              const actual = (await this.adb.run(["-s", connected.id, "shell", deviceShell(["getprop", "ro.serialno"])] )).trim();
              if (!expected.includes(actual)) throw new Error("发现的地址属于其他设备，已停止自动连接。请重新发现当前手机。");
            }
            return connected;
          } catch (error) {
            failure = error as Error;
            this.rememberWirelessFailure(group.routes, candidate.address, error);
            // Trying another cached port cannot repair a rejected certificate,
            // and a later network error must not hide the actionable diagnosis.
            if ((error as { code?: string }).code === "PHONE_WIFI_AUTH_REQUIRED") throw error;
          }
        }
        if (round === 0) await new Promise(resolve => setTimeout(resolve, 700));
      }
      throw failure || new WirelessFailure("discovery", undefined, began, {}, "NO_ENDPOINT");
    });
  }
  private async wirelessOperation<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.wirelessBusy) throw new Error("正在处理无线连接，请稍后重试。");
    this.wirelessBusy = true;
    try { return await work(); } finally { this.wirelessBusy = false; }
  }
  private rememberWirelessFailure(routes: PhoneDevice[], address: string, error: unknown): void {
    if (this.closed || !(error instanceof Error)) return;
    const code = (error as { code?: string }).code;
    if (!code?.startsWith("PHONE_WIFI_")) return;
    for (const route of routes) this.wirelessFailures.set(route.hardwareId || route.id, { at: this.now(), address, code, message: error.message });
    this.changed();
  }
  pairWireless(input: unknown) {
    return this.wirelessOperation(async () => {
      const paired = await pairWireless(this.adb, input);
      const host = paired.address.split(":")[0];
      for (const [key, failure] of this.wirelessFailures) if (failure.address.split(":")[0] === host) this.wirelessFailures.delete(key);
      for (const address of this.wirelessAttempts.keys()) if (address.split(":")[0] === host) this.wirelessAttempts.delete(address);
      this.wirelessScanAt = -Infinity;
      return paired;
    });
  }
  connectWireless(input: unknown): Promise<PhoneDevice> {
    return this.wirelessOperation(async () => { const device = await this.connectWirelessAddress(input); this.wirelessDisabled.delete(device.hardwareId || device.id); return device; });
  }
  private async connectWirelessAddress(input: unknown, adb = this.adb): Promise<PhoneDevice> {
      const began = Date.now();
      if (this.closed) throw new Error("手机服务正在退出。");
      const address = await connectWireless(adb, input);
      let discoveredIds: string[] = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        if (this.closed) throw new Error("手机服务正在退出。");
        await this.refresh();
        const device = this.devices.get(address);
        if (device?.connection === "device") return structuredClone(device);
        if (attempt === 0) discoveredIds = (await discoverWireless(adb)).services
          .filter(item => item.kind === "connect" && item.address === address)
          .map(item => `${item.name}._adb-tls-connect._tcp`);
        const aliases = [...this.devices.values()].filter(item => item.connection === "device"
          && discoveredIds.some(name => item.id === name || item.id === name + "."));
        if (aliases.length === 1) return structuredClone(aliases[0]);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new WirelessFailure("readiness", address, began, {}, "DEVICE_NOT_READY");
  }
  async prepare(id: string, update = true): Promise<PhoneDevice> {
    this.assertNoBasic();
    if (id.startsWith("internet-")) {
      if (update) throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "请使用手机 App 的检查更新，或通过外网安装入口提交 APK。");
      const device = this.device(id), connectionId = this.internet.connection(id);
      if (!connectionId) throw phoneFailure("PHONE_CONNECTION_REQUIRED", this.connectionError(device));
      this.setAppDisconnected(id, false);
      await this.internetConnected(id, device.name, connectionId);
      return structuredClone(this.device(id));
    }
    await this.refresh();
    if (!update && this.device(id).connection !== "device") {
      const alternatives = this.liveAliases(this.device(id));
      if (alternatives.length === 1) id = alternatives[0].id;
    }
    await this.exclusive(id, "正在连接手机…", async () => {
      const confirmedRoute = this.routes.has(id) && this.device(id).companion === "ready" && !this.reconcile.has(id);
      // USB and wireless transports can identify the same physical phone with
      // different ADB IDs. Reuse its existing app pairing without rotating its
      // credential or replacing a control session on the other transport.
      const hardwareId = (await this.adb.run(["-s", id, "shell", deviceShell(["getprop", "ro.serialno"])]).catch(() => "")).trim();
      if (/^[a-zA-Z0-9_-]{1,200}$/.test(hardwareId) && !["unknown", "null"].includes(hardwareId)) {
        const alias = this.saved[hardwareId] || Object.values(this.saved).find(item => item.hardwareId === hardwareId);
        if (!this.saved[id] && alias) this.saved[id] = { ...alias, hardwareId };
        else if (this.saved[id]) this.saved[id].hardwareId = hardwareId;
        if (this.saved[id]) this.persist();
        if (!this.routes.has(id) && this.saved[id]) await this.forward(id);
      }
      if (this.routes.has(id)) {
        let state: PhoneSessionState | undefined, peerOwnsSession: boolean | undefined;
        try { const response = await this.rpc(id, "sync"); state = response.state; peerOwnsSession = (response.result as { peerOwnsSession?: boolean })?.peerOwnsSession; } catch { /* recover a disconnected companion */ }
        // An established route stays unchanged. A newly authenticated route must
        // reconcile lingering control before returning; it never inherits input.
        if (state && !update) {
          if (peerOwnsSession !== false && !confirmedRoute && ["viewing", "controlling", "executing"].includes(state.phase)) {
            await this.rpc(id, "pause", { instanceId: state.instanceId, sessionId: state.sessionId, generation: state.generation });
          }
          this.setAppDisconnected(id, false);
          return;
        }
        if (state && ["viewing", "controlling", "executing", "paused"].includes(state.phase)) throw new Error("请先结束手机会话，再打开或更新配套 App。");
      }
      const installed = await this.adb.run(["-s", id, "shell", deviceShell(["pm", "path", this.companion.packageName])]).catch(() => "");
      let installedHash = this.saved[id]?.installedHash;
      if (!update && !installed.startsWith("package:")) throw new Error("未找到手机配套 App；请明确运行 ppilot phone update --device <ID> 安装。connect 不会安装或更新 App。");
      if (update) {
        if (!fs.existsSync(this.options.apkPath)) throw new Error("缺少手机配套安装包，请先运行 npm run build:phone。");
        const apk = fs.readFileSync(this.options.apkPath);
        installedHash = verifyCompanionApk(this.options.apkPath, apk, this.companion.packageName);
        if (!installed.startsWith("package:") || this.saved[id]?.installedHash !== installedHash) {
        // ADB cannot read Electron's virtual app.asar path on either OS.
        // Materialize the exact bundled bytes in the app's private data folder.
        const installPath = path.join(this.options.root, "profilepilot-phone.apk");
        fs.writeFileSync(installPath, apk);
          const result = await this.adb.run(["-s", id, "install", "-r", installPath], 120000);
          if (!/^Success\s*$/m.test(result)) throw new Error("Android 未确认配套 App 安装成功：" + result.slice(0, 800));
        }
      }
      this.saved[id] = { ...this.saved[id], token: this.saved[id]?.token || randomBytes(32).toString("hex"), installedHash, model: this.device(id).model.slice(0, 200), transport: this.device(id).transport,
        ...(/^[a-zA-Z0-9_-]{1,200}$/.test(hardwareId) && !["unknown", "null"].includes(hardwareId) ? { hardwareId } : {}) }; this.persist();
      this.device(id).appInstallation = { status: "installed", checkedAt: this.now() };
      this.pairing.add(id);
      await this.adb.run(["-s", id, "shell", deviceShell(["am", "start", "-f", "0x24000000", "-n", this.companion.mainActivity, "--es", "token", this.saved[id].token, "--es", "computer", this.computer])]);
      if (!this.routes.has(id)) await this.forward(id);
      this.device(id).companion = "pairing";
      try { await this.rpc(id, "sync"); } catch { /* phone must approve first */ }
      this.setAppDisconnected(id, false);
    });
    return structuredClone(this.device(id));
  }
  async rename(id: string, name: string): Promise<void> {
    const next = z.string().trim().min(1).max(80).parse(name);
    if (id.startsWith("registered-")) { this.registry.rename(id, next); this.changed(); return; }
    if (id.startsWith("cloud-")) { this.cloud.rename(id, next); return; }
    this.device(id);
    this.saved[id] = { ...this.saved[id], token: this.saved[id]?.token || randomBytes(32).toString("hex"), name: next };
    const group = groupPhoneDevices(this.snapshot().devices).find(item => item.routes.some(route => route.id === id))!;
    const hardwareIds = new Set(group.routes.map(route => route.hardwareId).filter(Boolean));
    for (const [routeId, saved] of Object.entries(this.saved)) {
      if (group.routes.some(route => route.id === routeId) || saved.hardwareId && hardwareIds.has(saved.hardwareId)) {
        saved.name = next;
        const route = this.devices.get(routeId); if (route) route.name = next;
      }
    }
    this.persist(); this.changed();
  }
  async start(id: string, mode: "view" | "control", controller: string, task: string, source: PhoneCommandSource = "desktop", keepScreenOn = true): Promise<PhoneDevice> {
    if (id.startsWith("iphone-")) return this.iphones.start({ id, mode, controller, task, keepScreenOn });
    this.assertNoBasic();
    const input = z.object({ mode: z.enum(["view", "control"]), controller: z.string().trim().min(1).max(120), task: z.string().trim().max(500), keepScreenOn: z.boolean() }).parse({ mode, controller, task, keepScreenOn });
    await this.exclusive(id, "等待手机确认会话…", async () => {
      const { state } = await this.rpc(id, "sync");
      if (["viewing", "controlling", "executing", "paused"].includes(state.phase)) throw phoneFailure("PHONE_SESSION_CONFLICT", "手机已有会话，请继续该会话或先结束。");
      if (state.readiness?.unlocked === false) throw phoneFailure("PHONE_SCREEN_LOCKED", "请先解锁手机。");
      const readiness = phoneReadiness({ ...this.device(id), state, companion: "ready" });
      if (!readiness.readyToStart) throw phoneFailure(readiness.checks.some(c => c.status === "blocked" && ["overlay", "notifications"].includes(c.id)) ? "PHONE_USER_PERMISSION_REQUIRED"
        : readiness.checks.some(c => c.status === "blocked" && c.id === "accessibility") ? "PHONE_PERMISSION_REQUIRED" : "PHONE_NOT_READY",
        readiness.checks.filter(c => c.status === "blocked").map(c => c.message).join(" "), "not-executed", readiness);
      const started = await this.rpc(id, "start", { ...input, instanceId: state.instanceId, generation: state.generation, sessionId: randomUUID(), computer: this.computer });
      if (source === "external") this.ownTaskCapture(id, started.state, "app");
    }); return this.snapshot().devices.find(device => device.id === id)!;
  }
  async control(id: string, command: "pause" | "resume" | "stop"): Promise<PhoneDevice> {
    if (id.startsWith("iphone-")) return this.iphones.control(id, command);
    if (command === "resume") this.assertNoBasic();
    z.enum(["pause", "resume", "stop"]).parse(command);
    if (command !== "resume") this.screenCamera.stopFor(id, command === "pause" ? "手机控制已暂停" : "手机控制已结束");
    await this.exclusive(id, command === "stop" ? "正在结束控制…" : command === "pause" ? "正在暂停…" : "正在恢复…", async () => {
      const { state } = await this.rpc(id, "sync");
      await this.rpc(id, command, { instanceId: state.instanceId, sessionId: state.sessionId, generation: state.generation });
    }); return this.snapshot().devices.find(device => device.id === id)!;
  }
  /** User-initiated wake. It never resumes a session by itself; the phone owns that decision. */
  async wake(id: string): Promise<PhoneDevice> {
    const device = this.device(id);
    if (device.connection !== "device") throw new Error(this.connectionError(device));
    await this.exclusive(id, "正在点亮屏幕…", async () => {
      if (device.transport === "internet") await this.rpc(id, "wake");
      else await wakeDevice(this.adb, id);
      await new Promise(resolve => setTimeout(resolve, 500));
      if (this.routes.has(id)) await this.rpc(id, "sync", {}, true).catch(() => undefined);
    });
    return this.snapshot().devices.find(item => item.id === id)!;
  }
  /** Charging-only idle wake lock; keeps ADB reachable while the screen is off. */
  async unattended(id: string, op: "on" | "off" | "status"): Promise<{ enabled: boolean; charging: boolean; active: boolean }> {
    const device = this.device(id);
    if (device.connection !== "device" || device.companion !== "ready") throw new Error("请先连接手机配套 App。");
    const { result } = await this.rpc(id, "unattended", { op });
    return z.object({ enabled: z.boolean(), charging: z.boolean(), active: z.boolean() }).strict().parse(result);
  }
  private async companionState(id: string) {
    if (!this.routes.has(id)) return null;
    try { return (await this.rpc(id, "sync", {}, true)).state; } catch { return null; }
  }
  private async screenUnlocked(id: string): Promise<boolean> {
    // KeyguardManager can report "unlocked" while the display is asleep.
    if ((await screenAwake(this.adb, id)) === false) return false;
    const state = await this.companionState(id);
    if (state?.readiness) return state.readiness.unlocked;
    return (await keyguardLocked(this.adb, id)) === false;
  }
  private patternKey(id: string): string { const device = this.device(id); return device.hardwareId || this.saved[id]?.hardwareId || id; }
  private unlockSecretStatusFor(key: string) {
    const info = this.secrets.status(key);
    return { available: this.secrets.available(), saved: !!info, kind: info?.kind ?? null, savedAt: info?.savedAt ?? null, allowAgent: info?.allowAgent ?? false };
  }
  unlockSecretStatus(id: string) { return this.unlockSecretStatusFor(this.patternKey(id)); }
  saveUnlockSecret(id: string, input: { kind: UnlockSecretKind; value: string; allowAgent: boolean }) {
    // Validate before touching the vault; errors never echo the value.
    const value = input.kind === "pattern" ? validatePattern(input.value).join("") : validateCredential(input.value);
    this.secrets.save(this.patternKey(id), { kind: input.kind, value, allowAgent: input.allowAgent });
    this.changed();
    return this.unlockSecretStatus(id);
  }
  deleteUnlockSecret(id: string) {
    const removed = this.secrets.remove(this.patternKey(id));
    if (removed) this.changed();
    return { removed, ...this.unlockSecretStatus(id) };
  }
  /** Use the stored, OS-encrypted credential; its value never leaves the desktop. */
  async unlockStored(id: string, geometry?: string) {
    const key = this.patternKey(id);
    const info = this.secrets.status(key);
    if (!info) throw new Error("这台手机没有保存解锁凭据；请先在桌面 App 的“解锁凭据”中保存，或改用 --pattern/标准输入。");
    if (!info.allowAgent) throw new Error("已保存解锁凭据，但“允许命令行与 Agent 使用”未开启；请在桌面 App 中开启。");
    const value = this.secrets.get(key);
    if (!value) throw new Error("保存的解锁凭据无法解密（系统账户可能已变化）；请重新保存。");
    return info.kind === "pattern" ? this.unlockPattern(id, value, geometry) : this.unlock(id, value);
  }
  private savedPatternLayout(id: string): PatternLayout | null { return this.patternLayouts[this.patternKey(id)] || null; }
  private rememberPatternLayout(id: string, layout: PatternLayout): void {
    const key = this.patternKey(id);
    this.patternLayouts[key] = layout;
    const keys = Object.keys(this.patternLayouts);
    for (const extra of keys.slice(0, Math.max(0, keys.length - 50))) delete this.patternLayouts[extra];
    try {
      const file = path.join(this.options.root, "pattern-layout.json");
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.patternLayouts), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* A cached geometry is optional. */ }
  }
  /** Best-effort dot detection from the lock-screen framebuffer; never required. */
  private async detectPatternLayout(id: string): Promise<PatternLayout | null> {
    if (!this.adb.runBinary) return null;
    try {
      const screen = parseRawScreencap(await this.adb.runBinary(["-s", id, "exec-out", "screencap"], 12000));
      return screen ? detectPatternGrid(screen) : null;
    } catch { return null; }
  }
  /**
   * Type the phone's own lock credential over ADB. Only a user who knows it can
   * reach this point; the credential is never retried and never stored here.
   */
  async unlock(id: string, credential: string): Promise<{ id: string; unlocked: boolean; verified: boolean; note: string }> {
    if (this.device(id).transport === "internet") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "此版本外网连接可点亮屏幕；安全锁屏请在手机解锁后继续。");
    const secret = validateCredential(credential);
    const device = this.device(id);
    if (device.connection !== "device") throw new Error(this.connectionError(device));
    return this.exclusive(id, "正在解锁手机…", async () => {
      // Wake first: a sleeping display may still report "not locked".
      await wakeDevice(this.adb, id);
      await new Promise(resolve => setTimeout(resolve, 500));
      if (await this.screenUnlocked(id)) return { id, unlocked: true, verified: true, note: "手机已点亮且处于解锁状态，没有输入凭据。" };
      const size = await readScreenSize(this.adb, id);
      await enterCredential(this.adb, id, secret, { swipe: true, size });
      const deadline = this.now() + 6000;
      while (this.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (await this.screenUnlocked(id)) {
          // Let the companion report the automatic resume before returning.
          await this.companionState(id);
          return { id, unlocked: true, verified: true, note: "手机已解锁；熄屏暂停的会话会自动继续。" };
        }
      }
      return { id, unlocked: false, verified: false, note: "已发送解锁凭据，但电脑没有确认到解锁结果。请查看手机；不会自动重试。" };
    });
  }
  /**
   * Draw the phone's own pattern over ADB. The digits stay on the desktop; only
   * the resulting coordinates reach the device. One attempt, never retried.
   */
  async unlockPattern(id: string, pattern: string, geometry?: string): Promise<{ id: string; unlocked: boolean; verified: boolean; note: string; layout?: PatternLayout }> {
    if (this.device(id).transport === "internet") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "此版本外网连接可点亮屏幕；安全锁屏请在手机解锁后继续。");
    const dots = validatePattern(pattern);
    const explicit = geometry ? parsePatternLayout(geometry) : undefined;
    const device = this.device(id);
    if (device.connection !== "device") throw new Error(this.connectionError(device));
    return this.exclusive(id, "正在解锁手机…", async () => {
      await wakeDevice(this.adb, id);
      await new Promise(resolve => setTimeout(resolve, 500));
      if (await this.screenUnlocked(id)) return { id, unlocked: true, verified: true, note: "手机已点亮且处于解锁状态，没有绘制图案。" };
      const size = await readScreenSize(this.adb, id);
      if (size) await swipeUpBouncer(this.adb, id, size).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 500));
      const layout = explicit || this.savedPatternLayout(id) || await this.detectPatternLayout(id)
        || (size ? defaultPatternLayout(size.width, size.height) : null);
      if (!layout) throw new Error("无法确定图案点阵的位置；请重新连接手机，或用 patternGeometry 指定坐标。");
      await drawPattern(this.adb, id, patternPoints(dots, layout));
      const deadline = this.now() + 6000;
      while (this.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (await this.screenUnlocked(id)) {
          this.rememberPatternLayout(id, layout);
          await this.companionState(id);
          return { id, unlocked: true, verified: true, note: "手机已解锁；熄屏暂停的会话会自动继续。", layout };
        }
      }
      return { id, unlocked: false, verified: false, note: "已按图案尝试一次，但电脑没有确认到解锁结果。不会自动重试；可用 patternGeometry 校准点位后再试。", layout };
    });
  }
  async perform(input: PhoneActionInput): Promise<PhoneActionResult> {
    if (input.id.startsWith("iphone-")) return this.iphones.perform(input);
    this.assertNoBasic();
    const { id, sessionId, generation, requestId, action, observeAfter } = z.object({ id: z.string(), sessionId: z.string().min(1).max(100), generation: z.number().int().nonnegative(), requestId: z.string().uuid(), action: phoneActionSchema, observeAfter: z.boolean().optional() }).strict().parse(input);
    const device = this.connected(id);
    if (device.companion !== "ready" || this.reconcile.has(id)) throw phoneFailure("PHONE_CONNECTION_REQUIRED", "手机连接需要重新确认，请等待状态同步后核查会话。");
    if (this.closed || this.captureRoutes(id).some(route => this.operations.has(route.id) || this.actions.has(route.id))) throw phoneFailure("PHONE_TARGET_BUSY", "手机正在处理操作或交接控制权。");
    this.actions.add(id); this.cancelScreenReads(id); this.changed();
    try {
      const { state } = await this.rpc(id, "sync");
      if (state.phase === "paused") throw phoneFailure(state.pauseCause === "screen" ? "PHONE_SCREEN_LOCKED" : "PHONE_USER_IN_CONTROL", "手机已暂停，不能继续操作。");
      if (state.sessionId !== sessionId || state.generation !== generation) throw phoneFailure("PHONE_SESSION_STALE", "手机会话已改变，请重新读取状态；不要重放输入。");
      if (!["viewing", "controlling"].includes(state.phase)) throw phoneFailure("PHONE_SESSION_ENDED", "手机已结束或断开，不能继续操作。");
      if (state.mode === "view" && !isPhoneRead(action.kind)) throw phoneFailure("PHONE_PERMISSION_REQUIRED", "当前为仅查看会话，不能操作手机。");
      const response = await this.rpc(id, "action", { instanceId: state.instanceId, sessionId, generation, requestId, action });
      if (observeAfter && !isPhoneRead(action.kind)) {
        const route = this.routes.get(id);
        const check = () => {
          const current = device.state;
          if (this.closed || this.routes.get(id) !== route || !current || current.instanceId !== state.instanceId || current.sessionId !== sessionId || current.generation !== generation || current.phase !== 'controlling')
            throw phoneFailure('PHONE_SESSION_STALE', '操作后手机控制状态已改变。');
        };
        const feedback = await observeAfterAction({ check, errorCode: 'PHONE_OBSERVATION_FAILED', invalidate: () => {},
          observe: async () => {
            const observed = await this.rpc(id, 'action', { instanceId: state.instanceId, sessionId, generation, requestId: randomUUID(), action: { kind: 'snapshot' } });
            const tree = observed.result as { nodes?: unknown[] };
            if (!tree || !Array.isArray(tree.nodes)) throw phoneFailure('PHONE_OBSERVATION_FAILED', '手机未返回有效控件树。');
            return { kind: 'accessibility', capturedAt: this.now(), ...tree,
              completeness: 'bounded', limits: { maxNodes: 400, maxDepth: 25 }, ...(tree.nodes.length >= 400 ? { truncated: true } : {}) };
          }
        });
        return { state: structuredClone(device.state || response.state), result: response.result, ...feedback };
      }
      return { state: response.state, result: response.result };
    } catch (error) { this.device(id).error = (error as Error).message; throw error; }
    finally { this.actions.delete(id); this.changed(); }
  }
  /** Desktop inspector read: no session creation, input frame, installation or takeover. */
  async startScreenVideo(id: string, signal: AbortSignal, basic?: { sessionId: string; generation: number }): Promise<PhoneVideoStream> {
    const device = this.connected(id);
    if (device.transport === "internet") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "外网连接请使用 phone action 的截图；此版本暂不支持视频预览。");
    const guard = () => {
      if (this.closed || device.connection !== "device") throw new Error("手机连接已断开。");
      if (basic) {
        const state = this.basic.state(id);
        if (!state || state.sessionId !== basic.sessionId || state.generation !== basic.generation || !["viewing", "controlling"].includes(state.phase)) throw new Error("手机操作会话已改变，视频已停止。");
      } else if (!phoneAppConnected(device, this.now()) || this.appConnectionDisabled(device)) throw new Error("请先连接手机 App，再查看画面。");
      return JSON.stringify(this.guardPreview(id, false, !!basic).map(route => [route.id, route.connection, route.basic?.sessionId, route.basic?.generation,
        route.basic?.phase, route.state?.instanceId, route.state?.sessionId, route.state?.generation, route.state?.phase]));
    };
    const version = guard(); signal.throwIfAborted();
    for (const route of this.captureRoutes(id)) this.screenVideos.get(route.id)?.abort();
    const controller = new AbortController(); this.screenVideos.set(id, controller);
    const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
    controller.signal.addEventListener("abort", () => {
      signal.removeEventListener("abort", abort);
      if (this.screenVideos.get(id) === controller) this.screenVideos.delete(id);
    }, { once: true });
    const stream = new PhoneVideoStream(this.adb, id, () => {
      if (guard() !== version) throw new Error("手机会话已改变，视频预览已停止。");
    }, controller.signal);
    try { await stream.start(); return stream; }
    catch (error) { controller.abort(); stream.stop(); throw error; }
  }
  /** Desktop inspector read: no session creation, input frame, installation or takeover. */
  async screen(id: string): Promise<PhoneScreenFrame> {
    const device = this.connected(id);
    if (device.transport === "internet") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "外网截图请使用有效手机会话下的 phone action screenshot。");
    if (!this.adb.runBinary) throw new Error("当前连接不支持读取手机画面。");
    if (this.captureRoutes(id).some(route => this.screenReads.has(route.id))) throw new Error("正在获取手机画面，请稍候。");
    const guard = () => {
      if (!phoneAppConnected(device, this.now()) || this.appConnectionDisabled(device)) throw new Error("请先连接手机 App，再查看画面。");
      if (this.closed || device.connection !== "device" || this.operations.has(id)) throw new Error("手机连接或状态已改变，请稍后重试。");
      const routes = this.guardPreview(id);
      return JSON.stringify(routes.map(route => [route.id, route.connection, route.basic?.sessionId, route.basic?.generation, route.basic?.phase, route.state?.instanceId, route.state?.sessionId, route.state?.generation, route.state?.phase]));
    };
    guard();
    const abort = new AbortController(); this.screenReads.set(id, abort);
    try {
      if (device.companion === "ready" && this.routes.has(id)) await this.rpc(id, "sync");
      const version = guard(); abort.signal.throwIfAborted();
      const check = () => { if (guard() !== version) throw new Error("手机会话已改变，本次画面已丢弃。"); };
      const { png, width, height } = await captureAdbScreen(this.adb, id, abort.signal, check);
      check(); abort.signal.throwIfAborted();
      return { mime: "image/png", base64: png.toString("base64"), width, height, capturedAt: this.now() };
    } finally { this.screenReads.delete(id); }
  }
  async preview(id: string): Promise<PhoneActionResult> {
    this.assertNoBasic();
    const device = this.connected(id);
    if (device.companion !== "ready" || this.reconcile.has(id)) throw new Error("请先连接手机 App，并确认会话状态。");
    this.guardPreview(id);
    return this.exclusive(id, "正在获取手机画面…", async () => {
      let { state } = await this.rpc(id, "sync");
      this.guardPreview(id, true);
      if (["paused", "disconnected", "executing"].includes(state.phase)) throw new Error("手机已暂停、断开或正在执行操作，请确认状态后查看画面。");
      let owned: PhoneSessionState | undefined;
      if (["idle", "stopped"].includes(state.phase)) {
        ({ state } = await this.rpc(id, "start", { instanceId: state.instanceId, generation: state.generation, sessionId: randomUUID(), computer: this.computer, controller: "本机用户", task: "查看手机画面", mode: "view" }));
        owned = state;
      }
      try {
        const response = await this.rpc(id, "action", { instanceId: state.instanceId, sessionId: state.sessionId, generation: state.generation, requestId: randomUUID(), action: { kind: "screenshot" } });
        return { state: response.state, result: response.result };
      } finally {
        if (owned) {
          // Only release the view session created by this click. A phone-side
          // pause, disconnect or a replacement session must remain authoritative.
          const current = this.device(id);
          if (current.companion === "ready" && current.state?.instanceId === owned.instanceId && current.state.sessionId === owned.sessionId && current.state.generation === owned.generation && current.state.phase === "viewing") {
            await this.rpc(id, "stop", { instanceId: owned.instanceId, sessionId: owned.sessionId, generation: owned.generation });
          }
        }
      }
    });
  }
  async repairAccessibility(id: string, autoRestore?: boolean): Promise<unknown> {
    this.assertNoBasic();
    await this.refresh();
    return this.exclusive(id, "正在恢复无障碍服务…", async () => {
      const check = async () => {
        const { state } = await this.rpc(id, "sync");
        if (!["idle", "stopped"].includes(state.phase)) throw new Error("请先结束当前手机任务，再恢复无障碍服务。");
      };
      await check();
      // This authenticated setup endpoint works before accessibility is ready.
      // Older companions reject it before any permission is granted.
      const status = await this.rpc(id, "accessibility-recovery", { op: "status" });
      if (!(status.result as { authorized?: boolean })?.authorized) {
        if (this.device(id).transport === "internet") throw phoneFailure("PHONE_USER_PERMISSION_REQUIRED", "手机尚未授予自动恢复所需权限，请先在手机开启无障碍；外网连接不会执行 ADB 授权。");
        await check();
        await this.adb.run(["-s", id, "shell", deviceShell(["pm", "grant", this.companion.packageName, "android.permission.WRITE_SECURE_SETTINGS"])]);
      }
      await check();
      const repaired = await this.rpc(id, "accessibility-recovery", { op: "repair", ...(autoRestore === undefined ? {} : { autoRestore }) });
      let state = repaired.state;
      for (let attempt = 0; attempt < 20 && !state.permissions.accessibility; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250));
        ({ state } = await this.rpc(id, "sync"));
        if (!["idle", "stopped"].includes(state.phase)) throw new Error("恢复期间手机会话已变化，请重新检查状态。");
      }
      // Rebinding temporarily removes our component. Report settings after the
      // wait rather than the pre-bind snapshot returned by the repair request.
      const finalStatus = await this.rpc(id, "accessibility-recovery", { op: "status" });
      return { id, ...(finalStatus.result as object), running: finalStatus.state.permissions.accessibility, phase: finalStatus.state.phase };
    });
  }
  async openSettings(id: string, setting: PhoneSetting): Promise<void> {
    this.assertNoBasic();
    if (this.device(id).transport === "internet") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "外网连接请在已授权的控制会话中操作手机设置页面。");
    const target = z.enum(["accessibility", "overlay", "notifications", "developerOptions", "usbDebugging", "wirelessDebugging"]).parse(setting);
    if (this.actions.has(id)) throw new Error("手机正在执行操作，请稍后打开设置。");
    await this.exclusive(id, "正在打开手机设置…", async () => {
      const { state } = await this.rpc(id, "sync");
      if (!["idle", "stopped"].includes(state.phase)) throw new Error("请先结束当前手机任务，再打开设置。");
      const options: Record<PhoneSetting, string[]> = {
        accessibility: ["-a", "android.settings.ACCESSIBILITY_SETTINGS", "--es", ":settings:fragment_args_key", this.companion.accessibilityService],
        overlay: ["-a", "android.settings.action.MANAGE_OVERLAY_PERMISSION", "-d", `package:${this.companion.packageName}`],
        notifications: ["-a", "android.settings.APP_NOTIFICATION_SETTINGS", "--es", "android.provider.extra.APP_PACKAGE", this.companion.packageName],
        developerOptions: ["-a", "android.settings.APPLICATION_DEVELOPMENT_SETTINGS"],
        usbDebugging: ["-a", "android.settings.APPLICATION_DEVELOPMENT_SETTINGS", "--es", ":settings:fragment_args_key", "enable_adb"],
        wirelessDebugging: ["-a", "android.settings.APPLICATION_DEVELOPMENT_SETTINGS", "--es", ":settings:fragment_args_key", "toggle_adb_wireless"]
      };
      const developerSetup = ["developerOptions", "usbDebugging", "wirelessDebugging"].includes(target) && state.readiness?.developerOptions === "disabled";
      const args = developerSetup ? ["-a", "android.settings.DEVICE_INFO_SETTINGS", "--es", ":settings:fragment_args_key", "build_number"] : options[target];
      const output = await this.adb.run(["-s", id, "shell", deviceShell(["am", "start", ...args])]);
      if (/Error:|Exception|unable to resolve Intent/i.test(output)) throw new Error("此手机无法直接打开该设置，请在手机设置中手动开启。");
    });
  }
  async startWrapper(id: string, mode: "view" | "control", controller: string, task: string, backend: "app" | "basic" = "app", recoverTransport = false): Promise<{ lease: string; device: PhoneDevice }> {
    const releaseCapture = this.reserveTaskCapture(id);
    try {
      await this.refresh();
      let device = backend === "basic" ? await this.basicStart(id, mode, controller, task, "external") : await this.start(id, mode, controller, task, "external");
      if (backend === "basic") device = { ...device, state: device.basic! };
      const lease = randomUUID();
      this.wrappers.set(lease, { id, sessionId: device.state!.sessionId!, instanceId: device.state!.instanceId, seenAt: this.now(), closing: false, backend,
        ...(recoverTransport && backend === "app" ? { recovery: new FollowRecovery<PhoneDevice>(), recoveryGeneration: device.state!.generation, recoveryMode: mode } : {}) });
      return { lease, device };
    } finally { releaseCapture(); }
  }
  private wrapper(lease: string) {
    z.string().uuid().parse(lease);
    const owner = this.wrappers.get(lease);
    if (this.closed || !owner || owner.closing || this.now() - owner.seenAt >= 8000) throw phoneFailure("PHONE_SESSION_ENDED", "ADB 托管任务已结束或失联，请重新启动任务；不会自动恢复旧操作。");
    return owner;
  }
  private awaitingFollowRecovery(id: string): boolean {
    return [...this.wrappers.values()].some(owner => owner.id === id && !owner.closing
      && this.now() - owner.seenAt < 8000 && owner.recovery?.waiting);
  }
  private async recoverFollow(lease: string, generation: number): Promise<PhoneDevice> {
    const owner = this.wrapper(lease), device = this.device(owner.id), recovery = owner.recovery;
    const check = () => {
      if (this.wrapper(lease) !== owner || !owner.visualFollow || owner.backend !== "app" || !recovery
        || generation !== owner.recoveryGeneration || device.state?.instanceId !== owner.instanceId
        || device.state.sessionId !== owner.sessionId || device.state.generation !== generation
        || device.state.mode !== owner.recoveryMode || ["paused", "stopped", "idle"].includes(device.state.phase))
        throw new Error("手机实例、会话或控制权已改变，不能恢复跟随。");
    };
    check();
    return recovery!.recover(check, async signal => {
      try {
        if (!this.routes.has(owner.id)) await this.forward(owner.id, signal);
        signal.throwIfAborted(); check();
        const { state } = await this.rpc(owner.id, "sync", {}, false, signal);
        signal.throwIfAborted(); check();
        if (state.instanceId !== owner.instanceId || state.sessionId !== owner.sessionId || state.generation !== generation
          || state.mode !== owner.recoveryMode || !["viewing", "controlling", "executing"].includes(state.phase)
          || !Object.values(state.permissions).every(Boolean) || state.readiness?.unlocked === false)
          throw new Error("手机未确认原来的有效会话，跟随已停止。");
        if (state.phase === "executing") return undefined;
        this.reconcile.delete(owner.id); device.connection = "device"; owner.seenAt = this.now();
        return structuredClone(device);
      } catch (error) {
        // A rejected/authenticated response is final. Only a failed transport
        // (which rpc removed) or a failed forward may be observed again.
        if (signal.aborted || this.routes.has(owner.id)) throw error;
        check(); return undefined;
      }
    });
  }
  pulseWrapper(lease: string): PhoneDevice {
    const owner = this.wrapper(lease), device = this.device(owner.id), state = owner.backend === "basic" ? this.basic.state(owner.id) : device.state;
    if (!state || state.instanceId !== owner.instanceId || state.sessionId !== owner.sessionId || !["viewing", "controlling", "executing", "paused"].includes(state.phase) || device.connection !== "device" || owner.backend === "app" && device.companion !== "ready") throw phoneFailure("PHONE_SESSION_ENDED", "手机会话已结束或断开，ADB 托管任务已停止。", "unknown");
    owner.seenAt = this.now();
    return structuredClone({ ...device, state });
  }
  async wrapperState(lease: string, background = false): Promise<PhoneDevice> {
    const owner = this.wrapper(lease);
    if (owner.backend === "app") await this.rpc(owner.id, "sync", {}, background);
    this.wrapper(lease);
    const device = this.device(owner.id), state = owner.backend === "basic" ? this.basic.state(owner.id) : device.state;
    if (!state || state.instanceId !== owner.instanceId || state.sessionId !== owner.sessionId) throw phoneFailure("PHONE_SESSION_STALE", "手机已切换会话，不能沿用旧 ADB 任务。");
    return structuredClone({ ...device, state });
  }
  async performWrapper(lease: string, generation: number, action: PhoneAction, requestId: string, observeAfter = false): Promise<PhoneActionResult> {
    const owner = this.wrapper(lease);
    // The caller captures generation before submitting the action. Pausing and
    // resuming while that request is in flight must invalidate it, not rebase it.
    const input = { id: owner.id, sessionId: owner.sessionId, generation, requestId, action, observeAfter };
    return owner.backend === "basic" ? this.basicPerform(input) : this.perform(input);
  }
  private claimFollowCapture(owner: { id: string; visualFollow?: boolean }): void {
    if (owner.visualFollow) return;
    owner.visualFollow = true;
    this.cancelScreenReads(owner.id);
    this.changed();
  }
  private async followLive(lease: string, generation: number, command: object): Promise<unknown> {
    const owner = this.wrapper(lease), device = this.connected(owner.id);
    if (owner.backend === "basic") {
      const state = this.pulseWrapper(lease).state!;
      if (state.generation !== generation || !["viewing", "controlling"].includes(state.phase)
        || this.operations.has(owner.id) || this.actions.has(owner.id)) throw new Error("手机已暂停或切换会话，跟随已停止");
      const coordinate = z.number().int().nonnegative().max(20000);
      const input = z.discriminatedUnion("op", [
        z.object({ op: z.literal("probe") }).strict(),
        z.object({ op: z.literal("frame") }).strict(),
        z.object({ op: z.literal("touch"), sequence: z.number().int().positive(), ttlMs: z.number().int().min(1).max(1500),
          points: z.array(z.object({ id: z.literal(0), x: coordinate, y: coordinate, fromX: coordinate, fromY: coordinate }).strict()).max(1) }).strict()
      ]).parse(command);
      if (input.op === "probe") {
        this.claimFollowCapture(owner);
        return { protocol: 1, input: "bounded-swipes", maxStrokeMs: 350 };
      }
      if (input.op === "frame") return (await this.performWrapper(lease, generation, { kind: "screenshot" }, randomUUID())).result;
      if (state.mode !== "control") throw new Error("仅查看会话不能操作手机。");
      if (input.sequence <= (owner.followSequence || 0)) throw new Error("此移动已提交过，不会重复执行。");
      owner.followSequence = input.sequence;
      const point = input.points[0];
      if (!point) return { accepted: true };
      // A finite swipe releases on-device even if the host disconnects.
      // Basic control retains its frame, bounds, mode and ownership checks.
      return (await this.performWrapper(lease, generation, { kind: "swipe",
        x: point.fromX, y: point.fromY, toX: point.x, toY: point.y, duration: Math.min(350, input.ttlMs)
      }, randomUUID())).result;
    }
    if (owner.backend !== "app" || device.companion !== "ready" || this.reconcile.has(owner.id)
      || this.operations.has(owner.id) || this.actions.has(owner.id)) throw new Error("手机连接或操作状态已改变");
    const state = device.state;
    if (!state || state.instanceId !== owner.instanceId || state.sessionId !== owner.sessionId
      || state.generation !== generation || !["viewing", "controlling", "executing"].includes(state.phase)) throw new Error("手机已暂停或切换会话，跟随已停止");
    this.claimFollowCapture(owner);
    this.actions.add(owner.id);
    try {
      const response = await this.rpc(owner.id, "follow", { ...command, instanceId: owner.instanceId, sessionId: owner.sessionId, generation });
      if (response.state.instanceId !== owner.instanceId || response.state.sessionId !== owner.sessionId
        || response.state.generation !== generation || !["viewing", "controlling"].includes(response.state.phase))
        throw new Error("手机已暂停或切换会话，跟随已停止");
      return response.result;
    } finally { this.actions.delete(owner.id); }
  }
  private async authorizeAdb(lease: string, generation: number, mode: "view" | "control", acquire: boolean) {
    const owner = this.wrapper(lease), device = await this.wrapperState(lease), state = device.state!;
    if (device.transport === "internet") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "外网控制通道不开放 ADB Shell；请使用手机动作、应用和安装命令。");
    if (state.phase === "paused") throw phoneFailure(state.pauseCause === "screen" ? "PHONE_SCREEN_LOCKED" : "PHONE_USER_IN_CONTROL", "手机已暂停，ADB 命令未执行。");
    if (this.closed || device.connection !== "device" || owner.backend === "app" && (device.companion !== "ready" || this.reconcile.has(owner.id))
        || state.generation !== generation || !["viewing", "controlling"].includes(state.phase)
        || mode === "control" && state.mode !== "control") throw phoneFailure(state.mode !== mode && mode === "control" ? "PHONE_PERMISSION_REQUIRED" : "PHONE_SESSION_STALE", "ADB 命令需要对应的当前查看/控制会话；手机已暂停、断开或会话已改变。");
    if (acquire) {
      if (this.actions.has(owner.id) || this.operations.has(owner.id)) throw phoneFailure("PHONE_TARGET_BUSY", "手机上一项操作尚未结束。");
      this.actions.add(owner.id);
    }
    return { id: owner.id, release: () => { if (acquire) this.actions.delete(owner.id); } };
  }
  async internetLaunchWrapper(lease: string, generation: number, packageName: string) {
    const owner = this.wrapper(lease), device = await this.wrapperState(lease), state = device.state!;
    if (device.transport !== "internet") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "此入口仅用于外网连接。");
    if (state.phase !== "controlling" || state.mode !== "control" || state.generation !== generation || this.actions.has(owner.id) || this.operations.has(owner.id))
      throw phoneFailure("PHONE_SESSION_STALE", "启动应用需要当前有效的控制会话。");
    this.actions.add(owner.id);
    try { return (await this.rpc(owner.id, "package-launch", { instanceId: state.instanceId, sessionId: state.sessionId, generation, packageName })).result; }
    finally { this.actions.delete(owner.id); }
  }
  async internetInstallReceipt(id: string, jobId: string) {
    if (this.connected(id).transport !== "internet") throw phoneFailure("PHONE_OPERATION_UNSUPPORTED", "此入口仅用于外网安装回执。");
    return (await this.rpc(id, "package-install-receipt", { jobId: z.string().uuid().parse(jobId) })).result;
  }
  async installWrapper(lease: string, generation: number, apk: string, sha256: string) {
    const owner = this.wrapper(lease);
    const device = await this.wrapperState(lease), expected = device.state!;
    if (expected.phase === "paused") throw phoneFailure(expected.pauseCause === "screen" ? "PHONE_SCREEN_LOCKED" : "PHONE_USER_IN_CONTROL", "手机已暂停，安装尚未提交。");
    if (expected.mode !== "control" || expected.phase !== "controlling" || expected.generation !== generation)
      throw phoneFailure(expected.mode !== "control" ? "PHONE_PERMISSION_REQUIRED" : "PHONE_SESSION_STALE", "安装需要当前控制会话；手机已暂停、结束或会话已改变。");
    if (this.reconcile.has(owner.id) || device.companion !== "ready" || device.connection !== "device") throw phoneFailure("PHONE_CONNECTION_REQUIRED", "手机连接尚未确认，不能安装。");
    if (this.actions.has(owner.id) || this.operations.has(owner.id) || this.installs.has(lease)) throw phoneFailure("PHONE_TARGET_BUSY", "此会话已有操作或安装请求；请先核对结果，不要重试。");
    z.string().regex(/^[a-f0-9]{64}$/).parse(sha256);
    if (!path.isAbsolute(apk) || path.extname(apk).toLowerCase() !== ".apk") throw phoneFailure("PHONE_INVALID_REQUEST", "请提供本地 APK 文件的绝对路径。");
    const job: InstallJob = { abort: new AbortController(), result: { status: "running", sha256, bytes: 0 } };
    this.installs.set(lease, job); this.actions.add(owner.id);
    // The management request returns promptly; the CLI polls and maintains its
    // lease. No long socket timeout can silently cause a second install.
    job.done = this.runInstall(lease, owner.id, expected, apk, job);
    return { status: "running" };
  }
  installWrapperStatus(lease: string) {
    this.wrapper(lease);
    const job = this.installs.get(lease);
    if (!job) throw new Error("此会话没有安装请求。");
    return { ...job.result };
  }
  private async runInstall(lease: string, id: string, expected: PhoneSessionState, apk: string, job: InstallJob): Promise<void> {
    const directory = path.join(this.options.root, "apk-installs");
    const staged = path.join(directory, `${randomUUID()}.apk`);
    let attempted = false, checking: Promise<void> | undefined;
    const internet = this.device(id).transport === "internet", jobId = randomUUID();
    let artifactId: string | undefined;
    const authority = { instanceId: expected.instanceId, sessionId: expected.sessionId, generation: expected.generation };
    let observedAt = -Infinity, observing: Promise<unknown> | undefined;
    const check = async () => {
      if (internet) {
        this.wrapper(lease);
        // Transfer chunks and the cancellation watchdog share one recent
        // observation. The phone independently checks the lease before every
        // chunk and before commit; no cached observation grants new authority.
        if (this.now() - observedAt >= 500) {
          if (!observing) observing = this.wrapperState(lease).then(() => { observedAt = this.now(); }).finally(() => { observing = undefined; });
          await observing;
        }
        this.wrapper(lease);
      } else await this.wrapperState(lease);
      const device = this.device(id), state = device.state;
      const outcome = attempted ? "unknown" : "not-executed";
      if (state?.phase === "paused") throw phoneFailure(state.pauseCause === "screen" ? "PHONE_SCREEN_LOCKED" : "PHONE_USER_IN_CONTROL", "手机已暂停，安装已停止。", outcome);
      if (this.closed || this.reconcile.has(id) || device.companion !== "ready" || device.connection !== "device") throw phoneFailure("PHONE_CONNECTION_REQUIRED", "手机连接已断开，安装已停止。", outcome);
      if (!state || state.instanceId !== expected.instanceId || state.sessionId !== expected.sessionId || state.generation !== expected.generation
          || state.mode !== "control" || !(internet ? ["controlling", "executing"] : ["controlling"]).includes(state.phase)) throw phoneFailure("PHONE_SESSION_STALE", "手机会话已改变，安装已停止。", outcome);
      job.abort.signal.throwIfAborted();
    };
    const timer = setInterval(() => {
      if (checking || job.abort.signal.aborted) return;
      checking = check().catch(error => { job.abort.abort(error); }).finally(() => { checking = undefined; });
    }, 300);
    try {
      await check();
      const original = await inspectApk(apk);
      if (original.sha256 !== job.result.sha256) throw phoneFailure("PHONE_INVALID_REQUEST", "APK 已改变，未提交安装。请重新确认文件。");
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.copyFile(apk, staged, fs.constants.COPYFILE_EXCL);
      const verified = await inspectApk(staged);
      if (verified.sha256 !== job.result.sha256) throw phoneFailure("PHONE_INVALID_REQUEST", "APK 已改变，未提交安装。请重新确认文件。");
      job.result.bytes = verified.bytes;
      await check();
      attempted = true;
      if (internet) {
        const artifact = this.internet.offerArtifact(id, staged, verified.bytes, verified.sha256, check);
        artifactId = artifact.artifactId;
        await this.rpc(id, "package-install", { ...authority, jobId, artifact }, false, job.abort.signal);
        // System installation UI remains controllable under this exact lease.
        this.actions.delete(id);
        const deadline = this.now() + 600000;
        while (true) {
          await check();
          const { result, state: installState } = await this.rpc(id, "package-install-status", { ...authority, jobId }, false, job.abort.signal);
          const status = z.object({ status: z.enum(["preparing", "downloading", "awaiting-permission", "installing", "awaiting-confirmation", "installed", "failed", "cancelled"]), error: z.string().optional() }).parse(result);
          job.result.phase = status.status;
          if (status.status === "awaiting-confirmation") {
            if (installState.instanceId !== expected.instanceId || installState.sessionId !== expected.sessionId
                || !(["controlling", "executing"].includes(installState.phase) || installState.phase === "paused" && installState.pauseCause === "permission"))
              throw phoneFailure("PHONE_USER_IN_CONTROL", "手机控制已交接，安装已取消。", "unknown");
            job.result.status = "awaiting-user"; job.result.jobId = jobId;
            return;
          }
          if (status.status === "installed") break;
          if (["failed", "cancelled"].includes(status.status)) throw phoneFailure("PHONE_INSTALL_FAILED", status.error || "手机安装已取消，请核对实际版本。", "unknown");
          if (this.now() >= deadline) throw phoneFailure("PHONE_EXECUTION_UNCERTAIN", "安装等待超时，请核对手机上的安装状态。", "unknown");
          await new Promise(resolve => setTimeout(resolve, 800));
        }
      } else {
        const output = await this.adb.run(["-s", id, "install", "-r", staged], 180000, undefined, job.abort.signal);
        if (!/^Success\s*$/m.test(output)) throw phoneFailure("PHONE_INSTALL_FAILED", "Android 未返回安装成功。" + output.slice(0, 400), /^Failure\s*\[/m.test(output) ? "completed" : "unknown");
      }
      await check();
      job.result.status = "installed";
    } catch (error) {
      // A committed installer may hide the capsule before the next poll. Read
      // its receipt without authorizing more input, and release the controller
      // while leaving Android's explicit human confirmation available.
      if (internet && attempted && this.routes.has(id)) {
        try {
          const { state, result } = await this.rpc(id, "package-install-receipt", { jobId });
          const receipt = result as { status?: string; sha256?: string };
          if (state.instanceId === expected.instanceId && state.sessionId === expected.sessionId
              && state.permissions.overlay === false && (state.pauseCause === "permission" || ["controlling", "executing"].includes(state.phase))
              && receipt?.status === "awaiting-confirmation" && receipt.sha256 === job.result.sha256) {
            job.result.status = "awaiting-user"; job.result.phase = "awaiting-confirmation"; job.result.jobId = jobId;
            return;
          }
        } catch { /* An unknown receipt must not become a successful handoff. */ }
      }
      job.result.status = job.abort.signal.aborted ? "interrupted" : "failed";
      const reason = job.abort.signal.aborted ? job.abort.signal.reason : error;
      job.result.error = (reason instanceof Error ? reason.message : "安装已停止。")
        + (attempted ? " 请核对手机上的安装结果，不会自动重试。" : "");
      const failure = phoneErrorResult(reason, attempted);
      job.result.code = failure.code;
      job.result.recovery = { ...failure.recovery, actionOutcome: attempted && failure.recovery.actionOutcome !== "completed" ? "unknown" : failure.recovery.actionOutcome };
    } finally {
      clearInterval(timer);
      await checking;
      if (artifactId) this.internet.revokeArtifact(artifactId);
      if (internet && attempted && !["installed", "awaiting-user"].includes(job.result.status) && this.routes.has(id))
        await this.rpc(id, "package-install-cancel", { ...authority, jobId }).catch(() => {});
      await fs.promises.rm(staged, { force: true }).catch(() => {});
      this.actions.delete(id); this.changed();
    }
  }
  async stopWrapper(lease: string): Promise<void> {
    z.string().uuid().parse(lease);
    const owner = this.wrappers.get(lease); if (!owner) return;
    owner.closing = true; // Revoke first, including when phone cleanup must retry.
    owner.recovery?.cancel();
    await this.adbJobs.release(lease);
    if (owner.backend === "basic") {
      const state = this.basic.state(owner.id);
      if (state?.sessionId === owner.sessionId && state.instanceId === owner.instanceId && !["stopped", "disconnected"].includes(state.phase)) this.basic.control(owner.id, "stop");
      this.wrappers.delete(lease); return;
    }
    this.installs.get(lease)?.abort.abort(new Error("安装会话已结束。"));
    const original = this.device(owner.id);
    const alternatives = this.liveAliases(original).filter(device => device.companion === "ready" && this.routes.has(device.id));
    const id = original.connection === "device" && this.routes.has(original.id) ? original.id
      : alternatives.length === 1 ? alternatives[0].id : original.id;
    // A changed port may be used to end this exact owned task, never to resume
    // commands or transfer its input authority to the replacement transport.
    await this.exclusive(id, "正在结束 ADB 托管任务…", async () => {
      const { state } = await this.rpc(id, "sync");
      if (state.instanceId === owner.instanceId && state.sessionId === owner.sessionId && !["idle", "stopped", "disconnected"].includes(state.phase)) {
        await this.rpc(id, "stop", { instanceId: state.instanceId, sessionId: state.sessionId, generation: state.generation });
      }
      this.wrappers.delete(lease);
      this.installs.delete(lease);
    });
  }
  async close(): Promise<void> {
    await this.iphones.close();
    await this.gameFollower.close();
    this.screenCamera.stop();
    for (const read of this.screenReads.values()) read.abort();
    for (const video of this.screenVideos.values()) video.abort();
    for (const read of this.inspections) read.abort();
    this.closed = true; clearInterval(this.timer); this.wirelessReconnectAbort.abort();
    let commandCleanupError: unknown;
    try { await this.adbJobs.close(); } catch (error) { commandCleanupError = error; }
    if (this.wirelessReconnect) await this.wirelessReconnect;
    await this.androidSetup.close();
    this.basic.close();
    this.cloud.close();
    for (const job of this.installs.values()) job.abort.abort(new Error("ProfilePilot 正在退出，安装已停止。"));
    this.closed = true; this.wrappers.clear(); this.captureStarting.clear(); this.captureSessions.clear(); clearInterval(this.timer);
    this.debugReadings.clear(); this.debugPending.clear();
    if (this.refreshing) await this.refreshing;
    await Promise.allSettled([...this.connectionPulses.values()]);
    await Promise.allSettled([...this.routes].map(async ([id, route]) => {
      try {
        const { state, result } = await this.rpc(id, "sync");
        if (state.sessionId && (result as { peerOwnsSession?: boolean })?.peerOwnsSession !== false)
          await this.rpc(id, "stop", { instanceId: state.instanceId, sessionId: state.sessionId, generation: state.generation });
      } finally { if (!route.internetConnection) await this.adb.run(["-s", id, "forward", "--remove", `tcp:${route.port}`]).catch(() => {}); }
    })); this.routes.clear();
    await this.internet.close();
    if (commandCleanupError) throw commandCleanupError;
  }
}
