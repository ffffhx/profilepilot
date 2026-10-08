import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { PHONE_PROTOCOL, type PhoneDevice, type PhonesSnapshot, type PhoneSessionState, type PhoneAction, type PhoneActionInput, type PhoneActionResult } from "../../shared/phones";
import { groupPhoneDevices } from "../../shared/phone-devices";
import type { PhoneSetting } from "../../shared/phones";
import { Adb, COMPANION_PACKAGE, COMPANION_PORT, parseAdbDevices, deviceShell, phoneRequest, validateDeviceId, type AdbRunner } from "./adb";
import { phoneActionSchema, isPhoneRead } from "./actions";
import { discoverWireless, pairWireless, connectWireless, wirelessCandidates, probeWireless } from "./wireless";
import { readDebugSettings, type DebugSettings } from "./readiness";
import { AndroidEmulators, type EmulatorRuntime } from "./emulators";
import { PhoneCloud } from "./cloud";
import { readinessSchema } from "./readiness-schema";
import { inspectApk } from "./apk";
export { phoneActionSchema } from "./actions";

const sessionSchema = z.object({
  statusDeviceId: z.string().uuid().optional(),
  protocol: z.literal(PHONE_PROTOCOL), instanceId: z.string().min(1).max(100), sessionId: z.string().nullable(), generation: z.number().int().nonnegative(),
  phase: z.enum(["idle", "viewing", "controlling", "executing", "paused", "stopped", "disconnected"]), mode: z.enum(["view", "control"]),
  computer: z.string().max(120), controller: z.string().max(120), task: z.string().max(500), startedAt: z.number().nullable(), lastAction: z.string().max(300),
  permissions: z.object({ overlay: z.boolean(), notifications: z.boolean(), accessibility: z.boolean() }),
  readiness: readinessSchema.optional()
});
type SavedPhone = { statusDeviceId?: string; token: string; name?: string; installedHash?: string; hardwareId?: string; model?: string; transport?: PhoneDevice["transport"] };
type Route = { port: number; token: string };
type InstallJob = { abort: AbortController; done?: Promise<void>; result: { status: "running" | "installed" | "failed" | "interrupted"; sha256: string; bytes: number; error?: string } };
export interface PhonesOptions {
  root: string;
  apkPath: string;
  adb?: AdbRunner;
  emulators?: EmulatorRuntime;
  request?: typeof phoneRequest;
  now?: () => number;
  computer?: string;
  probeWireless?: typeof probeWireless;
  onChanged?: (snapshot: PhonesSnapshot) => void;
}
export class PhonesService {
  private devices = new Map<string, PhoneDevice>();
  private routes = new Map<string, Route>();
  private debugReadings = new Map<string, { route: Route; at: number; value: DebugSettings }>();
  private debugPending = new Map<string, Route>();
  private saved: Record<string, SavedPhone>;
  private adb: AdbRunner;
  private request: typeof phoneRequest;
  private timer?: NodeJS.Timeout;
  private refreshing?: Promise<PhonesSnapshot>;
  private operations = new Set<string>();
  private actions = new Set<string>();
  private sequence = 0;
  private observations = new Map<string, { instanceId: string; sequence: number; generation: number }>();
  private reconcile = new Set<string>();
  private pairing = new Set<string>();
  private wrappers = new Map<string, { id: string; sessionId: string; instanceId: string; seenAt: number; closing: boolean }>();
  private installs = new Map<string, InstallJob>();
  private closed = false;
  private wirelessBusy = false;
  private emulatorBusy = false;
  private emulators: EmulatorRuntime;
  private adbAvailable = false;
  private error = "";
  private cloud: PhoneCloud;
  readonly computer: string;
  constructor(private options: PhonesOptions) {
    this.adb = options.adb || new Adb(); this.request = options.request || phoneRequest; this.computer = (options.computer || os.hostname()).slice(0, 120);
    this.emulators = options.emulators || new AndroidEmulators();
    fs.mkdirSync(options.root, { recursive: true });
    this.cloud = new PhoneCloud(options.root, () => this.changed());
    const file = path.join(options.root, "devices.json");
    this.saved = fs.existsSync(file) ? z.record(z.string(), z.object({ statusDeviceId: z.string().uuid().optional(), token: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().max(80).optional(), installedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), hardwareId: z.string().max(200).optional(), model: z.string().max(200).optional(), transport: z.enum(["usb", "wifi", "emulator"]).optional() })).parse(JSON.parse(fs.readFileSync(file, "utf8"))) : {};
    // Remember paired devices across app restarts, but never persist permissions,
    // screenshots or session authority as though they were current observations.
    for (const [id, saved] of Object.entries(this.saved)) {
      try { validateDeviceId(id); } catch { continue; }
      this.devices.set(id, { id, name: saved.name || saved.model || "Android 手机", model: saved.model || "Android 手机", transport: saved.transport || (id.startsWith("emulator-") ? "emulator" : /:|_adb-tls/.test(id) ? "wifi" : "usb"), connection: "missing", companion: "unavailable", state: null, confirmedAt: null, pending: null, error: "" });
      this.reconcile.add(id);
    }
  }
  startPolling(): void { this.cloud.start(); if (!this.timer) { this.timer = setInterval(() => void this.refresh(), 2000); this.timer.unref(); void this.refresh(); } }
  snapshot(): PhonesSnapshot {
    const cloud = this.cloud.devices();
    const identityByHardware = new Map(Object.values(this.saved).filter(s => s.hardwareId && s.statusDeviceId).map(s => [s.hardwareId, s.statusDeviceId]));
    const matched = new Set<string>();
    const devices: PhoneDevice[] = [...this.devices.values()].map(device => {
      const saved = this.saved[device.id];
      const identity = device.state?.statusDeviceId || saved?.statusDeviceId || identityByHardware.get(saved?.hardwareId);
      if (identity) matched.add(identity);
      return structuredClone({ ...device, hardwareId: saved?.hardwareId, cloud: identity ? cloud.find(c => c.cloud?.report?.deviceId === identity)?.cloud : undefined });
    });
    devices.push(...cloud.filter(c => !c.cloud?.report || !matched.has(c.cloud.report.deviceId)));
    return { devices, adbAvailable: this.adbAvailable, error: this.error, computer: this.computer };
  }
  cloudPair(url?: string) { return this.cloud.pair(url); }
  cloudForget(id: string) { return this.cloud.forget(id); }
  private changed(): void { this.options.onChanged?.(this.snapshot()); }
  listEmulators(): Promise<string[]> { return this.emulators.list(); }
  async connectEmulator(name: string): Promise<PhoneDevice> {
    if (this.emulatorBusy) throw new Error("正在启动模拟器，请稍候。");
    this.emulatorBusy = true;
    try {
      if (!(await this.emulators.list()).includes(name)) throw new Error("模拟器不存在，请重新选择虚拟设备。");
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
      const deadline = Date.now() + 90000;
      while (!found || found.connection !== "device") {
        if (this.closed) throw new Error("ProfilePilot 正在关闭，已停止等待模拟器连接。");
        if (Date.now() >= deadline) throw new Error("模拟器尚未连接。请检查模拟器窗口中的启动提示，启动完成后重新连接。");
        await new Promise(resolve => setTimeout(resolve, 1000));
        found = await find();
      }
      await this.refresh();
      return this.connected(found.id);
    } finally { this.emulatorBusy = false; }
  }
  private persist(): void {
    const file = path.join(this.options.root, "devices.json"), tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.saved, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file);
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private device(id: string): PhoneDevice { validateDeviceId(id); const device = this.devices.get(id); if (!device) throw new Error("手机不存在，请刷新设备列表。"); return device; }
  private connected(id: string): PhoneDevice { const device = this.device(id); if (device.connection !== "device") throw new Error(device.transport === "emulator" ? "模拟器未连接，请先启动模拟器并确认调试连接。" : "手机未连接或尚未授权 USB 调试。"); return device; }
  refresh(): Promise<PhonesSnapshot> {
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
      for (const device of this.devices.values()) if (!ids.has(device.id)) await this.disconnected(device, "手机连接已断开。", "missing");
      for (const next of found) {
        const previous = this.devices.get(next.id);
        const device = previous || next;
        Object.assign(device, { model: next.model, transport: next.transport, connection: next.connection, name: this.saved[next.id]?.name || next.model });
        this.devices.set(device.id, device);
        const saved = this.saved[device.id];
        if (saved && (saved.model !== next.model || saved.transport !== next.transport)) { saved.model = next.model.slice(0, 200); saved.transport = next.transport; metadataChanged = true; }
        if (device.connection !== "device") { await this.disconnected(device, device.connection === "unauthorized" ? device.transport === "emulator" ? "请在模拟器窗口中确认此电脑的调试连接。" : "请在手机上允许此电脑进行 USB 调试。" : "ADB 连接离线。", device.connection); continue; }
        if (this.operations.has(device.id)) continue;
        try {
          if (!this.routes.has(device.id) && this.saved[device.id]) await this.forward(device.id);
          if (this.routes.has(device.id)) {
            const { state } = await this.rpc(device.id, "sync");
            // A new desktop process or a recovered link must not silently
            // inherit an old controller's authority, even within the phone TTL.
            if ((!previous || this.reconcile.has(device.id)) && ["viewing", "controlling", "executing"].includes(state.phase)) {
              await this.rpc(device.id, "pause", { instanceId: state.instanceId, sessionId: state.sessionId, generation: state.generation });
            }
            this.reconcile.delete(device.id);
          }
        } catch (error) {
          if ((error as { code?: string }).code === "PAIRING_REQUIRED") { this.pairing.add(device.id); device.companion = "pairing"; device.error = (error as Error).message; }
          else await this.disconnected(device, (error as Error).message);
        }
      }
      if (metadataChanged) this.persist();
    } catch (error) {
      this.adbAvailable = false; this.error = (error as Error).message;
      for (const device of this.devices.values()) await this.disconnected(device, this.error, "offline");
    }
    this.changed(); return this.snapshot();
  }
  private async disconnected(device: PhoneDevice, error: string, connection = device.connection): Promise<void> {
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
      await this.adb.run(["-s", device.id, "forward", "--remove", `tcp:${route.port}`]).catch(() => {});
    }
  }
  private async forward(id: string): Promise<void> {
    const token = this.saved[id]?.token; if (!token) throw new Error("请先连接手机配套 App。");
    const port = Number(await this.adb.run(["-s", id, "forward", "tcp:0", `tcp:${COMPANION_PORT}`]));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("ADB 未返回有效的手机连接端口。");
    this.routes.set(id, { port, token });
  }
  private async rpc(id: string, method: string, body: unknown = {}): Promise<{ state: PhoneSessionState; result?: unknown }> {
    const route = this.routes.get(id); if (!route) throw new Error("请先连接手机配套 App。");
    const sequence = ++this.sequence;
    const device = this.device(id);
    const reading = this.debugReadings.get(id);
    const ageMs = reading ? Math.max(0, this.now() - reading.at) : Infinity;
    const syncBody = { transport: device.transport, ...(reading?.route === route && ageMs < 6000 ? { debugSettings: { ...reading.value, ageMs } } : {}) };
    let raw: unknown;
    try { raw = await this.request(route.port, route.token, method, method === "sync" ? syncBody : body); }
    catch (error) {
      if (this.routes.get(id) === route) await this.disconnected(device, (error as Error).message);
      throw error;
    }
    if (this.routes.get(id) !== route) throw new Error("手机连接已改变，请重新读取状态；不要重放输入。");
    const response = z.object({ ok: z.boolean(), code: z.string().optional(), error: z.string().optional(), state: sessionSchema.optional(), result: z.unknown().optional() }).parse(raw);
    if (response.state) {
      // Polls may complete after a newer action. Within a service instance the
      // phone generation is monotonic; an older result cannot restore control.
      const previous = this.observations.get(id);
      const incoming = response.state;
      const accept = !previous || (previous.instanceId !== incoming.instanceId ? sequence >= previous.sequence : incoming.generation > previous.generation || incoming.generation === previous.generation && sequence >= previous.sequence);
      if (accept) {
        this.observations.set(id, { instanceId: incoming.instanceId, sequence, generation: incoming.generation });
        device.state = response.state; device.confirmedAt = this.now(); device.companion = "ready"; device.error = "";
        const saved = this.saved[id];
        if (saved && incoming.statusDeviceId && saved.statusDeviceId !== incoming.statusDeviceId) {
          saved.statusDeviceId = incoming.statusDeviceId; this.persist();
        }
        this.pairing.delete(id);
      }
    }
    if (!response.ok) {
      if (response.code === "PAIRING_REQUIRED") device.companion = "pairing";
      throw Object.assign(new Error(response.error || "手机拒绝了操作。"), { code: response.code });
    }
    if (!response.state) throw new Error("手机未返回控制状态。");
    if (method === "sync") this.refreshDebugSettings(id, route);
    return { state: response.state, result: response.result };
  }
  private refreshDebugSettings(id: string, route: Route): void {
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
    if (this.closed) throw new Error("手机服务正在退出。");
    if (this.operations.has(id)) throw new Error("此手机正在处理另一项操作。");
    const device = this.connected(id); this.operations.add(id); device.pending = label; this.changed();
    try { return await work(); }
    catch (error) { device.error = (error as Error).message; throw error; }
    finally { this.operations.delete(id); device.pending = null; this.changed(); }
  }
  private wirelessGroup(id: string) {
    const group = groupPhoneDevices(this.snapshot().devices).find(item => item.routes.some(route => route.id === id));
    if (!group) throw new Error("手机不存在，请刷新设备列表。");
    return group;
  }
  async discoverWireless(id?: string) {
    if (id) await this.cloud.refresh();
    const discovered = await discoverWireless(this.adb);
    const candidates = id ? wirelessCandidates(discovered.services, this.wirelessGroup(id).routes, this.now())
      : { services: discovered.services.slice(0, 16), phoneIps: [] as string[] };
    const services = await Promise.all(candidates.services.map(async item => ({ ...item, ...await (this.options.probeWireless || probeWireless)(item.address) })));
    return { ...candidates, services, error: discovered.error };
  }
  autoConnectWireless(id: string): Promise<PhoneDevice> {
    return this.wirelessOperation(async () => {
      const attempted = new Set<string>();
      let failure = "尚未发现这台手机当前的连接端口。请保持手机状态同步和无线调试开启；首次使用需先配对。";
      for (let round = 0; round < 2; round++) {
        const group = this.wirelessGroup(id);
        if (group.routes.some(device => device.state && ["viewing", "controlling", "executing", "paused"].includes(device.state.phase)))
          throw new Error("手机有进行中或暂停的会话，请先处理原会话；自动连接不会恢复或接管它。");
        const live = group.routes.find(device => device.transport === "wifi" && device.connection === "device" && device.companion === "ready");
        if (live) return structuredClone(live);
        const expected = group.routes.map(device => device.hardwareId || (device.transport === "usb" ? device.id : "")).filter(Boolean);
        if (!expected.length) throw new Error("这台手机尚未在此电脑确认设备身份，请先完成首次配对或手动连接。手机上报的地址可在手动连接中自动填入。");
        const result = await this.discoverWireless(id);
        for (const candidate of result.services.filter(item => item.kind === "connect")) {
          if (!candidate.reachable) { failure = candidate.reason || failure; continue; }
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
          } catch (error) { failure = (error as Error).message; }
        }
        if (round === 0) await new Promise(resolve => setTimeout(resolve, 700));
      }
      throw new Error(failure);
    });
  }
  private async wirelessOperation<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed || this.wirelessBusy) throw new Error("正在处理无线连接，请稍后重试。");
    this.wirelessBusy = true;
    try { return await work(); } finally { this.wirelessBusy = false; }
  }
  pairWireless(input: unknown) { return this.wirelessOperation(() => pairWireless(this.adb, input)); }
  connectWireless(input: unknown): Promise<PhoneDevice> {
    return this.wirelessOperation(() => this.connectWirelessAddress(input));
  }
  private async connectWirelessAddress(input: unknown): Promise<PhoneDevice> {
      const address = await connectWireless(this.adb, input);
      let discoveredIds: string[] = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.refresh();
        const device = this.devices.get(address);
        if (device?.connection === "device") return structuredClone(device);
        if (attempt === 0) discoveredIds = (await discoverWireless(this.adb)).services
          .filter(item => item.kind === "connect" && item.address === address)
          .map(item => `${item.name}._adb-tls-connect._tcp`);
        const aliases = [...this.devices.values()].filter(item => item.connection === "device"
          && discoveredIds.some(name => item.id === name || item.id === name + "."));
        if (aliases.length === 1) return structuredClone(aliases[0]);
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw new Error("无线连接已提交，但设备尚未就绪。请保持手机解锁，核对无线调试主页面的地址后重新连接。");
  }
  async prepare(id: string): Promise<PhoneDevice> {
    await this.exclusive(id, "正在连接手机…", async () => {
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
        let state: PhoneSessionState | undefined;
        try { state = (await this.rpc(id, "sync")).state; } catch { /* recover a disconnected companion */ }
        if (state && ["viewing", "controlling", "executing", "paused"].includes(state.phase)) throw new Error("请先结束手机会话，再打开或更新配套 App。");
      }
      if (!fs.existsSync(this.options.apkPath)) throw new Error("缺少手机配套安装包，请先运行 npm run build:phone。");
      const apk = fs.readFileSync(this.options.apkPath);
      const installedHash = createHash("sha256").update(apk).digest("hex");
      const installed = await this.adb.run(["-s", id, "shell", deviceShell(["pm", "path", COMPANION_PACKAGE])]).catch(() => "");
      if (!installed.startsWith("package:") || this.saved[id]?.installedHash !== installedHash) {
        // ADB cannot read Electron's virtual app.asar path on either OS.
        // Materialize the exact bundled bytes in the app's private data folder.
        const installPath = path.join(this.options.root, "profilepilot-phone.apk");
        fs.writeFileSync(installPath, apk);
        await this.adb.run(["-s", id, "install", "-r", installPath], 120000);
      }
      this.saved[id] = { ...this.saved[id], token: this.saved[id]?.token || randomBytes(32).toString("hex"), installedHash, model: this.device(id).model.slice(0, 200), transport: this.device(id).transport,
        ...(/^[a-zA-Z0-9_-]{1,200}$/.test(hardwareId) && !["unknown", "null"].includes(hardwareId) ? { hardwareId } : {}) }; this.persist();
      this.pairing.add(id);
      await this.adb.run(["-s", id, "shell", deviceShell(["am", "start", "-f", "0x24000000", "-n", `${COMPANION_PACKAGE}/.MainActivity`, "--es", "token", this.saved[id].token, "--es", "computer", this.computer])]);
      if (!this.routes.has(id)) await this.forward(id);
      this.device(id).companion = "pairing";
      try { await this.rpc(id, "sync"); } catch { /* phone must approve first */ }
    });
    return structuredClone(this.device(id));
  }
  async rename(id: string, name: string): Promise<void> {
    this.device(id); const next = z.string().trim().min(1).max(80).parse(name);
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
  async start(id: string, mode: "view" | "control", controller: string, task: string): Promise<PhoneDevice> {
    const input = z.object({ mode: z.enum(["view", "control"]), controller: z.string().trim().min(1).max(120), task: z.string().trim().max(500) }).parse({ mode, controller, task });
    await this.exclusive(id, "等待手机确认会话…", async () => {
      const { state } = await this.rpc(id, "sync");
      if (["viewing", "controlling", "executing", "paused"].includes(state.phase)) throw new Error("手机已有会话，请继续该会话或先结束。");
      await this.rpc(id, "start", { ...input, instanceId: state.instanceId, generation: state.generation, sessionId: randomUUID(), computer: this.computer });
    }); return structuredClone(this.device(id));
  }
  async control(id: string, command: "pause" | "resume" | "stop"): Promise<PhoneDevice> {
    z.enum(["pause", "resume", "stop"]).parse(command);
    await this.exclusive(id, command === "stop" ? "正在结束控制…" : command === "pause" ? "正在暂停…" : "正在恢复…", async () => {
      const { state } = await this.rpc(id, "sync");
      await this.rpc(id, command, { instanceId: state.instanceId, sessionId: state.sessionId, generation: state.generation });
    }); return structuredClone(this.device(id));
  }
  async perform(input: PhoneActionInput): Promise<PhoneActionResult> {
    const { id, sessionId, generation, requestId, action } = z.object({ id: z.string(), sessionId: z.string().min(1).max(100), generation: z.number().int().nonnegative(), requestId: z.string().uuid(), action: phoneActionSchema }).strict().parse(input);
    const device = this.connected(id);
    if (device.companion !== "ready" || this.reconcile.has(id)) throw new Error("手机连接需要重新确认，请等待状态同步后由用户恢复会话。");
    if (this.closed || this.operations.has(id) || this.actions.has(id)) throw new Error("手机正在处理操作或交接控制权。");
    this.actions.add(id);
    try {
      const { state } = await this.rpc(id, "sync");
      if (state.sessionId !== sessionId || state.generation !== generation) throw new Error("手机会话已改变，请重新读取状态；不要重放输入。");
      if (!["viewing", "controlling"].includes(state.phase)) throw new Error("手机已暂停、结束或断开，不能继续操作。");
      if (state.mode === "view" && !isPhoneRead(action.kind)) throw new Error("当前为仅查看会话，不能操作手机。");
      const response = await this.rpc(id, "action", { instanceId: state.instanceId, sessionId, generation, requestId, action });
      return { state: response.state, result: response.result };
    } catch (error) { this.device(id).error = (error as Error).message; throw error; }
    finally { this.actions.delete(id); this.changed(); }
  }
  async preview(id: string): Promise<PhoneActionResult> {
    const device = this.connected(id);
    if (device.companion !== "ready" || this.reconcile.has(id)) throw new Error("请先连接手机 App，并确认会话状态。");
    if (this.actions.has(id)) throw new Error("手机正在执行操作，请稍后刷新画面。");
    return this.exclusive(id, "正在获取手机画面…", async () => {
      let { state } = await this.rpc(id, "sync");
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
  async openSettings(id: string, setting: PhoneSetting): Promise<void> {
    const target = z.enum(["accessibility", "overlay", "notifications", "developerOptions", "usbDebugging", "wirelessDebugging"]).parse(setting);
    if (this.actions.has(id)) throw new Error("手机正在执行操作，请稍后打开设置。");
    await this.exclusive(id, "正在打开手机设置…", async () => {
      const { state } = await this.rpc(id, "sync");
      if (!["idle", "stopped"].includes(state.phase)) throw new Error("请先结束当前手机任务，再打开设置。");
      const options: Record<PhoneSetting, string[]> = {
        accessibility: ["-a", "android.settings.ACCESSIBILITY_SETTINGS", "--es", ":settings:fragment_args_key", `${COMPANION_PACKAGE}/.PhoneAccessibility`],
        overlay: ["-a", "android.settings.action.MANAGE_OVERLAY_PERMISSION", "-d", `package:${COMPANION_PACKAGE}`],
        notifications: ["-a", "android.settings.APP_NOTIFICATION_SETTINGS", "--es", "android.provider.extra.APP_PACKAGE", COMPANION_PACKAGE],
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
  async startWrapper(id: string, mode: "view" | "control", controller: string, task: string): Promise<{ lease: string; device: PhoneDevice }> {
    await this.refresh();
    const device = await this.start(id, mode, controller, task);
    const lease = randomUUID();
    this.wrappers.set(lease, { id, sessionId: device.state!.sessionId!, instanceId: device.state!.instanceId, seenAt: this.now(), closing: false });
    return { lease, device };
  }
  private wrapper(lease: string) {
    z.string().uuid().parse(lease);
    const owner = this.wrappers.get(lease);
    if (this.closed || !owner || owner.closing || this.now() - owner.seenAt >= 8000) throw new Error("ADB 托管任务已结束或失联，请重新启动任务；不会自动恢复旧操作。");
    return owner;
  }
  pulseWrapper(lease: string): PhoneDevice {
    const owner = this.wrapper(lease), device = this.device(owner.id), state = device.state;
    if (!state || state.instanceId !== owner.instanceId || state.sessionId !== owner.sessionId || !["viewing", "controlling", "executing", "paused"].includes(state.phase) || device.companion !== "ready") throw new Error("手机会话已结束或断开，ADB 托管任务已停止。");
    owner.seenAt = this.now();
    return structuredClone(device);
  }
  async wrapperState(lease: string): Promise<PhoneDevice> {
    const owner = this.wrapper(lease);
    await this.rpc(owner.id, "sync");
    this.wrapper(lease);
    const device = this.device(owner.id), state = device.state;
    if (!state || state.instanceId !== owner.instanceId || state.sessionId !== owner.sessionId) throw new Error("手机已切换会话，不能沿用旧 ADB 任务。");
    return structuredClone(device);
  }
  async performWrapper(lease: string, generation: number, action: PhoneAction, requestId: string): Promise<PhoneActionResult> {
    const owner = this.wrapper(lease);
    // The caller captures generation before submitting the action. Pausing and
    // resuming while that request is in flight must invalidate it, not rebase it.
    return this.perform({ id: owner.id, sessionId: owner.sessionId, generation, requestId, action });
  }
  async installWrapper(lease: string, generation: number, apk: string, sha256: string) {
    const owner = this.wrapper(lease);
    const device = await this.wrapperState(lease), expected = device.state!;
    if (expected.mode !== "control" || expected.phase !== "controlling" || expected.generation !== generation)
      throw new Error("安装需要当前控制会话；手机已暂停、结束或会话已改变。");
    if (this.reconcile.has(owner.id) || device.companion !== "ready" || device.connection !== "device") throw new Error("手机连接尚未确认，不能安装。");
    if (this.actions.has(owner.id) || this.operations.has(owner.id) || this.installs.has(lease)) throw new Error("此会话已有操作或安装请求；请先核对结果，不要重试。");
    z.string().regex(/^[a-f0-9]{64}$/).parse(sha256);
    if (!path.isAbsolute(apk) || path.extname(apk).toLowerCase() !== ".apk") throw new Error("请提供本地 APK 文件的绝对路径。");
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
    const check = async () => {
      const device = await this.wrapperState(lease), state = device.state;
      if (this.closed || this.reconcile.has(id) || device.companion !== "ready" || device.connection !== "device" || !state
          || state.instanceId !== expected.instanceId || state.sessionId !== expected.sessionId || state.generation !== expected.generation
          || state.mode !== "control" || state.phase !== "controlling") throw new Error("手机已暂停、断开或会话已改变，安装已停止。");
      job.abort.signal.throwIfAborted();
    };
    const timer = setInterval(() => {
      if (checking || job.abort.signal.aborted) return;
      checking = check().catch(error => { job.abort.abort(error); }).finally(() => { checking = undefined; });
    }, 300);
    try {
      await check();
      const original = await inspectApk(apk);
      if (original.sha256 !== job.result.sha256) throw new Error("APK 已改变，未提交安装。请重新确认文件。");
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.copyFile(apk, staged, fs.constants.COPYFILE_EXCL);
      const verified = await inspectApk(staged);
      if (verified.sha256 !== job.result.sha256) throw new Error("APK 已改变，未提交安装。请重新确认文件。");
      job.result.bytes = verified.bytes;
      await check();
      attempted = true;
      const output = await this.adb.run(["-s", id, "install", "-r", staged], 180000, undefined, job.abort.signal);
      if (!/^Success\s*$/m.test(output)) throw new Error("Android 未返回安装成功。" + output.slice(0, 400));
      await check();
      job.result.status = "installed";
    } catch (error) {
      job.result.status = job.abort.signal.aborted ? "interrupted" : "failed";
      const reason = job.abort.signal.aborted ? job.abort.signal.reason : error;
      job.result.error = (reason instanceof Error ? reason.message : "安装已停止。")
        + (attempted ? " 请核对手机上的安装结果，不会自动重试。" : "");
    } finally {
      clearInterval(timer);
      await checking;
      await fs.promises.rm(staged, { force: true }).catch(() => {});
      this.actions.delete(id); this.changed();
    }
  }
  async stopWrapper(lease: string): Promise<void> {
    z.string().uuid().parse(lease);
    const owner = this.wrappers.get(lease); if (!owner) return;
    owner.closing = true; // Revoke first, including when phone cleanup must retry.
    this.installs.get(lease)?.abort.abort(new Error("安装会话已结束。"));
    await this.exclusive(owner.id, "正在结束 ADB 托管任务…", async () => {
      const { state } = await this.rpc(owner.id, "sync");
      if (state.instanceId === owner.instanceId && state.sessionId === owner.sessionId && !["idle", "stopped", "disconnected"].includes(state.phase)) {
        await this.rpc(owner.id, "stop", { instanceId: state.instanceId, sessionId: state.sessionId, generation: state.generation });
      }
      this.wrappers.delete(lease);
      this.installs.delete(lease);
    });
  }
  async close(): Promise<void> {
    this.cloud.close();
    for (const job of this.installs.values()) job.abort.abort(new Error("ProfilePilot 正在退出，安装已停止。"));
    this.closed = true; this.wrappers.clear(); clearInterval(this.timer);
    this.debugReadings.clear(); this.debugPending.clear();
    if (this.refreshing) await this.refreshing;
    await Promise.allSettled([...this.routes].map(async ([id, route]) => {
      try {
        const { state } = await this.rpc(id, "sync");
        if (state.sessionId) await this.rpc(id, "stop", { instanceId: state.instanceId, sessionId: state.sessionId, generation: state.generation });
      } finally { await this.adb.run(["-s", id, "forward", "--remove", `tcp:${route.port}`]).catch(() => {}); }
    })); this.routes.clear();
  }
}
