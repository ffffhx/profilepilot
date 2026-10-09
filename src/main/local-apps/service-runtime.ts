import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { LocalAppConfig, LocalAppRuntime } from "../../shared/local-apps";
import { getWindowsSystemSnapshot, invalidateWindowsSystemSnapshot, type WindowsProcessInfo, type WindowsSystemSnapshot } from "../windows-platform";
import { idleRuntime } from "./protocol";

const execute = promisify(execFile);
const genericRuntime = /^(?:electron|node|nodejs|powershell|pwsh|cmd|bash|zsh|sh|npm|npx|pnpm|yarn|corepack)(?:\.exe|\.cmd)?$/i;
function unknown(detail: string): LocalAppRuntime { return { ...idleRuntime(), status: "unknown", statusDetail: detail }; }

export function appProcessPaths(config: LocalAppConfig, platform = process.platform): string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (config.mode === "service") return config.serviceProcess ? [config.serviceProcess] : [];
  const identities = new Set<string>();
  const tokens = [...config.command.matchAll(/"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"';&|]+)/g)].map(match => match[1] || match[2] || match[3]);
  for (const token of tokens) {
    if (token.startsWith("-") || token.includes("{") || !/\.(?:exe|[cm]?js|ps1)$|\.app(?:\/Contents\/MacOS\/.+)?$/i.test(token)) continue;
    if (genericRuntime.test(paths.basename(token))) continue;
    if (paths.isAbsolute(token) || config.cwd) identities.add(paths.resolve(config.cwd, token));
  }
  if (config.cwd) {
    identities.add(paths.join(config.cwd, "node_modules/electron/dist", platform === "win32" ? "electron.exe" : platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron"));
    if (/\.app$/i.test(config.cwd)) identities.add(config.cwd);
  }
  return [...identities];
}

function hasPath(command: string, identity: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => platform === "win32" ? value.replaceAll("\\", "/").toLowerCase() : value;
  const text = normalize(command), needle = normalize(identity);
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    if ((at === 0 || /[\s"']/.test(text[at - 1])) && (at + needle.length === text.length || /[\s"']/.test(text[at + needle.length]) || (needle.endsWith(".app") && text.slice(at + needle.length).startsWith("/Contents/MacOS/")))) return true;
  }
  return false;
}

export function processRuntimeFromSnapshot(config: LocalAppConfig, snapshot: WindowsSystemSnapshot, platform: NodeJS.Platform = process.platform): LocalAppRuntime {
  const identities = appProcessPaths(config, platform);
  const service = config.mode === "service";
  const ports = service ? [config.servicePort] : [config.cdpPort, config.inspectPort];
  const owners = new Set(snapshot.tcp.filter(item => ports.includes(item.localPort) && item.state.toLowerCase() === "listen").map(item => item.pid));
  const candidates = snapshot.processes.filter(item => !/(?:^|\s)--type=/.test(item.commandLine)
    && !/^(?:cmd(?:\.exe)?|sh|bash|zsh)$/i.test(item.name)
    && !(/^(?:powershell|pwsh)(?:\.exe)?$/i.test(item.name) && /(?:^|\s)-(?:command|encodedcommand|c|ec)\b/i.test(item.commandLine)));
  const matches = (item: WindowsProcessInfo) => identities.some(identity => hasPath(item.executablePath || "", identity, platform) || hasPath(item.commandLine, identity, platform));
  const matchingProcesses = candidates.filter(matches);
  const matching = matchingProcesses.find(item => owners.has(item.pid)) || (matchingProcesses.length === 1 ? matchingProcesses[0] : undefined);
  if (matching) return { ...idleRuntime(), status: "running", pid: matching.pid, startedAt: matching.startedAt, ...(service ? { serviceReady: owners.has(matching.pid) } : {}) };
  if (matchingProcesses.length > 1) return unknown("检测到多个匹配进程，暂时无法确认当前应用的服务实例，请检查应用状态。");
  const unreadable = (item: WindowsProcessInfo) => !item.commandLine.trim() || [item.name, item.executablePath].some(value => value && value.toLowerCase() === item.commandLine.trim().toLowerCase());
  const ownerProcesses = snapshot.processes.filter(item => owners.has(item.pid));
  if (owners.size > ownerProcesses.length || ownerProcesses.some(unreadable)) return unknown("服务端口正在监听，但系统未提供足够的进程信息，暂时无法确认是否属于此应用。请在应用托盘或窗口中确认运行状态。");
  if (snapshot.processesAvailable === false || snapshot.tcpAvailable === false) return unknown("系统进程或端口信息暂时无法读取，请稍后检查应用状态。");
  const names = new Set(identities.map(identity => (platform === "win32" ? path.win32 : path.posix).basename(identity).toLowerCase()).filter(name => !genericRuntime.test(name)));
  if (candidates.some(item => unreadable(item) && names.has(item.name.toLowerCase()))) return unknown("系统未允许读取应用进程的信息，暂时无法确认运行状态。");
  if (!identities.length && config.mode === "attach") return unknown("尚未发现调试连接，暂时无法确认应用是否仍在运行。");
  return idleRuntime();
}

export function windowsServiceRuntime(config: LocalAppConfig, snapshot: WindowsSystemSnapshot): LocalAppRuntime {
  return processRuntimeFromSnapshot({ ...config, mode: "service" }, snapshot, "win32");
}

let posixProcesses: { expires: number; value: Promise<WindowsProcessInfo[]> } | undefined;
export function invalidateProcessRuntime(): void { posixProcesses = undefined; invalidateWindowsSystemSnapshot(); }
function readPosixProcesses(): Promise<WindowsProcessInfo[]> {
  if (posixProcesses && posixProcesses.expires > Date.now()) return posixProcesses.value;
  const value = execute("ps", ["-axo", "pid=,command="], { timeout: 4000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } }).then(({ stdout }) => stdout.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parentPid: 0, name: path.posix.basename(match[2].split(/\s/)[0]), commandLine: match[2], executablePath: null, startedAt: null }] : [];
  }));
  posixProcesses = { expires: Date.now() + 750, value };
  return value;
}

// Read OS listeners without connecting: some tray apps treat even an empty TCP
// probe as an incoming delivery. macOS uses ps/lsof; Windows uses CIM/netstat.
export async function processRuntime(config: LocalAppConfig): Promise<LocalAppRuntime> {
  try {
    if (process.platform === "win32") return processRuntimeFromSnapshot(config, await getWindowsSystemSnapshot());
    const processes = await readPosixProcesses();
    const ports = (config.mode === "service" ? [config.servicePort] : [config.cdpPort, config.inspectPort]).filter((value): value is number => !!value);
    const tcp: WindowsSystemSnapshot["tcp"] = [];
    for (const port of ports) {
      try {
        const { stdout } = await execute("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { timeout: 4000 });
        for (const line of stdout.split("\n")) if (/^p\d+$/.test(line)) tcp.push({ pid: Number(line.slice(1)), state: "Listen", localPort: port, localAddress: "", remotePort: 0, remoteAddress: "" });
      } catch (error) { if ((error as { code?: number }).code !== 1) return unknown("系统端口信息暂时无法读取，请稍后检查应用状态。"); }
    }
    return processRuntimeFromSnapshot(config, { processes, tcp });
  } catch { return unknown("系统进程信息暂时无法读取，请稍后检查应用状态。"); }
}

export const serviceRuntime = processRuntime;
