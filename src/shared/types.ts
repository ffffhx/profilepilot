export interface StoredProfile {
  id: string;
  name: string;
  dirName: string;
  createdAt: string;
  lastLaunchedAt: string | null;
}

export interface Registry {
  profiles: StoredProfile[];
}

export interface PublicProfile extends StoredProfile {
  path: string;
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
  nativeChromeProfiles: NativeChromeProfile[];
  runningProfiles: PublicProfile[];
  currentProfile: PublicProfile | null;
  chromeLauncher: string;
}

export interface DeleteProfileResult {
  deletedProfile: StoredProfile;
  trashPath: string | null;
  state: AppState;
}

export interface ProfileManagerApi {
  getState(): Promise<AppState>;
  createProfile(name: string): Promise<AppState>;
  launchProfile(id: string): Promise<AppState>;
  openProfileFolder(id: string): Promise<AppState>;
  deleteProfile(id: string): Promise<DeleteProfileResult>;
}
