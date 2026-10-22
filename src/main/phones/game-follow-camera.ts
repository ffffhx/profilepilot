/** Native minimap pixels. This module never sends input or derives movement from history. */
export type CameraPoint = Readonly<{ x: number; y: number }>;
export type CameraProof = Readonly<{
  version: 1; epoch: number; sequence: number; x: number; y: number;
  heldSinceUptimeMs: number; capturedAtUptimeMs: number; expiresAtUptimeMs: number;
}>;
export type CameraContext = Readonly<{ point: CameraPoint; epoch: number; sequence: number }>;
export type CameraObservation = {
  /** Current reliable full portrait only; never a partial, prediction, or old tracker point. */
  fullTarget?: CameraPoint;
  lost: boolean;
  /** Current name/HP projection, accepted by vision using this frame's CameraContext. */
  cameraTarget?: CameraPoint;
};
export type CameraPlan = Readonly<{
  id: number; point: CameraPoint | null; stopJoystick: boolean;
  allowCameraMovement: boolean; reason: string; ttlMs: number;
}>;
export type GameFollowCameraOptions = {
  enabled: boolean; mode: "observe" | "control"; backend: "app" | "basic";
  provenanceVersion?: number;
};
type Hold = {
  point: CameraPoint; sequence: number; startedAt: number; expiresAt: number;
  epoch?: number; heldSince?: number; lastCapture?: number;
};
type CurrentFrame = { context: CameraContext };
const STABLE_MS = 250, RECENT_MS = 3000, BUDGET_MS = 6000, FRAME_MS = 1000, RELEASE_MS = 500;
const validPoint = (point: CameraPoint | undefined): point is CameraPoint => !!point
  && Number.isFinite(point.x) && point.x >= 0 && Number.isFinite(point.y) && point.y >= 0;
const samePoint = (a: CameraPoint, b: CameraPoint) => a.x === b.x && a.y === b.y;
const copyPoint = (p: CameraPoint): CameraPoint => Object.freeze({ x: p.x, y: p.y });

/**
 * Pure camera state machine. All `now` values are host performance.now() values.
 * Phone uptime values are compared only with other phone uptime values.
 * Call beforeAnalyze once per newly captured frame, then afterAnalyze once. Merge
 * the returned point as id1 with this frame's id0 decision; commit only after that
 * exact touch succeeds. An uncertain input must propagate to the outer loop and
 * invalidate this machine; it must never be replayed. Every touch, including [],
 * participates in commit. Cancel/recovery creates a fresh evidence boundary.
 */
export class GameFollowCamera {
  private readonly enabled: boolean;
  private hold?: Hold;
  private recent?: { point: CameraPoint; observedAt: number };
  private frame?: CurrentFrame;
  private fullSince?: number;
  private fullCount = 0;
  private pending?: { plan: CameraPlan; createdAt: number };
  private nextId = 0;
  private lastSequence = 0;
  private lastNow = -Infinity;
  private releaseRequired = false;
  private reason = "idle";

  constructor(options: GameFollowCameraOptions) {
    this.enabled = options.enabled && options.mode === "control" && options.backend === "app"
      && options.provenanceVersion === 1;
  }

  get state(): "idle" | "arming" | "held" | "releasing" {
    // Status only. Each frame still requires its own returned CameraContext.
    return this.releaseRequired ? "releasing" : !this.hold ? "idle" : this.hold.epoch !== undefined ? "held" : "arming";
  }

  invalidate(reason: string): void {
    this.releaseRequired ||= !!this.hold || !!this.pending?.plan.point;
    this.hold = undefined; this.recent = undefined; this.frame = undefined;
    this.fullSince = undefined; this.fullCount = 0; this.pending = undefined; this.reason = reason;
  }

  private clock(now: number): void {
    if (!Number.isFinite(now) || now < this.lastNow) {
      this.invalidate("invalid-monotonic-clock");
      throw new Error("Camera state requires a nondecreasing host monotonic clock");
    }
    this.lastNow = now;
  }

  private expire(now: number): void {
    if (this.hold && (now >= this.hold.expiresAt || now - this.hold.startedAt >= BUDGET_MS))
      this.invalidate(now >= this.hold.expiresAt ? "hold-expired" : "hold-budget");
  }

  beforeAnalyze(proof: CameraProof | undefined, now: number): CameraContext | undefined {
    this.clock(now); this.frame = undefined;
    // A caller cannot silently continue after an input with no known ACK.
    if (this.pending) this.invalidate("unacknowledged-input");
    this.expire(now);
    const hold = this.hold;
    if (!this.enabled || !hold || !proof) return undefined;
    const integers = [proof.epoch, proof.sequence, proof.x, proof.y, proof.heldSinceUptimeMs,
      proof.capturedAtUptimeMs, proof.expiresAtUptimeMs];
    if (proof.version !== 1 || !integers.every(v => Number.isSafeInteger(v) && v >= 0)
      || proof.sequence !== hold.sequence || !samePoint(proof, hold.point)
      || proof.capturedAtUptimeMs < proof.heldSinceUptimeMs) return undefined;
    if (proof.capturedAtUptimeMs >= proof.expiresAtUptimeMs) {
      this.invalidate("phone-proof-expired"); return undefined;
    }
    if (hold.epoch !== undefined && (proof.epoch !== hold.epoch || proof.heldSinceUptimeMs !== hold.heldSince)) {
      this.invalidate("phone-hold-changed"); return undefined;
    }
    if (proof.capturedAtUptimeMs - proof.heldSinceUptimeMs < STABLE_MS
      || hold.lastCapture !== undefined && proof.capturedAtUptimeMs <= hold.lastCapture) return undefined;
    hold.epoch = proof.epoch; hold.heldSince = proof.heldSinceUptimeMs; hold.lastCapture = proof.capturedAtUptimeMs;
    const context: CameraContext = Object.freeze({ point: copyPoint(hold.point), epoch: proof.epoch, sequence: proof.sequence });
    this.frame = { context };
    return context;
  }

  afterAnalyze(analysis: CameraObservation, frameAgeMs: number, now: number): CameraPlan {
    this.clock(now); this.expire(now);
    if (this.pending) this.invalidate("unacknowledged-input");
    const current = this.frame; this.frame = undefined;
    const plan = (point: CameraPoint | null, stopJoystick: boolean, allowCameraMovement: boolean, reason: string) => {
      const remaining = this.hold ? Math.floor(this.hold.startedAt + BUDGET_MS - now) : BUDGET_MS;
      if (point && remaining < 100) {
        this.invalidate("hold-budget"); point = null; stopJoystick = true; allowCameraMovement = false; reason = "hold-budget";
      }
      const value: CameraPlan = Object.freeze({ id: ++this.nextId, point: point ? copyPoint(point) : null,
        stopJoystick, allowCameraMovement, reason, ttlMs: point ? Math.min(1200, remaining) : 1200 });
      this.pending = { plan: value, createdAt: now }; this.reason = reason; return value;
    };
    if (!this.enabled) return plan(null, false, false, "disabled");
    if (!Number.isFinite(frameAgeMs) || frameAgeMs < 0 || frameAgeMs >= FRAME_MS) {
      this.invalidate("stale-frame"); return plan(null, true, false, "stale-frame");
    }
    if (this.releaseRequired) return plan(null, true, false, this.reason);
    const full = validPoint(analysis.fullTarget) ? analysis.fullTarget : undefined;
    if (full) this.recent = { point: copyPoint({ x: Math.round(full.x), y: Math.round(full.y) }), observedAt: now - frameAgeMs };
    if (!this.hold) {
      if (!full && analysis.lost && this.recent && now - this.recent.observedAt <= RECENT_MS)
        return plan(this.recent.point, true, false, "arm");
      return plan(null, !full && analysis.lost, false, "idle");
    }
    if (full) {
      this.fullSince ??= now; this.fullCount++;
      if (this.fullCount >= 2 && now - this.fullSince >= RELEASE_MS)
        return plan(null, true, false, "full-target-restored");
    } else { this.fullSince = undefined; this.fullCount = 0; }
    // expire(now) enforces plan-created-at + the exact ACKed TTL. Plan creation
    // precedes phone receipt, so that host deadline cannot outlast the phone's
    // receipt + TTL. The matching proof separately validates the capture instant.
    // Do not subtract the whole request age from phone expiry-minus-capture:
    // that would count time spent waiting BEFORE capture as post-capture age.
    const proven = !!current && !!this.hold && current.context.sequence === this.hold.sequence;
    const cameraCurrent = proven && validPoint(analysis.cameraTarget);
    return plan(this.hold.point, !full && !cameraCurrent, !full && cameraCurrent,
      full ? "full-target-confirming" : cameraCurrent ? "held-current-target" : "await-current-evidence");
  }

  /** ACK means accepted, not yet applied. Only a later matching frame proves application. */
  commit(plan: CameraPlan, sequence: number, now: number, ttlMs = plan.ttlMs): boolean {
    this.clock(now);
    const pending = this.pending;
    if (!pending || pending.plan !== plan) return false;
    if (!Number.isSafeInteger(sequence) || sequence <= this.lastSequence
      || !Number.isInteger(ttlMs) || ttlMs < 100 || ttlMs > plan.ttlMs) {
      this.invalidate("invalid-input-ack"); return false;
    }
    this.pending = undefined; this.lastSequence = sequence; this.frame = undefined;
    if (!plan.point) {
      this.hold = undefined; this.releaseRequired = false; this.fullSince = undefined; this.fullCount = 0;
      return true;
    }
    // Start the host TTL before transmission (plan creation), never at late ACK.
    if (now >= pending.createdAt + ttlMs || this.hold &&
      (now >= this.hold.expiresAt || now - this.hold.startedAt >= BUDGET_MS)) {
      this.releaseRequired = true; this.invalidate("late-input-ack"); return false;
    }
    if (this.hold && samePoint(plan.point, this.hold.point)) {
      this.hold.sequence = sequence; this.hold.expiresAt = pending.createdAt + ttlMs;
    } else {
      this.hold = { point: copyPoint(plan.point), sequence, startedAt: pending.createdAt, expiresAt: pending.createdAt + ttlMs };
      this.fullSince = undefined; this.fullCount = 0;
    }
    return true;
  }
}
