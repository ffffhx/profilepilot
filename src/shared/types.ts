export interface StoredProfile {
  id: string;
  name: string;
  dirName: string;
  createdAt: string;
  lastLaunchedAt: string | null;
}

export interface NativeProfileMetadata {
  lastLaunchedAt: string | null;
}

export interface Registry {
  profiles: StoredProfile[];
  nativeProfiles?: Record<string, NativeProfileMetadata>;
}

export type ProfileSource = "native" | "isolated";

export interface PublicProfile {
  id: string;
  source: ProfileSource;
  name: string;
  dirName: string;
  path: string;
  createdAt: string | null;
  lastLaunchedAt: string | null;
  userName: string | null;
  isDefault: boolean;
  deletable: boolean;
  running: boolean;
  pids: number[];
}

export interface NativeChromeProfile {
  dirName: string;
  name: string;
  userName: string | null;
  path: string;
  isDefault: boolean;
}

export interface AppState {
  appTitle: string;
  dataDir: string;
  profilesDir: string;
  profiles: PublicProfile[];
  nativeProfileCount: number;
  isolatedProfileCount: number;
  nativeChromeProfiles: NativeChromeProfile[];
  runningProfiles: PublicProfile[];
  currentProfile: PublicProfile | null;
  chromeLauncher: string;
}

export interface DeleteProfileResult {
  deletedProfile: PublicProfile;
  trashPath: string | null;
  state: AppState;
}

export interface ProfileManagerApi {
  getState(): Promise<AppState>;
  createProfile(name: string): Promise<AppState>;
  launchProfile(id: string): Promise<AppState>;
  focusProfile(id: string): Promise<AppState>;
  closeProfile(id: string): Promise<AppState>;
  openProfileFolder(id: string): Promise<AppState>;
  deleteProfile(id: string): Promise<DeleteProfileResult>;
}
