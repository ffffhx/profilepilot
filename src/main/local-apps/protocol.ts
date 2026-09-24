import net from "node:net";
import fs from "node:fs";
import type { LocalAppConfig, LocalAppRuntime } from "../../shared/local-apps";

export interface LocalAppWorkerRecord {
  workerPid?: number;
  socket: string;
  token: string;
  runtime: LocalAppRuntime;
}

export interface LocalAppLaunch {
  config: LocalAppConfig;
  socket: string;
  token: string;
  recordPath: string;
  logPath: string;
}

export const idleRuntime = (): LocalAppRuntime => ({ status: "stopped", pid: null, startedAt: null, exitCode: null, error: "" });

export function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function workerRequest(record: LocalAppWorkerRecord, action: "status" | "stop", timeout = 1500): Promise<LocalAppRuntime> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(record.socket);
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("应用管理进程未响应，请稍后重试。")), timeout);
    const finish = (error?: Error, value?: LocalAppRuntime) => {
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(value!);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ token: record.token, action }) + "\n"));
    socket.once("error", error => finish(error));
    socket.once("end", () => { if (!buffer.includes("\n")) finish(new Error("应用管理连接已断开。")); });
    socket.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) return finish(new Error("应用管理响应过大。"));
      if (!buffer.includes("\n")) return;
      try {
        const result = JSON.parse(buffer.split("\n")[0]);
        if (result.error) finish(new Error(result.error)); else finish(undefined, result.runtime);
      } catch { finish(new Error("应用管理响应无效。")); }
    });
  });
}

export function launchCommand(config: LocalAppConfig, platform = process.platform, env = process.env): { executable: string; args: string[] } {
  const command = config.command.replaceAll("{cdpPort}", String(config.cdpPort ?? "")).replaceAll("{inspectPort}", String(config.inspectPort ?? ""));
  if (platform === "win32") {
    return { executable: env.ComSpec || env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`] };
  }
  // Login shell loads the developer's Node/version-manager PATH on macOS.
  return { executable: env.SHELL || "/bin/sh", args: ["-lc", command] };
}

export function parseEnvironment(value: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error("环境变量请按每行 NAME=value 填写。");
    result[match[1]] = match[2];
  }
  return result;
}
