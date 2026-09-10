import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticLogEntry {
  timestamp: string;
  level: DiagnosticLogLevel;
  component: string;
  event: string;
  message: string;
  details?: unknown;
  pid: number;
  platform: string;
  app_version: string | null;
}

export interface DiagnosticLogReadOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  since?: number | null;
  levels?: DiagnosticLogLevel[];
  limit?: number;
}

export interface DiagnosticLogStats {
  root: string;
  active_file: string;
  files: number;
  bytes: number;
}

export interface DiagnosticRuntimeState {
  version: 1;
  pid: number;
  started_at: string;
  heartbeat_at: string;
  clean_shutdown: boolean;
  clean_shutdown_at?: string;
  shutdown_reason?: string;
  exit_code?: number;
  last_failure?: {
    timestamp: string;
    event: string;
    message: string;
  };
  platform: string;
  app_version: string | null;
}

interface DiagnosticLogConfiguration {
  root: string;
  appVersion: string | null;
  maxBytes: number;
  retainedFiles: number;
}

const LOG_FILE_NAME = "profilepilot.log.jsonl";
const RUNTIME_STATE_FILE_NAME = "runtime-state.json";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETAINED_FILES = 5;
const DEFAULT_HEARTBEAT_MS = 15_000;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|proxy[_-]?(?:password|username)|credential)/i;
const URL_CREDENTIALS = /\b(https?|socks5?):\/\/([^\s/@:]+):([^\s/@]+)@/gi;
const AUTH_HEADER = /\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi;
const INLINE_SECRET = /\b(token|password|passwd|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*([^\s,;]+)/gi;

let configuration: DiagnosticLogConfiguration | null = null;
let consoleCaptureInstalled = false;
let processCrashCaptureInstalled = false;
let runtimeState: DiagnosticRuntimeState | null = null;
let runtimeStatePath: string | null = null;
let runtimeHeartbeatTimer: NodeJS.Timeout | null = null;

export function diagnosticLogRoot(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = String(env.PROFILEPILOT_LOG_ROOT || "").trim();
  return override ? path.resolve(override) : path.join(homeDir, ".profilepilot", "logs");
}

export function diagnosticLogPath(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(diagnosticLogRoot(homeDir, env), LOG_FILE_NAME);
}

export function diagnosticRuntimeStatePath(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(diagnosticLogRoot(homeDir, env), RUNTIME_STATE_FILE_NAME);
}

export function initializeDiagnosticLogging(options: {
  appVersion?: string | null;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  retainedFiles?: number;
  captureConsole?: boolean;
} = {}): void {
  const root = diagnosticLogRoot(options.homeDir, options.env);
  configuration = {
    root,
    appVersion: options.appVersion || null,
    maxBytes: positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES),
    retainedFiles: positiveInteger(options.retainedFiles, DEFAULT_RETAINED_FILES)
  };
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
  } catch {
    // Logging must never keep ProfilePilot from starting.
  }
  if (options.captureConsole !== false) installDiagnosticConsoleCapture();
}

export function installProcessCrashLogging(): void {
  if (processCrashCaptureInstalled) return;
  processCrashCaptureInstalled = true;
  process.prependListener("uncaughtExceptionMonitor", (error, origin) => {
    const message = error instanceof Error ? error.message : String(error);
    writeDiagnosticLog("error", "process", "process.uncaught_exception", `主进程出现未捕获异常：${message}`, {
      origin,
      error
    });
    recordRuntimeFailure("process.uncaught_exception", message);
  });
  process.on("warning", (warning) => {
    writeDiagnosticLog("warn", "process", "process.warning", warning.message, { warning });
  });
  process.on("exit", (code) => {
    writeDiagnosticLog(code === 0 ? "info" : "error", "process", "process.exit", `主进程退出，退出码 ${code}`, { exitCode: code });
    if (runtimeState && !runtimeState.clean_shutdown) {
      runtimeState.exit_code = code;
      runtimeState.heartbeat_at = new Date().toISOString();
      writeRuntimeStateSnapshot();
    }
  });
}

export function startRuntimeStateTracking(options: { heartbeatMs?: number } = {}): void {
  if (!configuration) return;
  stopRuntimeHeartbeat();
  runtimeStatePath = path.join(configuration.root, RUNTIME_STATE_FILE_NAME);
  const previous = readRuntimeState(runtimeStatePath);
  if (previous && !previous.clean_shutdown && previous.pid !== process.pid) {
    writeDiagnosticLog(
      "error",
      "app",
      "app.previous_unclean_exit",
      `检测到上一次主进程 ${previous.pid} 未完成正常退出`,
      { previous }
    );
  }
  const now = new Date().toISOString();
  runtimeState = {
    version: 1,
    pid: process.pid,
    started_at: now,
    heartbeat_at: now,
    clean_shutdown: false,
    platform: `${process.platform}/${process.arch}`,
    app_version: configuration.appVersion
  };
  writeRuntimeStateSnapshot();
  const heartbeatMs = Math.max(positiveInteger(options.heartbeatMs, DEFAULT_HEARTBEAT_MS), 1_000);
  runtimeHeartbeatTimer = setInterval(() => {
    if (!runtimeState || runtimeState.clean_shutdown) return;
    runtimeState.heartbeat_at = new Date().toISOString();
    writeRuntimeStateSnapshot();
  }, heartbeatMs);
  runtimeHeartbeatTimer.unref();
}

export function stopRuntimeStateTracking(reason = "normal-shutdown"): void {
  stopRuntimeHeartbeat();
  if (!runtimeState) return;
  const now = new Date().toISOString();
  runtimeState.heartbeat_at = now;
  runtimeState.clean_shutdown = true;
  runtimeState.clean_shutdown_at = now;
  runtimeState.shutdown_reason = reason;
  writeRuntimeStateSnapshot();
}

export function writeDiagnosticLog(
  level: DiagnosticLogLevel,
  component: string,
  event: string,
  message: string,
  details?: unknown
): void {
  if (!configuration) return;
  const entry: DiagnosticLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    component: sanitizeText(component).slice(0, 120) || "app",
    event: sanitizeText(event).slice(0, 160) || "diagnostic",
    message: sanitizeText(message).slice(0, 8_000),
    ...(details === undefined ? {} : { details: sanitizeValue(details) }),
    pid: process.pid,
    platform: `${process.platform}/${process.arch}`,
    app_version: configuration.appVersion
  };
  try {
    const filePath = path.join(configuration.root, LOG_FILE_NAME);
    const line = `${JSON.stringify(entry)}\n`;
    rotateIfNeeded(filePath, Buffer.byteLength(line, "utf8"), configuration);
    appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 });
    chmodSync(filePath, 0o600);
  } catch {
    // A full/read-only disk must not break the application or recurse through console.
  }
}

export function readDiagnosticLogs(options: DiagnosticLogReadOptions = {}): DiagnosticLogEntry[] {
  const root = diagnosticLogRoot(options.homeDir, options.env);
  const levels = options.levels?.length ? new Set(options.levels) : null;
  const since = Number.isFinite(options.since) ? Number(options.since) : null;
  const limit = Math.min(Math.max(positiveInteger(options.limit, 200), 1), 5_000);
  const entries: DiagnosticLogEntry[] = [];
  for (const filePath of diagnosticLogFiles(root)) {
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as DiagnosticLogEntry;
        if (!isDiagnosticLogEntry(entry)) continue;
        if (levels && !levels.has(entry.level)) continue;
        if (since !== null && Date.parse(entry.timestamp) < since) continue;
        entries.push(entry);
      } catch {
        // Ignore partial lines left by an interrupted write.
      }
    }
  }
  entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return entries.slice(-limit);
}

export function getDiagnosticLogStats(
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env
): DiagnosticLogStats {
  const root = diagnosticLogRoot(homeDir, env);
  const files = diagnosticLogFiles(root).filter((filePath) => existsSync(filePath));
  return {
    root,
    active_file: path.join(root, LOG_FILE_NAME),
    files: files.length,
    bytes: files.reduce((total, filePath) => {
      try {
        return total + statSync(filePath).size;
      } catch {
        return total;
      }
    }, 0)
  };
}

export function sanitizeDiagnosticValue(value: unknown): unknown {
  return sanitizeValue(value);
}

function installDiagnosticConsoleCapture(): void {
  if (consoleCaptureInstalled) return;
  consoleCaptureInstalled = true;
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    writeDiagnosticLog("warn", "console", "console.warn", formatConsoleArgs(args), { arguments: args });
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    writeDiagnosticLog("error", "console", "console.error", formatConsoleArgs(args), { arguments: args });
    originalError(...args);
  };
}

function recordRuntimeFailure(event: string, message: string): void {
  if (!runtimeState || runtimeState.clean_shutdown) return;
  const now = new Date().toISOString();
  runtimeState.heartbeat_at = now;
  runtimeState.last_failure = {
    timestamp: now,
    event: sanitizeText(event).slice(0, 160),
    message: sanitizeText(message).slice(0, 8_000)
  };
  writeRuntimeStateSnapshot();
}

function stopRuntimeHeartbeat(): void {
  if (runtimeHeartbeatTimer) clearInterval(runtimeHeartbeatTimer);
  runtimeHeartbeatTimer = null;
}

function writeRuntimeStateSnapshot(): void {
  if (!runtimeState || !runtimeStatePath) return;
  const temporaryPath = `${runtimeStatePath}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(runtimeStatePath), { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(runtimeState, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    try {
      renameSync(temporaryPath, runtimeStatePath);
    } catch {
      rmSync(runtimeStatePath, { force: true });
      renameSync(temporaryPath, runtimeStatePath);
    }
    chmodSync(runtimeStatePath, 0o600);
  } catch {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Runtime diagnostics must never break the application.
    }
  }
}

function readRuntimeState(filePath: string): DiagnosticRuntimeState | null {
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as Partial<DiagnosticRuntimeState>;
    if (value.version !== 1 || !Number.isSafeInteger(value.pid) || typeof value.started_at !== "string" ||
      typeof value.heartbeat_at !== "string" || typeof value.clean_shutdown !== "boolean") return null;
    return value as DiagnosticRuntimeState;
  } catch {
    return null;
  }
}

function diagnosticLogFiles(root: string): string[] {
  const active = path.join(root, LOG_FILE_NAME);
  const rotated = Array.from({ length: DEFAULT_RETAINED_FILES }, (_, index) => `${active}.${DEFAULT_RETAINED_FILES - index}`);
  return [...rotated, active];
}

function rotateIfNeeded(
  filePath: string,
  incomingBytes: number,
  options: DiagnosticLogConfiguration
): void {
  let currentBytes = 0;
  try {
    currentBytes = statSync(filePath).size;
  } catch {
    return;
  }
  if (currentBytes + incomingBytes <= options.maxBytes) return;
  rmSync(`${filePath}.${options.retainedFiles}`, { force: true });
  for (let index = options.retainedFiles - 1; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    if (existsSync(source)) renameSync(source, `${filePath}.${index + 1}`);
  }
  renameSync(filePath, `${filePath}.1`);
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 8) return "[MAX_DEPTH]";
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeText(value).slice(0, 20_000);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeText(value.message),
      stack: value.stack ? sanitizeText(value.stack).slice(0, 20_000) : undefined,
      ...(typeof (value as NodeJS.ErrnoException).code === "string" ? { code: (value as NodeJS.ErrnoException).code } : {})
    };
  }
  if (typeof value !== "object") return sanitizeText(String(value));
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, seen, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 100)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(nested, seen, depth + 1);
  }
  return output;
}

function sanitizeText(value: string): string {
  return value
    .replace(URL_CREDENTIALS, (_match, scheme: string) => `${scheme}://${REDACTED}@`)
    .replace(AUTH_HEADER, (_match, name: string) => `${name}: ${REDACTED}`)
    .replace(INLINE_SECRET, (_match, name: string) => `${name}=${REDACTED}`);
}

function formatConsoleArgs(args: unknown[]): string {
  return sanitizeText(args.map((value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return inspect(value, { depth: 3, breakLength: 160 });
  }).join(" "));
}

function isDiagnosticLogEntry(value: unknown): value is DiagnosticLogEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DiagnosticLogEntry>;
  return typeof entry.timestamp === "string" &&
    (entry.level === "debug" || entry.level === "info" || entry.level === "warn" || entry.level === "error") &&
    typeof entry.component === "string" && typeof entry.event === "string" && typeof entry.message === "string";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
