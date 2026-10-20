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
}
export interface FollowFrame { mime: string; base64: string; width: number; height: number; }
export interface FollowStatus {
  running: boolean;
  runId?: string;
  deviceId?: string;
  mode?: "observe" | "control";
  backend?: "app" | "basic";
  frames: number;
  actions: number;
  fps: number;
  error: string;
  analysis?: FollowAnalysis;
  frame?: FollowFrame;
}
export interface FollowRuntime { available: boolean; python: string; version: string; error: string; }
export type FollowCommand =
  | { op: "runtime" | "setup" | "status" }
  | { op: "load" | "save"; config?: GameFollowConfig }
  | { op: "analyze"; config: GameFollowConfig; frame: FollowFrame }
  | { op: "start"; id: string; mode: "observe" | "control"; backend?: "app" | "basic"; config: GameFollowConfig }
  | { op: "stop"; runId: string };
