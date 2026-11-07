import { existsSync, promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  CdpClientInfo,
  ExternalChromeInstance
} from "../shared/types";
import {
  readAgentBrowserProfileLeaseSync,
  type AgentBrowserProfileLease
} from "./agent-browser-lease";
import { readActiveAgentBrowserSessionActivityClientsByPort } from "./agent-browser-session";
import { isValidTcpPort, makeCdpUrl, parseRemoteDebuggingPort, requestCdpVersionInfo } from "./cdp-client";
import { POSIX_LOCALE_ENV, compareNumbers, earlierIsoDate, execFileAsync, uniqueNumbers } from "./fs-util";
import { RuntimeProfile } from "./internal-types";
import { profileFileProcessChanged, type ProfileProcessChangeDetails } from './profile-process-change';
import { resolveClientContexts } from "./session-context";
import { findWindowsProcessesLockingPaths, findWindowsProcessIdentitiesLockingPaths, collectWindowsControlSample, createWindowsReadContext, getWindowsSystemSnapshot, type WindowsProcessInfo, type WindowsSystemEvidence, type WindowsControlSample } from "./windows-platform";
import type { WindowsSamplerReadContext } from './windows-sampler';
import { isWindowsCreationFileTime, type WindowsSamplerIdentityReason } from './windows-sampler-protocol';

export interface ControlDiscovery {
  snapshotId: string;
  capturedAt: number;
  // Complete process enumeration and all unscoped discovery steps succeeded.
  // A scoped gap still prevents admitting every process in its impact set.
  complete: true;
  processPids: number[];
  scopedGaps: { code: 'PROFILE_BROWSER_COMMAND_LINE_UNAVAILABLE'; processPids: number[] }[];
}

export interface RuntimeScanOptions {
  strict?: boolean;
  processes?: RuntimeProcessInfo[];
  windowsSnapshot?: WindowsSystemEvidence;
  windowsReadContext?: WindowsSamplerReadContext;
  // Internal until ProfileStateReader completes every strict discovery step.
  controlDiscovery?: ControlDiscovery;
}

// One control-admission collection shares the exact process/TCP evidence that
// produced its catalog. A later successful scan cannot certify earlier rows.
export async function createControlRuntimeScan(windowsSample?: Promise<WindowsControlSample>): Promise<RuntimeScanOptions> {
  let capturedAt = Date.now(), snapshotId: string = randomUUID();
  const options: RuntimeScanOptions = { strict: true };
  if (windowsSample && process.platform !== 'win32') throw new Error('PROFILE_WINDOWS_SAMPLE_UNSUPPORTED');
  if (process.platform === 'win32') {
    // Even compatibility samples without an internal context consume the
    // original call's fixed budget while pending, not a fresh post-await one.
    const fallbackContext = createWindowsReadContext();
    const sample = await (windowsSample || collectWindowsControlSample(fallbackContext));
    {
      if (!sample || !sample.snapshot || typeof sample.snapshotId !== 'string' || !sample.snapshotId.trim() || !Number.isFinite(sample.capturedAt) || sample.capturedAt < 0)
        throw new Error('PROFILE_WINDOWS_SAMPLE_INVALID');
      capturedAt = sample.capturedAt; snapshotId = sample.snapshotId;
    }
    options.windowsReadContext = sample.context || fallbackContext;
    const snapshot = options.windowsSnapshot = sample.snapshot;
    requireWindowsEvidence(snapshot, options);
    const processPids = snapshot.processes.map(item => item.pid);
    if (processPids.some(pid => !Number.isSafeInteger(pid) || pid <= 0) || new Set(processPids).size !== processPids.length)
      throw new Error('PROFILE_PROCESS_SCAN_INVALID_ROW');
    const affected = unavailableBrowserImpact(snapshot.processes);
    options.controlDiscovery = { snapshotId, capturedAt, complete: true, processPids,
      scopedGaps: affected.length ? [{ code: 'PROFILE_BROWSER_COMMAND_LINE_UNAVAILABLE', processPids: affected }] : [] };
  }
  options.processes = await listRuntimeProcesses(options);
  options.controlDiscovery ||= { snapshotId, capturedAt, complete: true,
    processPids: options.processes.map(item => item.pid), scopedGaps: [] };
  return options;
}

function unavailableBrowserCommandLine(item: WindowsProcessInfo): boolean {
  return item.commandLineAvailable !== true && isChromiumBrowserMainProcess(item.executablePath || item.name);
}

function unavailableBrowserImpact(processes: readonly WindowsProcessInfo[]): number[] {
  const byPid = new Map(processes.map(item => [item.pid, item]));
  const affected = new Set<number>();
  for (const item of processes.filter(unavailableBrowserCommandLine)) {
    affected.add(item.pid);
    // The existing file/profile mapper can attribute a child to a browser
    // ancestor. Include those dependencies, even through non-browser parents.
    const seen = new Set<number>();
    let current = byPid.get(item.parentPid);
    while (current && !seen.has(current.pid)) {
      seen.add(current.pid);
      if (isChromiumBrowserMainProcess(current.executablePath || current.name) ||
        (current.commandLineAvailable === true && isChromiumBrowserMainProcess(current.commandLine))) affected.add(current.pid);
      current = byPid.get(current.parentPid);
    }
  }
  // Include every descendant, regardless of executable name. A target is
  // excluded only by membership in this complete same-scan dependency set.
  const children = new Map<number, number[]>();
  for (const item of processes) {
    const values = children.get(item.parentPid) || [];
    values.push(item.pid); children.set(item.parentPid, values);
  }
  const pending = [...affected];
  for (let index = 0; index < pending.length; index++) for (const pid of children.get(pending[index]) || []) {
    if (!affected.has(pid)) { affected.add(pid); pending.push(pid); }
  }
  return [...affected].sort((left, right) => left - right);
}

function windowsCommand(item: WindowsProcessInfo, strict?: boolean): string {
  // imagePath/name is useful display fallback, never evidence of Default,
  // user-data-dir, profile-directory, or a main browser process in strict mode.
  return strict && item.commandLineAvailable !== true ? '' : item.commandLine;
}

function requireWindowsEvidence(snapshot: WindowsSystemEvidence, options: RuntimeScanOptions, tcp = false): void {
  if (!options.strict) return;
  if (snapshot.processesAvailable !== true || snapshot.processesComplete !== true) throw new Error('PROFILE_PROCESS_SCAN_INCOMPLETE');
  if (tcp && (snapshot.tcpAvailable !== true || snapshot.tcpComplete !== true)) throw new Error('PROFILE_TCP_SCAN_INCOMPLETE');
}

function emptyLsofResult(error: unknown): boolean {
  const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
  return failure?.code === 1 && String(failure.stdout || '').trim() === '' && String(failure.stderr || '').trim() === '';
}

export type RuntimeProcessInfo = RuntimeProfile & {
  pid: number;
  command: string;
  parentPid?: number;
  executablePath?: string | null;
  creationFileTime?: string | null;
  identityStatus?: 'confirmed' | 'unavailable';
  identityReason?: WindowsSamplerIdentityReason;
};

export function requireWindowsRuntimeIdentity(row: RuntimeProcessInfo, options: RuntimeScanOptions): void {
  if (!options.strict || process.platform !== 'win32' || !options.windowsSnapshot) return;
  const original = options.windowsSnapshot.processes.find(value => value.pid === row.pid);
  if (!original || original.identityStatus !== 'confirmed' || row.identityStatus !== 'confirmed'
      || !isWindowsCreationFileTime(original.creationFileTime) || row.creationFileTime !== original.creationFileTime) {
    const unavailable = !original || original.identityStatus !== 'confirmed' || row.identityStatus !== 'confirmed';
    const identityReason = original?.identityStatus !== 'confirmed' ? original?.identityReason : row.identityReason;
    throw profileFileProcessChanged('profile_runtime_birth_join', row.pid, options.windowsSnapshot.processes.length, options.controlDiscovery,
      { origin: 'runtime_profile', reason: unavailable ? 'unavailable' : !isWindowsCreationFileTime(original.creationFileTime) || !isWindowsCreationFileTime(row.creationFileTime) ? 'invalid_birth' : 'birth_mismatch',
        ...(unavailable && identityReason ? { identityReason } : {}) });
  }
}

function requireWindowsIdentity(row: WindowsProcessInfo, options: RuntimeScanOptions, stage: 'windows_rm_birth_join' | 'windows_parent_identity',
  origin: ProfileProcessChangeDetails['origin']): string {
  if (row.identityStatus !== 'confirmed' || !isWindowsCreationFileTime(row.creationFileTime))
    throw profileFileProcessChanged(stage, row.pid, options.windowsSnapshot?.processes.length || 0, options.controlDiscovery,
      { origin, reason: row.identityStatus !== 'confirmed' ? 'unavailable' : 'invalid_birth',
        ...(row.identityStatus !== 'confirmed' && row.identityReason ? { identityReason: row.identityReason } : {}) });
  return row.creationFileTime;
}
function windowsParent(row: WindowsProcessInfo, byPid: Map<number, WindowsProcessInfo>, options: RuntimeScanOptions): WindowsProcessInfo | undefined {
  const parent = byPid.get(row.parentPid);
  if (options.strict && parent) {
    const birth = requireWindowsIdentity(row, options, 'windows_parent_identity', 'parent_chain'), parentBirth = requireWindowsIdentity(parent, options, 'windows_parent_identity', 'parent_chain');
    if (BigInt(parentBirth) > BigInt(birth)) throw profileFileProcessChanged('windows_parent_identity', parent.pid, byPid.size, options.controlDiscovery, { origin: 'parent_chain', reason: 'parent_newer' });
  }
  return parent;
}

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
    browserPids: isChromiumBrowserMainProcess(command) ? [pid] : [],
    startedAt,
    cdpPort: parseRemoteDebuggingPort(command),
    listeningPorts: [],
    command
  };
}

export async function listRuntimeProcesses(options: RuntimeScanOptions = {}): Promise<RuntimeProcessInfo[]> {
  if (options.processes) return options.processes;
  if (process.platform === "win32") {
    const snapshot = options.windowsSnapshot || await getWindowsSystemSnapshot();
    requireWindowsEvidence(snapshot, options);
    const scoped = new Set(options.controlDiscovery?.scopedGaps.flatMap(gap => gap.processPids));
    if (options.strict && snapshot.processes.some(item => unavailableBrowserCommandLine(item) && !scoped.has(item.pid)))
      throw new Error('PROFILE_BROWSER_COMMAND_LINE_UNAVAILABLE');
    return snapshot.processes.map((processInfo) => ({
      pid: processInfo.pid,
      parentPid: processInfo.parentPid,
      executablePath: processInfo.executablePath,
      ...(processInfo.identityStatus ? { identityStatus: processInfo.identityStatus, creationFileTime: processInfo.creationFileTime,
        ...(processInfo.identityReason ? { identityReason: processInfo.identityReason } : {}) } : {}),
      pids: [processInfo.pid],
      browserPids: isChromiumBrowserMainProcess(windowsCommand(processInfo, options.strict)) ? [processInfo.pid] : [],
      startedAt: processInfo.startedAt,
      cdpPort: parseRemoteDebuggingPort(windowsCommand(processInfo, options.strict)),
      listeningPorts: [],
      command: windowsCommand(processInfo, options.strict)
    }));
  }
  const { stdout, stderr } = await execFileAsync("ps", [...(options.strict ? ['-ww'] : []), "-axo", "pid=,lstart=,command="], {
    maxBuffer: 1024 * 1024 * 8,
    ...(options.strict ? { timeout: 8000 } : {}),
    env: POSIX_LOCALE_ENV
  });
  if (options.strict && String(stderr || '').trim()) throw new Error('PROFILE_PROCESS_SCAN_INCOMPLETE');
  const rows = stdout.split("\n").filter(line => line.trim());
  if (options.strict && !rows.length) throw new Error('PROFILE_PROCESS_SCAN_EMPTY');
  const seen = new Set<number>();
  const processes = rows.flatMap((line) => {
    if (options.strict && /^\s*0\s/.test(line)) return []; // Kernel PID is not a browser/window candidate.
    const processInfo = parseRuntimeProcess(line);
    if (options.strict && (!processInfo || !Number.isSafeInteger(processInfo.pid) || processInfo.pid <= 0 || !processInfo.startedAt || !processInfo.command.trim()))
      throw new Error('PROFILE_PROCESS_SCAN_INVALID_ROW');
    if (options.strict && processInfo && seen.has(processInfo.pid)) throw new Error('PROFILE_PROCESS_SCAN_INVALID_ROW');
    if (processInfo) seen.add(processInfo.pid);
    return processInfo ? [processInfo] : [];
  });
  if (options.strict && !processes.length) throw new Error('PROFILE_PROCESS_SCAN_EMPTY');
  return processes;
}

export function parsePsStartTime(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function laterIsoDate(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime)) {
    return right;
  }
  if (!Number.isFinite(rightTime)) {
    return left;
  }
  return rightTime > leftTime ? right : left;
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
  profile.browserPids = uniqueNumbers([...(profile.browserPids || []), ...(processInfo.browserPids || [])]);
  profile.startedAt = earlierIsoDate(profile.startedAt, processInfo.startedAt);
  profile.cdpPort = profile.cdpPort || processInfo.cdpPort;
  profile.listeningPorts = uniqueNumbers(profile.listeningPorts.concat(processInfo.listeningPorts)).sort(compareNumbers);
  runtime.set(key, profile);
}

export async function attachListeningPorts(runtime: Map<string, RuntimeProfile>, options: RuntimeScanOptions = {}): Promise<void> {
  const knownPids = new Set<number>();
  for (const profile of runtime.values()) {
    for (const pid of profile.pids) {
      knownPids.add(pid);
    }
  }

  if (!knownPids.size) {
    return;
  }

  const portsByPid = await getListeningPortsByPid(knownPids, options);
  for (const profile of runtime.values()) {
    const listeningPorts = profile.pids.flatMap((pid) => portsByPid.get(pid) || []);
    profile.listeningPorts = uniqueNumbers(profile.listeningPorts.concat(listeningPorts)).sort(compareNumbers);
  }
}

export async function getListeningPortsByPid(targetPids: Set<number>, options: RuntimeScanOptions = {}): Promise<Map<number, number[]>> {
  const portsByPid = new Map<number, number[]>();

  if (process.platform === "win32") {
    try {
      const snapshot = options.windowsSnapshot || await getWindowsSystemSnapshot();
      requireWindowsEvidence(snapshot, options, true);
      for (const connection of snapshot.tcp) {
        if (connection.state.toLowerCase() !== "listen" || !targetPids.has(connection.pid)) continue;
        if (!isValidTcpPort(connection.localPort)) continue;
        portsByPid.set(
          connection.pid,
          uniqueNumbers([...(portsByPid.get(connection.pid) || []), connection.localPort]).sort(compareNumbers)
        );
      }
    } catch (error) {
      if (options.strict) throw error;
      // Return the empty, conservative snapshot below.
    }
    return portsByPid;
  }

  try {
    const { stdout, stderr } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      maxBuffer: 1024 * 1024 * 8,
      ...(options.strict ? { timeout: 8000 } : {})
    });
    if (options.strict && String(stderr || '').trim()) throw new Error('PROFILE_TCP_SCAN_INCOMPLETE');

    for (const line of stdout.split("\n")) {
      const pid = parseLsofPid(line);
      if (options.strict && line.trim() && !line.trim().startsWith('COMMAND') && !pid) throw new Error('PROFILE_TCP_SCAN_INVALID_ROW');
      if (!pid || !targetPids.has(pid)) {
        continue;
      }

      const port = parseLsofListeningPort(line);
      if (!port) {
        if (options.strict) throw new Error('PROFILE_TCP_SCAN_INVALID_ROW');
        continue;
      }

      portsByPid.set(pid, uniqueNumbers([...(portsByPid.get(pid) || []), port]).sort(compareNumbers));
    }
  } catch (error) {
    if (options.strict && !emptyLsofResult(error)) throw error;
    return portsByPid;
  }

  return portsByPid;
}

export async function getOpenProfilePidsByPath(profilePaths: string[], options: RuntimeScanOptions = {}): Promise<Map<string, number[]>> {
  if (options.strict && process.platform === 'win32') options.windowsReadContext ||= createWindowsReadContext();
  const profileByCandidatePath = new Map<string, string>();
  for (const profilePath of profilePaths) {
    for (const relativePath of PROFILE_OPEN_FILE_RELATIVE_PATHS) {
      const candidatePath = path.join(profilePath, relativePath);
      let exists = options.strict ? false : existsSync(candidatePath);
      if (options.strict) {
        try { exists = (await fs.stat(candidatePath)).isFile(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error; exists = false; }
      }
      if (exists) {
        profileByCandidatePath.set(candidatePath, profilePath);
      }
    }
  }

  if (!profileByCandidatePath.size) {
    return new Map();
  }

  if (process.platform === "win32") {
    try {
      if (options.strict && !options.windowsSnapshot) {
        const scan = await createControlRuntimeScan(collectWindowsControlSample(options.windowsReadContext));
        options.windowsSnapshot = scan.windowsSnapshot; options.controlDiscovery ||= scan.controlDiscovery;
      }
      const snapshot = options.windowsSnapshot || await getWindowsSystemSnapshot();
      requireWindowsEvidence(snapshot, options);
      const associationProcesses = options.strict ? snapshot.processes.map(item => ({ ...item, commandLine: windowsCommand(item, true) })) : snapshot.processes;
      const result = windowsOpenProfilePids(profilePaths, associationProcesses, options);
      const lockers = options.strict
        ? await findWindowsProcessIdentitiesLockingPaths([...profileByCandidatePath.keys()], { context: options.windowsReadContext })
        : new Map([...await findWindowsProcessesLockingPaths([...profileByCandidatePath.keys()])].map(([file, pids]) => [file, pids.map(pid => ({ pid, creationFileTime: '' }))]));
      const processByPid = new Map(associationProcesses.map((processInfo) => [processInfo.pid, processInfo]));
      for (const [candidatePath, pids] of lockers) {
        const profilePath = profileByCandidatePath.get(candidatePath);
        if (!profilePath) continue;
        const resolved = new Set(result.get(profilePath) || []);
        for (const { pid, creationFileTime } of pids) {
          if (options.strict && !processByPid.has(pid)) throw profileFileProcessChanged('windows_rm_pid_join', pid, processByPid.size, options.controlDiscovery);
          if (options.strict && requireWindowsIdentity(processByPid.get(pid)!, options, 'windows_rm_birth_join', 'restart_manager') !== creationFileTime)
            throw profileFileProcessChanged('windows_rm_birth_join', pid, processByPid.size, options.controlDiscovery, { origin: 'restart_manager', reason: 'birth_mismatch' });
          resolved.add(pid);
          let current = processByPid.get(pid);
          const seen = new Set<number>();
          while (current && !seen.has(current.pid)) {
            seen.add(current.pid);
            if (isGoogleChromeMainProcess(current.commandLine)) {
              resolved.add(current.pid);
              break;
            }
            current = windowsParent(current, processByPid, options);
          }
        }
        if (resolved.size) result.set(profilePath, [...resolved]);
      }
      return result;
    } catch (error) {
      if (options.strict) throw error;
      return new Map();
    }
  }

  let stdout = "";
  try {
    const result = await execFileAsync(
      "lsof",
      ["-nP", "-F", "pn", "--", ...profileByCandidatePath.keys()],
      { maxBuffer: 1024 * 1024 * 8, ...(options.strict ? { timeout: 8000 } : {}) }
    );
    if (options.strict && String(result.stderr || '').trim()) throw new Error('PROFILE_FILE_SCAN_INCOMPLETE');
    stdout = result.stdout;
  } catch (error) {
    if (options.strict && !emptyLsofResult(error)) throw error;
    return new Map();
  }

  const pidsByProfile = new Map<string, number[]>();
  let currentPid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      currentPid = Number.isInteger(pid) && pid > 0 ? pid : null;
      if (options.strict && currentPid === null) throw new Error('PROFILE_FILE_SCAN_INVALID_ROW');
      continue;
    }

    // lsof 4.88–4.93.2 emits f even when it was not requested by -F.
    if (line.startsWith('f') && currentPid !== null && line.length > 1) continue;

    if (!line.startsWith("n") || currentPid === null) {
      if (options.strict && line.trim()) throw new Error('PROFILE_FILE_SCAN_INVALID_ROW');
      continue;
    }

    const profilePath = profileByCandidatePath.get(line.slice(1));
    if (!profilePath) {
      if (options.strict) throw new Error('PROFILE_FILE_SCAN_INVALID_PATH');
      continue;
    }
    if (options.strict && options.processes && !options.processes.some(item => item.pid === currentPid)) throw profileFileProcessChanged('posix_lsof_pid_join', currentPid, options.processes.length, options.controlDiscovery);
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
// （形如 本地:xxxx->127.0.0.1:<端口>），持有方就是 agent-browser 等驱动工具。
// 工具无关：任何 CDP 客户端都走同一个本机 TCP 端口；WebSocket 长连接常驻 ESTABLISHED，能稳定抓到。
export async function getCdpClientsByPort(
  ports: number[], options: RuntimeScanOptions = {}, presentation: { includeActivityRepository?: boolean } = {}
): Promise<Map<number, CdpClientInfo[]>> {
  const result = new Map<number, CdpClientInfo[]>();
  const targetPorts = uniqueNumbers(ports.filter((port) => isValidTcpPort(port)));
  if (!targetPorts.length) {
    return result;
  }
  const portSet = new Set(targetPorts);

  if (process.platform === "win32") {
    try {
      const snapshot = options.windowsSnapshot || await getWindowsSystemSnapshot();
      requireWindowsEvidence(snapshot, options, true);
      const processByPid = new Map(snapshot.processes.map((item) => [item.pid, item]));
      for (const connection of snapshot.tcp) {
        if (connection.state.toLowerCase() !== "established" || !portSet.has(connection.remotePort)) continue;
        if (connection.pid <= 0 || connection.pid === process.pid) continue;
        const clients = result.get(connection.remotePort) || [];
        if (!clients.some((client) => client.pid === connection.pid)) {
          const processInfo = processByPid.get(connection.pid);
          clients.push({ pid: connection.pid, label: processInfo?.name.replace(/\.exe$/i, "") || "unknown" });
        }
        result.set(connection.remotePort, clients);
      }
    } catch (error) {
      if (options.strict) throw error;
      // Continue with activity/lease metadata even when the OS snapshot fails.
    }
  } else {

    // 注意：不要按 `-iTCP:<port>` 逐端口过滤——只要其中某个端口当前没有连接，
    // lsof 就会以非零码退出（即便其它端口有有效输出），execFileAsync 会因此 reject 把有效结果一起丢掉。
    // 这里列出全部 ESTABLISHED TCP，再用下面的 portSet 在代码里过滤，稳。
    let stdout = "";
    try {
      const result = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:ESTABLISHED", "-Fpcn"], {
        maxBuffer: 1024 * 1024 * 8,
        ...(options.strict ? { timeout: 8000 } : {})
      });
      if (options.strict && String(result.stderr || '').trim()) throw new Error('PROFILE_TCP_SCAN_INCOMPLETE');
      stdout = result.stdout;
    } catch (error) {
      if (options.strict && !emptyLsofResult(error)) throw error;
      stdout = "";
    }

    let pid: number | null = null;
    let label = "";
    for (const line of stdout.split("\n")) {
      if (line.startsWith("p")) {
        pid = Number(line.slice(1)) || null;
        if (options.strict && (!Number.isSafeInteger(pid) || Number(pid) <= 0)) throw new Error('PROFILE_TCP_SCAN_INVALID_ROW');
        label = "";
        continue;
      }
      if (line.startsWith("c")) {
        if (options.strict && pid === null) throw new Error('PROFILE_TCP_SCAN_INVALID_ROW');
        label = line.slice(1).trim();
        continue;
      }
      if (line.startsWith('f') && pid !== null && line.length > 1) continue;
      if (line.startsWith("n") && pid !== null) {
        const endpoints = line.slice(1).match(/^.+:(\d+)->.+:(\d+)$/);
        if (options.strict && (!endpoints || !isValidTcpPort(Number(endpoints[1])) || !isValidTcpPort(Number(endpoints[2])))) throw new Error('PROFILE_TCP_SCAN_INVALID_ROW');
        if (pid === process.pid) continue;
        const port = parseCdpClientRemotePort(line.slice(1));
        if (port === null || !portSet.has(port)) continue;
        const clients = result.get(port) || [];
        if (!clients.some((client) => client.pid === pid)) clients.push({ pid, label: label || "unknown" });
        result.set(port, clients);
        continue;
      }
      if (options.strict && line.trim()) throw new Error('PROFILE_TCP_SCAN_INVALID_ROW');
    }
  }

  await dropOwnAppClients(result, options);
  await applyClientContexts(result);
  await applyAgentBrowserSessionActivities(result, targetPorts, presentation.includeActivityRepository !== false);
  applyDelegatedAgentBrowserProfileLeases(result, targetPorts);
  collapseDuplicateNamedSessionClients(result);
  // 同端口多条连接按“最近活动”降序：UI 主展示（表格药丸/tooltip 首条/行内时间）取的是
  // clients[0]，必须让活跃的驱动者排前面——否则先连上的残留连接（会话早已结束）会把
  // 刚连上的新会话压进“同时连接”，行上时间显示成几小时前。
  const activeTs = (client: CdpClientInfo): number => {
    const ts = client.lastActive ? Date.parse(client.lastActive) : Number.NaN;
    return Number.isFinite(ts) ? ts : 0;
  };
  for (const clients of result.values()) {
    clients.sort((a, b) => activeTs(b) - activeTs(a));
  }
  return result;
}

// lsof 按进程列连接；同一个命名 Session 在 daemon 异常重启时可能短暂或永久残留多个 PID。
// 对产品控制权来说 owner 是 Session，而不是 daemon 进程，因此这里按 Session 折叠：
//   · 争用统计不会把一个 Session 误报成两个会话；
//   · 仍保留 duplicatePids，让 UI 和回收逻辑能明确诊断/结束残留 daemon。
export function collapseDuplicateNamedSessionClients(byPort: Map<number, CdpClientInfo[]>): void {
  for (const [port, clients] of byPort) {
    const result: CdpClientInfo[] = [];
    const bySession = new Map<string, CdpClientInfo>();
    for (const client of clients) {
      const session = client.session?.trim();
      if (!session) {
        result.push(client);
        continue;
      }
      const existing = bySession.get(session);
      if (!existing) {
        bySession.set(session, client);
        result.push(client);
        continue;
      }
      existing.duplicatePids = [...new Set([...(existing.duplicatePids || []), client.pid, ...(client.duplicatePids || [])])]
        .filter((pid) => pid !== existing.pid)
        .sort(compareNumbers);
      existing.agent = existing.agent || client.agent;
      existing.project = existing.project || client.project;
      existing.branch = existing.branch || client.branch;
      existing.title = existing.title || client.title;
      existing.lastActive = laterIsoDate(existing.lastActive, client.lastActive);
      const duplicateNote = `同一 Session 存在 ${1 + existing.duplicatePids.length} 个 agent-browser daemon（PID ${[
        existing.pid,
        ...existing.duplicatePids
      ].join("、")}）`;
      existing.note = existing.note ? `${existing.note}；${duplicateNote}` : duplicateNote;
    }
    byPort.set(port, result);
  }
}

function applyDelegatedAgentBrowserProfileLeases(
  byPort: Map<number, CdpClientInfo[]>,
  targetPorts: number[],
  homeDir = os.homedir()
): void {
  for (const port of targetPorts) {
    const lease = readAgentBrowserProfileLeaseSync(port, homeDir);
    if (!lease?.delegatedToUser) continue;
    const leaseClient = clientFromDelegatedAgentBrowserProfileLease(lease);
    const clients = byPort.get(port) || [];
    const existing = clients.find(
      (client) => client.session === leaseClient.session || client.pid === leaseClient.pid
    );
    if (existing) {
      existing.agent = existing.agent || leaseClient.agent;
      existing.project = existing.project || leaseClient.project;
      existing.branch = existing.branch || leaseClient.branch;
      existing.title = existing.title || leaseClient.title;
      existing.session = existing.session || leaseClient.session;
      existing.note = existing.note || leaseClient.note;
      existing.lastActive = laterIsoDate(existing.lastActive, leaseClient.lastActive);
    } else {
      clients.push(leaseClient);
    }
    byPort.set(port, clients);
  }
}

export function clientFromDelegatedAgentBrowserProfileLease(lease: AgentBrowserProfileLease): CdpClientInfo {
  return {
    pid: lease.daemonPid || lease.holderPid,
    label: "agent-browser",
    agent: lease.agent,
    project: lease.project,
    branch: lease.branch,
    title: lease.command ? `agent-browser ${lease.command}` : "agent-browser Session",
    session: lease.session,
    lastActive: lease.updatedAt,
    note: "ProfilePilot 控制权状态：用户正在操作，原 agent-browser Session 与 Profile 排它绑定继续保留"
  };
}

async function applyAgentBrowserSessionActivities(
  byPort: Map<number, CdpClientInfo[]>,
  targetPorts: number[],
  includeRepository = true
): Promise<void> {
  const activityClientsByPort = await readActiveAgentBrowserSessionActivityClientsByPort(targetPorts, undefined, undefined, { includeRepository });
  for (const [port, activityClients] of activityClientsByPort) {
    const clients = byPort.get(port) || [];
    for (const activityClient of activityClients) {
      const existing = clients.find((client) =>
        (activityClient.session && client.session === activityClient.session) || client.pid === activityClient.pid
      );
      if (existing) {
        existing.agent = existing.agent || activityClient.agent;
        existing.project = activityClient.project || existing.project;
        existing.branch = activityClient.branch || existing.branch;
        existing.title = existing.title || activityClient.title;
        existing.session = existing.session || activityClient.session;
        existing.note = existing.note || activityClient.note;
        existing.lastActive = laterIsoDate(existing.lastActive, activityClient.lastActive);
        continue;
      }
      clients.push(activityClient);
    }
    if (clients.length) {
      byPort.set(port, clients);
    }
  }
}

// 排除所有 ProfilePilot 进程（按可执行文件路径识别，覆盖其它实例）：
// 实时画面截图和 tab 争用观测都会对 live 端口保持只读长连接——观察者不该出现在
// “驱动工具”名单里，也不该被算进多会话争用的活跃连接数。
// 注意只按“可执行路径 == 本进程 execPath”精确匹配，绝不能按进程名 Electron 过滤——
// VS Code 等一大票工具都是 Electron 壳，它们连 CDP 时可能是真驱动。
// ps 查询失败或查不到某 pid 时保守放行（宁可多显示，不可漏掉真驱动方）。
async function dropOwnAppClients(byPort: Map<number, CdpClientInfo[]>, options: RuntimeScanOptions = {}): Promise<void> {
  const pids = uniqueNumbers([...byPort.values()].flat().map((client) => client.pid));
  if (!pids.length) {
    return;
  }

  const ownPids = new Set<number>();
  if (process.platform === "win32") {
    try {
      const snapshot = options.windowsSnapshot || await getWindowsSystemSnapshot();
      const ownExecutable = normalizeFilesystemPath(process.execPath);
      for (const processInfo of snapshot.processes) {
        if (pids.includes(processInfo.pid) && processInfo.executablePath && normalizeFilesystemPath(processInfo.executablePath) === ownExecutable) {
          ownPids.add(processInfo.pid);
        }
      }
    } catch {
      return;
    }
  } else {
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
        browserPids: uniqueNumbers([...(merged.browserPids || []), ...(profile.browserPids || [])]),
        startedAt: earlierIsoDate(merged.startedAt, profile.startedAt),
        cdpPort: merged.cdpPort || profile.cdpPort,
        listeningPorts: uniqueNumbers(merged.listeningPorts.concat(profile.listeningPorts)).sort(compareNumbers)
      };
    },
    emptyRuntimeProfile()
  );
}

export function emptyRuntimeProfile(): RuntimeProfile {
  return { pids: [], browserPids: [], startedAt: null, cdpPort: null, listeningPorts: [] };
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
    return /(^|[\\/\s"])(chrome)\.exe(?:"|\s|$)/i.test(command);
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

  if (process.platform === "win32") {
    return /(^|[\\/\s"])(chrome|msedge|brave|chromium)\.exe(?:"|\s|$)/i.test(command);
  }

  return isGoogleChromeMainProcess(command);
}

export function parseExternalBrowserName(command: string): string {
  if (process.platform === "win32") {
    const match = command.match(/(?:^|[\\/\s"])(chrome|msedge|brave|chromium)\.exe(?:"|\s|$)/i);
    const names: Record<string, string> = {
      chrome: /Chrome for Testing/i.test(command) ? "Google Chrome for Testing" : "Google Chrome",
      msedge: "Microsoft Edge",
      brave: "Brave Browser",
      chromium: "Chromium"
    };
    return match ? names[match[1].toLowerCase()] : "Chromium";
  }
  const match = command.match(
    /\/Contents\/MacOS\/(Google Chrome( for Testing| Beta| Dev| Canary)?|Chromium|Microsoft Edge|Brave Browser)(\s|$)/
  );
  return match ? match[1] : "Chromium";
}

// ps 输出不带引号，路径里可能有空格；取到下一个“ --flag”或行尾为止。
export function parseUserDataDirFlag(command: string): string | null {
  const wholeQuoted = command.match(/(?:^|\s)"--user-data-dir=([^"]+)"/i);
  if (wholeQuoted?.[1]) return wholeQuoted[1].trim();
  const valueQuoted = command.match(/(?:^|\s)--user-data-dir="([^"]+)"/i);
  if (valueQuoted?.[1]) return valueQuoted[1].trim();
  const match = command.match(/--user-data-dir=(.*?)(?=\s+--|$)/);
  const value = match?.[1]?.trim().replace(/^"|"$/g, "");
  return value || null;
}

export function parseProfileDirectoryFlag(command: string): string | null {
  const match = command.match(/(?:^|\s)"?--profile-directory=(?:"([^"]+)"|([^"\s]+))"?/i);
  return match?.[1]?.trim() || match?.[2]?.trim() || null;
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

export async function findExternalChromeInstances(
  knownUserDataDirs: string[], options: RuntimeScanOptions = {}, presentation: { includeDisplayCdpUrl?: boolean } = {}
): Promise<ExternalChromeInstance[]> {
  const known = new Set(knownUserDataDirs.map(normalizeFilesystemPath));

  let processes: RuntimeProcessInfo[] = [];
  try {
    processes = await listRuntimeProcesses(options);
  } catch (error) {
    if (options.strict) throw error;
    return [];
  }

  const byDir = new Map<string, ExternalChromeInstance>();
  for (const processInfo of processes) {
    if (!isChromiumBrowserMainProcess(processInfo.command)) {
      continue;
    }

    const userDataDir = parseUserDataDirFlag(processInfo.command);
    if (!userDataDir || known.has(normalizeFilesystemPath(userDataDir))) {
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
  // Admission needs PID/port/occupancy evidence, not a clickable display URL.
  // Skipping this probe does not erase a declared port or a failed scan.
  await Promise.all(
    (presentation.includeDisplayCdpUrl === false ? [] : instances).map(async (instance) => {
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
  if (process.platform === "win32") {
    try {
      const snapshot = await getWindowsSystemSnapshot();
      return snapshot.processes.some((processInfo) => isGoogleChromeProcess(processInfo));
    } catch {
      return true;
    }
  }
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
  if (process.platform === "win32") {
    try {
      const snapshot = await getWindowsSystemSnapshot(true);
      return uniqueNumbers(snapshot.processes.filter(isGoogleChromeProcess).map((processInfo) => processInfo.pid));
    } catch {
      return [];
    }
  }
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

function windowsOpenProfilePids(profilePaths: string[], processes: readonly WindowsProcessInfo[], options: RuntimeScanOptions = {}): Map<string, number[]> {
  const result = new Map<string, number[]>();
  const mainProcesses = processes.filter((processInfo) => isGoogleChromeMainProcess(processInfo.commandLine));
  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  const mainPidFor = (processInfo: WindowsProcessInfo): number | null => {
    let current: WindowsProcessInfo | undefined = processInfo;
    const seen = new Set<number>();
    while (current && !seen.has(current.pid)) {
      seen.add(current.pid);
      if (isGoogleChromeMainProcess(current.commandLine)) return current.pid;
      current = windowsParent(current, byPid, options);
    }
    return null;
  };
  for (const profilePath of profilePaths) {
    const dirName = path.basename(profilePath);
    const matched = new Set<number>();
    for (const processInfo of processes) {
      const command = processInfo.commandLine;
      const profileDirectory = parseProfileDirectoryFlag(command);
      if (profileDirectory === dirName || normalizeFilesystemPath(command).includes(normalizeFilesystemPath(profilePath))) {
        if (options.strict) requireWindowsIdentity(processInfo, options, 'windows_rm_birth_join', 'profile_command');
        matched.add(processInfo.pid);
        const mainPid = mainPidFor(processInfo);
        if (mainPid) matched.add(mainPid);
      }
    }
    if (dirName === "Default") {
      for (const processInfo of mainProcesses.filter((item) => isImplicitDefaultChromeProcess(item.commandLine))) {
        if (options.strict) requireWindowsIdentity(processInfo, options, 'windows_rm_birth_join', 'profile_command');
        matched.add(processInfo.pid);
      }
    }
    if (matched.size) result.set(profilePath, [...matched]);
  }
  return result;
}

function isGoogleChromeProcess(processInfo: WindowsProcessInfo): boolean {
  const executable = `${processInfo.executablePath || ""} ${processInfo.commandLine}`;
  return /(?:^|[\\/\s"])(chrome)\.exe(?:"|\s|$)/i.test(executable) &&
    (/Google[\\/]Chrome/i.test(executable) || /chrome\.exe/i.test(processInfo.name));
}

function normalizeFilesystemPath(value: string): string {
  const resolved = value.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.replace(/\//g, "\\").toLowerCase() : resolved;
}
