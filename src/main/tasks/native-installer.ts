import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CdpBrowserClient } from "../cdp-client";

export type InstallStage = "preparing" | "enable-debugging" | "authorizing" | "installing" | "confirm-tab" | "connected" | "failed" | "cancelled";
export interface InstallProgress { stage: InstallStage; message: string; extensionPath?: string; version?: string; mode?: "local" | "store" | "temporary" | "existing"; }
export interface PreparedNativeExtension { extensionPath: string; version: string; digest: string; }
export interface InstallRequest {
  url: string; profileId: string; signal: AbortSignal;
  report(progress: InstallProgress): void;
}
export interface NativeInstallDriver {
  install(request: InstallRequest): Promise<void>;
  openSettings(profileId: string, invitationUrl?: string): Promise<void>;
  prepare?(): Promise<PreparedNativeExtension>;
  openExtensions?(profileId: string, invitationUrl?: string): Promise<void>;
  revealExtension?(): Promise<void>;
  maintenanceStates?(): Array<InstallProgress & { profileId: string }>;
  reportMaintenance?(profileId: string, progress?: InstallProgress): void;
  setMaintenanceListener?(changed: () => void): void;
}
interface InstallerOptions {
  source: string; destination: string; userDataDir: string; extensionId: string;
  openSettings(profileId: string, invitationUrl?: string): Promise<void>;
  openExtensions?(profileId: string, invitationUrl?: string): Promise<void>;
  revealExtension?(folder: string): Promise<void>;
  connect?: typeof CdpBrowserClient.connect;
}

export function parseNativeDebugEndpoint(contents: string): string {
  const [portText, wsPath] = contents.trim().split(/\r?\n/);
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser(?:\/[a-zA-Z0-9-]+)?$/.test(wsPath || "")) {
    throw new Error("Chrome 的调试连接信息无效，请关闭再开启远程调试开关。");
  }
  return `ws://127.0.0.1:${port}${wsPath}`;
}

const preparations = new Map<string, Promise<string>>();

// A fixed path is essential: a manually installed unpacked extension must keep
// finding its files after an application upgrade, including new sidepanel/assets.
export function prepareNativeExtension(source: string, destination: string, extensionId: string): Promise<string> {
  const key = process.platform === "win32" ? path.resolve(destination).toLowerCase() : path.resolve(destination);
  const previous = preparations.get(key) || Promise.resolve("");
  const next = previous.catch(() => "").then(() => prepareFiles(source, destination, extensionId));
  preparations.set(key, next);
  void next.finally(() => { if (preparations.get(key) === next) preparations.delete(key); }).catch(() => {});
  return next;
}

async function extensionFiles(root: string, relative = ""): Promise<Array<{ name: string; data: Buffer }>> {
  const files: Array<{ name: string; data: Buffer }> = [];
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) throw new Error("扩展文件不能包含符号链接。");
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await extensionFiles(root, name));
    else if (entry.isFile()) files.push({ name, data: await readFile(path.join(root, name)) });
    else throw new Error("扩展目录包含不支持的文件。");
  }
  return files;
}

async function prepareFiles(source: string, destination: string, extensionId: string): Promise<string> {
  const files = await extensionFiles(source);
  const manifest = JSON.parse(files.find(f => f.name === "manifest.json")?.data.toString("utf8") || "{}");
  const digest = createHash("sha256").update(Buffer.from(manifest.key || "", "base64")).digest("hex").slice(0, 32);
  const actualId = digest.replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
  if (actualId !== extensionId || manifest.manifest_version !== 3) throw new Error("扩展文件校验失败，请重新安装 ProfilePilot。");
  const names = new Set(files.map(f => f.name));
  const resources = [manifest.background?.service_worker, manifest.action?.default_popup, manifest.side_panel?.default_path,
    ...Object.values(manifest.icons || {}), ...(manifest.content_scripts || []).flatMap((entry: { js?: string[]; css?: string[] }) => [...entry.js || [], ...entry.css || []])].filter(Boolean);
  if (!manifest.version || resources.some(resource => typeof resource !== "string" || !names.has(resource))) throw new Error("扩展资源不完整，请重新安装 ProfilePilot。");
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.name).update("\0").update(file.data).update("\0");
  const fingerprint = hash.digest("hex");
  const folder = path.join(destination, "current");
  try {
    const ready = JSON.parse(await readFile(path.join(folder, ".ready"), "utf8"));
    const existing = await extensionFiles(folder);
    if (ready.digest === fingerprint && existing.length === files.length && existing.every((file, i) => file.name === files[i].name && file.data.equals(files[i].data))) return folder;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "") && !(error instanceof SyntaxError)) throw error;
  }
  await mkdir(destination, { recursive: true });
  const staging = path.join(destination, `.staging-${randomBytes(8).toString("hex")}`);
  await mkdir(staging);
  const backup = path.join(destination, ".previous");
  let backedUp = false;
  try {
    for (const file of files) {
      await mkdir(path.dirname(path.join(staging, file.name)), { recursive: true });
      await writeFile(path.join(staging, file.name), file.data);
    }
    await writeFile(path.join(staging, ".ready"), JSON.stringify({ digest: fingerprint, version: manifest.version }));
    // Only our dedicated subdirectories are replaced. Old hash directories are
    // retained because an earlier manual installation may still reference one.
    try { await rename(folder, backup); backedUp = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Recover an interrupted previous update before replacing current.
        if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code || "")) {
          await rm(backup, { recursive: true, force: true }); await rename(folder, backup); backedUp = true;
        } else throw error;
      }
    }
    try { await rename(staging, folder); }
    catch (error) { if (backedUp) await rename(backup, folder); throw error; }
    await rm(backup, { recursive: true, force: true });
  } finally { await rm(staging, { recursive: true, force: true }); }
  return folder;
}

export function nativeExtensionStoreUrl(extensionId: string, configured = process.env.PROFILEPILOT_EXTENSION_STORE_URL || ""): string {
  if (!/^[a-p]{32}$/.test(extensionId)) return "";
  return new RegExp(`^https://chromewebstore\\.google\\.com/detail/(?:[a-zA-Z0-9-]+/)?${extensionId}$`).test(configured) ? configured : "";
}

export async function sameNativeProfilePath(actual: string, expected: string): Promise<boolean> {
  // realpath respects case-sensitive APFS and resolves macOS /var -> /private/var.
  // Windows paths can differ only in casing; macOS must not be blindly lowercased.
  try {
    const [a, b] = await Promise.all([realpath(actual), realpath(expected)]);
    if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
    if (a === b) return true;
    const [left, right] = await Promise.all([stat(a), stat(b)]);
    return left.ino !== 0 && left.dev === right.dev && left.ino === right.ino;
  } catch {
    return process.platform === "win32" ? path.resolve(actual).toLowerCase() === path.resolve(expected).toLowerCase() : path.resolve(actual) === path.resolve(expected);
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class NativeExtensionInstaller implements NativeInstallDriver {
  private readonly maintenance = new Map<string, InstallProgress>();
  private maintenanceChanged = () => {};
  constructor(private readonly options: InstallerOptions) {}
  maintenanceStates(): Array<InstallProgress & { profileId: string }> { return [...this.maintenance].map(([profileId, state]) => ({ profileId, ...state })); }
  setMaintenanceListener(changed: () => void): void { this.maintenanceChanged = changed; }
  reportMaintenance(profileId: string, progress?: InstallProgress): void {
    if (!progress && !this.maintenance.has(profileId)) return;
    if (progress) this.maintenance.set(profileId, progress); else this.maintenance.delete(profileId);
    this.maintenanceChanged();
  }
  openSettings(profileId: string, invitationUrl?: string): Promise<void> { return this.options.openSettings(profileId, invitationUrl); }
  async prepare(): Promise<PreparedNativeExtension> {
    const extensionPath = await prepareNativeExtension(this.options.source, this.options.destination, this.options.extensionId);
    const ready = JSON.parse(await readFile(path.join(extensionPath, ".ready"), "utf8"));
    return { extensionPath, version: ready.version, digest: ready.digest };
  }
  async openExtensions(profileId: string, invitationUrl?: string): Promise<void> {
    if (this.options.openExtensions) await this.options.openExtensions(profileId, invitationUrl);
  }
  async revealExtension(): Promise<void> {
    const prepared = await this.prepare();
    await this.options.revealExtension?.(prepared.extensionPath);
  }
  async install(request: InstallRequest): Promise<void> {
    const { signal, report } = request;
    if (!/^native:[^/\\]{1,100}$/.test(request.profileId) || [".", ".."].includes(request.profileId.slice(7))) throw new Error("系统 Profile 无效。");
    const { extensionPath, version: preparedVersion } = await this.prepare();
    signal.throwIfAborted();
    // An already installed extension can claim the invitation without CDP.
    await pause(1500, signal);
    let endpoint: string | undefined;
    report({ stage: "enable-debugging", mode: "temporary", extensionPath, message: "正在进行临时安装（Chrome 重启后可能移除）。请打开 Chrome 设置，开启“允许对此浏览器进行远程调试”。" });
    while (!endpoint) {
      signal.throwIfAborted();
      try { endpoint = parseNativeDebugEndpoint(await readFile(path.join(this.options.userDataDir, "DevToolsActivePort"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!endpoint) await pause(1000, signal);
    }
    report({ stage: "authorizing", message: "请在 Chrome 弹窗中点击“允许”。允许后会自动安装扩展，无需选择文件夹。" });
    let client: CdpBrowserClient;
    try { client = await (this.options.connect || CdpBrowserClient.connect)(endpoint, 180000, signal); }
    catch (error) {
      signal.throwIfAborted();
      throw new Error("Chrome 调试连接未建立或等待超时；这不一定表示你没有点击允许。本次连接已结束，不会自动重试。请确认 Chrome 仍在运行；需要再次安装时点击“安装或修复扩展”。");
    }
    let verificationTarget: string | undefined;
    const abort = () => {
      if (verificationTarget) void client.send("Target.closeTarget", { targetId: verificationTarget }, 1000).catch(() => {}).finally(() => client.close());
      else client.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const version = await client.send<{ product: string }>("Browser.getVersion");
      if (Number(/(?:Chrome|Chromium)\/(\d+)/.exec(version.product)?.[1] || 0) < 149) throw new Error("自动安装需要 Chrome 149 或更新版本。请更新 Chrome 后重试；也可使用下方的手动安装。");
      const { targetInfos } = await client.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>("Target.getTargets");
      const page = targetInfos.find(t => t.type === "page" && t.url === request.url);
      if (!page) throw new Error("连接页面已关闭或当前 Chrome 不属于所选 Profile，请返回应用重新连接。");
      await client.send("Target.activateTarget", { targetId: page.targetId });
      const created = await client.send<{ targetId: string }>("Target.createTarget", { url: "chrome://version/", background: true });
      verificationTarget = created.targetId;
      const { sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: verificationTarget, flatten: true });
      const expected = path.join(this.options.userDataDir, request.profileId.slice(7));
      const checkProfile = async () => {
        let actual = "";
        for (let i = 0; i < 30; i++) {
          signal.throwIfAborted();
          const result = await client.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: "document.querySelector('#profile_path')?.textContent?.trim() || ''", returnByValue: true }, 5000, sessionId);
          actual = result.result.value || "";
          if (actual) break;
          await pause(100, signal);
        }
        if (!actual || !await sameNativeProfilePath(actual, expected)) throw new Error("Chrome 当前使用的 Profile 与所选 Profile 不一致，未继续安装。请切回连接页面对应的 Chrome 窗口后重试。");
      };
      await checkProfile();
      signal.throwIfAborted();
      report({ stage: "installing", message: "正在当前 Profile 安装并验证 ProfilePilot 扩展，请保持此 Chrome 窗口。" });
      await client.send("Target.activateTarget", { targetId: page.targetId });
      const installed = await client.send<{ extensions: Array<{ id: string; enabled: boolean; path: string }> }>("Extensions.getExtensions");
      const existing = installed.extensions.find(e => e.id === this.options.extensionId);
      // loadUnpacked may be a no-op for an existing path. Treating its success
      // as a fresh CDP install would incorrectly mark a persistent installation
      // temporary. Reuse an enabled matching installation without rewriting it.
      if (existing && (!existing.enabled || typeof existing.path !== "string" || !await sameNativeProfilePath(existing.path, extensionPath))) {
        throw new Error("已存在 ProfilePilot 扩展，但尚未启用或安装目录不同。请在 Chrome 扩展管理页启用它，或从准备好的固定目录加载；现有安装方式与配对信息未更改。");
      }
      if (existing) report({ stage: "installing", mode: "existing", message: "正在核验已有扩展；保留原有安装方式与配对信息。" });
      signal.throwIfAborted();
      let loaded: { id: string };
      try { loaded = existing ? { id: existing.id } : await client.send<{ id: string }>("Extensions.loadUnpacked", { path: extensionPath }, 30000); }
      catch (error) {
        signal.throwIfAborted();
        throw new Error(`Chrome 未完成扩展安装。请检查浏览器的扩展策略或安全提示，然后重试。${error instanceof Error ? `（${error.message}）` : ""}`);
      }
      if (loaded.id !== this.options.extensionId) throw new Error("安装返回了意外的扩展 ID，未继续配对。");
      const extensions = await client.send<{ extensions: Array<{ id: string; enabled: boolean; path: string }> }>("Extensions.getExtensions");
      if (!extensions.extensions.some(e => e.id === loaded.id && e.enabled)) throw new Error("Chrome 未启用扩展，请检查浏览器的扩展策略或安全提示后重试。");
      // Chrome 153 can disable a CDP-loaded extension on runtime.reload. This
      // marker distinguishes it from a genuine developer-mode installation.
      // Use this extension's own initialized worker. The CDP storage domain can
      // race worker registration and rejects even a just-attached worker host.
      let workerId: string | undefined;
      for (let attempt = 0; attempt < 100 && !workerId; attempt++) {
        signal.throwIfAborted();
        const targets = await client.send<{ targetInfos: Array<{ targetId: string; type: string; url: string }> }>("Target.getTargets");
        workerId = targets.targetInfos.find(t => t.type === "service_worker" && t.url === `chrome-extension://${loaded.id}/background.js`)?.targetId;
        if (!workerId) await pause(100, signal);
      }
      if (!workerId) throw new Error("扩展已安装，但后台服务未启动。请检查 Chrome 扩展管理页中的错误并重试。");
      const worker = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: workerId, flatten: true });
      try {
        let ready = false;
        for (let attempt = 0; attempt < 50 && !ready; attempt++) {
          signal.throwIfAborted();
          const check = await client.send<{ result: { value?: boolean } }>("Runtime.evaluate", { expression: `typeof chrome !== 'undefined' && chrome.runtime?.id === '${loaded.id}' && Boolean(chrome.storage?.local)`, returnByValue: true }, 5000, worker.sessionId);
          ready = check.result?.value === true;
          if (!ready) await pause(100, signal);
        }
        if (!ready) throw new Error("扩展后台尚未就绪，未完成临时安装标记；请重试安装。");
        // loadUnpacked can succeed for an already loaded path while its old
        // worker keeps running. Verify the worker, not the enabled/list metadata.
        const manifest = await client.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", {
          expression: "chrome.runtime.getManifest().version", returnByValue: true
        }, 5000, worker.sessionId);
        const workerVersion = manifest.result?.value;
        if (manifest.exceptionDetails || typeof workerVersion !== "string" || workerVersion !== preparedVersion) {
          throw new Error(`未确认扩展更新成功：运行中的后台版本为 ${typeof workerVersion === "string" && !manifest.exceptionDetails ? workerVersion : "未知"}，已准备版本为 ${preparedVersion}。请在 Chrome 扩展管理页重新加载 ProfilePilot 扩展；已有配对会保留，无需卸载或重新配对。`);
        }
        if (!existing) {
          const marked = await client.send<{ result?: { value?: boolean }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: "chrome.storage.local.set({profilepilotInstallation:{mode:'temporary'}}).then(() => true)", awaitPromise: true, returnByValue: true }, 5000, worker.sessionId);
          if (marked.exceptionDetails || marked.result?.value !== true) throw new Error("无法记录临时安装状态，请重新安装扩展。");
        }
      } finally { await client.send("Target.detachFromTarget", { sessionId: worker.sessionId }, 2000).catch(() => {}); }
      signal.throwIfAborted();
      await client.send("Target.closeTarget", { targetId: verificationTarget }); verificationTarget = undefined;
      const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      // Freshly installed content scripts run on the next navigation. Only reload
      // our exact invitation target, never a user work tab.
      await client.send("Page.reload", {}, 5000, attached.sessionId);
      report(existing
        ? { stage: "confirm-tab", mode: "existing", extensionPath, message: "已核验运行中的扩展版本，正在连接当前 Profile；原有安装方式和配对信息已保留。" }
        : { stage: "confirm-tab", mode: "temporary", extensionPath, message: "临时扩展已安装，正在连接当前 Profile。要在 Chrome 重启后保留扩展，请使用本地持久安装或商店安装。" });
    } finally {
      if (verificationTarget) await client.send("Target.closeTarget", { targetId: verificationTarget }, 2000).catch(() => {});
      signal.removeEventListener("abort", abort);
      client.close();
    }
  }
}
