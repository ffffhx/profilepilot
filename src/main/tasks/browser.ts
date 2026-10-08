import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { BrowserAction, BrowserObservation, BrowserTask, Effect } from "../../shared/tasks";
import { requestBrowserGateway } from "../browser-gateway-client";
import { FastBrowser, domControlEffect, pageViewport, type DomCandidate, type PageReadOptions } from "./fast-browser";
import { bundledBrowserExecutable } from "./browser-runtime";

export const browserActionSchema = z.object({
  kind: z.enum(["open", "click", "hover", "fill", "select", "check", "uncheck", "press", "scroll", "upload", "download", "back", "switch_tab", "close_tab"]),
  version: z.string().max(100).optional(), ref: z.string().regex(/^@?e\d+$/).optional(),
  value: z.string().max(20000).describe("动作参数；open 必须在 value 中传完整网址，不能只传 ref；按 ref 打开链接请用 click。scroll 只接受 up、down、left、right，每次滚动 600 像素。不要传 top 或 bottom。").optional(), attachmentId: z.string().max(100).optional(),
  effect: z.enum(["read", "edit", "submit", "send", "purchase", "delete"]), summary: z.string().min(1).max(2000)
}).superRefine((action, context) => {
  if (action.kind === "open" && (!action.value?.trim() || !URL.canParse(action.value))) {
    context.addIssue({ code: "custom", path: ["value"], message: "open 需要在 value 中填写用户提供或已观察到的完整网址；若要点击 ref 对应的链接，请使用 kind=click。未执行浏览器操作。" });
  }
  if (action.kind === "scroll" && action.value !== undefined && !["up", "down", "left", "right"].includes(action.value)) {
    context.addIssue({ code: "custom", path: ["value"], message: "scroll 方向只支持 up、down、left、right；到页底请逐次 down 并观察。" });
  }
});
export type BrowserCommand = (task: BrowserTask, args: string[]) => Promise<unknown>;
export interface BrowserAdapter {
  readPage?(task: BrowserTask, options: PageReadOptions): Promise<BrowserObservation>;
  observeFast?(task: BrowserTask): Promise<BrowserObservation>;
  observe(task: BrowserTask, screenshot?: boolean, retainScreenshot?: boolean): Promise<BrowserObservation>;
  execute(task: BrowserTask, action: BrowserAction): Promise<string>;
  tabs(task: BrowserTask): Promise<unknown>;
  control(task: BrowserTask, action: "handoff" | "resume" | "complete" | "release"): Promise<void>;
}
export function parseCliResult(stdout: string): unknown {
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines.slice(i).join("\n"));
      if (parsed.success === false || parsed.ok === false) throw new Error(String(parsed.error || parsed.message || "浏览器操作失败"));
      return parsed.data ?? parsed;
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return stdout.trim();
}
function field(value: unknown, key: string): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return String((value as Record<string, unknown>)[key] ?? "");
  return "";
}
export function observationFingerprint(url: string, snapshot: string): string {
  return createHash("sha256").update(url + "\n" + snapshot).digest("hex");
}
export function effectiveEffect(action: BrowserAction, observation?: BrowserObservation): Effect {
  const ref = action.ref?.replace(/^@/, "");
  let candidates: DomCandidate[] = [], focus: { focusedRef?: string } | undefined;
  try { [, , candidates, , , focus] = JSON.parse(observation?.fast?.guard || ""); } catch { candidates = observation?.fast?.candidates || []; }
  const candidate = candidates.find(candidate => candidate.ref === ref);
  if (action.kind === "press") {
    // Escape dismisses UI; it cannot activate a form or a focused submit button.
    if (/^Escape$/i.test(action.value || "") && observation) return "read";
    if (/^(?:(Control|Meta)\+)?(Enter|Return)$/i.test(action.value || "")) {
      const focused = candidates.find(candidate => candidate.ref === focus?.focusedRef);
      if (/^(Enter|Return)$/i.test(action.value || "") && focused?.dom?.search && (!ref || ref === focused.ref)) return "read";
      const effect = focused && (focused.dom?.enterEffect || (focused.kind === "click" ? domControlEffect(focused) : undefined));
      if (effect && ["purchase", "delete", "send"].includes(effect)) return effect;
      return "submit";
    }
  }
  if (action.kind === "hover" && candidate) return "read";
  if (["click", "fill", "select"].includes(action.kind) && candidate) {
    const inferred = domControlEffect(candidate);
    if (inferred) return inferred;
  }
  if (action.kind === "click" && !candidate) {
    const line = observation?.snapshot.split("\n").find(line => ref && (line.includes(`ref=${ref}]`) || new RegExp(`^\\s*@${ref}\\s`).test(line))) || "";
    const match = line.match(/\b(button|link|menuitem|checkbox|radio|switch|option)\s+"((?:\\.|[^"\\])*)"/);
    if (match) {
      let label = match[2]; try { label = JSON.parse(`"${label}"`); } catch { /* Keep observed text. */ }
      const inferred = domControlEffect({ ref: ref!, role: match[1], label, kind: "click", submit: /\(submit button\)/.test(line) });
      if (inferred) return inferred;
      if (match[1] === "link" && /(?:记录|历史|状态|详情|列表)$|\b(?:history|records|status|details|list)$/i.test(label)) return action.effect;
    }
  }
  if (["purchase", "delete", "send", "submit"].includes(action.effect)) return action.effect;
  if (["fill", "select", "check", "uncheck", "upload", "press", "download", "close_tab"].includes(action.kind)) return "edit";
  return action.effect;
}
export class WrapperBrowser implements BrowserAdapter {
  private readonly fast: FastBrowser;
  private readonly command: BrowserCommand;
  private readonly usesGateway: boolean;
  constructor(readonly artifactRoot: string, command?: BrowserCommand) {
    this.usesGateway = !command;
    this.command = command || ((task, args) => new Promise((resolve, reject) => {
      if (!task.port) return reject(new Error("任务没有绑定浏览器端口。"));
      // The app owns a separate task identity. Never inherit the developing agent's session.
      const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PROFILEPILOT_AGENT_BROWSER_REAL: bundledBrowserExecutable() };
      delete env.CLAUDECODE;
      execFile(process.execPath, [path.join(__dirname, "../profilepilot-agent-browser-wrapper.cjs"),
        "--session", task.sessionId, "--cdp", String(task.port), "--json", ...args],
      { env, windowsHide: true, timeout: 45000, maxBuffer: 6 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          // A benign control-return notice is written to stderr. It must not
          // hide the controller's actual JSON error on stdout.
          let commandError = "";
          try { parseCliResult(stdout); } catch (failure) { commandError = failure instanceof Error ? failure.message : String(failure); }
          reject(new Error([commandError, stderr || (!commandError ? stdout || error.message : "")].filter(Boolean).join("\n").slice(0, 5000)));
        }
        else { try { resolve(parseCliResult(stdout)); } catch (error) { reject(error); } }
      });
    }));
    // URL/title getters may return the driver's cached target metadata without
    // touching CDP. Acquisition must prove this session still reaches Gateway,
    // especially after pause interrupted its initial navigation.
    this.fast = new FastBrowser(task => this.command(task, ["eval", "document.title"]));
  }
  observeFast(task: BrowserTask): Promise<BrowserObservation> { return this.fast.reobserve(task); }
  readPage(task: BrowserTask, options: PageReadOptions): Promise<BrowserObservation> { return this.fast.observe(task, options); }
  async observe(task: BrowserTask, screenshot = false, retainScreenshot = true): Promise<BrowserObservation> {
    let url: string, title: string;
    if (this.usesGateway) {
      const page = await this.fast.raw(task, "Runtime.evaluate", {
        expression: "({url:location.href,title:document.title})", returnByValue: true
      });
      if (page.exceptionDetails || typeof page.result?.value?.url !== "string") throw new Error("无法读取当前浏览器页面，请重新观察。");
      ({ url, title } = page.result.value);
    } else {
      url = field(await this.command(task, ["get", "url"]), "url");
      title = field(await this.command(task, ["get", "title"]), "title");
    }
    const data = await this.command(task, ["snapshot"]);
    const snapshot = field(data, "snapshot").slice(0, 60000);
    const observation: BrowserObservation = { version: randomUUID(), at: new Date().toISOString(),
      fingerprint: observationFingerprint(url, snapshot), url, title, snapshot, account: "账号未确认" };
    if (this.usesGateway) {
      const layout = await this.fast.raw(task, "Runtime.evaluate", { expression: `(${pageViewport.toString()})()`, returnByValue: true });
      if (layout.result?.value) observation.viewport = layout.result.value;
    }
    if (screenshot) {
      const dir = path.join(this.artifactRoot, task.id);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      observation.screenshotPath = path.join(dir, `${observation.version}.png`);
      await this.command(task, ["screenshot", observation.screenshotPath]);
      observation.screenshotDataUrl = `data:image/png;base64,${readFileSync(observation.screenshotPath).toString("base64")}`;
      if (!retainScreenshot) {
        rmSync(observation.screenshotPath, { force: true }); observation.screenshotPath = undefined;
      }
    }
    return observation;
  }
  tabs(task: BrowserTask): Promise<unknown> { return this.command(task, ["tab", "list"]); }
  private async preparePointer(task: BrowserTask, ref: string): Promise<void> {
    if (process.platform !== "win32") return;
    // A background Chrome tab on Windows can expose layout while its compositor
    // still drops native pointer input. Bring the target into view and force a
    // frame before the ONE requested click. Never retry a side-effecting click.
    await this.command(task, ["scrollintoview", ref]);
    const dir = path.resolve(this.artifactRoot, task.id);
    if (!dir.startsWith(path.resolve(this.artifactRoot) + path.sep)) throw new Error("无效的任务目录。");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const frame = path.join(dir, `input-frame-${randomUUID()}.png`);
    try { await this.command(task, ["screenshot", frame]); }
    finally { rmSync(frame, { force: true }); }
  }
  async execute(task: BrowserTask, input: BrowserAction): Promise<string> {
    const action = browserActionSchema.parse(input);
    if (task.observation?.fast && ["click", "hover", "fill", "select", "scroll"].includes(action.kind)) return this.fast.execute(task, action);
    let args: string[];
    const ref = action.ref ? `@${action.ref.replace(/^@/, "")}` : "";
    if (["click", "hover", "fill", "select", "check", "uncheck", "upload", "download"].includes(action.kind) && !ref) throw new Error("缺少页面元素引用，请重新观察页面。");
    switch (action.kind) {
      case "open": {
        const url = new URL(action.value || "");
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("只支持不包含凭据的 HTTP/HTTPS 页面。");
        args = ["open", url.href]; break;
      }
      case "click": case "hover": case "check": case "uncheck": args = [action.kind, ref]; break;
      case "fill": case "select": args = [action.kind, ref, action.value ?? ""]; break;
      case "upload": {
        const file = [...task.attachments, ...(task.outputs || [])].find((entry) => entry.id === action.attachmentId);
        if (!file) throw new Error("只能上传当前任务明确选择的附件。");
        args = ["upload", ref, file.path]; break;
      }
      case "download": {
        if (process.platform === "win32" && this.usesGateway) {
          const gateway = await requestBrowserGateway({ action: "ping" }, { homeDir: process.env.PROFILEPILOT_GATEWAY_HOME });
          if (Number(gateway.protocolVersion) < 15) throw new Error("下载需要更新浏览器连接服务。请先关闭所有 ProfilePilot 浏览器窗口，应用会自动更新；之后继续任务即可。");
        }
        const name = action.value || "download.bin";
        if (!/^[\p{L}\p{N} _.-]{1,120}$/u.test(name) || name.includes("..") || /[. ]$/.test(name) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)) throw new Error("下载文件名无效。");
        const id = randomUUID(); const dir = path.resolve(this.artifactRoot, task.id);
        if (!dir.startsWith(path.resolve(this.artifactRoot) + path.sep)) throw new Error("无效的任务目录。");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const destination = path.join(dir, `${id}-${name}`);
        await this.preparePointer(task, ref);
        await this.command(task, ["download", ref, destination]);
        const output = { id, name, path: destination, size: statSync(destination).size };
        (task.outputs ||= []).push(output);
        return JSON.stringify({ message: "下载已保存", file: output });
      }
      case "press": {
        if (!/^(Enter|Return|Tab|Escape|ArrowDown|ArrowUp|ArrowLeft|ArrowRight|Space|Backspace|Delete|Control\+a|Meta\+a|Control\+Enter|Meta\+Enter)$/i.test(action.value || "")) throw new Error("不支持该按键。");
        args = ["press", action.value!]; break;
      }
      case "scroll": args = ["scroll", z.enum(["up", "down", "left", "right"]).parse(action.value || "down"), "600"]; break;
      case "back": args = ["back"]; break;
      case "switch_tab": case "close_tab": {
        if (!/^(t?\d{1,4}|[A-Fa-f0-9]{32})$/.test(action.value || "")) throw new Error("请选择标签页编号或 Target ID。");
        args = action.kind === "switch_tab" ? ["tab", action.value!] : ["tab", "close", action.value!]; break;
      }
    }
    if (["click", "hover", "check", "uncheck"].includes(action.kind)) await this.preparePointer(task, ref);
    const result = await this.command(task, args);
    return typeof result === "string" ? result : JSON.stringify(result);
  }
  async control(task: BrowserTask, action: "handoff" | "resume" | "complete" | "release"): Promise<void> {
    this.fast.forget(task);
    if (!task.port) return;
    await this.command(task, ["profilepilot", action, ...(action === "handoff" ? ["--reason", task.pending?.title || "任务暂停，用户操作浏览器"] : [])]);
  }
}
