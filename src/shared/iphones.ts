export interface IphoneUsbDevice { udid: string; name: string; version?: string; product?: string; error?: string; }
export interface IphoneToolsStatus { platform: string; installed: boolean; version: string; directory: string; devices: IphoneUsbDevice[]; error?: string; nextStep: string; }
export interface IphoneWdaArtifact { version: string; ipa: string; app: string; sourceSha256: string; requiresSigning: true; }
export interface IphoneUsbStatus {
  udid: string; name: string; bundleId: string; phase: "checking" | "tunnel" | "image" | "runner" | "ready" | "error" | "stopped";
  message: string; endpoint?: string; deviceId?: string;
}
