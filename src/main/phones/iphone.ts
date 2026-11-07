import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PhoneDevice, PhoneActionInput, PhoneActionResult, PhoneSelector, PhoneSessionState } from "../../shared/phones";
import { phoneActionSchema, isPhoneRead } from "./actions";
import { inspectScreenPng } from "./screenshot";
import { iphoneAddSchema, iphoneSessionInput, requestWda, wdaSessionId, type WdaRequest } from "./iphone-wda";
import { IphoneTools, iphoneUdid } from "./iphone-tools";
import { IphoneUsb, iphoneBundleId } from "./iphone-usb";
import type { IphoneUsbStatus } from "../../shared/iphones";
import { IphoneSigning } from "./iphone-signing";

const savedSchema = iphoneAddSchema.extend({ id: z.string().uuid(), fingerprint: z.string().uuid().optional(), udid: iphoneUdid.optional(), bundleId: iphoneBundleId.optional() });
type Saved = z.infer<typeof savedSchema>;
type Frame = { width: number; height: number; pointsWidth: number; pointsHeight: number; at: number };
type Entry = { saved: Saved; device: PhoneDevice; remoteSession?: string; requests: Set<string>; pending?: AbortController; probing?: Promise<PhoneDevice>; frame?: Frame; disconnected?: boolean; stopping?: boolean };
const active = (entry: Entry) => !!entry.device.state && !["idle", "stopped", "disconnected"].includes(entry.device.state.phase);
const sizeSchema = z.object({ width: z.number().positive().max(20000), height: z.number().positive().max(20000) });
const actionSchema = z.object({ id: z.string(), sessionId: z.string().min(1), generation: z.number().int().nonnegative(), requestId: z.string().uuid(), action: phoneActionSchema }).strict();

/** Host-owned iPhone sessions. Persist endpoints only, never control authority. */
export class IphonesService {
  readonly tools: IphoneTools;
  readonly usb: IphoneUsb;
  readonly signing: IphoneSigning;
  private maintaining = new Set<string>();
  private entries = new Map<string, Entry>();
  private file: string;
  private closed = false;
  private adding = new Set<string>();
  private starting = false;
  constructor(root: string, private computer: string, private changed: () => void, private request: WdaRequest = requestWda, private now = Date.now, fetcher?: typeof fetch) {
    this.tools = new IphoneTools(root, process.platform, fetcher);
    this.signing = new IphoneSigning(this.tools);
    this.usb = new IphoneUsb(this.tools, { ready: state => this.attachUsb(state), ended: state => this.usbEnded(state), changed }, undefined, request);
    this.file = path.join(root, "iphones.json");
    const saved = fs.existsSync(this.file) ? z.array(savedSchema).max(100).parse(JSON.parse(fs.readFileSync(this.file, "utf8"))) : [];
    for (const item of saved) this.entries.set(`iphone-${item.id}`, this.create(item));
  }
  private create(saved: Saved): Entry {
    return { saved, disconnected: !!saved.udid, requests: new Set(), device: { id: `iphone-${saved.id}`, platform: "ios", name: saved.name, model: "iPhone", transport: saved.udid ? "usb" : "wifi",
      connection: "missing", companion: "unavailable", state: null, confirmedAt: null, pending: null, error: "",
      iphone: { endpoint: saved.endpoint, driver: "wda", udid: saved.udid } } };
  }
  private async attachUsb(status: IphoneUsbStatus): Promise<string> {
    if (this.closed || !status.endpoint) throw new Error("iPhone USB 连接已取消。");
    let entry = [...this.entries.values()].find(item => item.saved.udid === status.udid);
    if (entry) {
      if (active(entry) || entry.pending) throw new Error("请先结束该 iPhone 的现有会话。");
      entry.saved.endpoint = status.endpoint; entry.saved.bundleId = status.bundleId || undefined;
      entry.device.iphone!.endpoint = status.endpoint;
    } else entry = this.create({ id: randomUUID(), endpoint: status.endpoint, name: status.name, udid: status.udid, bundleId: status.bundleId || undefined });
    entry.disconnected = false;
    try { await this.probe(entry); } catch (error) { entry.disconnected = true; throw error; }
    if ([...this.entries.values()].some(item => item !== entry && item.saved.fingerprint === entry!.saved.fingerprint)) throw new Error("这台 iPhone 已通过其他地址添加，请先移除旧连接。");
    if (this.closed) throw new Error("iPhone USB 服务已关闭。");
    this.entries.set(entry.device.id, entry); this.persist(); this.changed(); return entry.device.id;
  }
  private usbEnded(status: IphoneUsbStatus): void {
    const entry = [...this.entries.values()].find(item => item.saved.udid === status.udid);
    if (!entry) return;
    entry.disconnected = true; entry.device.connection = "offline"; entry.device.companion = "unavailable"; entry.device.confirmedAt = null;
    entry.device.error = status.phase === "error" ? status.message : ""; this.invalidate(entry, "disconnected");
  }
  async stopUsb(udid: string): Promise<void> {
    const entry = [...this.entries.values()].find(item => item.saved.udid === udid);
    if (entry && active(entry)) await this.control(entry.device.id, "stop").catch(() => {});
    await this.usb.stop(udid);
  }
  startUsb(input: unknown): IphoneUsbStatus {
    if (this.maintaining.size) throw new Error("正在安装或签名 iPhone 组件，请完成后再连接。");
    return this.usb.start(input);
  }
  async maintain<T>(udid: string, operation: () => Promise<T>): Promise<T> {
    iphoneUdid.parse(udid);
    if (this.maintaining.has(udid) || [...this.entries.values()].some(active) || this.usb.status().some(job => job.udid === udid && !["error", "stopped"].includes(job.phase)))
      throw new Error("请先结束 iPhone 会话并停止该设备的 USB 连接，再安装或签名控制组件。");
    this.maintaining.add(udid);
    try { return await operation(); } finally { this.maintaining.delete(udid); }
  }
  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify([...this.entries.values()].map(entry => entry.saved), null, 2)); fs.renameSync(temporary, this.file);
  }
  devices(): PhoneDevice[] { return [...this.entries.values()].map(entry => structuredClone(entry.device)); }
  has(id: string): boolean { return this.entries.has(id); }
  private entry(id: string): Entry {
    if (this.closed) throw new Error("手机服务正在退出。");
    const entry = this.entries.get(id); if (!entry) throw new Error("找不到这台 iPhone，请重新读取设备列表。"); return entry;
  }
  async add(input: unknown): Promise<PhoneDevice> {
    const parsed = iphoneAddSchema.parse(input);
    if (this.closed) throw new Error("手机服务正在退出。");
    if (this.entries.size >= 100) throw new Error("iPhone 数量已达上限。");
    if (this.adding.has(parsed.endpoint) || [...this.entries.values()].some(entry => entry.saved.endpoint === parsed.endpoint)) throw new Error("该 iPhone 控制地址已经添加或正在连接。");
    this.adding.add(parsed.endpoint);
    const entry = this.create({ ...parsed, id: randomUUID() });
    try {
      await this.probe(entry); if (this.closed) throw new Error("手机服务正在退出。");
      if ([...this.entries.values()].some(other => other.saved.fingerprint === entry.saved.fingerprint)) throw new Error("这台 iPhone 已经添加，请使用已有设备，避免重复控制连接。");
      this.entries.set(entry.device.id, entry); this.persist(); this.changed(); return structuredClone(entry.device);
    }
    finally { this.adding.delete(parsed.endpoint); }
  }
  private invalidate(entry: Entry, phase: "paused" | "stopped" | "disconnected"): void {
    const state = entry.device.state;
    if (state && state.phase !== "stopped") { state.phase = phase; state.generation++; state.pauseCause = "manual"; }
    entry.frame = undefined; entry.pending?.abort(); this.changed();
  }
  private async probe(entry: Entry): Promise<PhoneDevice> {
    const endpoint = entry.saved.endpoint;
    const response = await this.request(entry.saved.endpoint, "/status");
    const status = z.object({ ready: z.literal(true), os: z.object({ name: z.string(), version: z.string().max(80) }), device: z.string(),
      ios: z.object({ simulatorVersion: z.string().optional() }).passthrough().optional(), build: z.object({ productBundleIdentifier: z.string() }) }).passthrough().parse(response.value);
    if (!/^(iOS|iPadOS)$/i.test(status.os.name) || status.ios?.simulatorVersion) throw new Error("请选择运行 WebDriverAgent 的 iPhone/iPad 真机。");
    const identity = z.object({ uuid: z.string().uuid(), name: z.string().max(200), model: z.string().max(100), isSimulator: z.literal(false) }).passthrough().parse((await this.request(entry.saved.endpoint, "/wda/device/info")).value);
    if (this.closed || entry.disconnected || endpoint !== entry.saved.endpoint) throw new Error("iPhone 连接已改变，请重新连接。");
    if (entry.saved.fingerprint && entry.saved.fingerprint !== identity.uuid) throw new Error("控制地址对应的 iPhone 身份已改变；请核对设备后移除旧记录并重新添加。");
    entry.saved.fingerprint = identity.uuid; entry.device.hardwareId = `ios-wda-${identity.uuid}`;
    if (entry.remoteSession && wdaSessionId(response) !== entry.remoteSession && active(entry)) {
      this.invalidate(entry, "disconnected"); entry.remoteSession = undefined;
      throw new Error("iPhone 控制组件已重启或会话已被其他控制器替换，请重新开始。");
    }
    entry.device.connection = "device"; entry.device.companion = "ready"; entry.device.confirmedAt = this.now(); entry.device.error = "";
    entry.device.iphone!.osVersion = status.os.version;
    entry.device.model = status.device.toLowerCase().includes("ipad") ? "iPad" : "iPhone";
    return structuredClone(entry.device);
  }
  async connect(id: string): Promise<PhoneDevice> {
    const entry = this.entry(id);
    if (entry.saved.udid && this.usb.status().find(item => item.udid === entry.saved.udid)?.phase !== "ready") {
      this.startUsb({ udid: entry.saved.udid, bundleId: entry.saved.bundleId, name: entry.saved.name });
      return structuredClone(entry.device);
    }
    entry.disconnected = false;
    return this.refreshEntry(entry);
  }
  private refreshEntry(entry: Entry): Promise<PhoneDevice> {
    if (entry.probing) return entry.probing;
    entry.probing = this.probe(entry).catch(error => {
      entry.device.connection = "offline"; entry.device.companion = "unavailable"; entry.device.confirmedAt = null;
      entry.device.error = `无法连接 iPhone：${(error as Error).message}`;
      if (active(entry)) this.invalidate(entry, "disconnected");
      throw error;
    }).finally(() => { entry.probing = undefined; this.changed(); });
    return entry.probing;
  }
  async refresh(): Promise<void> {
    if (this.closed) return;
    await Promise.allSettled([...this.entries.values()].filter(entry => !entry.disconnected && !entry.pending).map(entry => this.refreshEntry(entry)));
  }
  async disconnect(id: string): Promise<PhoneDevice> {
    const entry = this.entry(id); if (active(entry) || entry.pending) throw new Error("请先结束 iPhone 当前会话，再断开连接。");
    await this.cleanup(entry); entry.disconnected = true; entry.device.connection = "missing"; entry.device.companion = "unavailable"; entry.device.confirmedAt = null; this.changed();
    if (entry.saved.udid) await this.usb.stop(entry.saved.udid);
    return structuredClone(entry.device);
  }
  async forget(id: string): Promise<void> {
    const entry = this.entry(id); await this.disconnect(id); this.entries.delete(id); this.persist(); this.changed();
  }
  rename(id: string, name: string): PhoneDevice {
    const entry = this.entry(id); entry.saved.name = z.string().trim().min(1).max(80).parse(name); entry.device.name = entry.saved.name; this.persist(); this.changed(); return structuredClone(entry.device);
  }
  private async cleanup(entry: Entry): Promise<void> {
    const remote = entry.remoteSession;
    if (!remote) return;
    // Never delete a session installed by another controller after a disconnect.
    const status = await this.request(entry.saved.endpoint, "/status");
    if (wdaSessionId(status) === remote) await this.request(entry.saved.endpoint, `/session/${remote}`, "DELETE");
    entry.remoteSession = undefined;
  }
  async start(input: unknown): Promise<PhoneDevice> {
    const p = iphoneSessionInput.parse(input), entry = this.entry(p.id);
    if (this.maintaining.size) throw new Error("正在安装或签名 iPhone 组件，请完成后再开始会话。");
    if (active(entry) || entry.pending || entry.stopping || this.starting) throw new Error("iPhone 已有会话或正在交接会话，请继续该会话或等待结束。");
    this.starting = true;
    const abort = new AbortController(); entry.pending = abort; entry.device.pending = "正在开始 iPhone 会话…"; this.changed();
    try {
      if (entry.saved.udid && this.usb.status().find(item => item.udid === entry.saved.udid)?.phase !== "ready") throw new Error("请先连接该 iPhone 的 USB 控制组件。");
      entry.disconnected = false;
      await this.cleanup(entry);
      await this.probe(entry);
      const status = await this.request(entry.saved.endpoint, "/status", "GET", undefined, abort.signal);
      if (wdaSessionId(status)) throw new Error("WebDriverAgent 正被其他会话使用，请在原控制器中结束后再连接。");
      const response = await this.request(entry.saved.endpoint, "/session", "POST", { capabilities: { alwaysMatch: { shouldTerminateApp: false, shouldWaitForQuiescence: false } } }, abort.signal);
      const remote = wdaSessionId(response);
      if (!remote) throw new Error("iPhone 未返回控制会话，需先检查手机上的 WebDriverAgent。");
      entry.remoteSession = remote;
      if (this.closed || abort.signal.aborted) { await this.cleanup(entry); throw new Error("iPhone 会话启动已取消。"); }
      entry.disconnected = false; entry.requests.clear(); entry.frame = undefined;
      entry.device.state = { protocol: 1, instanceId: randomUUID(), sessionId: randomUUID(), generation: 1, phase: p.mode === "view" ? "viewing" : "controlling", mode: p.mode,
        computer: this.computer, controller: p.controller, task: p.task, startedAt: this.now(), lastAction: "iPhone 会话已开始", permissions: { overlay: false, notifications: false, accessibility: false } };
      return structuredClone(entry.device);
    } finally { this.starting = false; entry.pending = undefined; entry.device.pending = null; this.changed(); }
  }
  async control(id: string, command: "pause" | "resume" | "stop", expected?: { sessionId: string; generation: number }): Promise<PhoneDevice> {
    const entry = this.entry(id), state = entry.device.state;
    if (!state) throw new Error("没有 iPhone 控制会话。");
    if (expected && (expected.sessionId !== state.sessionId || expected.generation !== state.generation)) throw new Error("iPhone 会话已改变，请重新读取状态。");
    if (command === "resume") {
      if (state.phase !== "paused" || entry.pending) throw new Error("只能恢复已暂停且没有未完成操作的会话；断线后请重新开始。");
      await this.probe(entry);
      if (state.phase !== "paused") throw new Error("iPhone 会话已改变。");
      state.generation++; state.phase = state.mode === "view" ? "viewing" : "controlling"; entry.frame = undefined; this.changed();
    } else {
      if (command === "pause" && !["viewing", "controlling"].includes(state.phase)) throw new Error("当前 iPhone 会话不能暂停。");
      this.invalidate(entry, command === "pause" ? "paused" : "stopped");
      if (command === "stop") { entry.stopping = true; try { await this.cleanup(entry); } finally { entry.stopping = false; } }
    }
    return structuredClone(entry.device);
  }
  async perform(input: PhoneActionInput): Promise<PhoneActionResult> {
    const p = actionSchema.parse(input), entry = this.entry(p.id), state = entry.device.state;
    if (!state || state.sessionId !== p.sessionId || state.generation !== p.generation || !entry.remoteSession) throw new Error("iPhone 会话已改变，请重新读取状态。");
    if (!["viewing", "controlling"].includes(state.phase)) throw new Error("iPhone 会话已暂停、结束或断开。");
    if (entry.pending) throw new Error("上一项 iPhone 操作尚未结束。");
    if (entry.requests.has(p.requestId)) throw new Error("此操作已提交过，请核对手机画面，不会重复执行。");
    if (entry.requests.size >= 4096) throw new Error("本次会话操作数已达上限，请结束后重新开始。");
    const action = p.action, read = isPhoneRead(action.kind);
    if (!read && state.mode !== "control") throw new Error("仅查看会话不能操作 iPhone。");
    if (action.kind === "key" && action.key !== "home") throw new Error("iPhone 不提供 Android 返回/最近应用键；请使用页面控件或手势。");
    const abort = new AbortController(); entry.pending = abort; entry.requests.add(p.requestId);
    const remote = entry.remoteSession;
    const check = () => { if (this.closed || abort.signal.aborted || state.generation !== p.generation || !["viewing", "controlling"].includes(state.phase)) throw new Error("iPhone 会话已改变，本次操作不会继续或重放。"); };
    const call = async (route: string, method: "GET" | "POST" = "GET", body?: unknown) => { check(); const reply = await this.request(entry.saved.endpoint, `/session/${remote}${route}`, method, body, abort.signal); check(); return reply.value; };
    let sentInput = false;
    const write = async (route: string, body: unknown) => { check(); sentInput = true; entry.frame = undefined; return call(route, "POST", body); };
    try {
      await this.probe(entry); check();
      let result: unknown;
      if (action.kind === "screenshot") {
        entry.frame = undefined;
        const before = sizeSchema.parse(await call("/window/size"));
        const base64 = z.string().max(34 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/).parse(await call("/screenshot"));
        const info = inspectScreenPng(Buffer.from(base64, "base64"));
        if (!info.complete) throw new Error("iPhone 截图不完整，请重新观察。");
        const after = sizeSchema.parse(await call("/window/size"));
        if (before.width !== after.width || before.height !== after.height || Math.abs(info.width / info.height - after.width / after.height) > 0.03) throw new Error("iPhone 屏幕方向已变化，请重新截图。");
        entry.frame = { width: info.width, height: info.height, pointsWidth: after.width, pointsHeight: after.height, at: this.now() };
        result = { mime: "image/png", base64, width: info.width, height: info.height };
      } else if (action.kind === "snapshot") result = await call("/source?format=json");
      else if (action.kind === "tap" || action.kind === "swipe") {
        const frame = entry.frame;
        if (!frame || this.now() - frame.at > 30000) throw new Error("请先刷新 iPhone 画面，再点击或滑动。");
        const current = sizeSchema.parse(await call("/window/size"));
        if (current.width !== frame.pointsWidth || current.height !== frame.pointsHeight) { entry.frame = undefined; throw new Error("iPhone 屏幕方向已变化，请重新截图。"); }
        const point = (x: number, y: number) => { if (x >= frame.width || y >= frame.height) throw new Error("操作位置超出 iPhone 画面。"); return { x: x * frame.pointsWidth / frame.width, y: y * frame.pointsHeight / frame.height }; };
        const from = point(action.x, action.y);
        if (action.kind === "tap") await write("/wda/tap", from);
        else { const to = point(action.toX, action.toY); await write("/wda/dragfromtoforduration", { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, duration: (action.duration || 350) / 1000 }); }
        result = { accepted: true };
      } else if (action.kind === "key") { await write("/wda/pressButton", { name: "home" }); result = { accepted: true }; }
      else if (action.kind === "text") { await write("/wda/keys", { value: Array.from(action.text) }); result = { accepted: true }; }
      else {
        const elements = z.array(z.record(z.string(), z.unknown())).max(1000).parse(await call("/elements", "POST", { using: "predicate string", value: iphonePredicate(action.selector) }));
        if (action.kind === "find") result = { count: elements.length, matches: elements };
        else {
          if (elements.length !== 1) throw new Error(`iPhone 控件匹配 ${elements.length} 项，操作需要唯一匹配。`);
          const element = elements[0]["element-6066-11e4-a52e-4f735466cecf"] || elements[0].ELEMENT;
          if (typeof element !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(element)) throw new Error("iPhone 控件标识无效。");
          if (action.kind === "click") await write(`/element/${element}/click`, {});
          else if (action.kind === "fill") { await write(`/element/${element}/clear`, {}); if (action.text) await write(`/element/${element}/value`, { value: Array.from(action.text) }); }
          else await write(`/wda/element/${element}/scroll`, { direction: action.direction === "forward" ? "down" : "up" });
          result = { accepted: true };
        }
      }
      state.lastAction = action.kind; return { state: structuredClone(state), result };
    } catch (error) {
      if (sentInput && state.generation === p.generation) this.invalidate(entry, "paused");
      throw error;
    } finally { if (entry.pending === abort) entry.pending = undefined; this.changed(); }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values()) this.invalidate(entry, "disconnected");
    await Promise.allSettled([...this.entries.values()].map(entry => this.cleanup(entry)));
    await this.usb.close();
  }
}

export function iphonePredicate(selector: PhoneSelector): string {
  for (const key of ["packageName", "checked", "editable", "clickable", "scrollable"] as const)
    if (selector[key] !== undefined) throw new Error(`iPhone 不支持 ${key} 定位条件；请使用 resourceId、text、description、className 或 enabled。`);
  const clauses = ["visible == true"];
  for (const [key, attribute] of [["resourceId", "name"], ["description", "name"], ["text", "label"], ["className", "type"]] as const)
    if (selector[key] !== undefined) clauses.push(`${attribute} == ${JSON.stringify(selector[key])}`);
  if (selector.enabled !== undefined) clauses.push(`enabled == ${selector.enabled}`);
  if (clauses.length === 1) throw new Error("iPhone 定位条件不能为空。");
  return clauses.join(" AND ");
}
