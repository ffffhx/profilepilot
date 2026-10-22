import { performance } from "node:perf_hooks";

/** Opt-in transport observation only: neither retries input nor grants a new lease. */
export class FollowRecovery<T> {
  private lostAt?: number;
  private lastAttempt?: number;
  private attempts = 0;
  private pending?: Promise<T>;
  private abort?: AbortController;
  constructor(private now = () => performance.now()) {}

  lost(): void {
    if (this.lostAt === undefined && !this.pending) this.lostAt = this.now();
  }
  get waiting(): boolean {
    return this.lostAt !== undefined && this.now() - this.lostAt < 2000
      && (!!this.pending || this.attempts < 3 && (this.lastAttempt === undefined || this.now() - this.lastAttempt >= 10000));
  }
  cancel(): void {
    this.lostAt = undefined;
    this.abort?.abort(new Error("跟随恢复已取消，手机会话不能继续。"));
  }
  recover(check: () => void, attempt: (signal: AbortSignal) => Promise<T | undefined>): Promise<T> {
    if (this.pending) return this.pending;
    check();
    if (!this.waiting) return Promise.reject(new Error("跟随连接恢复已超过次数、间隔或两秒时限，已停止。"));
    const controller = this.abort = new AbortController();
    const remaining = Math.max(1, 2000 - (this.now() - this.lostAt!));
    const timer = setTimeout(() => controller.abort(new Error("两秒内未核对原手机会话，跟随已停止。")), remaining);
    this.attempts++; this.lastAttempt = this.now();
    let abortListener!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    this.pending = Promise.resolve().then(async () => {
      try {
        while (true) {
          controller.signal.throwIfAborted(); check();
          const result = await Promise.race([attempt(controller.signal), aborted]);
          controller.signal.throwIfAborted(); check();
          if (result !== undefined) { this.lostAt = undefined; return result; }
          await Promise.race([new Promise(resolve => setTimeout(resolve, 150)), aborted]);
        }
      } finally {
        clearTimeout(timer); controller.signal.removeEventListener("abort", abortListener);
        this.lostAt = undefined; this.pending = undefined; this.abort = undefined;
      }
    });
    return this.pending;
  }
}
