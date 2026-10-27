import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { RemoteControlConnection, RemoteSessionStore, remoteError, type RemoteSession } from "./remote-control-client";

type Io = { stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } };
export interface RemoteCliRuntime { homeDir?: string; env?: NodeJS.ProcessEnv; stdin?: Readable; }
export interface RemoteCommand {
  kind: "devices" | "connect" | "sessions" | "disconnect" | "execute";
  json: boolean; session?: string; deviceId?: string; leaseSeconds?: number; operation?: string;
  params: Record<string, unknown>; paramsFile?: string; paramsStdin?: boolean; requestId?: string; output?: string;
}
export const remoteCliHelp = () => `ProfilePilot 远程控制：ppilot remote <命令>
  devices [--json]                            列出可发现及已配对电脑
  connect <设备ID> [--lease-seconds 60..1800]   建立会话，默认闲置 300 秒后释放
  sessions                                   列出本机保存的 CLI 会话（不含凭据）
  status | disconnect --session <会话ID>      核对状态或释放控制
  profiles | apps | windows --session <会话ID>
  profile <get|create|rename|start|stop|delete|configure> --session ID
      [--profile ID] [--name 名称] [--hide-automation on|off] [--yes]
  browser open --session ID --profile ID [--tab ID | --new-tab]
  browser <observe|tabs|close|handoff|resume> --session ID --browser ID
  browser navigate --session ID --browser ID [--url URL [--new-tab] | --tab ID]
  browser tab-close --session ID --browser ID --tab ID
  browser action --session ID --browser ID --params-file action.json
  window <observe|screenshot> --session ID --window ID [--output 图片路径]
  window action --session ID --params-file action.json

所有命令支持 --json；action 也可用 --params-stdin 读取 UTF-8 JSON。
动作包含最近观察的 version、ref、kind 等参数；使用 --request-id 32位十六进制值查询同一请求回执，不能改参数重放。
命令结束后会话在 ClipRelay 后台限时保留；后续命令延长有效期，任务结束必须 disconnect。
截图保存在本机并返回路径；--output 不覆盖已有文件。普通操作返回 JSON，日志不混入 stdout。
被控电脑需要新版 ClipRelay 应用并允许连接；浏览器/Electron 还需目标端准备 ProfilePilot 连接。
尊重远端接管和停止；只有用户明确交还后才 resume，再重新 observe。无需安装或注册 MCP。
退出码：0 成功，1 操作失败，2 参数错误，69 后台未就绪，75 控制停止/会话失效/结果未知。
`;

export function parseRemoteCliArgs(args: string[]): RemoteCommand {
  const words: string[] = [], options = new Map<string, string | true>();
  const booleans = new Set(["json", "new-tab", "yes", "params-stdin"]);
  const known = new Set([...booleans, "session", "browser", "profile", "window", "tab", "url", "name", "hide-automation", "lease-seconds", "params-file", "request-id", "output"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) { words.push(arg); continue; }
    const key = arg.slice(2);
    if (!known.has(key) || options.has(key)) throw remoteError("REMOTE_INVALID_ARGUMENTS", `未知或重复参数：${arg}`);
    if (booleans.has(key)) options.set(key, true);
    else { const value = args[++i]; if (!value || value.startsWith("--")) throw remoteError("REMOTE_INVALID_ARGUMENTS", `${arg} 需要值。`); options.set(key, value); }
  }
  const bad = (message: string): never => { throw remoteError("REMOTE_INVALID_ARGUMENTS", message); };
  const get = (key: string) => options.get(key) as string | undefined;
  const requireOption = (key: string) => get(key) || bad(`需要 --${key}。`);
  const parsed: RemoteCommand = { kind: "execute", json: options.has("json"), params: {} };
  let allowed = ["json", "session", "request-id"];
  const exactWords = (count: number) => { if (words.length !== count) bad("位置参数不正确，请查看 ppilot remote --help。"); };
  const tab = () => { const value = requireOption("tab"); if (!/^(?:t?\d{1,10}|[A-Fa-f0-9]{32})$/.test(value)) bad("请使用观察到的标签页 ID。"); return /^\d+$/.test(value) ? Number(value) : value; };
  switch (words[0]) {
    case "devices": case "sessions": exactWords(1); parsed.kind = words[0]; allowed = ["json"]; break;
    case "connect":
      exactWords(2); parsed.kind = "connect"; parsed.deviceId = words[1]; allowed = ["json", "lease-seconds"];
      parsed.leaseSeconds = get("lease-seconds") === undefined ? 300 : Number(get("lease-seconds"));
      if (!Number.isInteger(parsed.leaseSeconds) || parsed.leaseSeconds < 60 || parsed.leaseSeconds > 1800) bad("租约需要 60 到 1800 秒的整数。");
      break;
    case "disconnect": exactWords(1); parsed.kind = "disconnect"; allowed = ["json", "session"]; break;
    case "status": case "profiles": case "apps": case "windows": exactWords(1); parsed.operation = words[0]; break;
    case "profile": {
      exactWords(2); const command = words[1]; parsed.operation = "profile"; parsed.params.command = command;
      if (!["get", "create", "rename", "start", "stop", "delete", "configure"].includes(command)) bad("不支持这个 Profile 命令。");
      allowed.push(command === "create" ? "name" : "profile");
      if (command !== "create") parsed.params.profileId = requireOption("profile");
      if (command === "create" || command === "rename") { allowed.push("name"); parsed.params.name = requireOption("name"); }
      if (command === "delete") { allowed.push("yes"); if (!options.has("yes")) bad("删除目标 Profile 需要明确指定 --yes。"); }
      if (command === "configure") { allowed.push("hide-automation"); const value = requireOption("hide-automation"); if (!["on", "off"].includes(value)) bad("--hide-automation 需要 on 或 off。"); parsed.params.hideAutomation = value === "on"; }
      break;
    }
    case "browser": {
      exactWords(2); const verb = words[1];
      if (!["open", "observe", "tabs", "close", "handoff", "resume", "navigate", "tab-close", "action"].includes(verb)) bad("不支持这个浏览器命令。");
      parsed.operation = "browser." + verb.replace("-", "_");
      if (verb === "open") {
        allowed.push("profile", "tab", "new-tab"); parsed.params.profileId = requireOption("profile");
        if (options.has("tab") && options.has("new-tab")) bad("--tab 和 --new-tab 只能选一个。");
        if (options.has("tab")) parsed.params.tabId = tab();
        if (options.has("new-tab")) parsed.params.newTab = true;
      } else if (verb === "tabs" && options.has("profile")) { allowed.push("profile"); parsed.params.profileId = get("profile"); }
      else { allowed.push("browser"); parsed.params.browserId = requireOption("browser"); }
      if (verb === "navigate") {
        allowed.push("url", "tab", "new-tab");
        if (options.has("tab")) { if (options.has("url") || options.has("new-tab")) bad("选择标签页时不能同时打开 URL。"); parsed.params.tabId = tab(); }
        else { parsed.params.url = requireOption("url"); if (options.has("new-tab")) parsed.params.newTab = true; }
      }
      if (verb === "tab-close") { allowed.push("tab"); parsed.params.tabId = tab(); }
      if (verb === "action") allowed.push("params-file", "params-stdin");
      break;
    }
    case "window":
      exactWords(2); if (!["observe", "screenshot", "action"].includes(words[1])) bad("不支持这个窗口命令。");
      parsed.operation = "window." + words[1];
      if (words[1] === "action") allowed.push("params-file", "params-stdin");
      else { allowed.push("window", "output"); parsed.params.windowId = requireOption("window"); parsed.output = get("output"); if (parsed.output) parsed.params.screenshot = true; }
      break;
    default: bad("请选择 remote 命令，运行 ppilot remote --help 查看用法。");
  }
  for (const key of options.keys()) if (!allowed.includes(key)) bad(`当前命令不支持 --${key}。`);
  if (parsed.kind === "execute" || parsed.kind === "disconnect") {
    parsed.session = requireOption("session"); if (!/^[a-f0-9]{32}$/.test(parsed.session)) bad("会话 ID 必须来自 connect 返回值。");
  }
  if (parsed.operation?.endsWith(".action")) {
    if (options.has("params-file") === options.has("params-stdin")) bad("请选择一种动作 JSON 输入：--params-file 或 --params-stdin。");
    parsed.paramsFile = get("params-file"); parsed.paramsStdin = options.has("params-stdin");
  }
  parsed.requestId = get("request-id");
  if (parsed.requestId && !/^[a-f0-9]{32}$/.test(parsed.requestId)) bad("--request-id 需要 32 位十六进制值。");
  return parsed;
}

async function readAction(command: RemoteCommand, input: Readable) {
  let text: string;
  if (command.paramsFile) {
    const stat = await fs.stat(command.paramsFile);
    if (!stat.isFile() || stat.size > 49152) throw remoteError("REMOTE_INVALID_ARGUMENTS", "动作文件需要小于 48 KiB。");
    text = await fs.readFile(command.paramsFile, "utf8");
  } else {
    const chunks: Buffer[] = []; let size = 0;
    for await (const value of input) { const chunk = Buffer.from(value); size += chunk.length; if (size > 49152) throw remoteError("REMOTE_INVALID_ARGUMENTS"); chunks.push(chunk); }
    text = Buffer.concat(chunks).toString("utf8");
  }
  let value: any;
  try { value = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { throw remoteError("REMOTE_INVALID_ARGUMENTS", "动作必须是 UTF-8 JSON 对象。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw remoteError("REMOTE_INVALID_ARGUMENTS");
  if (command.operation === "browser.action") command.params.action = value;
  else command.params = value;
}

async function saveImages(value: any, command: RemoteCommand, home: string): Promise<any> {
  if (!value || typeof value !== "object") return value;
  if (typeof value.data === "string" && ["image/jpeg", "image/png"].includes(value.mimeType)) {
    const output = command.output ? path.resolve(command.output) : path.join(home, ".profilepilot", "remote", "artifacts", command.session!, `${randomUUID()}.${value.mimeType === "image/png" ? "png" : "jpg"}`);
    if (!command.output) await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
    await fs.writeFile(output, Buffer.from(value.data, "base64"), { mode: 0o600, flag: "wx" });
    const { data: _bytes, ...metadata } = value; return { ...metadata, path: output };
  }
  if (Array.isArray(value)) return Promise.all(value.map(item => saveImages(item, command, home)));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = await saveImages(item, command, home);
  return result;
}

function nestedFailure(value: any): number {
  if (!value || typeof value !== "object") return 0;
  if (Number.isInteger(value.exitCode) && (value.exitCode !== 0 || value.data?.ok === false)) return value.exitCode === 75 ? 75 : 1;
  return Object.values(value).reduce<number>((code, item) => Math.max(code, nestedFailure(item)), 0);
}

export async function runRemoteCli(args: string[], io: Io = process, runtime: RemoteCliRuntime = {}): Promise<number> {
  if (!args.length || args.includes("--help") || args.includes("-h")) { io.stdout.write(remoteCliHelp()); return 0; }
  const home = runtime.homeDir || os.homedir(), store = new RemoteSessionStore(home), connection = new RemoteControlConnection(runtime.env);
  let command: RemoteCommand | undefined, saved: RemoteSession | undefined;
  const write = (value: unknown) => io.stdout.write(JSON.stringify(value, null, command?.json ? undefined : 2) + "\n");
  try {
    command = parseRemoteCliArgs(args);
    if (command.kind === "sessions") { write({ ok: true, ...await store.list() }); return 0; }
    if (command.operation?.endsWith(".action")) await readAction(command, runtime.stdin || process.stdin);
    if (command.kind === "execute") command.requestId ||= randomUUID().replaceAll("-", "");
    if (command.session) saved = await store.read(command.session);
    await connection.start(saved);
    let result: any;
    if (command.kind === "devices") result = await connection.call({ method: "devices" });
    else if (command.kind === "connect") {
      result = await connection.call({ method: "connect", params: { deviceId: command.deviceId, leaseSeconds: command.leaseSeconds } });
      const { leaseToken, ...visible } = result;
      if (!/^[a-f0-9]{64}$/.test(leaseToken) || !/^[a-f0-9]{32}$/.test(result.session)) throw remoteError("REMOTE_INVALID_RESPONSE");
      saved = { session: result.session, leaseToken, deviceId: result.deviceId, name: result.name, expiresAt: result.expiresAt, leaseSeconds: result.leaseSeconds };
      try { await store.save(saved); } catch (error) { await connection.call({ method: "disconnect", params: { session: saved.session } }).catch(() => {}); throw error; }
      result = visible;
    } else if (command.kind === "disconnect") {
      result = await connection.call({ method: "disconnect", params: { session: command.session } }); await store.remove(command.session!);
    } else {
      result = await connection.call({ method: "execute", params: { session: command.session, operation: command.operation, params: command.params, requestId: command.requestId } });
      if (saved && Number.isFinite(result.expiresAt)) { saved.expiresAt = result.expiresAt; await store.save(saved); }
    }
    const failed = nestedFailure(result); result = await saveImages(result, command, home);
    write({ ok: failed === 0, ...result }); return failed;
  } catch (cause) {
    const error = cause as Error & { code?: string; requestId?: string };
    if (command?.session && error.code === "AUTOMATION_CLI_SESSION_ENDED") await store.remove(command.session).catch(() => {});
    write({ ok: false, code: error.code || "REMOTE_FAILED", message: error.message, requestId: error.requestId || command?.requestId });
    if (error.code === "REMOTE_INVALID_ARGUMENTS" || error instanceof SyntaxError) return 2;
    if (["REMOTE_APP_NOT_RUNNING", "REMOTE_UPDATE_REQUIRED", "REMOTE_PLATFORM_UNAVAILABLE"].includes(error.code || "")) return 69;
    if (/UNKNOWN|STALE|STOPPED|ENDED|UNPAIRED|ROUTE_CHANGED|CONTROL_BUSY|SESSION_NOT_FOUND|OBSERVATION/.test(error.code || "")) return 75;
    return 1;
  } finally { connection.close(); }
}
