import { access } from "node:fs/promises";
import path from "node:path";
import { ensureBrowserService } from "../browser-service/launcher";
import { browserServiceRoot, serviceRequest } from "../browser-service/connection";
import { acquireBrowserServiceLock } from "../browser-service/lock";
import { nativeChromeUserDataDir } from "../chrome-launch";
import { isExtensionEnabled, readChromePreferences, readChromeSecurePreferences } from "../extension-scan";
import { execFileAsync, sleep } from "../fs-util";
import { NATIVE_EXTENSION_ID, type NativeConnectionState } from "../tasks/native-bridge";
import type { PreparedNativeExtension } from "../tasks/native-installer";
import { NativeControlError } from "./errors";
import { macInstallPicker } from "./install-picker";

const profileId = "native:Default";
// Chromium's Extension::INSTALLED_VIA_CDP. Chrome records this flag even
// before the worker has reported its temporary installation mode.
const installedViaCdp = 1 << 15;

// Read Chrome's own record. A staged folder or a live temporary CDP connection
// alone is insufficient evidence of installation in this particular Profile.
export async function installedExtension(profile: string, folder: string) {
  const [preferences, secure] = await Promise.all([readChromePreferences(profile), readChromeSecurePreferences(profile)]);
  const setting = secure.extensions?.settings?.[NATIVE_EXTENSION_ID] ?? preferences.extensions?.settings?.[NATIVE_EXTENSION_ID];
  if (!setting) return "missing";
  if (typeof setting.creation_flags === "number" && (setting.creation_flags & installedViaCdp) !== 0) return "temporary";
  if (!isExtensionEnabled(setting)) return "disabled";
  if (setting.from_webstore === true) return "store";
  return setting.location === 4 && setting.path === folder ? "local" : "other";
}

export async function installDefaultExtension(progress: (message: string) => void) {
  if (process.platform !== "darwin") throw new NativeControlError("NATIVE_INSTALL_UNSUPPORTED", "此安装命令适用于 macOS 的 Google Chrome Default。");
  const root = browserServiceRoot();
  const userData = nativeChromeUserDataDir();
  const profile = path.join(userData, "Default");
  await access(path.join(profile, "Preferences")).catch(() => {
    throw new NativeControlError("NATIVE_INSTALL_PROFILE_MISSING", "未找到 Google Chrome Default，请先在 Chrome 中创建此配置。");
  });
  const service = await ensureBrowserService(root);
  const unlock = acquireBrowserServiceLock(path.join(root, "install-default"));
  if (!unlock) throw new NativeControlError("NATIVE_INSTALL_IN_PROGRESS", "另一个安装命令正在处理 Default。");
  try {
    const folder = path.join(root, "native-extension", "current");
    const snapshot = async () => (await serviceRequest(service, "snapshot")).result;
    let snap = await snapshot();
    const state = (): NativeConnectionState | undefined => snap.states.find((p: NativeConnectionState) => p.profileId === profileId);
    let record = await installedExtension(profile, folder);
    const result = () => ({ profileId, connected: true, installation: record, extensionVersion: state()?.extensionVersion });
    const ready = () => state()?.connected && state()?.extensionVersion && state()?.installationMode !== "temporary" && (record === "local" || record === "store");
    if (ready()) return result();
    if (state()?.ownerSessionId || state()?.pausedByBrowser) throw new NativeControlError("NATIVE_SESSION_CONFLICT", "Default 正被占用或处于接管状态。");
    if (record === "disabled" || record === "other" || record === "temporary" || state()?.connected) {
      throw new NativeControlError("NATIVE_INSTALL_REVIEW_REQUIRED", "检测到已有的临时、禁用或其他来源的安装。请在 Default 的扩展管理页核对现有安装。");
    }
    const prepared: PreparedNativeExtension = (await serviceRequest(service, "prepare")).result;
    if (prepared?.extensionPath !== folder) throw new Error("浏览器服务返回的扩展目录与预期不一致。");
    const { url, expiresAt } = (await serviceRequest(service, "authorize", [profileId, "Default"])).result;
    if (!/^http:\/\/127\.0\.0\.1:\d+\/profilepilot-connect\/[a-f0-9]{48}$/.test(url)) throw new Error("无效的本地安装邀请。");
    const deadline = Math.min(Date.parse(expiresAt), Date.now() + 300_000);
    const launch = async () => {
      try {
        await execFileAsync("/usr/bin/open", ["-nb", "com.google.Chrome", "--args", "--user-data-dir=" + userData, "--profile-directory=Default", url], { timeout: 15000 });
      } catch { throw new NativeControlError("NATIVE_INSTALL_OPEN_FAILED", "无法在 Google Chrome Default 打开本地连接页。"); }
    };
    await launch();
    let needsPairingPage = record === "missing";
    if (needsPairingPage) {
      progress("正在为 Default 打开 Chrome 安装界面。如开发者模式关闭，请在 Chrome 中开启。请确认所选文件夹，然后在扩展中确认连接。");
      try {
        await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", macInstallPicker, url, folder], { timeout: 30000 });
      } catch {
        // TCC, unsupported UI language or focus change. Keep the same invitation;
        // never send a blind click/keystroke to a different window.
        progress("未能预选目录。可在已打开的连接页完成持久安装，扩展目录为 " + folder);
      }
    } else progress("Default 已装有扩展，正在等待连接确认。");
    while (Date.now() < deadline) {
      snap = await snapshot();
      record = await installedExtension(profile, folder);
      if (record === "temporary" || state()?.installationMode === "temporary") throw new NativeControlError("NATIVE_INSTALL_TEMPORARY", "检测到临时安装，请使用 Chrome 的持久加载入口。");
      if (ready()) return result();
      const invitation = snap.installations.find((s: { profileId: string }) => s.profileId === profileId);
      if (invitation?.stage === "cancelled") throw new NativeControlError("NATIVE_INSTALL_CANCELLED", "用户已取消连接。");
      if (needsPairingPage && record === "local") {
        // New content scripts run on the next navigation. Reopen this same
        // scoped invitation once, after Chrome has recorded the installation.
        needsPairingPage = false;
        await launch();
      }
      await sleep(1000);
    }
    throw new NativeControlError("NATIVE_INSTALL_TIMEOUT", "等待 Default 的持久安装和连接确认超时。再次运行可继续核验现有安装。");
  } finally { unlock(); }
}
