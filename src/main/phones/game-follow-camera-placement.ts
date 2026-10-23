import type { GameFollowConfig, FollowRect, FollowCameraPlacement } from "../../shared/game-follow";
import type { CameraContext, CameraPoint, CameraProof } from "./game-follow-camera";
import { cameraProofSchema } from "./screenshot-transfer";

type Assist = NonNullable<GameFollowConfig["cameraAssist"]>;
export type CameraPlacementConfig = Pick<GameFollowConfig, "width" | "height" | "map"> & {
  cameraAssist: Pick<Assist, "referenceWidth" | "referenceHeight" | "matrix" | "anchorBounds" | "projectionErrorPx">;
};
export type CameraPlacement = FollowCameraPlacement;
export type CameraRecenterFrame = {
  /** Same-frame host-validated context and camera-source target, never history. */
  context?: CameraContext;
  proof?: CameraProof;
  target?: CameraPoint;
  frameAgeMs: number;
  /** Conservative host TTL remaining; phone uptime is never compared with this. */
  holdRemainingMs: number;
};
export type CameraPlacementMargin = {
  /** Independent calibration error bound in native minimap pixels. */
  projectionErrorPx: number;
  /** Recent measured map px/s; null explicitly means no adjacent measurement. */
  speedMapPxPerSecond: CameraPoint | null;
  /** Expected time FROM NOW until next usable proof frame, including settling. */
  horizonMs: number;
};
type Geometry = {
  map: FollowRect; bounds: FollowRect; center: CameraPoint; offset: CameraPoint;
  inverse: [number, number, number, number]; bias: CameraPoint;
};
const point = (p: CameraPoint | undefined): p is CameraPoint => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
const nonnegative = (v: number) => Number.isFinite(v) && v >= 0;
const inside = (p: CameraPoint, r: FollowRect) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;
// Inversion of floating-point affine coordinates can lose a few ulps at an edge.
const anchorInside = (p: CameraPoint, r: FollowRect) => p.x >= r.x - 1e-7 && p.y >= r.y - 1e-7
  && p.x <= r.x + r.width + 1e-7 && p.y <= r.y + r.height + 1e-7;
const reject = (reason: string): CameraPlacement => ({ action: "reject", reason, frameRemainingMs: 0 });

function geometry(config: CameraPlacementConfig): Geometry | undefined {
  const assist = config.cameraAssist, r = config.map;
  if (!assist || !r || !Number.isSafeInteger(config.width) || !Number.isSafeInteger(config.height)
    || config.width <= 0 || config.height <= 0 || assist.referenceWidth !== config.width || assist.referenceHeight !== config.height
    || ![r.x, r.y, r.width, r.height].every(nonnegative) || !r.width || !r.height || r.x + r.width > 1.00001 || r.y + r.height > 1.00001) return;
  const bounds = assist.anchorBounds;
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(nonnegative) || !bounds.width || !bounds.height
    || bounds.x + bounds.width > config.width || bounds.y + bounds.height > config.height) return;
  const m = assist.matrix;
  if (!Array.isArray(m) || m.length !== 3 || m.some(row => !Array.isArray(row) || row.length !== 2 || !row.every(Number.isFinite))) return;
  const [a, c] = m[0], [b, d] = m[1], determinant = a*d - b*c, scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (!scale || Math.abs(determinant) <= scale*scale*1e-8) return;
  const center = { x: bounds.x + bounds.width/2, y: bounds.y + bounds.height/2 };
  return { map: { x: r.x*config.width, y: r.y*config.height,
    width: Math.min(r.width*config.width, config.width-r.x*config.width),
    height: Math.min(r.height*config.height, config.height-r.y*config.height) },
    bounds, center, offset: { x: a*center.x + b*center.y + m[2][0], y: c*center.x + d*center.y + m[2][1] },
    inverse: [d/determinant, -b/determinant, -c/determinant, a/determinant], bias: { x: m[2][0], y: m[2][1] } };
}
function anchorFor(g: Geometry, target: CameraPoint, hold: CameraPoint): CameraPoint {
  const x = target.x-hold.x-g.bias.x, y = target.y-hold.y-g.bias.y, [a,b,c,d] = g.inverse;
  return { x: a*x + b*y, y: c*x + d*y };
}
function centered(g: Geometry, target: CameraPoint) {
  const p = { x: Math.round(target.x-g.offset.x), y: Math.round(target.y-g.offset.y) };
  return inside(p, g.map) ? p : undefined; // Never clamp a camera point at the map edge.
}

/** Old full-target evidence can select a camera point only; it cannot justify id0. */
export function planCameraArm(config: CameraPlacementConfig, full: { target?: CameraPoint; ageMs: number }): CameraPlacement {
  const g = geometry(config);
  if (!g) return reject("invalid-calibration");
  if (!point(full.target) || !inside(full.target, g.map) || !nonnegative(full.ageMs) || full.ageMs > 3000)
    return reject("no-recent-full-target");
  const p = centered(g, full.target);
  if (!p) return reject("camera-point-outside-map");
  const predictedAnchor = anchorFor(g, full.target, p);
  if (!anchorInside(predictedAnchor, g.bounds)) return reject("quantized-center-outside-calibration");
  return { action: "arm", reason: "calibrated-center", point: p, center: g.center, predictedAnchor, frameRemainingMs: 0 };
}

/**
 * Pure placement only. Does not send input, renew a deadline, or preserve id0.
 * The caller must bind target to this exact proof frame and still apply its
 * current-self/path/movement checks. No extra two-frame confirmation is imposed.
 */
export function planCameraRecenter(config: CameraPlacementConfig, frame: CameraRecenterFrame,
  budget: CameraPlacementMargin): CameraPlacement {
  const g = geometry(config);
  if (!g) return reject("invalid-calibration");
  if (!nonnegative(frame.frameAgeMs) || frame.frameAgeMs >= 1000 || !Number.isFinite(frame.holdRemainingMs) || frame.holdRemainingMs <= 0)
    return reject("stale-frame-or-hold");
  const parsed = cameraProofSchema.safeParse(frame.proof), context = frame.context;
  if (!parsed.success || !context || !point(context.point)) return reject("unproven-camera-frame");
  const proof = parsed.data;
  if (proof.epoch !== context.epoch || proof.sequence !== context.sequence || proof.x !== context.point.x || proof.y !== context.point.y
    || proof.capturedAtUptimeMs - proof.heldSinceUptimeMs < 250 || !inside(context.point, g.map))
    return reject("unproven-camera-frame");
  if (!point(frame.target) || !inside(frame.target, g.map)) return reject("no-current-camera-target");
  const anchor = anchorFor(g, frame.target, context.point);
  if (!point(anchor) || !anchorInside(anchor, g.bounds)) return reject("anchor-outside-calibration");
  if (!nonnegative(budget.projectionErrorPx) || budget.speedMapPxPerSecond !== null && !point(budget.speedMapPxPerSecond)
    || !Number.isFinite(budget.horizonMs) || budget.horizonMs < 250 || budget.horizonMs > 6000)
    return reject("invalid-motion-margin");
  // Include capture age, next-proof latency and integer camera-point rounding.
  // Propagate native-map uncertainty through the full inverse, including shear.
  const horizon = (frame.frameAgeMs + budget.horizonMs)/1000;
  const mx = budget.projectionErrorPx + .5 + Math.abs(budget.speedMapPxPerSecond?.x ?? 0)*horizon;
  const my = budget.projectionErrorPx + .5 + Math.abs(budget.speedMapPxPerSecond?.y ?? 0)*horizon;
  const [a,b,c,d] = g.inverse;
  const margin = { x: Math.abs(a)*mx + Math.abs(b)*my, y: Math.abs(c)*mx + Math.abs(d)*my };
  if (!point(margin)) return reject("invalid-motion-margin");
  // Future coverage controls how early to recenter, not permission to use a
  // CURRENT valid target. A narrow domain requests an immediate camera move;
  // if a later frame really leaves the domain, that frame must stop movement.
  const coverageInsufficient = margin.x >= g.bounds.width/2 || margin.y >= g.bounds.height/2;
  const evidence = { anchor, center: g.center, margin, coverageInsufficient,
    speedKnown: budget.speedMapPxPerSecond !== null, frameRemainingMs: Math.floor(1000-frame.frameAgeMs) };
  if (!coverageInsufficient && anchor.x >= g.bounds.x + margin.x && anchor.x <= g.bounds.x+g.bounds.width-margin.x
    && anchor.y >= g.bounds.y+margin.y && anchor.y <= g.bounds.y+g.bounds.height-margin.y)
    return { action: "keep", reason: "inside-calibrated-margin", point: { ...context.point }, ...evidence };
  const p = centered(g, frame.target);
  if (!p) return { ...reject("camera-point-outside-map"), anchor, center: g.center, margin };
  const predictedAnchor = anchorFor(g, frame.target, p);
  if (!anchorInside(predictedAnchor, g.bounds)) return reject("quantized-center-outside-calibration");
  return { action: p.x === context.point.x && p.y === context.point.y ? "keep" : "recenter",
    reason: coverageInsufficient ? "coverage-insufficient" : "calibrated-edge-margin", point: p, predictedAnchor, ...evidence };
}
