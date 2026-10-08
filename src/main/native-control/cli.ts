import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultDataDir } from "../fs-util";
import { NativeControlError, nativeControlError } from "./errors";
import { isNativeControlMethod } from "./protocol";
import { ensureBrowserService } from '../browser-service/launcher';
import { browserServiceRoot, readBrowserServiceConnection, processAlive, serviceRequest } from '../browser-service/connection';
export { nativeControlError } from "./errors";

export function nativeControlRoot(): string { return process.env.PROFILEPILOT_NATIVE_ROOT || path.join(process.env.CPM_DATA_DIR || defaultDataDir(), "browser-tasks"); }
export async function requestNativeControl(command: any, root = nativeControlRoot()): Promise<any> {
  let connection;
  try { connection = JSON.parse(readFileSync(path.join(root, "native-control.json"), "utf8")); }
  catch { throw new Error("浏览器服务未运行，请运行 ppilot browser status 自动启动并检查连接。"); }
  if (connection.version !== 1 || !Number.isInteger(connection.port) || connection.port < 1024 || connection.port > 65535 || !/^[a-f0-9]{64}$/.test(connection.token)) throw new Error("本地控制发现文件无效。");
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(command);
    const req = http.request({ hostname: "127.0.0.1", port: connection.port, path: "/native-control", method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on("data", chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) { res.destroy(); reject(new Error("响应超过 32 MiB，请缩小读取范围。")); } else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => { try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); value.ok ? resolve(value.result) : reject(new NativeControlError(value.code || "NATIVE_BROWSER_ERROR", value.error)); } catch (error) { reject(error); } });
    });
    req.setTimeout(310000, () => req.destroy(new Error("直接请求超时；先核查当前状态，不要重新触发动作。")));
    req.on("error", error => reject(new Error(`本地浏览器连接失败：${error.message}`))); req.end(body);
  });
}
export const nativeControlHelp = `ProfilePilot Browser CLI (ppilot browser; no model invocation)
ppilot browser [--profile native:Default] [--session NAME] METHOD [--params JSON|--params-file PATH|--params-stdin]
  status                         Auto-start browser service; list Profiles/ownership
  pair --profile native:NAME      Generate an extension pairing code (no App needed)
  connect --profile native:NAME   Print the installation/connection page URL
  service start | status | stop   Manage the independent background service
  tabs                           List existing ordinary tabs
  claim --tab ID | --new-tab      Claim one Profile; returns a session ID
  observe | read                 Read DOM and versioned element refs
  action --params JSON           BrowserAction with current observation version
  pointer --params JSON          Coordinates from a screenshot observation
  screenshot [--output PATH]     PNG capture
  open URL | switch ID | newTab   Select or create a page
  cdp METHOD --params JSON       Full Chrome-supported CDP, --cdp-session ID for OOPIF
  debug                          Enable Runtime/Network/Log/Performance events
  events --params JSON           Read events after {since:cursor,limit:100}
  history --params JSON          {query,startTime,endTime,maxResults}
  download --params JSON         Download and register a local output
  handoff | resume | complete | release
  --request-id ID                Reuse only to retrieve the SAME request result
  --root PATH                    Override browser service data directory
Use a session for every command after claim. Resume is explicit; never replay
an action after timeout/disconnect. Run observe again after actions or takeover.
Exit codes: 0 success, 64 invalid input, 69 disconnected, 75 stop/reconcile,
1 browser error. JSON errors include a stable NATIVE_* code.
`;
function invalidInput(message: string): never { throw new NativeControlError("NATIVE_INVALID_REQUEST", message); }

function readParams(inline: string | undefined, file: string | undefined, stdin: boolean): Record<string, any> {
  let text = inline ?? "{}";
  if (file !== undefined || stdin) {
    try { text = readFileSync(file ?? 0, "utf8"); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      invalidInput(file !== undefined ? `无法读取 params 文件 ${file}：${detail}` : `无法读取 params 标准输入：${detail}`);
    }
  }
  let params;
  try { params = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch (error) { invalidInput(`params JSON 语法无效：${error instanceof Error ? error.message : String(error)}`); }
  if (!params || typeof params !== "object" || Array.isArray(params)) invalidInput("params 必须是 JSON 对象。");
  return params;
}

function positiveTabId(value: unknown): number {
  const id = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) invalidInput("tabId 必须是正整数；使用 switch ID、--tab ID 或 params 中的 tabId。");
  return id;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) { process.stdout.write(nativeControlHelp); return; }
  if (argv[0] === 'service') {
    const rest = argv.slice(1); const rootAt = rest.indexOf('--root');
    let root = browserServiceRoot();
    if (rootAt >= 0) { if (!rest[rootAt + 1]) invalidInput('--root 需要目录。'); root = path.resolve(rest.splice(rootAt, 2)[1]); }
    if (rest.length !== 1 || !['start', 'status', 'stop'].includes(rest[0])) invalidInput('用法：ppilot browser service start|status|stop');
    let connection = rest[0] === 'start' ? await ensureBrowserService(root) : readBrowserServiceConnection(root);
    if (connection && !processAlive(connection.pid)) connection = undefined;
    const result = connection ? (await serviceRequest(connection, rest[0] === 'stop' ? 'stop' : 'ping')).result : { service: 'browser', running: false };
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n'); return;
  }
  const args = [...argv];
  const flag = (name: string): string | undefined => { const index = args.indexOf(name); if (index < 0) return; if (!args[index + 1] || args[index + 1].startsWith("--")) invalidInput(`${name} 需要参数。`); return args.splice(index, 2)[1]; };
  const boolean = (name: string): boolean => { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; };
  const profileId = flag("--profile"), sessionId = flag("--session"), root = flag("--root"), requestId = flag("--request-id") || randomUUID();
  const output = flag("--output"), cdpSessionId = flag("--cdp-session"), tabId = flag("--tab"), newTab = boolean("--new-tab");
  const inline = flag("--params"), file = flag("--params-file"), stdin = boolean("--params-stdin");
  if ([inline !== undefined, file !== undefined, stdin].filter(Boolean).length > 1) invalidInput("只使用一种 params 输入方式。");
  let method = args.shift();
  if (method === 'pair' || method === 'connect') {
    if (!profileId || !/^native:[^/\\]{1,100}$/.test(profileId) || ['.', '..'].includes(profileId.slice(7))) invalidInput('请用 --profile native:目录名称 指定要配对的 Chrome Profile。');
    if (args.length || sessionId || output || tabId || newTab || inline !== undefined || file !== undefined || stdin) invalidInput('pair/connect 只接受 --profile 和 --root。');
    const connection = await ensureBrowserService(root);
    const { result } = await serviceRequest(connection, method === 'pair' ? 'pair' : 'authorize', [profileId, profileId.slice(7)]);
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n'); return;
  }
  const controlAlias = ["handoff", "resume", "complete", "release"].includes(method || "");
  if (!isNativeControlMethod(method) && !controlAlias) invalidInput(method ? `未知浏览器方法：${method}` : "需要浏览器方法；运行 ppilot browser --help 查看用法。");
  if (!/^[\w.-]{1,128}$/.test(requestId)) invalidInput("requestId 必须是 1–128 个字母、数字、下划线、连字符或点。");
  if (output && method !== "screenshot") invalidInput("--output 仅支持截图。");
  const positional = ["open", "switch", "cdp"].includes(method!) && args[0] && !args[0].startsWith("--") ? args.shift() : undefined;
  if (args.length) invalidInput(`未知参数：${args.join(" ")}`);
  let params = readParams(inline, file, stdin);
  if (controlAlias) { params = { action: method }; method = "control"; }
  else if (method === "cdp") {
    if (!positional || !/^[A-Za-z]+\.[A-Za-z0-9]+$/.test(positional)) invalidInput("cdp 需要有效方法，例如 Runtime.evaluate。");
    params = { method: positional, params, cdpSessionId };
  } else if (method === "open") {
    if (positional !== undefined) params.url = positional;
    if (typeof params.url !== "string") invalidInput("open 需要字符串 URL；使用 open URL 或 params 中的 url。");
    let url: URL;
    try { url = new URL(params.url); } catch { invalidInput("open 需要有效 URL；使用 open URL 或 params 中的 url。"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) invalidInput("open 只支持不含凭据的 HTTP/HTTPS 页面。");
  } else if (method === "switch" && positional !== undefined) params.tabId = positiveTabId(positional);
  if (tabId !== undefined) params.tabId = positiveTabId(tabId);
  if (method === "switch" || params.tabId !== undefined) params.tabId = positiveTabId(params.tabId);
  if (newTab) params.newTab = true;
  await ensureBrowserService(root);
  const result = await requestNativeControl({ requestId, method, profileId, sessionId, params }, root);
  if (output) {
    if (method !== "screenshot" || typeof result?.data !== "string") throw new Error("--output 仅支持截图。");
    writeFileSync(output, Buffer.from(result.data, "base64"), { mode: 0o600 }); process.stdout.write(JSON.stringify({ ok: true, path: path.resolve(output) }) + "\n");
  } else process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
}
export function reportNativeControlError(error: unknown): void {
  const result = nativeControlError(error);
  process.stderr.write(JSON.stringify({ ok: false, code: result.code, error: result.message }) + "\n"); process.exitCode = result.exitCode;
}
// esbuild flattens this reusable module into ppilot's entry module. Its own
// require.main guard would then also be true, executing the request twice.
if (require.main === module && /[\\/]native-control[\\/]cli\.(?:js|ts)$/.test(process.argv[1] || "")) void main().catch(reportNativeControlError);
