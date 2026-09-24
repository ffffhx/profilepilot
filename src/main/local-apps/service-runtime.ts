import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocalAppConfig, LocalAppRuntime } from "../../shared/local-apps";
import { getWindowsSystemSnapshot } from "../windows-platform";
import { idleRuntime } from "./protocol";

const execute = promisify(execFile);

// Inspect OS listeners rather than connecting: some tray apps interpret even
// an empty TCP probe as an incoming clipboard delivery and log an error.
export async function serviceRuntime(config: LocalAppConfig): Promise<LocalAppRuntime> {
  const runtime = idleRuntime();
  if (!config.servicePort || !config.serviceProcess) return runtime;
  if (process.platform === "win32") {
    const snapshot = await getWindowsSystemSnapshot();
    const owners = new Set(snapshot.tcp.filter(item => item.localPort === config.servicePort && item.state.toLowerCase() === "listen").map(item => item.pid));
    const processInfo = snapshot.processes.find(item => owners.has(item.pid) && item.commandLine.toLowerCase().includes(config.serviceProcess!.toLowerCase()));
    if (processInfo) return { ...runtime, status: "running", pid: processInfo.pid, startedAt: processInfo.startedAt };
    return runtime;
  }
  let stdout: string;
  try {
    ({ stdout } = await execute("lsof", ["-nP", `-iTCP:${config.servicePort}`, "-sTCP:LISTEN", "-Fp"], { timeout: 4000 }));
  } catch (error) {
    if ((error as { code?: number }).code === 1) return runtime;
    throw error;
  }
  const pids = [...new Set(stdout.split("\n").filter(line => /^p\d+$/.test(line)).map(line => line.slice(1)))];
  if (!pids.length) return runtime;
  const processes = await execute("ps", ["-p", pids.join(","), "-o", "pid=,command="], { timeout: 4000 });
  for (const line of processes.stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (match && match[2].includes(config.serviceProcess)) return { ...runtime, status: "running", pid: Number(match[1]) };
  }
  return runtime;
}
