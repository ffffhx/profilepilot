export interface AndroidSystemImage {
  id: string;
  label: string;
  api: number;
  abi: string;
  bytes: number;
  installed: boolean;
}
export interface AndroidLicense { id: string; text: string; }
export interface AndroidSetupJob {
  id: string;
  kind: "environment" | "image" | "create";
  status: "running" | "succeeded" | "failed" | "cancelled";
  message: string;
  progress: number | null;
  error: string;
  deviceName?: string;
}
export interface AndroidSetupSnapshot {
  supported: boolean;
  platformLabel: string;
  sdkRoot: string;
  javaReady: boolean;
  toolsReady: boolean;
  adbReady: boolean;
  emulatorReady: boolean;
  ready: boolean;
  images: AndroidSystemImage[];
  licenses: AndroidLicense[];
  licenseToken: string;
  catalogLoaded: boolean;
  catalogError: string;
  job: AndroidSetupJob | null;
}
export type AndroidSetupAction =
  | { kind: "environment"; licenseToken: string }
  | { kind: "image"; imageId: string; licenseToken: string }
  | { kind: "create"; imageId: string; name: string; memoryMb: number; storageGb: number };
export interface AndroidSetupRuntime {
  snapshot(): Promise<AndroidSetupSnapshot>;
  catalog(): Promise<AndroidSetupSnapshot>;
  start(action: AndroidSetupAction): Promise<AndroidSetupSnapshot>;
  cancel(id: string): Promise<AndroidSetupSnapshot>;
  close(): Promise<void>;
}
