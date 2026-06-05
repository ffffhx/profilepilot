import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { shell } from "electron";
import type { AppState, DeleteProfileResult, PublicProfile, Registry, StoredProfile } from "../shared/types";

const execFileAsync = promisify(execFile);

export const APP_TITLE = "Codex Chrome Profile Manager";

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
    const profilePaths = registry.profiles.map((profile) => this.profilePath(profile));
    const runtime = await this.getRuntimeByPath(profilePaths);
    const profiles = registry.profiles
      .map((profile) => this.toPublicProfile(profile, runtime))
      .sort((a, b) => {
        const aTime = a.lastLaunchedAt || a.createdAt;
        const bTime = b.lastLaunchedAt || b.createdAt;
        return bTime.localeCompare(aTime);
      });

    const runningProfiles = profiles.filter((profile) => profile.running);
    const lastLaunchedProfile = profiles.find((profile) => profile.lastLaunchedAt) || null;

    return {
      appTitle: APP_TITLE,
      dataDir: this.dataDir,
      profilesDir: this.profilesDir,
      profiles,
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

    await fs.mkdir(this.profilePath(profile), { recursive: false });
    registry.profiles.push(profile);
    await this.saveRegistry(registry);

    return profile;
  }

  async launchProfile(id: string): Promise<StoredProfile> {
    const registry = await this.loadRegistry();
    const profile = this.findProfile(registry, id);
    const profilePath = this.profilePath(profile);
    await fs.mkdir(profilePath, { recursive: true });

    const args = [`--user-data-dir=${profilePath}`, "--no-first-run"];

    if (process.env.CHROME_BINARY) {
      launchDetached(process.env.CHROME_BINARY, args);
    } else if (process.platform === "darwin") {
      await execFileAsync("open", ["-na", process.env.CHROME_APP_NAME || "Google Chrome", "--args", ...args]);
    } else if (process.platform === "win32") {
      await execFileAsync("cmd", ["/c", "start", "", "chrome", ...args]);
    } else {
      launchDetached("google-chrome", args);
    }

    profile.lastLaunchedAt = new Date().toISOString();
    await this.saveRegistry(registry);

    return profile;
  }

  async openProfileFolder(id: string): Promise<StoredProfile> {
    const registry = await this.loadRegistry();
    const profile = this.findProfile(registry, id);
    const profilePath = this.profilePath(profile);
    await fs.mkdir(profilePath, { recursive: true });

    const error = await shell.openPath(profilePath);
    if (error) {
      throw new ProfileManagerError(error, "OPEN_FOLDER_FAILED");
    }

    return profile;
  }

  async deleteProfile(id: string): Promise<DeleteProfileResult> {
    const registry = await this.loadRegistry();
    const profile = this.findProfile(registry, id);

    const state = await this.getState();
    const current = state.profiles.find((item) => item.id === id);
    if (current?.running) {
      throw new ProfileManagerError("Close this Chrome profile before deleting it.", "PROFILE_RUNNING");
    }

    const trashPath = await this.moveToTrash(this.profilePath(profile), profile.dirName);
    const nextProfiles = registry.profiles.filter((item) => item.id !== id);
    await this.saveRegistry({ profiles: nextProfiles });

    return {
      deletedProfile: profile,
      trashPath,
      state: await this.getState()
    };
  }

  private async ensureStore(): Promise<void> {
    await fs.mkdir(this.profilesDir, { recursive: true });

    try {
      await fs.access(this.registryPath);
    } catch {
      await this.saveRegistry({ profiles: [] });
    }
  }

  private async loadRegistry(): Promise<Registry> {
    await this.ensureStore();

    try {
      const raw = await fs.readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<Registry>;
      if (!Array.isArray(parsed.profiles)) {
        return { profiles: [] };
      }

      return {
        profiles: parsed.profiles.map(normalizeProfile).filter(Boolean) as StoredProfile[]
      };
    } catch {
      const backup = `${this.registryPath}.broken-${Date.now()}`;
      try {
        await fs.rename(this.registryPath, backup);
      } catch {
        // Start clean if the broken registry cannot be backed up.
      }
      return { profiles: [] };
    }
  }

  private async saveRegistry(registry: Registry): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const tmpPath = `${this.registryPath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, this.registryPath);
  }

  private async getRuntimeByPath(profilePaths: string[]): Promise<Map<string, number[]>> {
    const runtime = new Map<string, number[]>();

    if (!profilePaths.length) {
      return runtime;
    }

    try {
      const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="], {
        maxBuffer: 1024 * 1024 * 8
      });

      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        const match = trimmed.match(/^(\d+)\s+(.*)$/);
        if (!match) {
          continue;
        }

        const pid = Number(match[1]);
        const command = match[2];
        for (const profilePath of profilePaths) {
          if (!command.includes("--user-data-dir=") || !command.includes(profilePath)) {
            continue;
          }

          const pids = runtime.get(profilePath) || [];
          pids.push(pid);
          runtime.set(profilePath, pids);
        }
      }
    } catch {
      return runtime;
    }

    return runtime;
  }

  private toPublicProfile(profile: StoredProfile, runtime: Map<string, number[]>): PublicProfile {
    const profilePath = this.profilePath(profile);
    const pids = runtime.get(profilePath) || [];

    return {
      ...profile,
      path: profilePath,
      running: pids.length > 0,
      pids
    };
  }

  private findProfile(registry: Registry, id: string): StoredProfile {
    const profile = registry.profiles.find((item) => item.id === id);
    if (!profile) {
      throw new ProfileManagerError("Profile not found.", "PROFILE_NOT_FOUND");
    }

    return profile;
  }

  private profilePath(profile: StoredProfile): string {
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
