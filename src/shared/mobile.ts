export const MOBILE_CHANNEL = "mobile:request";
export const MOBILE_CHANGED = "mobile:changed";
export interface MobileDevice { id: string; name: string; createdAt: string; lastSeen: string | null; canControl: boolean; }
export interface MobileSnapshot {
  enabled: boolean; listening: boolean; computerId: string; computerName: string;
  port: number; endpoints: string[]; advertisedUrl: string; fingerprint: string;
  devices: MobileDevice[]; error: string;
}
export interface MobilePairing { uri: string; qr: string; expiresAt: string; }
export interface MobileApi {
  snapshot(): Promise<MobileSnapshot>;
  configure(input: { enabled: boolean; advertisedUrl?: string }): Promise<MobileSnapshot>;
  pair(endpoint?: string): Promise<MobilePairing>;
  revoke(id: string): Promise<MobileSnapshot>;
  updateDevice(id: string, input: { name?: string; canControl?: boolean }): Promise<MobileSnapshot>;
  openApkFolder(): Promise<void>;
  onChanged(listener: (snapshot: MobileSnapshot) => void): () => void;
}
declare global { interface Window { mobile: MobileApi; } }
