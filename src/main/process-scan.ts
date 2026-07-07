import { existsSync } from "node:fs";
import path from "node:path";
import type {
  CdpClientInfo,
  ExternalChromeInstance
} from "../shared/types";
import { isValidTcpPort, makeCdpUrl, parseRemoteDebuggingPort, requestCdpVersionInfo } from "./cdp-client";
import { POSIX_LOCALE_ENV, compareNumbers, earlierIsoDate, execFileAsync, uniqueNumbers } from "./fs-util";
import { RuntimeProfile } from "./internal-types";
import { resolveClientContexts } from "./session-context";

export function makeNativeRuntimeKey(dirName: string): string {
  return `native:${dirName}`;
}

const PROFILE_OPEN_FILE_RELATIVE_PATHS = [
  "History",
  "Cookies",
  "Web Data",
  "Login Data",
  "Favicons",
  "Top Sites",
  path.join("Local Storage", "leveldb", "LOCK"),
  path.join("Session Storage", "LOCK")
];

export function parseRuntimeProcess(line: string): (RuntimeProfile & { pid: number; command: string }) | null {
  const match = line.match(
    /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/
  );
  if (!match) {
    return null;
  }

  const pid = Number(match[1]);
  const startedAt = parsePsStartTime(match[2]);
  const command = match[3];

  return {
    pid,
    pids: [pid],
    startedAt,
    cdpPort: parseRemoteDebuggingPort(command),
    listeningPorts: [],
    command
  };
}

export function parsePsStartTime(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

export function addRuntimeProcess(
  runtime: Map<string, RuntimeProfile>,
  key: string,
  processInfo: RuntimeProfile & { pid: number }
): void {
  const profile = runtime.get(key) || emptyRuntimeProfile();
  if (!profile.pids.includes(processInfo.pid)) {
    profile.pids.push(processInfo.pid);
  }
  profile.startedAt = earlierIsoDate(profile.startedAt, processInfo.startedAt);
  profile.cdpPort = profile.cdpPort || processInfo.cdpPort;
  profile.listeningPorts = uniqueNumbers(profile.listeningPorts.concat(processInfo.listeningPorts)).sort(compareNumbers);
  runtime.set(key, profile);
}

export async function attachListeningPorts(runtime: Map<string, RuntimeProfile>): Promise<void> {
  const knownPids = new Set<number>();
  for (const profile of runtime.values()) {
    for (const pid of profile.pids) {
      knownPids.add(pid);
    }
  }

  if (!knownPids.size) {
    return;
  }

  const portsByPid = await getListeningPortsByPid(knownPids);
  for (const profile of runtime.values()) {
    const listeningPorts = profile.pids.flatMap((pid) => portsByPid.get(pid) || []);
    profile.listeningPorts = uniqueNumbers(profile.listeningPorts.concat(listeningPorts)).sort(compareNumbers);
  }
}

export async function getListeningPortsByPid(targetPids: Set<number>): Promise<Map<number, number[]>> {
  const portsByPid = new Map<number, number[]>();

  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      maxBuffer: 1024 * 1024 * 8
    });

    for (const line of stdout.split("\n")) {
      const pid = parseLsofPid(line);
      if (!pid || !targetPids.has(pid)) {
        continue;
      }

      const port = parseLsofListeningPort(line);
      if (!port) {
        continue;
      }

      portsByPid.set(pid, uniqueNumbers([...(portsByPid.get(pid) || []), port]).sort(compareNumbers));
    }
  } catch {
    return portsByPid;
  }

  return portsByPid;
}

export async function getOpenProfilePidsByPath(profilePaths: string[]): Promise<Map<string, number[]>> {
  const profileByCandidatePath = new Map<string, string>();
  for (const profilePath of profilePaths) {
    for (const relativePath of PROFILE_OPEN_FILE_RELATIVE_PATHS) {
      const candidatePath = path.join(profilePath, relativePath);
      if (existsSync(candidatePath)) {
        profileByCandidatePath.set(candidatePath, profilePath);
      }
    }
  }

  if (!profileByCandidatePath.size) {
    return new Map();
  }

  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(
      "lsof",
      ["-nP", "-F", "pn", "--", ...profileByCandidatePath.keys()],
      { maxBuffer: 1024 * 1024 * 8 }
    ));
  } catch {
    return new Map();
  }

  const pidsByProfile = new Map<string, number[]>();
  let currentPid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      currentPid = Number.isInteger(pid) && pid > 0 ? pid : null;
      continue;
    }

    if (!line.startsWith("n") || currentPid === null) {
      continue;
    }

    const profilePath = profileByCandidatePath.get(line.slice(1));
    if (!profilePath) {
      continue;
    }
    pidsByProfile.set(profilePath, uniqueNumbers([...(pidsByProfile.get(profilePath) || []), currentPid]));
  }

  return pidsByProfile;
}

export function parseLsofPid(line: string): number | null {
  const match = line.trim().match(/^\S+\s+(\d+)\s+/);
  if (!match || line.trim().startsWith("COMMAND")) {
    return null;
  }

  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function parseLsofListeningPort(line: string): number | null {
  const match = line.match(/TCP\s+.*:(\d+)\s+\(LISTEN\)$/);
  if (!match) {
    return null;
  }

  const port = Number(match[1]);
  return isValidTcpPort(port) ? port : null;
}

// 检测“谁在持久连接这些 CDP 端口”：找连向 127.0.0.1:<端口> 的 ESTABLISHED 客户端 socket
// （形如 本地:xxxx->127.0.0.1:<端口>），持有方就是 agent-browser / Playwright / DevTools 等驱动工具。
// 工具无关：任何 CDP 客户端都走同一个本机 TCP 端口；WebSocket 长连接常驻 ESTABLISHED，能稳定抓到。
export async function getCdpClientsByPort(ports: number[]): Promise<Map<number, CdpClientInfo[]>> {
  const result = new Map<number, CdpClientInfo[]>();
  const targetPorts = uniqueNumbers(ports.filter((port) => isValidTcpPort(port)));
  if (!targetPorts.length) {
    return result;
  }
  const portSet = new Set(targetPorts);

  // 注意：不要按 `-iTCP:<port>` 逐端口过滤——只要其中某个端口当前没有连接，
  // lsof 就会以非零码退出（即便其它端口有有效输出），execFileAsync 会因此 reject 把有效结果一起丢掉。
  // 这里列出全部 ESTABLISHED TCP，再用下面的 portSet 在代码里过滤，稳。
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-Fpcn"], {
      maxBuffer: 1024 * 1024 * 8
    }));
  } catch {
    return result;
  }

  let pid: number | null = null;
  let label = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1)) || null;
      label = "";
      continue;
    }
    if (line.startsWith("c")) {
      label = line.slice(1).trim();
      continue;
    }
    if (line.startsWith("n") && pid !== null) {
      // 排除当前进程自己（快路径；所有 ProfilePilot 实例的排除见下面 dropOwnAppClients）。
      if (pid === process.pid) {
        continue;
      }
      const port = parseCdpClientRemotePort(line.slice(1));
      if (port === null || !portSet.has(port)) {
        continue;
      }
      const clients = result.get(port) || [];
      if (!clients.some((client) => client.pid === pid)) {
        clients.push({ pid, label: label || "unknown" });
      }
      result.set(port, clients);
    }
  }

  await dropOwnAppClients(result);
  await applyClientContexts(result);
  return result;
}

// 排除所有 ProfilePilot 进程（按可执行文件路径识别，覆盖其它实例）：
// 实时画面截图和 tab 争用观测都会对 live 端口保持只读长连接——观察者不该出现在
// “驱动工具”名单里，也不该被算进多会话争用的活跃连接数。
// 注意只按“可执行路径 == 本进程 execPath”精确匹配，绝不能按进程名 Electron 过滤——
// VS Code 等一大票工具都是 Electron 壳，它们连 CDP 时可能是真驱动。
// ps 查询失败或查不到某 pid 时保守放行（宁可多显示，不可漏掉真驱动方）。
async function dropOwnAppClients(byPort: Map<number, CdpClientInfo[]>): Promise<void> {
  const pids = uniqueNumbers([...byPort.values()].flat().map((client) => client.pid));
  if (!pids.length) {
    return;
  }

  const ownPids = new Set<number>();
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,comm=", "-p", pids.join(",")], {
      maxBuffer: 1024 * 1024
    });
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
      if (match && match[2] === process.execPath) {
        ownPids.add(Number(match[1]));
      }
    }
  } catch {
    return;
  }

  if (!ownPids.size) {
    return;
  }
  for (const [port, clients] of byPort) {
    const kept = clients.filter((client) => !ownPids.has(client.pid));
    if (kept.length) {
      byPort.set(port, kept);
    } else {
      byPort.delete(port);
    }
  }
}

// lsof 抓到的进程名往往没信息量（node）或只是驱动名（agent-browser）。这里翻命令行/cwd/会话档案，
// 把每条连接补成“工具名 + 项目 + 会话标题”，供 UI 显示与悬停 tooltip。
async function applyClientContexts(byPort: Map<number, CdpClientInfo[]>): Promise<void> {
  const clients: CdpClientInfo[] = [];
  for (const list of byPort.values()) {
    clients.push(...list);
  }
  if (!clients.length) {
    return;
  }
  const contexts = await resolveClientContexts(clients);
  for (const client of clients) {
    const context = contexts.get(client.pid);
    if (!context) {
      continue;
    }
    client.label = context.label;
    client.agent = context.agent;
    client.project = context.project;
    client.title = context.title;
    client.session = context.session;
    client.lastActive = context.lastActive;
    client.note = context.note;
  }
}

// 只认“客户端那一端”：本地:xxxx->远端:<port>，远端端口才是被连接的 CDP 端口。
// Chrome 自己的 accept socket 是 <port>->对端:xxxx，远端端口不是 CDP 端口，会被排除。
export function parseCdpClientRemotePort(name: string): number | null {
  const match = name.match(/->\S*?:(\d+)$/);
  if (!match) {
    return null;
  }
  const port = Number(match[1]);
  return isValidTcpPort(port) ? port : null;
}

export function mergeRuntimeProfiles(...profiles: Array<RuntimeProfile | undefined>): RuntimeProfile {
  return profiles.reduce<RuntimeProfile>(
    (merged, profile) => {
      if (!profile) {
        return merged;
      }

      return {
        pids: uniqueNumbers(merged.pids.concat(profile.pids)),
        startedAt: earlierIsoDate(merged.startedAt, profile.startedAt),
        cdpPort: merged.cdpPort || profile.cdpPort,
        listeningPorts: uniqueNumbers(merged.listeningPorts.concat(profile.listeningPorts)).sort(compareNumbers)
      };
    },
    emptyRuntimeProfile()
  );
}

export function emptyRuntimeProfile(): RuntimeProfile {
  return { pids: [], startedAt: null, cdpPort: null, listeningPorts: [] };
}

export function isImplicitDefaultChromeProcess(command: string): boolean {
  return (
    isGoogleChromeMainProcess(command) &&
    !command.includes("--profile-directory=") &&
    !command.includes("--user-data-dir=")
  );
}

export function isGoogleChromeMainProcess(command: string): boolean {
  if (command.includes("--type=") || command.includes("chrome_crashpad_handler")) {
    return false;
  }

  if (process.platform === "darwin") {
    return command.includes("/Google Chrome.app/Contents/MacOS/Google Chrome");
  }

  if (process.platform === "win32") {
    return /(^|[\\\s])chrome\.exe(\s|$)/i.test(command);
  }

  return /(^|\s)(\/\S+\/)?(google-chrome|google-chrome-stable|chromium|chromium-browser|chrome)(\s|$)/.test(
    command
  );
}

export const GENERIC_DIR_SEGMENTS = new Set([
  "user-data",
  "user_data",
  "userdata",
  "user data",
  "data",
  "default",
  "profile",
  "profiles",
  "browser",
  "browsers",
  "chrome",
  "chromium",
  "tmp"
]);

// 识别非本工具、非系统 Chrome 的 Chromium 系浏览器主进程（agent-browser、bb-browser 等
// 工具会用自带的 Chrome for Testing / Chromium 加自管 user-data-dir 启动）。
export function isChromiumBrowserMainProcess(command: string): boolean {
  if (command.includes("--type=") || command.includes("chrome_crashpad_handler")) {
    return false;
  }

  if (process.platform === "darwin") {
    return /\/Contents\/MacOS\/(Google Chrome( for Testing| Beta| Dev| Canary)?|Chromium|Microsoft Edge|Brave Browser)(\s|$)/.test(
      command
    );
  }

  return isGoogleChromeMainProcess(command);
}

export function parseExternalBrowserName(command: string): string {
  const match = command.match(
    /\/Contents\/MacOS\/(Google Chrome( for Testing| Beta| Dev| Canary)?|Chromium|Microsoft Edge|Brave Browser)(\s|$)/
  );
  return match ? match[1] : "Chromium";
}

// ps 输出不带引号，路径里可能有空格；取到下一个“ --flag”或行尾为止。
export function parseUserDataDirFlag(command: string): string | null {
  const match = command.match(/--user-data-dir=(.*?)(?=\s+--|$)/);
  const value = match?.[1]?.trim();
  return value || null;
}

export function externalInstanceLabel(userDataDir: string): string {
  const segments = userDataDir.split(path.sep).filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    const normalized = segment.replace(/^\./, "").toLowerCase();
    if (!GENERIC_DIR_SEGMENTS.has(normalized)) {
      return segment.replace(/^\./, "");
    }
  }

  return path.basename(userDataDir) || userDataDir;
}

export async function findExternalChromeInstances(knownUserDataDirs: string[]): Promise<ExternalChromeInstance[]> {
  const known = new Set(knownUserDataDirs.map((dir) => dir.replace(/\/+$/, "")));

  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("ps", ["-axo", "pid=,lstart=,command="], {
      maxBuffer: 1024 * 1024 * 8,
      env: POSIX_LOCALE_ENV
    }));
  } catch {
    return [];
  }

  const byDir = new Map<string, ExternalChromeInstance>();
  for (const line of stdout.split("\n")) {
    const processInfo = parseRuntimeProcess(line);
    if (!processInfo || !isChromiumBrowserMainProcess(processInfo.command)) {
      continue;
    }

    const userDataDir = parseUserDataDirFlag(processInfo.command);
    if (!userDataDir || known.has(userDataDir.replace(/\/+$/, ""))) {
      continue;
    }

    const existing = byDir.get(userDataDir);
    if (existing) {
      continue;
    }

    byDir.set(userDataDir, {
      userDataDir,
      label: externalInstanceLabel(userDataDir),
      browser: parseExternalBrowserName(processInfo.command),
      pid: processInfo.pid,
      startedAt: processInfo.startedAt,
      cdpPort: processInfo.cdpPort,
      cdpUrl: null,
      // 无头实例（agent-browser 默认 --headless=new）没有可见窗口，无法“显示”。
      headless: /--headless(=|\s|$)/.test(processInfo.command)
    });
  }

  const instances = [...byDir.values()];
  await Promise.all(
    instances.map(async (instance) => {
      if (instance.cdpPort === null) {
        return;
      }
      try {
        await requestCdpVersionInfo(instance.cdpPort);
        instance.cdpUrl = makeCdpUrl(instance.cdpPort);
      } catch {
        // 声明了端口但当前不可达，保留端口号、不给出可用地址。
      }
    })
  );

  return instances.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
}

export async function isChromeRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], {
      maxBuffer: 1024 * 1024 * 8,
      env: POSIX_LOCALE_ENV
    });
    return stdout
      .split("\n")
      .some((line) => line.includes("Google Chrome.app/Contents/MacOS/Google Chrome") || line.includes("Google Chrome Helper"));
  } catch {
    return true;
  }
}

export async function getChromeProcessPids(): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
      maxBuffer: 1024 * 1024 * 8,
      env: POSIX_LOCALE_ENV
    });

    return uniqueNumbers(
      stdout
        .split("\n")
        .map((line) => {
          const match = line.trim().match(/^(\d+)\s+(.*)$/);
          if (!match) {
            return null;
          }

          const command = match[2];
          if (!command.includes("Google Chrome.app/Contents/MacOS/Google Chrome") && !command.includes("Google Chrome Helper")) {
            return null;
          }

          const pid = Number(match[1]);
          return Number.isInteger(pid) && pid > 0 ? pid : null;
        })
        .filter((pid): pid is number => pid !== null)
    );
  } catch {
    return [];
  }
}
