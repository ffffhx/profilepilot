export interface ShutdownStage {
  name: string;
  order?: number;
  after?: string | readonly string[];
  run(): void | Promise<void>;
}

export interface ShutdownOptions {
  stages: ShutdownStage[];
  log(level: "info" | "error", event: string, message: string, details: Record<string, unknown>): void;
  requestQuit(): void;
  forceExit(): void;
  cleanupTimeoutMs?: number;
  quitTimeoutMs?: number;
  sequential?: boolean;
}

const DEFAULT_STAGE_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  // Task shutdown hands off active sessions over browserConnection; keep transport
  // alive until task persistence and handoff settle.
  "browser-connection": ["tasks-save-and-handoff"]
};

type StageStatus = "pending" | "running" | "done" | "error" | "timeout";

/** Keep both asynchronous cleanup and Electron's second quit attempt bounded. */
export class ShutdownCoordinator {
  private phase: "idle" | "cleaning" | "quitting" | "forced" | "finished" = "idle";
  private readonly stages = new Map<string, StageStatus>();
  private started = 0;
  private timer?: NodeJS.Timeout;
  private failed = false;

  constructor(private readonly options: ShutdownOptions) {}

  get clean(): boolean { return !this.failed && (this.phase === "quitting" || this.phase === "finished"); }

  beforeQuit(event: { preventDefault(): void }, reason = "electron"): void {
    if (this.phase === "quitting" || this.phase === "finished") {
      this.log("info", "app.shutdown.quit_allowed", "清理已结束，允许 Electron 退出");
      return;
    }
    event.preventDefault();
    if (this.phase !== "idle") {
      this.log("info", "app.shutdown.quit_deferred", "退出清理仍在进行，保留当前退出请求");
      return;
    }
    this.phase = "cleaning";
    this.started = Date.now();
    const timeoutMs = this.options.cleanupTimeoutMs ?? 45_000;
    this.log("info", "app.quit_requested", "ProfilePilot 正在退出", { reason, timeout_ms: timeoutMs });
    // Arm before invoking any cleanup. A rejected/synchronous stage must never
    // short-circuit the other stages or bypass saving/returning browser control.
    this.timer = setTimeout(() => this.force("cleanup"), timeoutMs);
    const pending = this.launchOrderedStages();
    void Promise.all(pending).then(() => {
      if (this.phase !== "cleaning") return;
      clearTimeout(this.timer);
      this.phase = "quitting";
      const timeoutMs = this.options.quitTimeoutMs ?? 5_000;
      this.timer = setTimeout(() => this.force("electron-quit"), timeoutMs);
      // Leave the original close/before-quit stack before requesting quit again.
      setImmediate(() => {
        if (this.phase !== "quitting") return;
        this.log("info", "app.shutdown.quit_again", "清理已结束，再次请求 Electron 退出", { timeout_ms: timeoutMs });
        try { this.options.requestQuit(); }
        catch (error) {
          this.failed = true;
          this.log("error", "app.shutdown.quit_error", "再次请求退出失败", { error });
          this.force("electron-quit-error");
        }
      });
    });
  }

  private launchOrderedStages(): Array<Promise<void>> {
    const entries = this.options.stages.map((stage, index) => ({
      stage,
      order: this.options.sequential ? index : (stage.order ?? 0)
    }));
    const byName = new Map(entries.map((entry) => [entry.stage.name, entry]));
    const sortedOrders = [...new Set(entries.map((entry) => entry.order))].sort((a, b) => a - b);
    const prevOrder = new Map<number, number>();
    for (let i = 1; i < sortedOrders.length; i += 1) {
      prevOrder.set(sortedOrders[i], sortedOrders[i - 1]);
    }

    const depsByName = new Map<string, string[]>();
    const reaches = (start: string, goal: string): boolean => {
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === goal) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const next of depsByName.get(current) ?? []) stack.push(next);
      }
      return false;
    };

    for (const entry of entries) {
      const { stage, order } = entry;
      const deps: string[] = [];
      const previousTier = prevOrder.get(order);
      if (previousTier !== undefined) {
        for (const candidate of entries) {
          if (candidate.order === previousTier && candidate.stage.name !== stage.name) {
            deps.push(candidate.stage.name);
          }
        }
      }
      const rawAfter = stage.after !== undefined
        ? (typeof stage.after === "string" ? [stage.after] : stage.after)
        : (!this.options.sequential && stage.order === undefined ? (DEFAULT_STAGE_DEPENDENCIES[stage.name] ?? []) : []);
      for (const dep of rawAfter) {
        if (dep !== stage.name && byName.has(dep) && !deps.includes(dep) && !reaches(dep, stage.name)) {
          deps.push(dep);
        }
      }
      depsByName.set(stage.name, deps);
      if (deps.length > 0) {
        this.stages.set(stage.name, "pending");
      }
    }

    const promises = new Map<string, Promise<void>>();
    const ensureScheduled = (name: string): Promise<void> => {
      const existing = promises.get(name);
      if (existing) return existing;
      const entry = byName.get(name)!;
      const deps = depsByName.get(name) ?? [];
      const task = deps.length === 0
        ? this.executeStage(entry.stage)
        : Promise.all(deps.map((dep) => ensureScheduled(dep))).then(() => {
            if (this.phase !== "cleaning") return;
            return this.executeStage(entry.stage);
          });
      promises.set(name, task);
      return task;
    };

    return entries.map((entry) => ensureScheduled(entry.stage.name));
  }

  private executeStage(stage: ShutdownStage): Promise<void> {
    this.stages.set(stage.name, "running");
    this.log("info", "app.shutdown.stage.begin", "开始退出清理", { stage: stage.name });
    const began = Date.now();
    return Promise.resolve().then(() => stage.run()).then(() => {
      if (this.phase !== "cleaning") return;
      this.stages.set(stage.name, "done");
      this.log("info", "app.shutdown.stage.done", "退出清理已完成", { stage: stage.name, duration_ms: Date.now() - began });
    }, error => {
      if (this.phase !== "cleaning") return;
      this.failed = true;
      this.stages.set(stage.name, "error");
      this.log("error", "app.shutdown.stage.error", "退出清理失败，其它清理将继续", { stage: stage.name, duration_ms: Date.now() - began, error });
    });
  }

  willQuit(): void {
    this.log("info", "app.shutdown.will_quit", "Electron 已开始最终退出");
    // Do not disarm here: another will-quit listener can still prevent exit.
  }

  didQuit(): void {
    clearTimeout(this.timer);
    this.phase = "finished";
  }

  private force(reason: string): void {
    if (this.phase === "finished" || this.phase === "forced") return;
    this.failed = true;
    for (const [stage, status] of this.stages) if (status === "running") {
      this.stages.set(stage, "timeout");
      this.log("error", "app.shutdown.stage.timeout", "退出清理超时，完成状态未确认", { stage });
    }
    this.phase = "forced";
    clearTimeout(this.timer);
    this.log("error", "app.shutdown.forced_exit", "退出未能在时限内完成；保留未完成清理记录并终止主进程", { reason, exit_code: 1 });
    this.options.forceExit();
  }

  private log(level: "info" | "error", event: string, message: string, details: Record<string, unknown> = {}): void {
    this.options.log(level, event, message, { elapsed_ms: this.started ? Date.now() - this.started : 0, stages: Object.fromEntries(this.stages), ...details });
  }
}
