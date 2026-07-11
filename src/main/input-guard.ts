import { spawn } from "node:child_process";
import {
  launchInputGuardCompanion,
  resolveInputGuardHelperPath,
  type InputGuardProcess
} from "./input-guard-companion";

const CLICK_MAX_DURATION_NS = 2_000_000_000;
const WINDOW_GEOMETRY_EPSILON = 0.75;
const HELPER_RESTART_DELAY_MS = 800;
const HEALTH_RETRY_DELAY_MS = 1500;

export interface InputGuardWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InputGuardPoint {
  x: number;
  y: number;
}

export interface InputGuardClick {
  pid: number;
  windowId: number;
  displayScale: number;
  window: InputGuardWindowBounds;
  down: InputGuardPoint;
  up: InputGuardPoint;
  startedAt: number;
  endedAt: number;
}

interface InputGuardMouseMessage {
  type: "mouse";
  pid: number;
  phase: "down" | "up";
  button: number;
  x: number;
  y: number;
  windowId: number;
  timestamp: number;
  displayScale: number;
  window: InputGuardWindowBounds | null;
}

export interface InputGuardStatusMessage {
  type: "status";
  status: string;
  pid?: number;
  activeCount?: number;
}

type InputGuardMessage = InputGuardMouseMessage | InputGuardStatusMessage;

export interface InputGuardController {
  sync(pids: number[]): void;
  dispose(): void | Promise<void>;
}

export interface MacInputGuardOptions {
  onClick: (click: InputGuardClick) => void;
  onStatus?: (message: InputGuardStatusMessage) => void;
  helperPath?: string;
  platform?: NodeJS.Platform;
  spawnHelper?: (helperPath: string) => InputGuardProcess;
}

export class MacInputGuard implements InputGuardController {
  private readonly platform: NodeJS.Platform;
  private readonly helperPath: string;
  private readonly spawnHelper: (helperPath: string) => InputGuardProcess;
  private wantedPids: number[] = [];
  private child: InputGuardProcess | null = null;
  private ready = false;
  private stopping = false;
  private stdoutBuffer = "";
  private restartTimer: NodeJS.Timeout | null = null;
  private healthRetryTimer: NodeJS.Timeout | null = null;
  private readonly activePids = new Set<number>();
  private readonly mouseDown = new Map<string, InputGuardMouseMessage>();

  constructor(private readonly options: MacInputGuardOptions) {
    this.platform = options.platform || process.platform;
    this.helperPath = options.helperPath || (this.platform === "darwin" ? defaultInputGuardHelperPath() : "");
    this.spawnHelper = options.spawnHelper || ((helperPath) => {
      if (this.platform === "darwin" && helperPath.includes(".app/Contents/MacOS/")) {
        return launchInputGuardCompanion(helperPath);
      }
      return spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    });
  }

  sync(pids: number[]): void {
    this.wantedPids = normalizePids(pids);
    for (const pid of [...this.activePids]) {
      if (!this.wantedPids.includes(pid)) {
        this.activePids.delete(pid);
      }
    }
    this.mouseDown.clear();
    if (this.platform !== "darwin" || !this.wantedPids.length) {
      this.clearHealthRetryTimer();
      this.stopHelper();
      return;
    }
    this.ensureHelper();
    this.writeWantedPids();
  }

  dispose(): void {
    this.wantedPids = [];
    this.clearRestartTimer();
    this.clearHealthRetryTimer();
    this.stopHelper();
  }

  private ensureHelper(): void {
    if (this.child || this.stopping || this.platform !== "darwin" || !this.wantedPids.length) {
      return;
    }
    this.clearRestartTimer();
    this.clearHealthRetryTimer();
    this.ready = false;
    this.stdoutBuffer = "";
    this.activePids.clear();
    let child: InputGuardProcess;
    try {
      child = this.spawnHelper(this.helperPath);
    } catch (error) {
      this.reportStatus({ type: "status", status: "helper-spawn-failed" });
      this.scheduleRestart();
      return;
    }
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (chunk.trim()) {
        console.warn(`[ProfilePilot] Input Guard: ${chunk.trim()}`);
      }
    });
    child.on("error", () => {
      this.reportStatus({ type: "status", status: "helper-error" });
    });
    child.on("exit", () => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.ready = false;
      this.stdoutBuffer = "";
      this.mouseDown.clear();
      this.activePids.clear();
      const wasStopping = this.stopping;
      this.stopping = false;
      if (this.wantedPids.length) {
        if (!wasStopping) {
          this.reportStatus({ type: "status", status: "helper-exited" });
        }
        this.scheduleRestart();
      }
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      const message = parseInputGuardOutputLine(line);
      if (!message) {
        continue;
      }
      if (message.type === "status") {
        if (message.status === "ready") {
          this.ready = true;
          this.writeWantedPids();
        }
        if ((message.status === "tap-active" || message.status === "tap-reenabled") && message.pid) {
          this.activePids.add(message.pid);
        }
        if (
          (message.status === "tap-removed" ||
            message.status === "tap-create-failed" ||
            message.status === "tap-disabled") &&
          message.pid
        ) {
          this.activePids.delete(message.pid);
        }
        this.reportStatus(message);
        if (message.status === "sync-complete") {
          const healthy =
            this.wantedPids.length > 0 &&
            message.activeCount === this.wantedPids.length &&
            this.wantedPids.every((pid) => this.activePids.has(pid));
          this.reportStatus({ type: "status", status: healthy ? "guard-active" : "guard-unavailable", activeCount: message.activeCount });
          if (healthy) {
            this.clearHealthRetryTimer();
          } else {
            this.scheduleHealthRetry();
          }
        }
        // 兼容旧 helper 或系统未能原地恢复事件 tap 的情况：保留目标 PID，重启后自动重新 SET。
        if (message.status === "tap-disabled") {
          this.stopHelper();
        }
        continue;
      }
      this.handleMouseMessage(message);
    }
  }

  private handleMouseMessage(message: InputGuardMouseMessage): void {
    const key = `${message.pid}:${message.button}`;
    if (message.phase === "down") {
      this.mouseDown.set(key, message);
      return;
    }

    const down = this.mouseDown.get(key);
    this.mouseDown.delete(key);
    if (!down || message.button !== 0 || !down.window || !message.window) {
      return;
    }
    if (
      down.pid !== message.pid ||
      down.windowId <= 0 ||
      down.windowId !== message.windowId ||
      message.timestamp < down.timestamp ||
      message.timestamp - down.timestamp > CLICK_MAX_DURATION_NS ||
      Math.abs(down.displayScale - message.displayScale) > 0.01 ||
      !sameWindowBounds(down.window, message.window)
    ) {
      return;
    }

    this.options.onClick({
      pid: message.pid,
      windowId: message.windowId,
      displayScale: message.displayScale,
      window: message.window,
      down: { x: down.x, y: down.y },
      up: { x: message.x, y: message.y },
      startedAt: down.timestamp,
      endedAt: message.timestamp
    });
  }

  private writeWantedPids(): void {
    const child = this.child;
    if (!child || !this.ready || child.stdin.destroyed || !child.stdin.writable) {
      return;
    }
    child.stdin.write(`SET${this.wantedPids.length ? ` ${this.wantedPids.join(" ")}` : ""}\n`);
  }

  private stopHelper(): void {
    const child = this.child;
    this.clearRestartTimer();
    this.clearHealthRetryTimer();
    this.mouseDown.clear();
    this.activePids.clear();
    if (!child) {
      this.ready = false;
      this.stopping = false;
      return;
    }
    this.stopping = true;
    this.ready = false;
    if (!child.stdin.destroyed && child.stdin.writable) {
      child.stdin.end("SET\nQUIT\n");
    } else {
      child.kill("SIGTERM");
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping || !this.wantedPids.length || this.platform !== "darwin") {
      return;
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.ensureHelper();
    }, HELPER_RESTART_DELAY_MS);
    this.restartTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private scheduleHealthRetry(): void {
    if (this.healthRetryTimer || !this.ready || !this.wantedPids.length || this.platform !== "darwin") {
      return;
    }
    this.healthRetryTimer = setTimeout(() => {
      this.healthRetryTimer = null;
      this.writeWantedPids();
    }, HEALTH_RETRY_DELAY_MS);
    this.healthRetryTimer.unref?.();
  }

  private clearHealthRetryTimer(): void {
    if (this.healthRetryTimer) {
      clearTimeout(this.healthRetryTimer);
      this.healthRetryTimer = null;
    }
  }

  private reportStatus(message: InputGuardStatusMessage): void {
    this.options.onStatus?.(message);
  }
}

export function parseInputGuardOutputLine(line: string): InputGuardMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || (value.type !== "mouse" && value.type !== "status")) {
    return null;
  }
  if (value.type === "status") {
    return typeof value.status === "string"
      ? {
          type: "status",
          status: value.status,
          pid: positiveInteger(value.pid) || undefined,
          activeCount: nonNegativeInteger(value.activeCount) ?? undefined
        }
      : null;
  }

  const window = inputGuardWindowBounds(value.window);
  const pid = positiveInteger(value.pid);
  const button = nonNegativeInteger(value.button);
  const windowId = nonNegativeInteger(value.windowId);
  const timestamp = finiteNumber(value.timestamp);
  const displayScale = positiveFiniteNumber(value.displayScale);
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  if (
    !pid ||
    button === null ||
    windowId === null ||
    timestamp === null ||
    displayScale === null ||
    x === null ||
    y === null ||
    (value.phase !== "down" && value.phase !== "up")
  ) {
    return null;
  }
  return {
    type: "mouse",
    pid,
    phase: value.phase,
    button,
    x,
    y,
    windowId,
    timestamp,
    displayScale,
    window
  };
}

export function defaultInputGuardHelperPath(): string {
  return resolveInputGuardHelperPath();
}

function normalizePids(pids: number[]): number[] {
  return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))].sort((left, right) => left - right);
}

function sameWindowBounds(left: InputGuardWindowBounds, right: InputGuardWindowBounds): boolean {
  return (
    Math.abs(left.x - right.x) <= WINDOW_GEOMETRY_EPSILON &&
    Math.abs(left.y - right.y) <= WINDOW_GEOMETRY_EPSILON &&
    Math.abs(left.width - right.width) <= WINDOW_GEOMETRY_EPSILON &&
    Math.abs(left.height - right.height) <= WINDOW_GEOMETRY_EPSILON
  );
}

function inputGuardWindowBounds(value: unknown): InputGuardWindowBounds | null {
  if (!isRecord(value)) {
    return null;
  }
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }
  return { x, y, width, height };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveFiniteNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
