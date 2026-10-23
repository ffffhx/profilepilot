type Point = Readonly<{ x: number; y: number }>;

export type CameraCaptureWindow = Readonly<{
  /** Host-monotonic scheduling hint, never evidence that a DOWN was applied. */
  notBefore: number;
  /** The original command's conservative deadline; waiting must not renew it. */
  expiresAt: number;
}>;

// Match the current negotiated release-newdown/100ms native policy. The extra
// 80ms is its UP stroke duration; callbacks and dispatch can still run late.
// A later frame must independently pass the native proof's 250ms stable gate.
const RESELECT_MS = 80 + 100 + 250;
const FIRST_DOWN_MS = 250;
const CHECK_MS = 25;

/** Only a newly added or changed id1 needs an additional capture interval. */
export function cameraCaptureWindow(previous: Point | undefined, next: Point | null,
  createdAt: number, acknowledgedAt: number, ttlMs: number): CameraCaptureWindow | undefined {
  if (!next || previous && previous.x === next.x && previous.y === next.y) return undefined;
  if (![createdAt, acknowledgedAt, next.x, next.y].every(Number.isFinite)
    || acknowledgedAt < createdAt || !Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > 1500)
    throw new RangeError("Invalid camera capture scheduling values");
  return Object.freeze({ notBefore: acknowledgedAt + (previous ? RESELECT_MS : FIRST_DOWN_MS),
    expiresAt: createdAt + ttlMs });
}

type WaitRuntime = { now(): number; wait(ms: number): Promise<void> };
const runtime: WaitRuntime = { now: () => performance.now(), wait: ms => new Promise(resolve => setTimeout(resolve, ms)) };

/**
 * Wait without sending/renewing input. The caller supplies run/epoch ownership,
 * so stop, pause observed by the heartbeat, and transport recovery interrupt the
 * wait. `expired` requires release before another capture. It also covers a
 * timer stall past the original TTL; no late timer counts as permission.
 */
export async function waitForCameraCapture(window: CameraCaptureWindow, cadenceAt: number,
  current: () => boolean, clock: WaitRuntime = runtime): Promise<"ready" | "cancelled" | "expired"> {
  const notBefore = Math.max(window.notBefore, cadenceAt);
  let previous = -Infinity;
  for (;;) {
    if (!current()) return "cancelled";
    const now = clock.now();
    if (!Number.isFinite(now) || now < previous || !Number.isFinite(notBefore)
      || !Number.isFinite(window.expiresAt) || notBefore >= window.expiresAt || now >= window.expiresAt)
      return "expired";
    previous = now;
    if (now >= notBefore) return "ready";
    await clock.wait(Math.min(CHECK_MS, notBefore - now, window.expiresAt - now));
  }
}
