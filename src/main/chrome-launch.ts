import { execFile, spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  NativeChromeProfile,
  PublicProfile
} from "../shared/types";
import { accountSyncDataScore } from "./account-sync";
import { CdpBrowserClient, requestCdpVersionInfo } from "./cdp-client";
import { openInspectablePageOverCdp } from "./cdp-page";
import { POSIX_LOCALE_ENV, execFileAsync, exists, getNestedValue, isRecord, isSafePathSegment, readJsonFile, sleep, stringValue, uniqueNumbers } from "./fs-util";
import { CdpRuntimeEvaluateResult, ChromeLocalState, ProfileRef, TemporaryChromeCdpLaunch } from "./internal-types";
import { ProfileManagerError } from "./profile-manager-error";

export async function launchChrome(args: string[]): Promise<void> {
  if (process.env.CHROME_BINARY) {
    launchDetached(process.env.CHROME_BINARY, args);
  } else if (process.platform === "darwin") {
    await execFileAsync("open", ["-na", process.env.CHROME_APP_NAME || "Google Chrome", "--args", ...args]);
  } else if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", "chrome", ...args]);
  } else {
    launchDetached("google-chrome", args);
  }
}

export async function openChromeUrl(url: string): Promise<void> {
  if (process.env.CHROME_BINARY) {
    launchDetached(process.env.CHROME_BINARY, [url]);
  } else if (process.platform === "darwin") {
    await setFrontMacChromeTabUrl(url);
  } else if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", "chrome", url]);
  } else {
    launchDetached("google-chrome", [url]);
  }
}

export async function setFrontMacChromeTabUrl(url: string): Promise<void> {
  const appName = process.env.CHROME_APP_NAME || "Google Chrome";
  const script = `
tell application ${toAppleScriptString(appName)}
  if (count of windows) is 0 then make new window
  set URL of active tab of front window to ${toAppleScriptString(url)}
  activate
end tell
`;
  await execFileAsync("osascript", ["-e", script]);
}

export function toAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function launchDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  // spawn 失败（如可执行文件不存在）会异步触发 error；监听以免未处理错误并留下线索，
  // 同时让 CDP 等待超时时能区分“没起来”而不是被静默吞掉。
  child.once("error", (error) => {
    console.error(`[profilepilot] 启动 ${command} 失败：`, error);
  });
  child.unref();
}

export async function focusProfileWindow(pids: number[]): Promise<boolean> {
  if (process.platform !== "darwin") {
    throw new ProfileManagerError("当前只支持在 macOS 上把 Profile 窗口显示到最前面。", "FOCUS_UNSUPPORTED");
  }

  let lastError: unknown = null;
  let activatedAnyProcess = false;
  for (const pid of pids) {
    try {
      const raisedWindow = await focusMacProcess(pid);
      activatedAnyProcess = true;
      if (raisedWindow) {
        return true;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (activatedAnyProcess) {
    return false;
  }

  const detail = lastError instanceof Error && lastError.message ? ` ${lastError.message}` : "";
  throw new ProfileManagerError(
    `无法把这个 Chrome Profile 窗口显示到最前面。${detail}`,
    "FOCUS_PROFILE_FAILED"
  );
}

export async function focusMacProcess(pid: number): Promise<boolean> {
  await activateMacProcess(pid);
  if (await isFrontmostMacProcess(pid)) {
    return true;
  }

  const script = `
tell application "System Events"
  set targetProcesses to every process whose unix id is ${pid}
  if (count of targetProcesses) is 0 then error "Process not found"
  set targetProcess to item 1 of targetProcesses
	  tell targetProcess
	    set visible to true
	    set raisedWindow to false
	    try
	      repeat with targetWindow in windows
	        try
	          set value of attribute "AXMinimized" of targetWindow to false
	        end try
      end repeat
	    end try
	    if (count of windows) is greater than 0 then
	      perform action "AXRaise" of window 1
	      set raisedWindow to true
	    end if
	    return raisedWindow
	  end tell
	end tell
`;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    const raisedWindow = stdout.trim().toLowerCase() === "true";
    return raisedWindow || (await isFrontmostMacProcess(pid));
  } catch {
    // 窗口级 AXRaise 可能因多 profile 实例或缺少辅助功能权限失败。
    // 只有能确认目标 PID 已成为前台进程时才算成功，避免把其它 Profile 当成已显示。
    return isFrontmostMacProcess(pid);
  }
}

export async function isFrontmostMacProcess(pid: number): Promise<boolean> {
  return isAnyMacProcessFrontmost([pid]);
}

export async function isAnyMacProcessFrontmost(pids: number[]): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  const normalizedPids = uniqueNumbers(pids.filter((pid) => Number.isInteger(pid) && pid > 0));
  if (!normalizedPids.length) {
    return false;
  }

  const script = `
ObjC.import("AppKit");
const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
if (!front) {
  false;
} else {
  [${normalizedPids.join(",")}].includes(front.processIdentifier);
}
`;

  try {
    const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script]);
    return stdout.trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

export async function hasRendererProcessForProfile(profilePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], {
      maxBuffer: 1024 * 1024 * 8,
      env: POSIX_LOCALE_ENV
    });

    return stdout.split("\n").some((command) => {
      return (
        command.includes("Google Chrome Helper (Renderer)") &&
        command.includes("--type=renderer") &&
        command.includes(`--user-data-dir=${profilePath}`)
      );
    });
  } catch {
    return true;
  }
}

export async function requestIsolatedProfileWindow(profile: PublicProfile): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const command = getDirectChromeCommand();
  if (!command) {
    throw new ProfileManagerError("找不到可直接唤起窗口的 Chrome 二进制。", "FOCUS_PROFILE_FAILED");
  }

  launchDetached(command, [`--user-data-dir=${profile.path}`, "--no-first-run"]);
}

export function getDirectChromeCommand(): string | null {
  if (process.env.CHROME_BINARY) {
    return process.env.CHROME_BINARY;
  }

  if (process.platform !== "darwin") {
    return null;
  }

  const appName = process.env.CHROME_APP_NAME || "Google Chrome";
  const command = `/Applications/${appName}.app/Contents/MacOS/${appName}`;
  return existsSync(command) ? command : null;
}

export async function activateMacProcess(pid: number): Promise<void> {
  const script = `
ObjC.import("AppKit");
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});
if (!app) {
  throw new Error("Process not found");
}
const activated = app.activateWithOptions(
  $.NSApplicationActivateIgnoringOtherApps | $.NSApplicationActivateAllWindows
);
if (!activated) {
  throw new Error("Activate failed");
}
`;

  await execFileAsync("osascript", ["-l", "JavaScript", "-e", script]);
}

export async function readIsolatedProfileUserName(profileRootPath: string): Promise<string | null> {
  const profileDataPath = await resolveIsolatedProfileDataPath(profileRootPath);
  const preferences = await readJsonFile<Record<string, unknown>>(path.join(profileDataPath, "Preferences"));
  if (!preferences) {
    return null;
  }

  return accountDisplayNameFromPreferences(preferences);
}

export async function resolveIsolatedProfileDataPath(profileRootPath: string): Promise<string> {
  const defaultProfilePath = path.join(profileRootPath, "Default");
  const [rootScore, defaultScore] = await Promise.all([
    accountSyncDataScore(profileRootPath),
    accountSyncDataScore(defaultProfilePath)
  ]);

  if (defaultScore > 0 || (await exists(defaultProfilePath)) || rootScore === 0) {
    return defaultProfilePath;
  }

  return profileRootPath;
}

export function accountDisplayNameFromPreferences(preferences: Record<string, unknown>): string | null {
  const accountInfoValue = preferences.account_info;
  if (Array.isArray(accountInfoValue)) {
    for (const accountInfo of accountInfoValue) {
      const label = accountDisplayNameFromRecord(accountInfo);
      if (label) {
        return label;
      }
    }
  } else {
    const label = accountDisplayNameFromRecord(accountInfoValue);
    if (label) {
      return label;
    }
  }

  return (
    stringValue(getNestedValue(preferences, ["profile", "user_name"])) ||
    stringValue(getNestedValue(preferences, ["profile", "gaia_name"])) ||
    stringValue(getNestedValue(preferences, ["google", "services", "username"])) ||
    stringValue(getNestedValue(preferences, ["google", "services", "last_username"])) ||
    null
  );
}

export function accountDisplayNameFromRecord(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  return (
    stringValue(value.email) ||
    stringValue(value.account_email) ||
    stringValue(value.full_name) ||
    stringValue(value.gaia_name) ||
    stringValue(value.name) ||
    null
  );
}

export async function launchTemporaryChromeWithCdp(userDataDir: string): Promise<TemporaryChromeCdpLaunch> {
  const command = directChromeCommandForMaintenance();
  await fs.mkdir(userDataDir, { recursive: true });
  const activePortPath = path.join(userDataDir, "DevToolsActivePort");
  await fs.rm(activePortPath, { force: true }).catch(() => undefined);

  const args = [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-component-update",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0"
  ];
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let spawnError: Error | null = null;
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  });
  child.once("error", (error) => {
    spawnError = error instanceof Error ? error : new Error(String(error));
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (spawnError) {
      throw spawnError;
    }
    if (child.exitCode !== null) {
      throw new ProfileManagerError(
        `临时 Chrome 启动失败，退出码 ${child.exitCode}。${stderr}`,
        "TEMP_CHROME_EXITED"
      );
    }
    if (await exists(activePortPath)) {
      const [portText] = (await fs.readFile(activePortPath, "utf8")).trim().split(/\n/);
      const port = Number(portText);
      if (Number.isInteger(port) && port > 0) {
        return { child, port, stderr: () => stderr };
      }
    }
    await sleep(100);
  }

  throw new ProfileManagerError(`临时 Chrome 没有返回 CDP 端口。${stderr}`, "TEMP_CHROME_CDP_NOT_READY");
}

export function directChromeCommandForMaintenance(): string {
  const direct = getDirectChromeCommand();
  if (direct) {
    return direct;
  }
  if (process.platform === "win32") {
    return "chrome";
  }
  return "google-chrome";
}

export async function closeTemporaryChromeWithCdp(launch: TemporaryChromeCdpLaunch): Promise<void> {
  try {
    const version = await requestCdpVersionInfo(launch.port);
    if (version.webSocketDebuggerUrl) {
      const client = await CdpBrowserClient.connect(version.webSocketDebuggerUrl, 3000);
      try {
        await client.send("Browser.close", {}, 3000).catch(() => undefined);
      } finally {
        client.close();
      }
    } else {
      launch.child.kill("SIGTERM");
    }
  } catch {
    launch.child.kill("SIGTERM");
  }

  const exited = await waitForChildExit(launch.child, 5000);
  if (!exited) {
    launch.child.kill("SIGKILL");
    await waitForChildExit(launch.child, 3000);
  }
}

export function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", handleExit);
      resolve(false);
    }, timeoutMs);
    const handleExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", handleExit);
  });
}

export async function enableDeveloperModeOverCdp(port: number): Promise<void> {
  const pageClient = await openInspectablePageOverCdp(port, "chrome://extensions/");
  try {
    const expression = `
new Promise((resolve) => {
  chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => {
    resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : { ok: true });
  });
})
`;
    const result = await pageClient.send<CdpRuntimeEvaluateResult>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      10000
    );
    if (result.exceptionDetails) {
      throw new ProfileManagerError("开启 Chrome 开发者模式时 WebUI 执行失败。", "DEVELOPER_MODE_UPDATE_FAILED");
    }
    const value = result.result?.value;
    if (!isRecord(value) || value.ok !== true) {
      const detail = isRecord(value) && typeof value.error === "string" ? value.error : "unknown error";
      throw new ProfileManagerError(`开启 Chrome 开发者模式失败：${detail}`, "DEVELOPER_MODE_UPDATE_FAILED");
    }
    await sleep(500);
  } finally {
    pageClient.close();
  }
}

export async function readChromeMajorVersion(): Promise<number | null> {
  const versionOutputs: string[] = [];

  const command = getDirectChromeCommand();
  if (command) {
    const output = await readCommandVersion(command, ["--version"]);
    if (output) {
      versionOutputs.push(output);
    }
  }

  if (!versionOutputs.length && process.platform === "darwin" && !process.env.CHROME_BINARY) {
    const appName = process.env.CHROME_APP_NAME || "Google Chrome";
    const plistPath = `/Applications/${appName}.app/Contents/Info.plist`;
    const output = await readCommandVersion("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleShortVersionString",
      plistPath
    ]);
    if (output) {
      versionOutputs.push(output);
    }
  }

  for (const output of versionOutputs) {
    const match = output.match(/(?:Chrome|Chromium)?\s*(\d+)(?:\.|$)/i);
    const version = match ? Number.parseInt(match[1], 10) : Number.NaN;
    if (Number.isFinite(version)) {
      return version;
    }
  }

  return null;
}

export async function readCommandVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 2000 });
    return `${stdout || ""}${stderr || ""}`.trim() || null;
  } catch {
    return null;
  }
}

export async function scanNativeChromeProfiles(): Promise<NativeChromeProfile[]> {
  return scanChromeProfilesInDir(nativeChromeUserDataDir());
}

// 枚举任意 user-data-dir 里的所有 profile 子目录（读它的 Local State → info_cache）。
// 原生系统目录和隔离目录复用同一套逻辑；隔离目录里的额外子 profile 由此发现。
export async function scanChromeProfilesInDir(userDataDir: string): Promise<NativeChromeProfile[]> {
  const infoCache = (await readChromeLocalStateFrom(userDataDir)).profile?.info_cache || {};

  return Object.entries(infoCache)
    // dirName 来自 Chrome 的 Local State，过滤掉含 ../ 或路径分隔符的恶意目录名。
    .filter(([dirName]) => isSafePathSegment(dirName))
    .map(([dirName, profile]) => ({
      dirName,
      name: typeof profile.name === "string" && profile.name.trim() ? profile.name : dirName,
      userName: typeof profile.user_name === "string" && profile.user_name.trim() ? profile.user_name : null,
      path: path.join(userDataDir, dirName),
      userDataDir,
      isDefault: dirName === "Default"
    }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) {
        return a.isDefault ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}

export async function readChromeLocalState(): Promise<ChromeLocalState> {
  return readChromeLocalStateFrom(nativeChromeUserDataDir());
}

async function readChromeLocalStateFrom(userDataDir: string): Promise<ChromeLocalState> {
  try {
    const raw = await fs.readFile(path.join(userDataDir, "Local State"), "utf8");
    return JSON.parse(raw) as ChromeLocalState;
  } catch {
    return {};
  }
}

export async function writeChromeLocalState(localState: ChromeLocalState): Promise<void> {
  await writeChromeLocalStateAt(nativeChromeUserDataDir(), localState);
}

// 把 Local State 写回指定 user-data-dir（原生或隔离目录都可）。原子替换 + 落一份备份。
async function writeChromeLocalStateAt(userDataDir: string, localState: ChromeLocalState): Promise<void> {
  const localStatePath = path.join(userDataDir, "Local State");
  const raw = await fs.readFile(localStatePath, "utf8");
  const tmpPath = `${localStatePath}.cpm-tmp-${process.pid}`;
  try {
    // 先把新内容写到临时文件——这步失败时原文件和备份都未改动，状态保持一致。
    await fs.writeFile(tmpPath, `${JSON.stringify(localState, null, 2)}\n`, "utf8");
    // 临时文件写成功后再落备份，避免出现“有备份但没写成功”的孤儿备份。
    const backupPath = `${localStatePath}.cpm-backup-${Date.now()}`;
    await fs.writeFile(backupPath, raw, "utf8");
    await fs.rename(tmpPath, localStatePath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

export async function removeNativeProfileFromLocalState(dirName: string): Promise<void> {
  await removeProfileFromLocalStateIn(nativeChromeUserDataDir(), dirName);
}

// 从指定 user-data-dir 的 Local State 里彻底摘掉某个 profile 子目录的记录：
// info_cache 主记录，外加 profiles_order / last_active_profiles 里的引用、last_used 兜底，
// 否则 Chrome 下次启动仍会“看见”这个已删目录、重新为它建空目录或报错。
export async function removeProfileFromLocalStateIn(userDataDir: string, dirName: string): Promise<void> {
  const localState = await readChromeLocalStateFrom(userDataDir);
  const profile = localState.profile;
  if (!profile) {
    return;
  }

  let changed = false;
  if (profile.info_cache && profile.info_cache[dirName]) {
    delete profile.info_cache[dirName];
    changed = true;
  }
  if (Array.isArray(profile.profiles_order)) {
    const next = profile.profiles_order.filter((item) => item !== dirName);
    if (next.length !== profile.profiles_order.length) {
      profile.profiles_order = next;
      changed = true;
    }
  }
  if (Array.isArray(profile.last_active_profiles)) {
    const next = profile.last_active_profiles.filter((item) => item !== dirName);
    if (next.length !== profile.last_active_profiles.length) {
      profile.last_active_profiles = next;
      changed = true;
    }
  }
  if (profile.last_used === dirName) {
    delete profile.last_used;
    changed = true;
  }

  if (!changed) {
    return;
  }
  await writeChromeLocalStateAt(userDataDir, localState);
}

export function nativeChromeLocalStatePath(): string {
  return path.join(nativeChromeUserDataDir(), "Local State");
}

export function nativeChromeUserDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  }

  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "google-chrome");
}

export function parseProfileId(profileId: string): ProfileRef {
  if (profileId.startsWith("native:")) {
    return { source: "native", dirName: profileId.slice("native:".length) };
  }

  if (profileId.startsWith("isolated-sub:")) {
    const rest = profileId.slice("isolated-sub:".length);
    const sep = rest.indexOf(":");
    // parentId 是 registry uuid（无冒号），冒号后整段是子 profile 目录名（可含空格，如 "Profile 2"）。
    return { source: "isolated-sub", parentId: rest.slice(0, sep), dirName: rest.slice(sep + 1) };
  }

  if (profileId.startsWith("isolated:")) {
    return { source: "isolated", id: profileId.slice("isolated:".length) };
  }

  return { source: "isolated", id: profileId };
}

export function makeNativeProfileId(dirName: string): string {
  return `native:${dirName}`;
}

export function makeIsolatedProfileId(id: string): string {
  return `isolated:${id}`;
}

export function makeIsolatedSubProfileId(parentId: string, dirName: string): string {
  return `isolated-sub:${parentId}:${dirName}`;
}
