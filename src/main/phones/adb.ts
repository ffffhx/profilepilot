import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { PhoneDevice } from "../../shared/phones";

export const COMPANION_PACKAGE = "io.github.profilepilot.phone";
export const COMPANION_PORT = 18761;
export interface AdbRunner { run(args: string[], timeout?: number, input?: string, signal?: AbortSignal): Promise<string>; }
export function findAdb(env = process.env, platform = process.platform): string {
  if (env.PROFILEPILOT_ADB_PATH) return env.PROFILEPILOT_ADB_PATH;
  const executable = platform === "win32" ? "adb.exe" : "adb";
  const sdkRoots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, platform === "win32" ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Android", "Sdk") : path.join(os.homedir(), "Library", "Android", "sdk"), path.join(os.homedir(), "Android", "Sdk")];
  for (const root of sdkRoots) if (root && fs.existsSync(path.join(root, "platform-tools", executable))) return path.join(root, "platform-tools", executable);
  return executable;
}
export class Adb implements AdbRunner {
  constructor(readonly executable = findAdb()) {}
  run(args: string[], timeout = 8000, input?: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.executable, args, { windowsHide: true, timeout, signal, encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // Never echo argv: pairing arguments contain the device credential.
        const detail = input !== undefined ? "配对未完成，请核对地址和最新配对码。" : String([stderr, stdout].filter(Boolean).join("\n") || error.code || "连接超时").replace(/[a-f0-9]{64}/g, "[credential]").trim().slice(0, 800);
        reject(Object.assign(new Error(error.code === "ENOENT" ? "未找到 ADB，请安装 Android Platform Tools，或设置 PROFILEPILOT_ADB_PATH。" : `ADB 操作失败：${detail}`), { code: error.code }));
      } else resolve(stdout.trim());
      });
      child.stdin?.on("error", () => { /* execFile completion reports a failed process. */ });
      child.stdin?.end(input);
    });
  }
}
export function validateDeviceId(id: string): string {
  if (!/^[a-zA-Z0-9_.:[\]-]{1,200}$/.test(id)) throw new Error("手机设备标识无效。");
  return id;
}
export function deviceShell(args: string[]): string { return args.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" "); }
export function parseAdbDevices(output: string): PhoneDevice[] {
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^(\S+)\s+(device|offline|unauthorized)(?:\s+(.*))?$/);
    if (!match) return [];
    try { validateDeviceId(match[1]); } catch { return []; }
    const model = match[3]?.match(/(?:^|\s)model:(\S+)/)?.[1]?.replaceAll("_", " ") || "Android 手机";
    return [{ id: match[1], name: model, model, transport: match[1].startsWith("emulator-") ? "emulator" : /:|_adb-tls/.test(match[1]) ? "wifi" : "usb", connection: match[2] as PhoneDevice["connection"], companion: "unknown", state: null, confirmedAt: null, pending: null, error: "" }];
  });
}
export function phoneRequest(port: number, token: string, method: string, body: unknown = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({ hostname: "127.0.0.1", port, method: "POST", path: `/${method}`, agent: false, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) request.destroy(new Error("手机响应超过大小限制。")); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("手机返回了无效响应。")); } });
    });
    request.setTimeout(7000, () => request.destroy(new Error("手机未及时确认操作；请检查状态，不要直接重试输入。")));
    request.on("error", reject); request.end(payload);
  });
}
