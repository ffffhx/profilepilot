import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync
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

interface DiagnosticLogConfiguration {
  root: string;
  appVersion: string | null;
  maxBytes: number;
  retainedFiles: number;
}

const LOG_FILE_NAME = "profilepilot.log.jsonl";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETAINED_FILES = 5;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|proxy[_-]?(?:password|username)|credential)/i;
const URL_CREDENTIALS = /\b(https?|socks5?):\/\/([^\s/@:]+):([^\s/@]+)@/gi;
const AUTH_HEADER = /\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi;
const INLINE_SECRET = /\b(token|password|passwd|secret|api[_-]?key|access[_-]?key)\s*[:=]\s*([^\s,;]+)/gi;

let configuration: DiagnosticLogConfiguration | null = null;
let consoleCaptureInstalled = false;

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
