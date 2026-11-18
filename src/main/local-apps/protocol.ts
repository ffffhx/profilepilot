import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

export function buildMacDeveloperPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || os.homedir();
  const candidates: string[] = [];
  if (home) {
    const nvmVersionsDir = path.posix.join(home, ".nvm/versions/node");
    try {
      if (fs.existsSync(nvmVersionsDir)) {
        const versions = fs.readdirSync(nvmVersionsDir, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => entry.name)
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const version of versions) {
          candidates.push(path.posix.join(nvmVersionsDir, version, "bin"));
        }
      }
    } catch { /* ignore unreadable nvm dir */ }
    candidates.push(
      path.posix.join(home, ".local/share/fnm/aliases/default/bin"),
      path.posix.join(home, ".local/share/fnm"),
      path.posix.join(home, ".volta/bin"),
      path.posix.join(home, ".bun/bin")
    );
  }
  candidates.push("/opt/homebrew/bin", "/usr/local/bin");
  const current = (env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin").split(":").filter(Boolean);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...candidates, ...current]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  return merged.join(":");
}

export function launchCommand(config: LocalAppConfig, platform = process.platform, env = process.env): { executable: string; args: string[] } {
  const command = config.command.replaceAll("{cdpPort}", String(config.cdpPort ?? "")).replaceAll("{inspectPort}", String(config.inspectPort ?? ""));
  if (platform === "win32") {
    return { executable: env.ComSpec || env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", `"${command}"`] };
  }
  if (platform === "darwin" && env !== process.env && !Object.isFrozen(env)) {
    env.PATH = buildMacDeveloperPath(env);
  }
  // Login shell loads the developer's Node/version-manager PATH on macOS.
  return { executable: env.SHELL || "/bin/sh", args: ["-lc", command] };
}

function unquoteEnvValue(raw: string): string {
  if (raw.length >= 2) {
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

export function parseEnvironment(value: string, options?: string | { cwd?: string }): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const cwd = typeof options === "string" ? options : options?.cwd;
  if (cwd) {
    const dotEnvPath = path.join(cwd, ".env");
    try {
      if (fs.existsSync(dotEnvPath) && fs.statSync(dotEnvPath).isFile()) {
        const dotEnvContent = fs.readFileSync(dotEnvPath, "utf8");
        for (const line of dotEnvContent.split(/\r?\n/)) {
          if (!line.trim() || line.trimStart().startsWith("#")) continue;
          const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
          if (!match) continue;
          result[match[1]] = unquoteEnvValue(match[2]);
        }
      }
    } catch { /* ignore unreadable .env */ }
  }
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) throw new Error("环境变量请按每行 NAME=value 填写。");
    result[match[1]] = unquoteEnvValue(match[2]);
  }
  return result;
}
