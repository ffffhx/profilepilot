import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StartupSettings } from "../shared/startup-settings";

interface LoginItemState {
  openAtLogin: boolean;
  status?: string;
  executableWillLaunchAtLogin?: boolean;
  launchItems?: Array<{ name: string; enabled: boolean; scope: string; args: string[] }>;
}

export interface LoginItemApi {
  getLoginItemSettings(options?: Electron.LoginItemSettingsOptions): LoginItemState;
  setLoginItemSettings(settings: Electron.Settings): void;
}

export interface StartupEnvironment {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  executablePath: string;
  appPath: string;
}

const LOGIN_ITEM_NAME = "ProfilePilot";

export function startupLoginItemOptions(environment: StartupEnvironment): Electron.Settings | null {
  if (environment.platform === "darwin") {
    // macOS registers the application bundle and ignores Windows' path/args.
    // Registering the development Electron.app would launch an empty Electron.
    return environment.isPackaged ? {} : null;
  }
  if (environment.platform !== "win32") return null;
  return {
    name: LOGIN_ITEM_NAME,
    path: environment.executablePath,
    // Electron quotes these arguments itself when writing the Run command.
    args: environment.isPackaged ? [] : [environment.appPath]
  };
}

export class StartupSettingsManager {
  private readonly options: Electron.Settings | null;
  private lastError: string | null = null;

  constructor(
    private readonly preferencesPath: string,
    private readonly api: LoginItemApi,
    private readonly environment: StartupEnvironment
  ) {
    this.options = startupLoginItemOptions(environment);
  }

  initialize(): StartupSettings {
    if (!this.options) return this.get();
    try {
      const saved: unknown = JSON.parse(readFileSync(this.preferencesPath, "utf8"));
      if (!saved || typeof saved !== "object" || typeof (saved as { enabled?: unknown }).enabled !== "boolean") {
        throw new Error("开机自启动设置文件无效，请重新设置开关。");
      }
      // Apply the default once. Later starts respect both the in-app choice and
      // changes made in Windows Startup Apps / macOS Login Items.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.setEnabled(true);
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return this.get();
  }

  get(): StartupSettings {
    if (!this.options) {
      return {
        supported: false, enabled: false, requiresApproval: false,
        error: this.environment.platform === "darwin"
          ? "请使用安装版 ProfilePilot 设置开机自启动。"
          : "当前系统暂不支持开机自启动。"
      };
    }
    try {
      // Electron's Windows lookup parses `path` as a command line, while its
      // setter accepts a file path. Quote only the lookup executable so spaces
      // cannot truncate it (shell/browser/browser_win.cc).
      const lookup = this.environment.platform === "win32"
        ? { path: `"${this.environment.executablePath}"`, args: this.options.args }
        : this.options;
      const native = this.api.getLoginItemSettings(lookup);
      const requiresApproval = native.status === "requires-approval";
      const ownItem = native.launchItems?.find((item) => item.name === LOGIN_ITEM_NAME && item.scope === "user");
      const matchesArguments = ownItem && JSON.stringify(ownItem.args) === JSON.stringify(this.options.args || []);
      // openAtLogin checks the AppUserModelID registry value, ignoring our
      // explicit name. Use the matching user entry, including its approval and
      // arguments, so another Electron project cannot make this switch read on.
      const enabled = this.environment.platform === "win32"
        ? native.launchItems
          ? Boolean(ownItem?.enabled && matchesArguments)
          : native.openAtLogin && (native.executableWillLaunchAtLogin ?? true)
        : native.openAtLogin || requiresApproval;
      return { supported: true, enabled, requiresApproval, error: this.lastError };
    } catch (error) {
      return { supported: true, enabled: false, requiresApproval: false, error: String(error instanceof Error ? error.message : error) };
    }
  }

  setEnabled(enabled: boolean): StartupSettings {
    if (typeof enabled !== "boolean") throw new TypeError("开机自启动开关必须是布尔值。");
    if (!this.options) return this.get();
    try {
      // Save the choice first: a failed OS update must never make an explicit
      // opt-out look like a fresh install and enable it on the next launch.
      mkdirSync(path.dirname(this.preferencesPath), { recursive: true });
      const temporary = `${this.preferencesPath}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify({ enabled })}\n`, "utf8");
        renameSync(temporary, this.preferencesPath);
      } finally {
        rmSync(temporary, { force: true });
      }
      this.api.setLoginItemSettings({ ...this.options, openAtLogin: enabled, enabled });
      this.lastError = null;
      const actual = this.get();
      if (!actual.error && actual.enabled !== enabled) {
        this.lastError = "系统未应用开机自启动设置，请检查系统登录项或启动应用设置后重试。";
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return this.get();
  }
}

// Electron smoke/E2E runs exercise IPC and persistence without registering a
// disposable test application in the user's real login items.
export function createTestLoginItemApi(): LoginItemApi {
  let enabled = false;
  return {
    getLoginItemSettings: () => ({ openAtLogin: enabled, executableWillLaunchAtLogin: enabled }),
    setLoginItemSettings: (settings) => { enabled = settings.openAtLogin === true; }
  };
}
