export interface FollowPoint { x: number; y: number; }
export interface FollowRect extends FollowPoint { width: number; height: number; }
export interface GameFollowConfig {
  version: 1;
  name: string;
  width: number;
  height: number;
  map: FollowRect;
  selfTemplate: string;
  targetTemplate: string;
  selfRotates: boolean;
  grid: { columns: number; rows: number; blocked: number[]; clearance: number };
  joystick: FollowPoint & { radius: number; rotation: number };
  confidence: number;
  stopDistance: number;
  intervalMs: number;
  /** Auto captures only the minimap when possible; full retains native world-view pixels. */
  capture?: "auto" | "full";
  nearby?: { selfLabel: string; targetLabel: string; region: FollowRect; pixelsPerMapUnit: number };
  selfMarker?: { hueMin: number; hueMax: number; saturationMin: number; valueMin: number; radiusPixels: number };
  /** Experimental, explicitly calibrated partial target identity; requires full native frames. */
  targetPartial?: {
    ring: { hueMin: number; hueMax: number; saturationMin: number; valueMin: number; radiusPixels: number };
    alive: { portraitTemplate: string; portraitRegion: FollowRect; healthBarRegion: FollowRect };
  };
  /** Experimental camera projection; calibrated native pixels for this hero/layout. */
  cameraAssist?: {
    referenceWidth: number; referenceHeight: number;
    targetLabel: string; healthBarTemplate: string;
    healthBar: { width: number; height: number; offsetX: number; offsetY: number };
    region: FollowRect;
    matrix: [[number, number], [number, number], [number, number]];
    anchorBounds: FollowRect;
  };
}
export interface FollowDetection extends FollowPoint { confidence: number; }
export interface FollowAnalysis {
  phase: "following" | "near" | "lost" | "no-path" | "stuck" | "confirming";
  message: string;
  self: FollowDetection | null;
  target: FollowDetection | null;
  path: FollowPoint[];
  direction: FollowPoint | null;
  elapsedMs: number;
  source?: "minimap" | "labels";
  selfSource?: "template" | "marker";
  targetSource?: "template" | "partial" | "labels" | "camera";
  distance?: number;
}
export interface FollowFrame {
  mime: string; base64: string;
  /** Native full-screen dimensions, including when only a region is encoded. */
  width: number; height: number;
  /** Integer native-pixel bounds of the encoded image; absent means a full frame. */
  region?: FollowRect;
  /** Android uptime, attached to these exact pixels; never a host timestamp. */
  cameraProof?: { version: 1; epoch: number; sequence: number; x: number; y: number;
    heldSinceUptimeMs: number; capturedAtUptimeMs: number; expiresAtUptimeMs: number };
}
/** Host HTTP events, in milliseconds from request start. Sent means locally flushed, not phone receipt. */
export interface PhoneRequestTiming {
  at: number;
  operation: "sync" | "follow-frame" | "follow-touch" | "follow-probe" | "screenshot-chunk" | "other";
  socketMs?: number; connectedMs?: number; sentMs?: number; headersMs?: number; firstDataMs?: number; endMs?: number;
  totalMs: number; responseBytes: number; outcome: "complete" | "error";
}
/** Host observations and planned transitions only; never permission to renew input. */
export interface FollowCameraStatus {
  state: "idle" | "arming" | "held" | "releasing";
  reason: string;
  point?: FollowPoint;
  sequence?: number;
  holdAgeMs: number;
  evidenceAgeMs?: number;
  searchRemainingMs: number;
  ttlRemainingMs: number;
  /** Validated proof for the last analyzed frame; sequence may precede the new ACK above. */
  frameProof: boolean;
  frameProofSequence?: number;
  frameTarget: "none" | "full" | "camera";
  armAttempts: number;
  releaseRequests: number;
  releaseReasons: Record<string, number>;
}
export interface FollowStatus {
  running: boolean;
  recovering?: boolean;
  recoveries?: number;
  runId?: string;
  deviceId?: string;
  mode?: "observe" | "control";
  backend?: "app" | "basic";
  frames: number;
  actions: number;
  fps: number;
  error: string;
  /** Observed durations only. Diagnostics never renew or authorize a phone lease. */
  timings?: {
    captureMs?: number; analysisMs?: number; inputMs?: number; heartbeatMs?: number; heartbeatGapMs?: number;
    heartbeatTimerLagMs?: number; maxHeartbeatTimerLagMs?: number; eventLoopMaxDelayMs?: number;
    slowAdbStarts?: { at: number; operation: string; resolveMs: number; spawnMs: number }[];
    httpRequests?: PhoneRequestTiming[];
  };
  analysis?: FollowAnalysis;
  frame?: FollowFrame;
  camera?: FollowCameraStatus;
}
export interface FollowRuntime { available: boolean; python: string; version: string; error: string; }
export type FollowCommand =
  | { op: "runtime" | "setup" | "status" }
  | { op: "camera-sample"; id: string; x: number; y: number; outputDir: string }
  | { op: "load" | "save"; config?: GameFollowConfig }
  | { op: "analyze"; config: GameFollowConfig; frame: FollowFrame }
  | { op: "start"; id: string; mode: "observe" | "control"; backend?: "app" | "basic"; recoverTransport?: boolean; config: GameFollowConfig }
  | { op: "stop"; runId: string };
