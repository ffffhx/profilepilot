import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { BrowserTask } from "../../shared/tasks";

export type DeviceCliRunner = (args: string[], stdinText?: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const phoneControlSchema = z.object({
  operation: z.enum(["list", "readiness", "start", "pause", "resume", "stop", "snapshot", "screenshot", "click", "fill", "scroll", "tap", "swipe", "text", "key"]),
  deviceId: z.string().trim().min(1).max(200).optional(),
  backend: z.enum(["app", "basic"]).default("app"),
  mode: z.enum(["view", "control"]).default("control"),
  sessionId: z.string().trim().min(1).max(200).optional(),
  generation: z.number().int().nonnegative().optional(),
  selector: z.object({
    resourceId: z.string().max(500).optional(),
    text: z.string().max(2000).optional(),
    description: z.string().max(2000).optional(),
    className: z.string().max(500).optional(),
    packageName: z.string().max(500).optional()
  }).strict().optional(),
  value: z.string().max(10000).optional(),
  direction: z.enum(["forward", "backward"]).optional(),
  key: z.enum(["back", "home", "recents"]).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  toX: z.number().finite().optional(),
  toY: z.number().finite().optional(),
  durationMs: z.number().int().min(10).max(10000).optional(),
  includeImage: z.boolean().default(false)
}).strict();

export const desktopControlSchema = z.object({
  operation: z.enum(["status", "windows", "claim", "select", "observe", "screenshot", "action", "handoff", "resume", "complete", "release"]),
  windowId: z.string().trim().min(1).max(200).optional(),
  mode: z.enum(["background", "interactive"]).default("background"),
  imageOnly: z.boolean().default(false),
  observeAfter: z.boolean().default(true),
  includeImage: z.boolean().default(false),
  action: z.record(z.string(), z.unknown()).optional()
}).strict();

export const electronControlSchema = z.object({
  operation: z.enum(["list", "inspect", "connect", "logs", "snapshot", "screenshot", "click", "fill", "press", "scroll", "handoff", "complete"]),
  target: z.string().trim().min(1).max(200).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  ref: z.string().trim().min(1).max(200).optional(),
  value: z.string().max(10000).optional(),
  confirmationToken: z.string().uuid().optional(),
  includeImage: z.boolean().default(false)
}).strict();

export function isMutatingDeviceTool(toolName: string, rawArgs: unknown): boolean {
  const op = (rawArgs as { operation?: string } | undefined)?.operation || "";
  if (toolName === "phone_control") return !["list", "readiness", "snapshot", "screenshot"].includes(op);
  if (toolName === "desktop_control") return !["status", "windows", "observe", "screenshot"].includes(op);
  if (toolName === "electron_control") return !["list", "inspect", "logs", "snapshot", "screenshot"].includes(op);
  return true;
}

export function devicePermissionScope(toolName: "phone_control" | "desktop_control" | "electron_control", rawArgs: unknown): { kind: "device"; scope: string; label: string } {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const operation = String(args.operation || "action");
  const target = String(args.deviceId || args.windowId || args.target || args.port || "default").slice(0, 120);
  const labelPrefix = toolName === "phone_control" ? "手机控制" : toolName === "desktop_control" ? "桌面控制" : "本机应用控制";
  return {
    kind: "device",
    scope: JSON.stringify([toolName, target, operation]),
    label: `${labelPrefix} · ${target} · ${operation}`
  };
}

export async function defaultDeviceCliRunner(args: string[], stdinText?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { runProfilePilotCli } = await import("../profilepilot-cli");
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, cb) { outChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); cb(); }
  }) as unknown as NodeJS.Process["stdout"];
  const stderr = new Writable({
    write(chunk, _encoding, cb) { errChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); cb(); }
  }) as unknown as NodeJS.Process["stderr"];
  const stdin = Readable.from(stdinText !== undefined ? [stdinText] : []);
  const exitCode = await runProfilePilotCli(args, { stdout, stderr }, { stdin });
  return {
    exitCode,
    stdout: Buffer.concat(outChunks).toString("utf8").trim(),
    stderr: Buffer.concat(errChunks).toString("utf8").trim()
  };
}

function parseCliJson(raw: { exitCode: number; stdout: string; stderr: string }): { ok: boolean; payload: any; text: string } {
  const combined = raw.stdout || raw.stderr || "";
  try {
    const parsed = JSON.parse(combined);
    const ok = raw.exitCode === 0 && parsed?.ok !== false;
    return { ok, payload: parsed, text: JSON.stringify(parsed) };
  } catch {
    return { ok: raw.exitCode === 0, payload: combined, text: combined || `命令退出码 ${raw.exitCode}` };
  }
}

function maybeImageContent(screenshotPath: string | undefined, allowInline: boolean): any[] {
  if (!screenshotPath || !allowInline || !existsSync(screenshotPath)) return [];
  try {
    const bytes = readFileSync(screenshotPath);
    if (bytes.length > 8 * 1024 * 1024) return [];
    const mimeType = screenshotPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    return [{ type: "image", mimeType, data: bytes.toString("base64") }];
  } catch { return []; }
}

export interface DeviceToolOptions {
  artifactRoot: string;
  runner?: DeviceCliRunner;
  canAttachScreenshot?: () => boolean;
}

export async function executeDeviceTool(
  task: BrowserTask,
  toolName: "phone_control" | "desktop_control" | "electron_control",
  rawArgs: unknown,
  options: DeviceToolOptions
): Promise<{ isError: boolean; content: any[]; snapshotText?: string; summary: string }> {
  const runner = options.runner || defaultDeviceCliRunner;
  const taskSession = `task-${task.id}`;
  const invoke = (routeArgs: string[], stdinText?: string) =>
    runner(["--task-kind", "real", "--task-id", task.id, "--operation-id", randomUUID(), ...routeArgs], stdinText);

  const taskArtifactDir = path.join(options.artifactRoot, task.id);
  const nextScreenshotPath = (prefix: string, ext = "png"): string => {
    mkdirSync(taskArtifactDir, { recursive: true, mode: 0o700 });
    return path.join(taskArtifactDir, `${prefix}-${randomUUID()}.${ext}`);
  };

  if (toolName === "phone_control") {
    const input = phoneControlSchema.parse(rawArgs);
    const deviceArg = input.deviceId || "default";
    if (input.operation === "list") {
      const res = parseCliJson(await invoke(["phone", "list", "--json"]));
      return { isError: !res.ok, content: [{ type: "text", text: res.text }], snapshotText: res.ok ? res.text : undefined, summary: "查询手机设备列表" };
    }
    if (input.operation === "readiness") {
      const res = parseCliJson(await invoke(["phone", "readiness", "--device", deviceArg, "--backend", input.backend, "--json"]));
      return { isError: !res.ok, content: [{ type: "text", text: res.text }], snapshotText: res.ok ? res.text : undefined, summary: `检查手机就绪状态（${deviceArg}）` };
    }
    if (input.operation === "start") {
      const res = parseCliJson(await invoke(["phone", "start", "--device", deviceArg, "--controller", taskSession, "--task", task.title.slice(0, 80) || "Agent 任务", "--mode", input.mode, "--backend", input.backend, "--json"]));
      return { isError: !res.ok, content: [{ type: "text", text: res.text }], snapshotText: res.ok ? res.text : undefined, summary: `建立手机控制会话（${deviceArg}）` };
    }
    if (["pause", "resume", "stop"].includes(input.operation)) {
      const res = parseCliJson(await invoke(["phone", input.operation, "--device", deviceArg, "--backend", input.backend, "--json"]));
      return { isError: !res.ok, content: [{ type: "text", text: res.text }], summary: `手机会话 ${input.operation}（${deviceArg}）` };
    }
    // Action operations: resolve sessionId + generation owned by task-${task.id} when omitted.
    let resolvedDeviceId = input.deviceId;
    let resolvedSessionId = input.sessionId;
    let resolvedGeneration = input.generation;
    if (!resolvedDeviceId || resolvedDeviceId === "default" || !resolvedSessionId || resolvedGeneration === undefined) {
      const listRes = parseCliJson(await invoke(["phone", "list", "--json"]));
      if (!listRes.ok) return { isError: true, content: [{ type: "text", text: listRes.text }], summary: "读取手机会话状态" };
      const data = listRes.payload?.data ?? listRes.payload;
      const devices: any[] = Array.isArray(data?.devices) ? data.devices : [];
      const defaultId = data?.defaultDeviceId || data?.defaultPhone?.deviceId;
      const targetId = (!resolvedDeviceId || resolvedDeviceId === "default") ? (defaultId || devices[0]?.id) : resolvedDeviceId;
      const device = devices.find(d => d.id === targetId || d.name === targetId);
      if (!device) {
        return { isError: true, content: [{ type: "text", text: "未找到可用的已连接手机，请先调用 phone_control(operation='list') 核查设备状态。" }], summary: "查找手机会话" };
      }
      resolvedDeviceId = String(device.id);
      const sessionInfo = input.backend === "basic" ? device.basic : device.session;
      if (!resolvedSessionId || resolvedGeneration === undefined) {
        if (!sessionInfo?.sessionId || sessionInfo.controller && sessionInfo.controller !== taskSession) {
          return {
            isError: true,
            content: [{ type: "text", text: sessionInfo?.controller && sessionInfo.controller !== taskSession
              ? `该手机当前由其他控制者（${sessionInfo.controller}）占用，禁止抢夺控制权。`
              : "当前任务尚未在该手机上建立活动会话，请先调用 phone_control(operation='start')。" }],
            summary: "校验手机控制权"
          };
        }
        resolvedSessionId ||= String(sessionInfo.sessionId);
        resolvedGeneration ??= Number(sessionInfo.generation ?? 1);
      }
    }
    const actionBody: Record<string, unknown> = (() => {
      switch (input.operation) {
        case "snapshot": return { kind: "snapshot" };
        case "screenshot": return { kind: "screenshot" };
        case "click": return { kind: "click", selector: input.selector || {} };
        case "fill": return { kind: "fill", selector: input.selector || {}, text: input.value ?? "" };
        case "scroll": return { kind: "scroll", selector: input.selector, direction: input.direction || "forward" };
        case "tap": return { kind: "tap", x: input.x, y: input.y };
        case "swipe": return { kind: "swipe", x: input.x, y: input.y, toX: input.toX, toY: input.toY, ...(input.durationMs ? { durationMs: input.durationMs } : {}) };
        case "text": return { kind: "text", text: input.value ?? "" };
        case "key": return { kind: "key", key: input.key || "back" };
        default: throw new Error(`不支持的手机操作：${input.operation}`);
      }
    })();
    const screenshotPath = input.operation === "screenshot" ? nextScreenshotPath("phone", "png") : undefined;
    const payload = {
      id: resolvedDeviceId,
      sessionId: resolvedSessionId,
      generation: resolvedGeneration,
      requestId: randomUUID(),
      action: actionBody
    };
    const args = ["phone", "action", "--backend", input.backend, "--params-stdin", ...(screenshotPath ? ["--output", screenshotPath] : []), "--json"];
    const res = parseCliJson(await invoke(args, JSON.stringify(payload)));
    const allowImage = (input.operation === "screenshot" || input.includeImage) && (options.canAttachScreenshot ? options.canAttachScreenshot() : true);
    const images = maybeImageContent(screenshotPath, allowImage);
    return {
      isError: !res.ok,
      content: [{ type: "text", text: res.text }, ...images],
      snapshotText: res.ok ? res.text : undefined,
      summary: `手机操作 ${input.operation}（${resolvedDeviceId}）`
    };
  }

  if (toolName === "desktop_control") {
    const input = desktopControlSchema.parse(rawArgs);
    const op = input.operation;
    if (op === "status" || op === "windows") {
      const res = parseCliJson(await invoke(["desktop", op, "--session", taskSession, "--json"]));
      return { isError: !res.ok, content: [{ type: "text", text: res.text }], snapshotText: res.ok ? res.text : undefined, summary: `查询桌面 ${op}` };
    }
    if (op === "claim" || op === "select") {
      if (!input.windowId) throw new Error(`desktop_control(${op}) 需要提供 windowId（先通过 windows 获取）。`);
      const args = ["desktop", op, "--session", taskSession, "--window", input.windowId, ...(op === "claim" ? ["--mode", input.mode] : []), "--json"];
      const res = parseCliJson(await invoke(args));
      return { isError: !res.ok, content: [{ type: "text", text: res.text }], snapshotText: res.ok ? res.text : undefined, summary: `桌面窗口 ${op}（${input.windowId}）` };
    }
    if (op === "observe") {
      const res = parseCliJson(await invoke(["desktop", "observe", "--session", taskSession, "--json"]));
      return { isError: !res.ok, content: [{ type: "text", text: res.text }], snapshotText: res.ok ? res.text : undefined, summary: "观察桌面窗口控件" };
    }
    if (op === "screenshot") {
      const screenshotPath = nextScreenshotPath("desktop", "jpg");
      const args = ["desktop", "screenshot", "--session", taskSession, "--output", screenshotPath, ...(input.imageOnly ? ["--image-only"] : []), "--json"];
      const res = parseCliJson(await invoke(args));
      const allowImage = (true || input.includeImage) && (options.canAttachScreenshot ? options.canAttachScreenshot() : true);
      const images = maybeImageContent(screenshotPath, allowImage);
      return { isError: !res.ok, content: [{ type: "text", text: res.text }, ...images], snapshotText: res.ok ? res.text : undefined, summary: "截取桌面窗口画面" };
    }
    if (op === "action") {
      if (!input.action || typeof input.action !== "object") throw new Error("desktop_control(action) 需要提供 action 对象（例如 { kind: 'invoke', ref: 'e1', version: '...' }）。");
      const args = ["desktop", "action", "--session", taskSession, "--params-stdin", ...(input.observeAfter === false ? ["--no-observe"] : []), "--json"];
      const res = parseCliJson(await invoke(args, JSON.stringify(input.action)));
      return { isError: !res.ok, content: [{ type: "text", text: res.text }], snapshotText: res.ok ? res.text : undefined, summary: `执行桌面动作 ${String(input.action.kind || "")}`.trim() };
    }
    const res = parseCliJson(await invoke(["desktop", op, "--session", taskSession, "--json"]));
    return { isError: !res.ok, content: [{ type: "text", text: res.text }], summary: `桌面会话 ${op}` };
  }

  const input = electronControlSchema.parse(rawArgs);
  const op = input.operation;
  if (op === "list") {
    const res = parseCliJson(await invoke(["electron", "list", "--all", "--json"]));
    return { isError: !res.ok, content: [{ type: "text", text: res.text }], snapshotText: res.ok ? res.text : undefined, summary: "查询本机 Electron 应用列表" };
  }
  if (op === "inspect") {
    if (!input.target) throw new Error("electron_control(inspect) 需要 target（应用名称或 ID）。");
    const res = parseCliJson(await invoke(["electron", "inspect", input.target, "--session", taskSession, "--json"]));
    return { isError: !res.ok, content: [{ type: "text", text: res.text }], snapshotText: res.ok ? res.text : undefined, summary: `检查本机应用 ${input.target}` };
  }
  if (op === "connect") {
    if (!input.target) throw new Error("electron_control(connect) 需要 target（应用名称或 ID）。");
    const args = ["electron", "connect", input.target, ...(input.confirmationToken ? ["--confirmation-token", input.confirmationToken] : []), "--json"];
    const res = parseCliJson(await invoke(args));
    return { isError: !res.ok, content: [{ type: "text", text: res.text }], snapshotText: res.ok ? res.text : undefined, summary: `连接本机应用 ${input.target}` };
  }
  let resolvedPort = input.port;
  if (!resolvedPort && input.target) {
    const listRes = parseCliJson(await invoke(["electron", "list", "--all", "--json"]));
    const apps: any[] = listRes.payload?.result?.apps || listRes.payload?.apps || [];
    const matched = apps.find(app => app.id === input.target || app.name === input.target);
    if (typeof matched?.port === "number") resolvedPort = matched.port;
  }
  if (!resolvedPort) throw new Error(`electron_control(${op}) 需要 port（应用的 Agent 逻辑端口）或已接入的 target 名称/ID。`);
  const screenshotPath = op === "screenshot" ? nextScreenshotPath("electron", "png") : undefined;
  const subArgs: string[] = (() => {
    switch (op) {
      case "logs": return ["console"];
      case "snapshot": return ["snapshot", "-i"];
      case "screenshot": return ["screenshot", screenshotPath!];
      case "click": if (!input.ref) throw new Error("click 需要 ref。"); return ["click", input.ref];
      case "fill": if (!input.ref) throw new Error("fill 需要 ref。"); return ["fill", input.ref, input.value ?? ""];
      case "press": if (!input.value) throw new Error("press 需要按键名称 value。"); return ["press", input.value];
      case "scroll": return ["scroll", input.value || "down"];
      case "handoff": return ["handoff"];
      case "complete": return ["complete"];
      default: throw new Error(`不支持的 Electron 操作：${op}`);
    }
  })();
  const res = parseCliJson(await invoke(["electron", "--session", taskSession, "--cdp", String(resolvedPort), ...subArgs, "--json"]));
  const allowImage = (op === "screenshot" || input.includeImage) && (options.canAttachScreenshot ? options.canAttachScreenshot() : true);
  const images = maybeImageContent(screenshotPath, allowImage);
  return {
    isError: !res.ok,
    content: [{ type: "text", text: res.text }, ...images],
    snapshotText: res.ok ? res.text : undefined,
    summary: `本机应用操作 ${op}（端口 ${resolvedPort}）`
  };
}
