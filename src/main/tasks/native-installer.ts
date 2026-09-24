import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { CdpBrowserClient } from "../cdp-client";

export type InstallStage = "preparing" | "enable-debugging" | "authorizing" | "installing" | "confirm-tab" | "connected" | "failed" | "cancelled";
export interface InstallProgress { stage: InstallStage; message: string; }
export interface InstallRequest {
  url: string; profileId: string; signal: AbortSignal;
  report(progress: InstallProgress): void;
}
export interface NativeInstallDriver {
  install(request: InstallRequest): Promise<void>;
  openSettings(profileId: string): Promise<void>;
}
interface InstallerOptions {
  source: string; destination: string; userDataDir: string; extensionId: string;
  openSettings(profileId: string): Promise<void>;
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

// Keep unpacked files outside app.asar and versioned application folders.
// Chrome 153 removes CDP installations on restart; retain files for reinstallation.
export async function prepareNativeExtension(source: string, destination: string, extensionId: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
  const digest = createHash("sha256").update(Buffer.from(manifest.key || "", "base64")).digest("hex").slice(0, 32);
  const actualId = digest.replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
  if (actualId !== extensionId || manifest.manifest_version !== 3) throw new Error("扩展文件校验失败，请重新安装 ProfilePilot。");
  const files = ["manifest.json", "background.js", "onboarding.js", "popup.html", "popup.js", "popup.css"];
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update(await readFile(path.join(source, file)));
  const folder = path.join(destination, hash.digest("hex").slice(0, 24));
  try { await readFile(path.join(folder, ".ready")); return folder; } catch {}
  await mkdir(destination, { recursive: true });
  const staging = path.join(destination, `.staging-${randomBytes(8).toString("hex")}`);
  await mkdir(staging);
  try {
    for (const file of files) await cp(path.join(source, file), path.join(staging, file));
    await cp(path.join(source, "manifest.json"), path.join(staging, ".ready"));
    await rename(staging, folder);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return folder;
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
  constructor(private readonly options: InstallerOptions) {}
  openSettings(profileId: string): Promise<void> { return this.options.openSettings(profileId); }
  async install(request: InstallRequest): Promise<void> {
    const { signal, report } = request;
    if (!/^native:[^/\\]{1,100}$/.test(request.profileId) || [".", ".."].includes(request.profileId.slice(7))) throw new Error("系统 Profile 无效。");
    const extensionPath = await prepareNativeExtension(this.options.source, this.options.destination, this.options.extensionId);
    signal.throwIfAborted();
    // An already installed extension can claim the invitation without CDP.
    await pause(1500, signal);
    let endpoint: string | undefined;
    report({ stage: "enable-debugging", message: "扩展文件已准备好。首次连接请打开 Chrome 设置，开启“允许对此浏览器进行远程调试”。" });
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
        const normalize = (s: string) => process.platform === "win32" ? path.resolve(s).toLowerCase() : path.resolve(s);
        if (!actual || normalize(actual) !== normalize(expected)) throw new Error("Chrome 当前使用的 Profile 与所选 Profile 不一致，未继续安装。请切回连接页面对应的 Chrome 窗口后重试。");
      };
      await checkProfile();
      signal.throwIfAborted();
      report({ stage: "installing", message: "正在当前 Profile 安装并验证 ProfilePilot 扩展，请保持此 Chrome 窗口。" });
      await client.send("Target.activateTarget", { targetId: page.targetId });
      let loaded: { id: string };
      try { loaded = await client.send<{ id: string }>("Extensions.loadUnpacked", { path: extensionPath }, 30000); }
      catch (error) {
        signal.throwIfAborted();
        throw new Error(`Chrome 未完成扩展安装。请检查浏览器的扩展策略或安全提示，然后重试。${error instanceof Error ? `（${error.message}）` : ""}`);
      }
      if (loaded.id !== this.options.extensionId) throw new Error("安装返回了意外的扩展 ID，未继续配对。");
      const extensions = await client.send<{ extensions: Array<{ id: string; enabled: boolean; path: string }> }>("Extensions.getExtensions");
      if (!extensions.extensions.some(e => e.id === loaded.id && e.enabled)) throw new Error("Chrome 未启用扩展，请检查浏览器的扩展策略或安全提示后重试。");
      signal.throwIfAborted();
      await client.send("Target.closeTarget", { targetId: verificationTarget }); verificationTarget = undefined;
      const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      // Freshly installed content scripts run on the next navigation. Only reload
      // our exact invitation target, never a user work tab.
      await client.send("Page.reload", {}, 5000, attached.sessionId);
      report({ stage: "confirm-tab", message: "扩展已安装。请在自动打开的扩展页面确认连接当前 Profile；任务会自动新开标签页。" });
    } finally {
      if (verificationTarget) await client.send("Target.closeTarget", { targetId: verificationTarget }, 2000).catch(() => {});
      signal.removeEventListener("abort", abort);
      client.close();
    }
  }
}
