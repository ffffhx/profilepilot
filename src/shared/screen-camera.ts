export interface ScreenCameraCapabilities {
  sdk: number; release: string; supported: boolean; reason: string;
  graphics?: { supported: boolean; reason: string; renderer?: string; version?: string; missingExtensions?: string[] };
}
export interface ScreenCameraSource { id: string; name: string; thumbnail: string; }
export interface ScreenCameraCrop { x: number; y: number; width: number; height: number; }
export interface ScreenCameraLease { id: string; sessionId: string; generation: number; }
export interface ScreenCameraStart extends ScreenCameraLease { sourceId?: string; crop?: ScreenCameraCrop; }
export interface ScreenCameraState {
  id: string; sessionId: string; generation: number; active: boolean; sourceId?: string; crop?: ScreenCameraCrop;
  displayId: number; cameraId: string; width: number; height: number;
  framesReceived: number; framesRendered: number; streams: number; error: string;
}
export interface ScreenCameraPreview { mime: "image/jpeg"; base64: string; width: number; height: number; }
export type ScreenCameraCommand = ScreenCameraLease & ({ op: "status" | "preview" | "apps" | "stop" }
  | { op: "frame"; base64: string }
  | { op: "launch"; component: string }
  | { op: "tap"; x: number; y: number }
  | { op: "key"; key: "back" });
