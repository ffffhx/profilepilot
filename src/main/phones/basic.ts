import { randomUUID } from "node:crypto";
import type { PhoneActionInput, PhoneActionResult, PhoneSessionState } from "../../shared/phones";
import { deviceShell, type AdbRunner } from "./adb";

type Session = { state: PhoneSessionState; requests: Set<string>; pending?: AbortController; frame?: { width: number; height: number; at: number } };
const occupied = (state: PhoneSessionState) => !["stopped", "disconnected"].includes(state.phase);

/** No APK, accessibility service or persisted control authority. */
export class BasicPhoneControl {
  private sessions = new Map<string, Session>();
  constructor(private adb: AdbRunner, private computer: string, private changed: () => void, private now = Date.now) {}
  state(id: string): PhoneSessionState | undefined { const session = this.sessions.get(id); return session ? structuredClone(session.state) : undefined; }
  get active(): boolean { return [...this.sessions.values()].some(s => occupied(s.state) || !!s.pending); }
  start(id: string, mode: "view" | "control", controller: string, task: string): void {
    if (this.active) throw new Error("请先结束已有的免安装会话，再开始新会话。");
    this.sessions.set(id, { requests: new Set(), state: {
      protocol: 1, instanceId: randomUUID(), sessionId: randomUUID(), generation: 1,
      phase: mode === "view" ? "viewing" : "controlling", mode, computer: this.computer, controller, task,
      startedAt: this.now(), lastAction: "免安装会话已开始", permissions: { overlay: false, accessibility: false, notifications: false }
    } });
    this.changed();
  }
  control(id: string, command: "pause" | "resume" | "stop"): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error("没有免安装会话。");
    const state = session.state;
    if (command === "resume" && state.phase !== "paused") throw new Error("只能恢复已暂停的会话；断线后请重新开始。");
    if (command === "pause" && !["viewing", "controlling"].includes(state.phase)) throw new Error("当前会话不能暂停。");
    state.generation++;
    state.phase = command === "stop" ? "stopped" : command === "pause" ? "paused" : state.mode === "view" ? "viewing" : "controlling";
    session.frame = undefined; session.pending?.abort(); this.changed();
  }
  disconnect(id: string): void {
    const session = this.sessions.get(id);
    if (!session || !occupied(session.state)) return;
    session.state.phase = "disconnected"; session.state.generation++;
    session.frame = undefined; session.pending?.abort(); this.changed();
  }
  close(): void { for (const id of this.sessions.keys()) this.disconnect(id); }
  async perform(input: PhoneActionInput): Promise<PhoneActionResult> {
    const { id, action, sessionId, generation, requestId } = input;
    const session = this.sessions.get(id), state = session?.state;
    if (!session || !state || state.sessionId !== sessionId || state.generation !== generation) throw new Error("免安装会话已改变，请重新读取状态。");
    if (!["viewing", "controlling"].includes(state.phase)) throw new Error("免安装会话已暂停、结束或断开。");
    if (session.pending) throw new Error("上一项手机操作尚未完成。");
    if (session.requests.has(requestId)) throw new Error("此操作已提交过，不会重复执行；请先核对手机画面。");
    if (session.requests.size >= 4096) throw new Error("本次会话操作数已达上限，请结束后重新开始。");
    if (action.kind !== "screenshot" && state.mode !== "control") throw new Error("仅查看会话不能操作手机。");
    let command: string[] | undefined;
    if (action.kind === "tap" || action.kind === "swipe") {
      const frame = session.frame;
      if (!frame || this.now() - frame.at > 30000) throw new Error("请先刷新手机画面，再点击或滑动。");
      const valid = (x: number, y: number) => x >= 0 && y >= 0 && x < frame.width && y < frame.height;
      if (!valid(action.x, action.y) || action.kind === "swipe" && !valid(action.toX, action.toY)) throw new Error("操作位置超出手机画面。");
      command = action.kind === "tap" ? ["input", "tap", String(action.x), String(action.y)]
        : ["input", "swipe", String(action.x), String(action.y), String(action.toX), String(action.toY), String(action.duration || 350)];
    } else if (action.kind === "key") {
      command = ["input", "keyevent", { back: "4", home: "3", recents: "187" }[action.key]];
    } else if (action.kind === "text") {
      if (!/^[\x20-\x7e]+$/.test(action.text) || action.text.includes("%s")) throw new Error("免安装模式仅支持基础英文、数字和符号输入；中文与精确填写请使用手机 App。");
      command = ["input", "text", action.text.replaceAll(" ", "%s")];
    } else if (action.kind !== "screenshot") throw new Error("控件识别和按控件操作需要手机 App；免安装模式支持截图、坐标点击、滑动和导航键。");
    const abort = new AbortController(); session.pending = abort; session.requests.add(requestId);
    const check = () => { if (abort.signal.aborted || state.generation !== generation || state.sessionId !== sessionId) throw new Error("手机会话已改变，本次结果已丢弃；不会重放操作。"); };
    try {
      let result: unknown;
      if (action.kind === "screenshot") {
        session.frame = undefined;
        if (!this.adb.runBinary) throw new Error("当前 ADB 不支持读取手机画面。");
        const png = await this.adb.runBinary(["-s", id, "exec-out", "screencap", "-p"], 12000, abort.signal); check();
        if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.toString("ascii", 12, 16) !== "IHDR") throw new Error("手机未返回有效画面，请解锁手机或切换到允许截图的页面。");
        const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
        if (!width || !height || width > 20000 || height > 20000) throw new Error("手机画面尺寸无效。");
        session.frame = { width, height, at: this.now() };
        result = { mime: "image/png", base64: png.toString("base64"), width, height };
      } else {
        session.frame = undefined;
        const output = await this.adb.run(["-s", id, "shell", deviceShell(command!)], 8000, undefined, abort.signal); check();
        if (/Exception|Error:|Permission denied/i.test(output)) throw new Error("手机拒绝执行输入，请检查系统的 USB 调试安全设置。");
        result = { accepted: true };
      }
      state.lastAction = action.kind; return { state: structuredClone(state), result };
    } catch (error) {
      // An uncertain input is never retried and requires an explicit resume.
      if (action.kind !== "screenshot" && state.generation === generation) this.control(id, "pause");
      throw error;
    } finally { if (session.pending === abort) session.pending = undefined; this.changed(); }
  }
}
