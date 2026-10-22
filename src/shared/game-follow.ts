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
  distance?: number;
}
export interface FollowFrame {
  mime: string; base64: string;
  /** Native full-screen dimensions, including when only a region is encoded. */
  width: number; height: number;
  /** Integer native-pixel bounds of the encoded image; absent means a full frame. */
  region?: FollowRect;
}
/** Host HTTP events, in milliseconds from request start. Sent means locally flushed, not phone receipt. */
export interface PhoneRequestTiming {
  at: number;
  operation: "sync" | "follow-frame" | "follow-touch" | "follow-probe" | "screenshot-chunk" | "other";
  socketMs?: number; connectedMs?: number; sentMs?: number; headersMs?: number; firstDataMs?: number; endMs?: number;
  totalMs: number; responseBytes: number; outcome: "complete" | "error";
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
}
export interface FollowRuntime { available: boolean; python: string; version: string; error: string; }
export type FollowCommand =
  | { op: "runtime" | "setup" | "status" }
  | { op: "load" | "save"; config?: GameFollowConfig }
  | { op: "analyze"; config: GameFollowConfig; frame: FollowFrame }
  | { op: "start"; id: string; mode: "observe" | "control"; backend?: "app" | "basic"; recoverTransport?: boolean; config: GameFollowConfig }
  | { op: "stop"; runId: string };
