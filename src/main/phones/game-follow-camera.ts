import type { FollowCameraStatus } from "../../shared/game-follow";
import { planCameraArm, planCameraRecenter, type CameraPlacementConfig, type CameraPlacement } from "./game-follow-camera-placement";

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
  /** Current non-camera evidence (including a separately validated partial portrait). */
  currentTarget?: CameraPoint;
  fullSelf?: CameraPoint;
  /** Current full portrait or green minimap marker; never a past tracker point. */
  currentSelf?: CameraPoint;
  cameraSelf?: CameraPoint;
  selfLost?: boolean;
  /** Host-monotonic capture/assembly duration; camera search planning only. */
  captureMs?: number;
};
export type CameraPlan = Readonly<{
  id: number; point: CameraPoint | null; stopJoystick: boolean;
  allowCameraMovement: boolean; reason: string; ttlMs: number;
}>;
export type GameFollowCameraOptions = {
  enabled: boolean; mode: "observe" | "control"; backend: "app" | "basic";
  provenanceVersion?: number;
  placement?: CameraPlacementConfig;
  targetEnabled?: boolean;
  selfPlacement?: CameraPlacementConfig;
  intervalMs?: number;
};
type Hold = {
  role: "target" | "self";
  point: CameraPoint; sequence: number; startedAt: number; expiresAt: number;
  searchDeadline: number; evidenceAt?: number;
  epoch?: number; heldSince?: number; lastCapture?: number;
  previousEpoch?: number;
};
type CurrentFrame = { context: CameraContext; proof: CameraProof };
type FullObservation = { point: CameraPoint; at: number };
type RecentFull = { point: CameraPoint; observedAt: number; speed?: CameraPoint; intervalMs?: number };
const STABLE_MS = 250, RECENT_MS = 3000, SEARCH_MS = 6000, FRAME_MS = 1000, RELEASE_MS = 500;
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
  private recent?: RecentFull;
  private recentSelf?: RecentFull;
  private previousFull?: FullObservation;
  private previousFullSelf?: FullObservation;
  private frame?: CurrentFrame;
  private fullSince?: number;
  private fullCount = 0;
  private pending?: { plan: CameraPlan; createdAt: number; role: "target" | "self" };
  private nextId = 0;
  private lastSequence = 0;
  private lastNow = -Infinity;
  private releaseRequired = false;
  private reason = "idle";
  private frameProof = false;
  private frameProofSequence?: number;
  private frameTarget: FollowCameraStatus["frameTarget"] = "none";
  private frameSelf: FollowCameraStatus["frameSelf"] = "none";
  private armAttempts = 0;
  private releaseRequests = 0;
  private releaseReasons: Record<string, number> = {};
  private releaseRecorded = false;
  private readonly placementConfig?: CameraPlacementConfig;
  private readonly selfPlacementConfig?: CameraPlacementConfig;
  private readonly targetEnabled: boolean;
  private readonly intervalMs: number;
  private placement?: CameraPlacement;
  private recenterAttempts = 0;
  private observation?: { point: CameraPoint; at: number };
  private selfObservation?: { point: CameraPoint; at: number };
  private selfSpeed?: CameraPoint;
  private speed?: CameraPoint;

  constructor(options: GameFollowCameraOptions) {
    this.enabled = options.enabled && options.mode === "control" && options.backend === "app"
      && options.provenanceVersion === 1;
    this.placementConfig = options.placement;
    this.selfPlacementConfig = options.selfPlacement;
    this.targetEnabled = options.targetEnabled ?? true;
    this.intervalMs = options.intervalMs ?? 350;
  }

  get state(): "idle" | "arming" | "held" | "releasing" {
    // Status only. Each frame still requires its own returned CameraContext.
    return this.releaseRequired ? "releasing" : !this.hold ? "idle" : this.hold.epoch !== undefined ? "held" : "arming";
  }

  /** A snapshot does not advance clocks, extend deadlines, or prove phone state. */
  status(now: number): FollowCameraStatus {
    const hold = this.hold, remaining = (deadline: number) => Math.max(0, Math.floor(deadline - now));
    return { state: this.state, reason: this.reason,
      ...(hold ? { point: copyPoint(hold.point), sequence: hold.sequence, role: hold.role } : {}),
      holdAgeMs: hold ? Math.max(0, Math.floor(now - hold.startedAt)) : 0,
      ...(hold?.evidenceAt !== undefined ? { evidenceAgeMs: Math.max(0, Math.floor(now - hold.evidenceAt)) } : {}),
      searchRemainingMs: hold ? remaining(hold.searchDeadline) : 0, ttlRemainingMs: hold ? remaining(hold.expiresAt) : 0,
      frameProof: this.frameProof, ...(this.frameProofSequence !== undefined ? { frameProofSequence: this.frameProofSequence } : {}),
      frameTarget: this.frameTarget, frameSelf: this.frameSelf, armAttempts: this.armAttempts,
      releaseRequests: this.releaseRequests, releaseReasons: { ...this.releaseReasons }, recenterAttempts: this.recenterAttempts,
      ...(this.placement ? { placement: structuredClone(this.placement) } : {}),
      ...((hold?.role === "self" ? this.selfSpeed : this.speed)
        ? { speedMapPxPerSecond: copyPoint((hold?.role === "self" ? this.selfSpeed : this.speed)!) } : {}) };
  }

  private recordRelease(reason: string) {
    if (!this.releaseRecorded && (this.hold || this.pending?.plan.point || this.releaseRequired)) {
      this.releaseRecorded = true; this.releaseRequests++;
      this.releaseReasons[reason] = (this.releaseReasons[reason] || 0) + 1;
    }
  }

  invalidate(reason: string): void {
    this.recordRelease(reason);
    this.releaseRequired ||= !!this.hold || !!this.pending?.plan.point;
    this.hold = undefined; this.recent = undefined; this.recentSelf = undefined; this.frame = undefined;
    this.fullSince = undefined; this.fullCount = 0; this.pending = undefined; this.reason = reason;
    this.frameProof = false; this.frameProofSequence = undefined; this.frameTarget = "none";
    this.frameSelf = "none";
    this.placement = undefined; this.observation = undefined; this.speed = undefined;
    this.selfObservation = undefined; this.selfSpeed = undefined;
    this.previousFull = undefined; this.previousFullSelf = undefined;
  }

  private clock(now: number): void {
    if (!Number.isFinite(now) || now < this.lastNow) {
      this.invalidate("invalid-monotonic-clock");
      throw new Error("Camera state requires a nondecreasing host monotonic clock");
    }
    this.lastNow = now;
  }

  private expire(now: number): void {
    if (this.hold && (now >= this.hold.expiresAt || now >= this.hold.searchDeadline))
      this.invalidate(now >= this.hold.searchDeadline ? "search-expired" : "hold-expired");
  }

  beforeAnalyze(proof: CameraProof | undefined, now: number): CameraContext | undefined {
    this.clock(now); this.frame = undefined; this.frameProof = false; this.frameProofSequence = undefined; this.frameTarget = "none";
    this.placement = undefined; this.frameSelf = "none";
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
    if (hold.previousEpoch !== undefined && proof.epoch <= hold.previousEpoch) return undefined;
    hold.epoch = proof.epoch; hold.heldSince = proof.heldSinceUptimeMs; hold.lastCapture = proof.capturedAtUptimeMs;
    const context: CameraContext = Object.freeze({ point: copyPoint(hold.point), epoch: proof.epoch, sequence: proof.sequence });
    this.frame = { context, proof: Object.freeze({ ...proof }) };
    this.frameProof = true; this.frameProofSequence = proof.sequence;
    return context;
  }

  afterAnalyze(analysis: CameraObservation, frameAgeMs: number, now: number): CameraPlan {
    this.clock(now); this.expire(now);
    if (this.pending) this.invalidate("unacknowledged-input");
    const current = this.frame; this.frame = undefined;
    const plan = (point: CameraPoint | null, stopJoystick: boolean, allowCameraMovement: boolean, reason: string,
      role: "target" | "self" = this.hold?.role ?? "target") => {
      const remaining = this.hold ? Math.floor(this.hold.searchDeadline - now) : SEARCH_MS;
      if (point && remaining < 100) {
        this.invalidate("search-expired"); point = null; stopJoystick = true; allowCameraMovement = false; reason = "search-expired";
      }
      if (!point) this.recordRelease(reason);
      if (reason === "arm" || reason === "arm-self" || reason === "switch-search-self") this.armAttempts++;
      const value: CameraPlan = Object.freeze({ id: ++this.nextId, point: point ? copyPoint(point) : null,
        stopJoystick, allowCameraMovement, reason, ttlMs: point ? Math.min(1200, remaining) : 1200 });
      this.pending = { plan: value, createdAt: now, role }; this.reason = reason; return value;
    };
    if (!this.enabled) return plan(null, false, false, "disabled");
    if (!Number.isFinite(frameAgeMs) || frameAgeMs < 0 || frameAgeMs >= FRAME_MS) {
      this.invalidate("stale-frame"); return plan(null, true, false, "stale-frame");
    }
    if (this.releaseRequired) return plan(null, true, false, this.reason);
    const full = validPoint(analysis.fullTarget) ? analysis.fullTarget : undefined;
    const fullSelf = validPoint(analysis.fullSelf) ? analysis.fullSelf : undefined;
    const selfEnabled = !!this.selfPlacementConfig;
    const proven = !!current && !!this.hold && current.context.sequence === this.hold.sequence;
    const cameraTarget = this.targetEnabled && proven && validPoint(analysis.cameraTarget) ? analysis.cameraTarget : undefined;
    const cameraSelf = selfEnabled && proven && validPoint(analysis.cameraSelf) ? analysis.cameraSelf : undefined;
    // Preserve target-only behavior; self assistance also accepts the current
    // non-camera target source, but it can never seed full-portrait history.
    const nonCameraTarget = full || (selfEnabled && validPoint(analysis.currentTarget) ? analysis.currentTarget : undefined);
    const nonCameraSelf = fullSelf || (validPoint(analysis.currentSelf) ? analysis.currentSelf : undefined);
    const targetCurrent = nonCameraTarget || cameraTarget, selfCurrent = nonCameraSelf || cameraSelf;
    const stopJoystick = !targetCurrent || selfEnabled && !selfCurrent;
    const allowCameraMovement = !!proven && !!(cameraTarget || cameraSelf) && !stopJoystick;
    this.frameTarget = full ? "full" : cameraTarget ? "camera" : "none";
    this.frameSelf = fullSelf ? "full" : cameraSelf ? "camera" : nonCameraSelf ? "current" : "none";
    const observedAt = now-frameAgeMs;
    const motion = (measured: CameraPoint | undefined, previous: { point: CameraPoint; at: number } | undefined) => {
      const dt = previous ? observedAt-previous.at : 0;
      const speed = measured && previous && dt > 0 && dt <= 1500
        ? { x: (measured.x-previous.point.x)*1000/dt, y: (measured.y-previous.point.y)*1000/dt } : undefined;
      // Only adjacent current measurements estimate speed. A missing frame is
      // not silently bridged; history is never a movement coordinate.
      return { speed, intervalMs: speed ? dt : undefined, observation: measured ? { point: copyPoint(measured), at: observedAt } : undefined };
    };
    const targetMotion = motion(full || cameraTarget, this.observation);
    this.speed = targetMotion.speed; this.observation = targetMotion.observation;
    const selfMotion = motion(fullSelf || cameraSelf, this.selfObservation);
    this.selfSpeed = selfMotion.speed; this.selfObservation = selfMotion.observation;
    // Keep the last adjacent FULL pair for initial id1 selection after loss.
    // Camera/partial/marker frames break the pair and cannot teach this speed.
    // A saved pair survives loss only as recent history; arm caps it at 1 second.
    const fullMotion = motion(full, this.previousFull), fullSelfMotion = motion(fullSelf, this.previousFullSelf);
    this.previousFull = fullMotion.observation; this.previousFullSelf = fullSelfMotion.observation;
    if (full) this.recent = { point: copyPoint(full), observedAt, speed: fullMotion.speed, intervalMs: fullMotion.intervalMs };
    if (fullSelf) this.recentSelf = { point: copyPoint(fullSelf), observedAt, speed: fullSelfMotion.speed, intervalMs: fullSelfMotion.intervalMs };
    const armPlacement = (config: CameraPlacementConfig, recent: RecentFull) => planCameraArm(config,
      { target: recent.point, ageMs: now-recent.observedAt }, { speedMapPxPerSecond: recent.speed,
        sampleIntervalMs: recent.intervalMs, intervalMs: this.intervalMs, captureMs: analysis.captureMs ?? 0 });
    if (!this.hold) {
      const armTarget = this.targetEnabled && !targetCurrent && analysis.lost
        && this.recent && now-this.recent.observedAt <= RECENT_MS;
      const armSelf = selfEnabled && !selfCurrent && !!targetCurrent
        && this.recentSelf && now-this.recentSelf.observedAt <= RECENT_MS;
      if (armTarget || armSelf) {
        const role = armTarget ? "target" : "self";
        const recent = (armTarget ? this.recent : this.recentSelf)!;
        const placement = armTarget ? this.placementConfig : this.selfPlacementConfig;
        if (placement) {
          this.placement = armPlacement(placement, recent);
          if (this.placement.action !== "arm" || !this.placement.point) return plan(null, true, false, "arm-placement-rejected", role);
          return plan(this.placement.point, true, false, armTarget ? "arm" : "arm-self", role);
        }
        return plan({ x: Math.round(recent.point.x), y: Math.round(recent.point.y) }, true, false, "arm", role);
      }
      return plan(null, stopJoystick, false, "idle");
    }
    if (cameraTarget || cameraSelf || nonCameraTarget && (!selfEnabled || nonCameraSelf)) {
      // Current evidence renews only the search horizon. A full target alone
      // cannot perpetually renew a search for a missing self. Neither proof nor
      // an ACK renews it; the independent host/phone touch TTL is unchanged.
      this.hold.evidenceAt = observedAt;
      this.hold.searchDeadline = Math.max(this.hold.searchDeadline, observedAt+SEARCH_MS);
    }
    if (full && (!selfEnabled || nonCameraSelf)) {
      this.fullSince ??= now; this.fullCount++;
      if (this.fullCount >= 2 && now-this.fullSince >= RELEASE_MS)
        return plan(null, false, false, selfEnabled ? "full-pair-restored" : "full-target-restored");
    } else { this.fullSince = undefined; this.fullCount = 0; }
    // A restored target no longer needs the old search point. Do not wait for
    // that search to expire (and discard recentSelf) before seeking a missing
    // self. This historical full portrait chooses id1 only; id0 stops now. The
    // existing search deadline and TTL remain unchanged, and commit requires
    // fresh applied proof for a changed point just like any other camera move.
    if (this.hold.role === "target" && full && !selfCurrent && this.selfPlacementConfig
      && this.recentSelf && now-this.recentSelf.observedAt <= RECENT_MS) {
      this.placement = armPlacement(this.selfPlacementConfig, this.recentSelf);
      if (this.placement.action === "arm" && this.placement.point)
        return plan(this.placement.point, true, false, "switch-search-self", "self");
      return plan(this.hold.point, true, false, "self-switch-placement-rejected");
    }
    // The hold role chooses geometry, never who may be identified in this frame.
    // If the first role is now full, a current camera-only second role may take
    // over placement without discarding the frame's valid directional evidence.
    const recenterRole = this.hold.role === "self" && cameraSelf ? "self"
      : cameraTarget ? "target" : cameraSelf ? "self" : undefined;
    const placement = recenterRole === "self" ? this.selfPlacementConfig : this.placementConfig;
    if (recenterRole && current && placement) {
      this.placement = planCameraRecenter(placement, {
        context: current.context, proof: current.proof, target: recenterRole === "self" ? cameraSelf : cameraTarget, frameAgeMs,
        holdRemainingMs: this.hold.expiresAt-now
      }, { projectionErrorPx: placement.cameraAssist.projectionErrorPx ?? 3,
        speedMapPxPerSecond: (recenterRole === "self" ? this.selfSpeed : this.speed) ?? null,
        horizonMs: Math.max(STABLE_MS, this.intervalMs, frameAgeMs) });
      if (this.placement.action === "recenter" && this.placement.point) {
        this.recenterAttempts++;
        // Direction belongs to the proven OLD frame and keeps the existing
        // submit-age/TTL semantics. commit clears proof for the changed point;
        // the next frame needs that NEW point's applied stable proof.
        return plan(this.placement.point, stopJoystick, allowCameraMovement, "recenter-current-"+recenterRole, recenterRole);
      }
    }
    // plan-created-at precedes receipt, so the host TTL is conservative. Do not
    // subtract frame age from phone expiry: pre-capture time would count twice.
    const reason = stopJoystick ? (selfEnabled && !selfCurrent ? "searching-current-self" : "searching-current-target")
      : cameraSelf ? "held-current-self" : cameraTarget ? "held-current-target" : "full-target-confirming";
    return plan(this.hold.point, stopJoystick, allowCameraMovement, reason, recenterRole ?? this.hold.role);
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
      this.releaseRecorded = false;
      return true;
    }
    // Start the host TTL before transmission (plan creation), never at late ACK.
    if (now >= pending.createdAt + ttlMs || this.hold &&
      (now >= this.hold.expiresAt || now >= this.hold.searchDeadline)) {
      this.releaseRequired = true; this.invalidate("late-input-ack"); return false;
    }
    if (this.hold && samePoint(plan.point, this.hold.point)) {
      this.hold.role = pending.role; this.hold.sequence = sequence; this.hold.expiresAt = pending.createdAt + ttlMs;
    } else {
      const old = this.hold;
      this.hold = { role: pending.role, point: copyPoint(plan.point), sequence, startedAt: pending.createdAt, expiresAt: pending.createdAt + ttlMs,
        searchDeadline: old?.searchDeadline ?? pending.createdAt + SEARCH_MS,
        ...(old?.evidenceAt !== undefined ? { evidenceAt: old.evidenceAt } : {}),
        ...(old?.epoch !== undefined ? { previousEpoch: old.epoch } : {}) };
      this.fullSince = undefined; this.fullCount = 0;
    }
    return true;
  }
}
