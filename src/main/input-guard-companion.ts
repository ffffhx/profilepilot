import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import type { InputGuardPermissionDiagnostic } from "../shared/types";

export const INPUT_GUARD_APP_NAME = "ProfilePilot Input Guard.app";
export const INPUT_GUARD_EXECUTABLE_NAME = "ProfilePilot Input Guard";
export const INPUT_GUARD_BUILD_INFO_NAME = "input-guard-build.json";
export const INPUT_GUARD_WINDOWS_HELPER_NAME = "input-guard-win.ps1";
export const INPUT_GUARD_ACCESSIBILITY_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

interface InputGuardPermissionCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface InputGuardPermissionOptions extends InputGuardCompanionOptions {
  runProbe?: (helperPath: string) => Promise<InputGuardPermissionCommandResult>;
  runRequest?: (helperPath: string) => Promise<void>;
}

export interface InputGuardCompanionOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  sourceAppPath?: string;
  installAppPath?: string;
  overridePath?: string;
  resourcesPath?: string;
  defaultApp?: boolean;
}

interface InputGuardBuildInfo {
  buildId: string;
}

export interface InputGuardProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export async function inspectInputGuardPermission(
  options: InputGuardPermissionOptions = {}
): Promise<InputGuardPermissionDiagnostic> {
  const platform = options.platform || process.platform;
  const base = {
    platform,
    supported: platform === "darwin",
    granted: platform !== "darwin",
    appName: "ProfilePilot Input Guard",
    appPath: null as string | null,
    inspectedAt: new Date().toISOString(),
    error: null as string | null
  };
  if (!base.supported) {
    return base;
  }

  let helperPath = "";
  try {
    helperPath = resolveInputGuardHelperPath(options);
    const result = await (options.runProbe || runInputGuardPermissionProbe)(helperPath);
    if (result.stdout.includes('"status":"accessibility-access-granted"')) {
      return { ...base, granted: true, appPath: companionAppPathFromExecutable(helperPath) };
    }
    if (result.stdout.includes('"status":"accessibility-access-denied"')) {
      return { ...base, granted: false, appPath: companionAppPathFromExecutable(helperPath) };
    }
    const detail = result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code ?? "未知"}`;
    return {
      ...base,
      appPath: companionAppPathFromExecutable(helperPath),
      error: `无法确认 Input Guard 辅助功能权限：${detail}`
    };
  } catch (error) {
    return {
      ...base,
      appPath: helperPath ? safeCompanionAppPath(helperPath) : null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function requestInputGuardPermission(
  options: InputGuardPermissionOptions = {}
): Promise<InputGuardPermissionDiagnostic> {
  const platform = options.platform || process.platform;
  if (platform !== "darwin") {
    return inspectInputGuardPermission(options);
  }
  let helperPath = "";
  let requestError: string | null = null;
  try {
    helperPath = resolveInputGuardHelperPath(options);
    await (options.runRequest || runInputGuardPermissionRequest)(helperPath);
  } catch (error) {
    requestError = error instanceof Error ? error.message : String(error);
  }
  const diagnostic = await inspectInputGuardPermission({
    ...options,
    ...(helperPath ? { overridePath: helperPath } : {})
  });
  return requestError && !diagnostic.granted
    ? { ...diagnostic, error: requestError }
    : diagnostic;
}

/**
 * Resolves the native helper through a stable user-level companion app.
 *
 * macOS privacy grants are tied to code identity. Keeping this bundle at a
 * fixed path and leaving it byte-for-byte untouched while its build id is the
 * same prevents ordinary ProfilePilot UI rebuilds from invalidating the
 * Accessibility grant.
 */
export function resolveInputGuardHelperPath(options: InputGuardCompanionOptions = {}): string {
  const overridePath = options.overridePath ?? process.env.PROFILEPILOT_INPUT_GUARD_PATH;
  if (overridePath) {
    return overridePath;
  }

  const platform = options.platform || process.platform;
  if (platform === "win32") {
    return defaultInputGuardWindowsHelperPath(options);
  }
  const sourceAppPath = options.sourceAppPath || defaultInputGuardSourceAppPath(options);
  const sourceExecutablePath = inputGuardExecutablePath(sourceAppPath);
  if (platform !== "darwin") {
    return sourceExecutablePath;
  }

  const installAppPath = options.installAppPath || defaultInputGuardInstallAppPath(options.homeDir);
  try {
    return ensureInputGuardCompanion({ sourceAppPath, installAppPath });
  } catch (error) {
    // A read-only home directory should not take the entire desktop app down.
    // Running the bundled helper preserves functionality, while the overlay
    // health state still makes any missing permission explicit.
    console.warn("[ProfilePilot] 无法安装固定的 Input Guard 伴随组件，回退到内置副本", error);
    return sourceExecutablePath;
  }
}

export function ensureInputGuardCompanion(input: {
  sourceAppPath: string;
  installAppPath: string;
}): string {
  const sourceBuildId = readInputGuardBuildId(input.sourceAppPath);
  const sourceExecutablePath = inputGuardExecutablePath(input.sourceAppPath);
  if (!sourceBuildId || !existsSync(sourceExecutablePath)) {
    throw new Error(`Input Guard 伴随组件不完整：${input.sourceAppPath}`);
  }

  const installedExecutablePath = inputGuardExecutablePath(input.installAppPath);
  if (
    existsSync(installedExecutablePath) &&
    readInputGuardBuildId(input.installAppPath) === sourceBuildId
  ) {
    return installedExecutablePath;
  }

  const parentDir = path.dirname(input.installAppPath);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stagingPath = path.join(parentDir, `.${path.basename(input.installAppPath)}.install-${token}`);
  const backupPath = path.join(parentDir, `.${path.basename(input.installAppPath)}.previous-${token}`);
  mkdirSync(parentDir, { recursive: true });
  rmSync(stagingPath, { recursive: true, force: true });
  rmSync(backupPath, { recursive: true, force: true });

  let movedExisting = false;
  try {
    cpSync(input.sourceAppPath, stagingPath, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true
    });
    if (!existsSync(inputGuardExecutablePath(stagingPath))) {
      throw new Error("复制后的 Input Guard 缺少可执行文件");
    }
    if (existsSync(input.installAppPath)) {
      renameSync(input.installAppPath, backupPath);
      movedExisting = true;
    }
    renameSync(stagingPath, input.installAppPath);
    rmSync(backupPath, { recursive: true, force: true });
    return installedExecutablePath;
  } catch (error) {
    rmSync(stagingPath, { recursive: true, force: true });
    if (movedExisting && !existsSync(input.installAppPath) && existsSync(backupPath)) {
      renameSync(backupPath, input.installAppPath);
    }
    throw error;
  } finally {
    rmSync(backupPath, { recursive: true, force: true });
  }
}

/** Launches the companion through LaunchServices so macOS attributes TCC
 * access to the stable companion app, not to ProfilePilot or its caller. */
export function launchInputGuardCompanion(helperPath: string): InputGuardProcess {
  return new InputGuardCompanionProcess(helperPath);
}

export function defaultInputGuardInstallAppPath(homeDir = os.homedir()): string {
  return path.join(homeDir, "Applications", INPUT_GUARD_APP_NAME);
}

export function defaultInputGuardSourceAppPath(options: Pick<InputGuardCompanionOptions, "resourcesPath" | "defaultApp"> = {}): string {
  const resourcesPath = options.resourcesPath ?? (typeof process.resourcesPath === "string" ? process.resourcesPath : "");
  const defaultApp = options.defaultApp ?? Boolean(process.defaultApp);
  if (resourcesPath && !defaultApp) {
    return path.join(resourcesPath, "native", INPUT_GUARD_APP_NAME);
  }
  return path.resolve(__dirname, "..", "native", INPUT_GUARD_APP_NAME);
}

export function defaultInputGuardWindowsHelperPath(
  options: Pick<InputGuardCompanionOptions, "resourcesPath" | "defaultApp"> = {}
): string {
  const resourcesPath = options.resourcesPath ?? (typeof process.resourcesPath === "string" ? process.resourcesPath : "");
  const defaultApp = options.defaultApp ?? Boolean(process.defaultApp);
  if (resourcesPath && !defaultApp) {
    return path.join(resourcesPath, "native", INPUT_GUARD_WINDOWS_HELPER_NAME);
  }
  return path.resolve(__dirname, "..", "..", "native", INPUT_GUARD_WINDOWS_HELPER_NAME);
}

export function inputGuardExecutablePath(appPath: string): string {
  return path.join(appPath, "Contents", "MacOS", INPUT_GUARD_EXECUTABLE_NAME);
}

export function inputGuardBuildInfoPath(appPath: string): string {
  return path.join(appPath, "Contents", "Resources", INPUT_GUARD_BUILD_INFO_NAME);
}

function readInputGuardBuildId(appPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(inputGuardBuildInfoPath(appPath), "utf8")) as Partial<InputGuardBuildInfo>;
    return typeof parsed.buildId === "string" && parsed.buildId ? parsed.buildId : null;
  } catch {
    return null;
  }
}

class InputGuardCompanionProcess extends EventEmitter implements InputGuardProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private readonly socketPath: string;
  private readonly launcher: ReturnType<typeof spawn>;
  private socket: net.Socket | null = null;
  private stopped = false;
  private emittedExit = false;
  private readonly connectDeadline = Date.now() + 5000;

  constructor(helperPath: string) {
    super();
    const appPath = companionAppPathFromExecutable(helperPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    this.socketPath = `/tmp/pp-ig-${uid}-${process.pid}-${Math.random().toString(16).slice(2, 10)}.sock`;
    rmSync(this.socketPath, { force: true });
    this.launcher = spawn(
      "/usr/bin/open",
      ["-W", "-g", "-j", "-n", appPath, "--args", "--socket", this.socketPath],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this.launcher.stdout?.pipe(this.stderr, { end: false });
    this.launcher.stderr?.pipe(this.stderr, { end: false });
    this.launcher.on("error", (error) => this.emit("error", error));
    this.launcher.on("exit", (code, signal) => {
      this.cleanup();
      this.emitExit(code, signal);
    });
    setTimeout(() => this.connect(), 10).unref?.();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.stopped = true;
    if (this.socket && !this.socket.destroyed) {
      this.socket.end("QUIT\n");
    }
    const killed = this.launcher.kill(signal);
    this.cleanup();
    return killed;
  }

  private connect(): void {
    if (this.stopped || this.socket) {
      return;
    }
    const socket = net.createConnection({ path: this.socketPath });
    const onError = (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (
        !this.stopped &&
        Date.now() < this.connectDeadline &&
        (error.code === "ENOENT" || error.code === "ECONNREFUSED")
      ) {
        setTimeout(() => this.connect(), 40).unref?.();
        return;
      }
      this.emit("error", error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      if (this.stopped) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      this.stdin.pipe(socket);
      socket.pipe(this.stdout);
      socket.on("error", (error) => {
        if (!this.stopped) {
          this.emit("error", error);
        }
      });
    });
  }

  private cleanup(): void {
    this.stopped = true;
    this.socket?.destroy();
    this.socket = null;
    rmSync(this.socketPath, { force: true });
    if (!this.stdin.destroyed) {
      this.stdin.destroy();
    }
  }

  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.emittedExit) {
      return;
    }
    this.emittedExit = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, signal);
  }
}

function runInputGuardPermissionProbe(helperPath: string): Promise<InputGuardPermissionCommandResult> {
  return collectInputGuardCommand(helperPath, ["--check-accessibility"], 4_000);
}

async function runInputGuardPermissionRequest(helperPath: string): Promise<void> {
  const appPath = companionAppPathFromExecutable(helperPath);
  const result = await collectInputGuardCommand(
    "/usr/bin/open",
    ["-W", "-g", "-j", "-n", appPath, "--args", "--request-accessibility"],
    8_000
  );
  // LaunchServices 偶尔在短命伴随进程先退出时返回 1；权限结果以随后的无打扰探测为准。
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(result.stderr.trim() || `无法启动 Input Guard 授权请求（退出码 ${result.code ?? "未知"}）`);
  }
}

function collectInputGuardCommand(
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<InputGuardPermissionCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`Input Guard 权限检查超时（${timeoutMs}ms）`)));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolve({ code, stdout, stderr })));
  });
}

function safeCompanionAppPath(helperPath: string): string | null {
  try {
    return companionAppPathFromExecutable(helperPath);
  } catch {
    return null;
  }
}

function companionAppPathFromExecutable(helperPath: string): string {
  const contentsPath = path.resolve(path.dirname(helperPath), "..");
  const appPath = path.resolve(contentsPath, "..");
  if (path.basename(appPath) !== INPUT_GUARD_APP_NAME) {
    throw new Error(`Input Guard 路径不属于固定伴随 App：${helperPath}`);
  }
  return appPath;
}
