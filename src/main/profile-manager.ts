import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { shell } from "electron";
import type {
  AppState,
  DeleteProfileResult,
  NativeChromeProfile,
  NativeProfileMetadata,
  PublicProfile,
  Registry,
  StoredProfile
} from "../shared/types";

const execFileAsync = promisify(execFile);

export const APP_TITLE = "Codex Chrome Profile Manager";

type ProfileRef = { source: "native"; dirName: string } | { source: "isolated"; id: string };

interface RuntimeProfile {
  pids: number[];
  startedAt: string | null;
}

interface ChromeLocalState {
  profile?: {
    info_cache?: Record<
      string,
      {
        name?: unknown;
        user_name?: unknown;
        is_using_default_name?: unknown;
      }
    >;
  };
}

export class ProfileManagerError extends Error {
  constructor(
    message: string,
    readonly code = "PROFILE_MANAGER_ERROR"
  ) {
    super(message);
    this.name = "ProfileManagerError";
  }
}

export class ProfileManager {
  private readonly profilesDir: string;
  private readonly registryPath: string;

  constructor(private readonly dataDir = defaultDataDir()) {
    this.profilesDir = path.join(dataDir, "profiles");
    this.registryPath = path.join(dataDir, "profiles.json");
  }

  async getState(): Promise<AppState> {
    const registry = await this.loadRegistry();
    const nativeChromeProfiles = await scanNativeChromeProfiles();
    const nativePaths = nativeChromeProfiles.map((profile) => profile.path);
    const isolatedPaths = registry.profiles.map((profile) => this.isolatedProfilePath(profile));
    const runtime = await this.getRuntime(nativePaths.concat(isolatedPaths), nativeChromeProfiles.map((profile) => profile.dirName));

    const nativeProfiles = nativeChromeProfiles.map((profile) => this.toNativePublicProfile(profile, registry, runtime));
    const isolatedProfiles = registry.profiles
      .map((profile) => this.toIsolatedPublicProfile(profile, runtime))
      .sort((a, b) => {
        const aTime = a.lastLaunchedAt || a.createdAt || "";
        const bTime = b.lastLaunchedAt || b.createdAt || "";
        return bTime.localeCompare(aTime);
      });
    const profiles = [...nativeProfiles, ...isolatedProfiles];

    const runningProfiles = profiles.filter((profile) => profile.running);
    const lastLaunchedProfile = profiles.find((profile) => profile.lastLaunchedAt) || null;

    return {
      appTitle: APP_TITLE,
      dataDir: this.dataDir,
      profilesDir: this.profilesDir,
      profiles,
      nativeProfileCount: nativeProfiles.length,
      isolatedProfileCount: isolatedProfiles.length,
      nativeChromeProfiles,
      runningProfiles,
      currentProfile: runningProfiles[0] || lastLaunchedProfile,
      chromeLauncher: this.getLauncherLabel()
    };
  }

  async createProfile(nameInput: string): Promise<StoredProfile> {
    const name = String(nameInput || "").trim();
    if (!name || name.length > 80) {
      throw new ProfileManagerError("Profile name must be 1-80 characters.", "INVALID_PROFILE_NAME");
    }

    const registry = await this.loadRegistry();
    const id = randomUUID();
    const dirName = `${makeSlug(name)}-${id.slice(0, 8)}`;
    const now = new Date().toISOString();
    const profile: StoredProfile = {
      id,
      name,
      dirName,
      createdAt: now,
      lastLaunchedAt: null
    };

    await fs.mkdir(this.isolatedProfilePath(profile), { recursive: false });
    registry.profiles.push(profile);
    await this.saveRegistry(registry);

    return profile;
  }

  async launchProfile(profileId: string): Promise<void> {
    const ref = parseProfileId(profileId);

    if (ref.source === "native") {
      await this.launchNativeProfile(ref.dirName);
      return;
    }

    await this.launchIsolatedProfile(ref.id);
  }

  async openProfileFolder(profileId: string): Promise<void> {
    const ref = parseProfileId(profileId);
    const profilePath = await this.pathForRef(ref);
    await fs.mkdir(profilePath, { recursive: true });

    const error = await shell.openPath(profilePath);
    if (error) {
      throw new ProfileManagerError(error, "OPEN_FOLDER_FAILED");
    }
  }

  async deleteProfile(profileId: string): Promise<DeleteProfileResult> {
    const ref = parseProfileId(profileId);

    if (ref.source === "native") {
      return this.deleteNativeProfile(ref.dirName);
    }

    return this.deleteIsolatedProfile(ref.id);
  }

  private async launchNativeProfile(dirName: string): Promise<void> {
    const profiles = await scanNativeChromeProfiles();
    const profile = profiles.find((item) => item.dirName === dirName);
    if (!profile) {
      throw new ProfileManagerError("Chrome profile not found.", "PROFILE_NOT_FOUND");
    }

    await launchChrome([`--profile-directory=${profile.dirName}`, "--no-first-run"]);
    const registry = await this.loadRegistry();
    registry.nativeProfiles = {
      ...(registry.nativeProfiles || {}),
      [profile.dirName]: {
        lastLaunchedAt: new Date().toISOString()
      }
    };
    await this.saveRegistry(registry);
  }

  private async launchIsolatedProfile(id: string): Promise<void> {
    const registry = await this.loadRegistry();
    const profile = this.findIsolatedProfile(registry, id);
    const profilePath = this.isolatedProfilePath(profile);
    await fs.mkdir(profilePath, { recursive: true });

    await launchChrome([`--user-data-dir=${profilePath}`, "--no-first-run"]);
    profile.lastLaunchedAt = new Date().toISOString();
    await this.saveRegistry(registry);
  }

  private async deleteNativeProfile(dirName: string): Promise<DeleteProfileResult> {
    const state = await this.getState();
    const profile = state.profiles.find((item) => item.source === "native" && item.dirName === dirName);
    if (!profile) {
      throw new ProfileManagerError("Chrome profile not found.", "PROFILE_NOT_FOUND");
    }
    if (profile.isDefault) {
      throw new ProfileManagerError("Default Chrome profile is protected.", "DEFAULT_PROFILE_PROTECTED");
    }
    if (await isChromeRunning()) {
      throw new ProfileManagerError("Quit Chrome before deleting a Chrome profile.", "CHROME_RUNNING");
    }
    if (profile.running) {
      throw new ProfileManagerError("Close this Chrome profile before deleting it.", "PROFILE_RUNNING");
    }

    const trashPath = await this.moveToTrash(profile.path, profile.dirName);
    await removeNativeProfileFromLocalState(profile.dirName);
    const registry = await this.loadRegistry();
    if (registry.nativeProfiles) {
      delete registry.nativeProfiles[profile.dirName];
      await this.saveRegistry(registry);
    }

    return {
      deletedProfile: profile,
      trashPath,
      state: await this.getState()
    };
  }

  private async deleteIsolatedProfile(id: string): Promise<DeleteProfileResult> {
    const registry = await this.loadRegistry();
    const storedProfile = this.findIsolatedProfile(registry, id);
    const state = await this.getState();
    const profile = state.profiles.find((item) => item.source === "isolated" && item.id === makeIsolatedProfileId(id));
    if (profile?.running) {
      throw new ProfileManagerError("Close this Chrome profile before deleting it.", "PROFILE_RUNNING");
    }

    const publicProfile = profile || this.toIsolatedPublicProfile(storedProfile, new Map());
    const trashPath = await this.moveToTrash(this.isolatedProfilePath(storedProfile), storedProfile.dirName);
    const nextProfiles = registry.profiles.filter((item) => item.id !== id);
    await this.saveRegistry({ ...registry, profiles: nextProfiles });

    return {
      deletedProfile: publicProfile,
      trashPath,
      state: await this.getState()
    };
  }

  private async pathForRef(ref: ProfileRef): Promise<string> {
    if (ref.source === "native") {
      const profile = (await scanNativeChromeProfiles()).find((item) => item.dirName === ref.dirName);
      if (!profile) {
        throw new ProfileManagerError("Chrome profile not found.", "PROFILE_NOT_FOUND");
      }

      return profile.path;
    }

    const registry = await this.loadRegistry();
    return this.isolatedProfilePath(this.findIsolatedProfile(registry, ref.id));
  }

  private async ensureStore(): Promise<void> {
    await fs.mkdir(this.profilesDir, { recursive: true });

    try {
      await fs.access(this.registryPath);
    } catch {
      await this.saveRegistry({ profiles: [], nativeProfiles: {} });
    }
  }

  private async loadRegistry(): Promise<Registry> {
    await this.ensureStore();

    try {
      const raw = await fs.readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<Registry>;
      const nativeProfiles =
        parsed.nativeProfiles && typeof parsed.nativeProfiles === "object"
          ? normalizeNativeProfileMetadata(parsed.nativeProfiles)
          : {};

      return {
        profiles: Array.isArray(parsed.profiles)
          ? (parsed.profiles.map(normalizeProfile).filter(Boolean) as StoredProfile[])
          : [],
        nativeProfiles
      };
    } catch {
      const backup = `${this.registryPath}.broken-${Date.now()}`;
      try {
        await fs.rename(this.registryPath, backup);
      } catch {
        // Start clean if the broken registry cannot be backed up.
      }
      return { profiles: [], nativeProfiles: {} };
    }
  }

  private async saveRegistry(registry: Registry): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmpPath = `${this.registryPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.registryPath);
  }

  private async getRuntime(profilePaths: string[], nativeDirNames: string[]): Promise<Map<string, RuntimeProfile>> {
    const runtime = new Map<string, RuntimeProfile>();
    const defaultNativeKey = nativeDirNames.includes("Default") ? makeNativeRuntimeKey("Default") : null;

    if (!profilePaths.length && !nativeDirNames.length) {
      return runtime;
    }

    try {
      const { stdout } = await execFileAsync("ps", ["-axo", "pid=,lstart=,command="], {
        maxBuffer: 1024 * 1024 * 8
      });

      for (const line of stdout.split("\n")) {
        const processInfo = parseRuntimeProcess(line);
        if (!processInfo) {
          continue;
        }

        const { command } = processInfo;

        // A normally opened Chrome often does not include --profile-directory.
        // Treat that main browser process as the Default profile.
        if (defaultNativeKey && isImplicitDefaultChromeProcess(command)) {
          addRuntimeProcess(runtime, defaultNativeKey, processInfo);
        }

        for (const profilePath of profilePaths) {
          if (!command.includes("--user-data-dir=") || !command.includes(profilePath)) {
            continue;
          }
          addRuntimeProcess(runtime, profilePath, processInfo);
        }

        for (const dirName of nativeDirNames) {
          if (!command.includes("--profile-directory=") || !command.includes(`--profile-directory=${dirName}`)) {
            continue;
          }
          addRuntimeProcess(runtime, makeNativeRuntimeKey(dirName), processInfo);
        }
      }
    } catch {
      return runtime;
    }

    return runtime;
  }

  private toNativePublicProfile(
    profile: NativeChromeProfile,
    registry: Registry,
    runtime: Map<string, RuntimeProfile>
  ): PublicProfile {
    const runtimeProfile = mergeRuntimeProfiles(runtime.get(profile.path), runtime.get(makeNativeRuntimeKey(profile.dirName)));

    return {
      id: makeNativeProfileId(profile.dirName),
      source: "native",
      name: profile.name,
      dirName: profile.dirName,
      path: profile.path,
      createdAt: null,
      lastLaunchedAt: runtimeProfile.startedAt || registry.nativeProfiles?.[profile.dirName]?.lastLaunchedAt || null,
      userName: profile.userName,
      isDefault: profile.isDefault,
      deletable: !profile.isDefault,
      running: runtimeProfile.pids.length > 0,
      pids: runtimeProfile.pids
    };
  }

  private toIsolatedPublicProfile(profile: StoredProfile, runtime: Map<string, RuntimeProfile>): PublicProfile {
    const profilePath = this.isolatedProfilePath(profile);
    const runtimeProfile = runtime.get(profilePath) || { pids: [], startedAt: null };

    return {
      id: makeIsolatedProfileId(profile.id),
      source: "isolated",
      name: profile.name,
      dirName: profile.dirName,
      path: profilePath,
      createdAt: profile.createdAt,
      lastLaunchedAt: runtimeProfile.startedAt || profile.lastLaunchedAt,
      userName: null,
      isDefault: false,
      deletable: true,
      running: runtimeProfile.pids.length > 0,
      pids: runtimeProfile.pids
    };
  }

  private findIsolatedProfile(registry: Registry, id: string): StoredProfile {
    const profile = registry.profiles.find((item) => item.id === id);
    if (!profile) {
      throw new ProfileManagerError("Profile not found.", "PROFILE_NOT_FOUND");
    }

    return profile;
  }

  private isolatedProfilePath(profile: StoredProfile): string {
    return path.join(this.profilesDir, profile.dirName);
  }

  private getLauncherLabel(): string {
    if (process.env.CHROME_BINARY) {
      return process.env.CHROME_BINARY;
    }

    if (process.platform === "darwin") {
      return process.env.CHROME_APP_NAME || "Google Chrome";
    }

    if (process.platform === "win32") {
      return "chrome";
    }

    return "google-chrome";
  }

  private async moveToTrash(sourcePath: string, dirName: string): Promise<string | null> {
    if (!(await exists(sourcePath))) {
      return null;
    }

    const trashRoot =
      process.platform === "darwin" ? path.join(os.homedir(), ".Trash") : path.join(this.dataDir, "trash");
    await fs.mkdir(trashRoot, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let targetPath = path.join(trashRoot, `${dirName}-${stamp}`);
    let counter = 1;
    while (await exists(targetPath)) {
      targetPath = path.join(trashRoot, `${dirName}-${stamp}-${counter}`);
      counter += 1;
    }

    await fs.rename(sourcePath, targetPath);
    return targetPath;
  }
}

export function createProfileManager(): ProfileManager {
  return new ProfileManager(process.env.CPM_DATA_DIR || defaultDataDir());
}

function defaultDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_TITLE);
  }

  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || os.homedir(), APP_TITLE);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "codex-chrome-profile-manager");
}

function makeSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);

  return slug || "profile";
}

async function launchChrome(args: string[]): Promise<void> {
  if (process.env.CHROME_BINARY) {
    launchDetached(process.env.CHROME_BINARY, args);
  } else if (process.platform === "darwin") {
    await execFileAsync("open", ["-na", process.env.CHROME_APP_NAME || "Google Chrome", "--args", ...args]);
  } else if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", "chrome", ...args]);
  } else {
    launchDetached("google-chrome", args);
  }
}

function launchDetached(command: string, args: string[]): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeProfile(profile: unknown): StoredProfile | null {
  if (!profile || typeof profile !== "object") {
    return null;
  }

  const candidate = profile as Partial<StoredProfile>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.dirName !== "string" ||
    typeof candidate.createdAt !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    name: candidate.name,
    dirName: candidate.dirName,
    createdAt: candidate.createdAt,
    lastLaunchedAt: typeof candidate.lastLaunchedAt === "string" ? candidate.lastLaunchedAt : null
  };
}

function normalizeNativeProfileMetadata(input: Record<string, unknown>): Record<string, NativeProfileMetadata> {
  return Object.fromEntries(
    Object.entries(input).map(([dirName, value]) => {
      const metadata = value && typeof value === "object" ? (value as Partial<NativeProfileMetadata>) : {};
      return [
        dirName,
        {
          lastLaunchedAt: typeof metadata.lastLaunchedAt === "string" ? metadata.lastLaunchedAt : null
        }
      ];
    })
  );
}

async function scanNativeChromeProfiles(): Promise<NativeChromeProfile[]> {
  const userDataDir = nativeChromeUserDataDir();
  const localState = await readChromeLocalState();
  const infoCache = localState.profile?.info_cache || {};

  return Object.entries(infoCache)
    .map(([dirName, profile]) => ({
      dirName,
      name: typeof profile.name === "string" && profile.name.trim() ? profile.name : dirName,
      userName: typeof profile.user_name === "string" && profile.user_name.trim() ? profile.user_name : null,
      path: path.join(userDataDir, dirName),
      isDefault: dirName === "Default"
    }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) {
        return a.isDefault ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
}

async function readChromeLocalState(): Promise<ChromeLocalState> {
  try {
    const raw = await fs.readFile(nativeChromeLocalStatePath(), "utf8");
    return JSON.parse(raw) as ChromeLocalState;
  } catch {
    return {};
  }
}

async function writeChromeLocalState(localState: ChromeLocalState): Promise<void> {
  const localStatePath = nativeChromeLocalStatePath();
  const backupPath = `${localStatePath}.cpm-backup-${Date.now()}`;
  const raw = await fs.readFile(localStatePath, "utf8");
  await fs.writeFile(backupPath, raw, "utf8");
  const tmpPath = `${localStatePath}.tmp-${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(localState, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, localStatePath);
}

async function removeNativeProfileFromLocalState(dirName: string): Promise<void> {
  const localState = await readChromeLocalState();
  if (!localState.profile?.info_cache?.[dirName]) {
    return;
  }

  delete localState.profile.info_cache[dirName];
  await writeChromeLocalState(localState);
}

function nativeChromeLocalStatePath(): string {
  return path.join(nativeChromeUserDataDir(), "Local State");
}

function nativeChromeUserDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  }

  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "google-chrome");
}

function parseProfileId(profileId: string): ProfileRef {
  if (profileId.startsWith("native:")) {
    return { source: "native", dirName: profileId.slice("native:".length) };
  }

  if (profileId.startsWith("isolated:")) {
    return { source: "isolated", id: profileId.slice("isolated:".length) };
  }

  return { source: "isolated", id: profileId };
}

function makeNativeProfileId(dirName: string): string {
  return `native:${dirName}`;
}

function makeIsolatedProfileId(id: string): string {
  return `isolated:${id}`;
}

function makeNativeRuntimeKey(dirName: string): string {
  return `native:${dirName}`;
}

function parseRuntimeProcess(line: string): (RuntimeProfile & { pid: number; command: string }) | null {
  const match = line.match(
    /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/
  );
  if (!match) {
    return null;
  }

  const pid = Number(match[1]);
  const startedAt = parsePsStartTime(match[2]);
  const command = match[3];

  return {
    pid,
    pids: [pid],
    startedAt,
    command
  };
}

function parsePsStartTime(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function addRuntimeProcess(
  runtime: Map<string, RuntimeProfile>,
  key: string,
  processInfo: RuntimeProfile & { pid: number }
): void {
  const profile = runtime.get(key) || { pids: [], startedAt: null };
  if (!profile.pids.includes(processInfo.pid)) {
    profile.pids.push(processInfo.pid);
  }
  profile.startedAt = earlierIsoDate(profile.startedAt, processInfo.startedAt);
  runtime.set(key, profile);
}

function mergeRuntimeProfiles(...profiles: Array<RuntimeProfile | undefined>): RuntimeProfile {
  return profiles.reduce<RuntimeProfile>(
    (merged, profile) => {
      if (!profile) {
        return merged;
      }

      return {
        pids: uniqueNumbers(merged.pids.concat(profile.pids)),
        startedAt: earlierIsoDate(merged.startedAt, profile.startedAt)
      };
    },
    { pids: [], startedAt: null }
  );
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function earlierIsoDate(current: string | null, next: string | null): string | null {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }

  return Date.parse(next) < Date.parse(current) ? next : current;
}

function isImplicitDefaultChromeProcess(command: string): boolean {
  return (
    isGoogleChromeMainProcess(command) &&
    !command.includes("--profile-directory=") &&
    !command.includes("--user-data-dir=")
  );
}

function isGoogleChromeMainProcess(command: string): boolean {
  if (command.includes("--type=") || command.includes("chrome_crashpad_handler")) {
    return false;
  }

  if (process.platform === "darwin") {
    return command.includes("/Google Chrome.app/Contents/MacOS/Google Chrome");
  }

  if (process.platform === "win32") {
    return /(^|[\\\s])chrome\.exe(\s|$)/i.test(command);
  }

  return /(^|\s)(\/\S+\/)?(google-chrome|google-chrome-stable|chromium|chromium-browser|chrome)(\s|$)/.test(
    command
  );
}

async function isChromeRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], {
      maxBuffer: 1024 * 1024 * 8
    });
    return stdout
      .split("\n")
      .some((line) => line.includes("Google Chrome.app/Contents/MacOS/Google Chrome") || line.includes("Google Chrome Helper"));
  } catch {
    return true;
  }
}
