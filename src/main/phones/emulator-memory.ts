import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runWindowsPowerShell } from "../windows-platform";

const GB = 1024 ** 3;
const execFileAsync = promisify(execFile);
const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;

export interface HostMemory {
  totalBytes: number;
  availableBytes: number;
  commitAvailableBytes?: number;
}

function validBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function ini(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^#;=]+?)\s*=\s*(.*?)\s*$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

/** Follow the AVD index: the actual device can live on another drive. */
export function readAvdMemoryMb(name: string, env = process.env, platform = process.platform, home = os.homedir()): number {
  if (!/^[\w.-]{1,200}$/.test(name) || name === "." || name === "..") throw new Error("模拟器名称无效。");
  const p = platform === "win32" ? path.win32 : path.posix;
  const userHome = env.ANDROID_USER_HOME || p.join(env.ANDROID_SDK_HOME || home, ".android");
  const roots = [...new Set([env.ANDROID_AVD_HOME, p.join(env.ANDROID_EMULATOR_HOME || userHome, "avd"), p.join(userHome, "avd"), p.join(home, ".android", "avd")].filter((v): v is string => !!v))];
  try {
    for (const root of roots) {
      const indexPath = p.join(root, `${name}.ini`);
      if (!fs.existsSync(indexPath)) continue;
      const index = ini(fs.readFileSync(indexPath, "utf8"));
      const absolute = index.get("path"), relative = index.get("path.rel");
      const directories = [absolute && p.isAbsolute(absolute) ? absolute : undefined,
        relative ? p.resolve(userHome, relative) : undefined, p.join(root, `${name}.avd`)].filter((v): v is string => !!v);
      const directory = directories.find(dir => fs.existsSync(p.join(dir, "config.ini")));
      if (!directory) throw new Error("AVD config.ini missing");
      const value = ini(fs.readFileSync(p.join(directory, "config.ini"), "utf8")).get("hw.ramSize") || "";
      // Older SDKs use integer MB, newer AVD tools can write M/G suffixes.
      const parsed = value.match(/^(\d+)\s*([MG])?B?$/i);
      const mb = parsed ? Number(parsed[1]) * (parsed[2]?.toUpperCase() === "G" ? 1024 : 1) : 0;
      if (!Number.isSafeInteger(mb) || mb <= 0 || mb > 1024 * 1024) throw new Error("AVD RAM size unknown");
      // Modern images can raise undersized configurations to at least 1536 MB.
      return Math.max(1536, mb);
    }
    throw new Error("AVD index missing");
  } catch (cause) {
    throw new Error(`无法确认 ${name} 的内存配置，已取消启动。请检查虚拟设备的 config.ini 中 hw.ramSize 是否为有效的内存大小，再重试。`, { cause });
  }
}

/** vm_stat supplies its page size (4 KiB on Intel, commonly 16 KiB on Apple Silicon). */
export function parseMacAvailableMemory(output: string): number {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (label: string) => {
    const match = output.match(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, "m"));
    if (!match) throw new Error(`Missing vm_stat ${label}`);
    return Number(match[1]);
  };
  // Do not add purgeable pages: they can overlap inactive pages. Wired and
  // compressed memory, and swap capacity, are not available physical RAM.
  const available = (pages("free") + pages("inactive") + pages("speculative")) * pageSize;
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || !validBytes(available)) throw new Error("Invalid vm_stat memory");
  return available;
}

export async function readHostMemory(platform = process.platform, powershell = runWindowsPowerShell,
  command: (file: string, args: string[]) => Promise<string> = async (file, args) =>
    String((await execFileAsync(file, args, { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true })).stdout)): Promise<HostMemory> {
  try {
    let memory: HostMemory;
    if (platform === "win32") {
      // PerfOS reports system commit, not the process virtual address space or
      // free space on the drive. A large pagefile must not excuse low RAM.
      const output = await powershell(`$ErrorActionPreference = 'Stop'
$memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
if ($null -eq $memory.AvailableBytes -or $null -eq $memory.CommitLimit -or $null -eq $memory.CommittedBytes) { throw 'Memory counters unavailable' }
@{ availableBytes = [double]$memory.AvailableBytes; commitAvailableBytes = [double]$memory.CommitLimit - [double]$memory.CommittedBytes } | ConvertTo-Json -Compress`, { timeout: 5000, maxBuffer: 4096 });
      const counters = JSON.parse(output);
      memory = { totalBytes: os.totalmem(), availableBytes: counters.availableBytes, commitAvailableBytes: counters.commitAvailableBytes };
      if (!validBytes(memory.commitAvailableBytes)) throw new Error("Invalid Windows commit counters");
    } else {
      memory = { totalBytes: os.totalmem(), availableBytes: platform === "darwin"
        ? parseMacAvailableMemory(await command("/usr/bin/vm_stat", [])) : os.freemem() };
    }
    if (!validBytes(memory.totalBytes) || memory.totalBytes === 0 || !validBytes(memory.availableBytes)
      || memory.availableBytes > memory.totalBytes) throw new Error("Invalid host memory counters");
    return memory;
  } catch (cause) {
    throw new Error("无法读取电脑当前可用内存，已取消启动模拟器。请稍后重试；持续失败时请检查系统内存统计服务。", { cause });
  }
}

export function assertEmulatorMemory(name: string, memoryMb: number, memory: HostMemory, estimated = false): void {
  if (!Number.isSafeInteger(memoryMb) || memoryMb <= 0 || !validBytes(memory.totalBytes) || memory.totalBytes === 0
    || !validBytes(memory.availableBytes) || memory.availableBytes > memory.totalBytes
    || memory.commitAvailableBytes !== undefined && !validBytes(memory.commitAvailableBytes)) {
    throw new Error("无法确认模拟器内存需求或电脑可用内存，已取消启动。");
  }
  const guest = memoryMb * 1024 ** 2;
  // Startup policy, not a promise of peak usage: leave 2 GiB for other apps,
  // plus at least 1 GiB (or 25% of guest RAM) for QEMU/graphics/startup work.
  const overhead = Math.max(GB, guest * 0.25), reserve = 2 * GB;
  const required = guest + overhead + reserve;
  const requirements = `${estimated ? "按" : "设备配置"} ${gb(guest)}${estimated ? " 估算" : ""}，加上运行开销 ${gb(overhead)} 和系统预留 ${gb(reserve)}，至少需要 ${gb(required)} 可用内存。`;
  if (memory.availableBytes < required) {
    throw new Error(`内存不足，已取消启动 ${name}。电脑当前可用 ${gb(memory.availableBytes)}（总内存 ${gb(memory.totalBytes)}）；${requirements}请关闭暂时不用的应用，或调低模拟器内存后重试。`);
  }
  if (memory.commitAvailableBytes !== undefined && memory.commitAvailableBytes < required) {
    throw new Error(`Windows 可提交内存不足，已取消启动 ${name}。当前剩余提交额度 ${gb(memory.commitAvailableBytes)}；${requirements}请关闭暂时不用的应用，或检查 Windows 分页文件设置后重试。`);
  }
}

export async function ensureAvdMemoryAvailable(name: string): Promise<void> {
  const memoryMb = readAvdMemoryMb(name);
  assertEmulatorMemory(name, memoryMb, await readHostMemory());
}

export async function ensureTencentMemoryAvailable(): Promise<void> {
  // GameLoop has no supported portable RAM-config API. Use a conservative
  // 8 GiB guest estimate and say so in the rejection, rather than skip checks.
  assertEmulatorMemory("腾讯手游助手", 8192, await readHostMemory(), true);
}
