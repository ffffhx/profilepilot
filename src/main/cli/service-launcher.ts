import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentCliTransport } from "../profilepilot-agent-cli";

export interface ServiceLaunchInfo { executable: string; args: string[]; cwd: string }

export function windowsArgument(value: string): string {
  if (value && !/[\s"]/u.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

export function windowsDetachedScript(info: ServiceLaunchInfo): string {
  const commandLine = [info.executable, ...info.args].map(windowsArgument).join(" ");
  const encoded = Buffer.from(commandLine, "utf8").toString("base64");
  const directory = Buffer.from(info.cwd, "utf8").toString("base64");
  return [
    "$ErrorActionPreference = 'Stop'",
    `$launchCommand = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
    `$launchDirectory = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${directory}'))`,
    "$startupInfo = New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
    "$launched = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $launchCommand; CurrentDirectory = $launchDirectory; ProcessStartupInformation = $startupInfo }",
    "if ($launched.ReturnValue -ne 0) { throw ('Cannot launch ProfilePilot: ' + $launched.ReturnValue) }"
  ].join("\n");
}

/** Windows CIM creates the service outside the terminal host's process job. */
export async function startService(info: ServiceLaunchInfo): Promise<void> {
  if (!path.isAbsolute(info.executable) || !path.isAbsolute(info.cwd) || !Array.isArray(info.args) || info.args.some(arg => typeof arg !== "string")) throw new Error("ProfilePilot 启动信息无效，请重新安装终端命令。");
  await fs.access(info.executable); await fs.access(info.cwd);
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsDetachedScript(info), "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
      let error = "";
      child.stderr?.on("data", chunk => { error = (error + chunk.toString()).slice(-3000); });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error(error || `ProfilePilot 启动失败 (${code})`)));
    });
  } else {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(info.executable, info.args, { cwd: info.cwd, env, detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  }
}

export async function ensureChatService(request: AgentCliTransport, homeDir: string, notify: (message: string) => void): Promise<void> {
  try {
    const response = await request({ action: "ping" });
    if (!response.ok) throw new Error(response.error.message);
    return;
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED", "EPIPE"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
  }
  let info: ServiceLaunchInfo;
  try { info = JSON.parse(await fs.readFile(path.join(homeDir, ".profilepilot", "cli", "app-launch.json"), "utf8")); }
  catch { throw new Error("无法找到 ProfilePilot 启动信息。请先打开 ProfilePilot，并在 Agent 集成中重新启用终端命令。"); }
  notify("正在启动 ProfilePilot 服务…\n");
  await startService(info);
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    try { const response = await request({ action: "ping" }); if (response.ok) return; } catch { /* Startup is asynchronous. */ }
  }
  throw new Error("ProfilePilot 服务启动超时。运行 ppilot doctor 检查原因后重试。");
}
