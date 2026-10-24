import { BrowserWindow, ipcMain, net, session } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isWorkspaceShell } from "../workspace-shell";
import { PHONE_CHANNEL, PHONE_CHANGED } from "../../shared/phones";
import { PhonesService } from "./service";
import { executePhoneCommand } from "./management";
import { AndroidSetup } from "./android-setup";
import { desktopCameraCapture } from "./screen-camera-capture";
import { cameraStartSchema } from "./screen-camera";
import { z } from "zod";
import type { PhoneVideoStream } from "./screen-video";

export function registerPhones(root: string, apkPath: string, poll = true): PhonesService {
  const service = new PhonesService({ root, apkPath, cameraCapture: desktopCameraCapture(), androidSetup: new AndroidSetup({
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
    proxy: async () => {
      const route = (await session.defaultSession.resolveProxy("https://dl.google.com/android/repository/repository2-3.xml")).split(";")[0].trim();
      const match = route.match(/^(PROXY|SOCKS5?)\s+([^\s:]+):(\d+)$/);
      return match ? [`--proxy=${match[1] === "PROXY" ? "http" : "socks"}`, `--proxy_host=${match[2]}`, `--proxy_port=${match[3]}`] : [];
    }
  }), onChanged: snapshot => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && trusted(window.webContents.getURL())) window.webContents.send(PHONE_CHANGED, snapshot);
  } });
  let followOwner: { contents: Electron.WebContents; stop: () => void } | undefined;
  const videos = new Map<number, { controller: AbortController; stream?: PhoneVideoStream; stop(): void }>();
  ipcMain.handle(PHONE_CHANNEL, async (event, method: string, params: unknown) => {
    const url = event.senderFrame?.url || "";
    if (event.senderFrame !== event.sender.mainFrame || !trusted(url)) throw new Error("手机接口仅供 ProfilePilot 工作区使用。");
    if (method === "snapshot") return service.snapshot();
    if (!trusted(url, true)) throw new Error("请在手机工作区操作设备。");
    if (method === "video-start") {
      const { id, basic } = z.object({ id: z.string().min(1).max(200), basic: z.object({ sessionId: z.string().min(1).max(100), generation: z.number().int().nonnegative() }).strict().optional() }).strict().parse(params);
      const owner = event.sender, window = BrowserWindow.fromWebContents(owner);
      if (!window?.isVisible() || window.isMinimized()) throw new Error("预览窗口不可见。");
      videos.get(owner.id)?.stop();
      const item = { controller: new AbortController(), stream: undefined as PhoneVideoStream | undefined, stop: () => {
        item.controller.abort(); item.stream?.stop();
        owner.removeListener("destroyed", item.stop); owner.removeListener("render-process-gone", item.stop);
        window.removeListener("hide", item.stop); window.removeListener("minimize", item.stop);
        if (videos.get(owner.id) === item) videos.delete(owner.id);
      } };
      videos.set(owner.id, item);
      owner.once("destroyed", item.stop); owner.once("render-process-gone", item.stop);
      window.once("hide", item.stop); window.once("minimize", item.stop);
      try {
        item.stream = await service.startScreenVideo(id, item.controller.signal, basic);
        item.controller.signal.throwIfAborted();
        return { streamId: item.stream.id };
      } catch (error) { item.stop(); throw error; }
    }
    if (method === "video-read" || method === "video-stop") {
      const { streamId } = z.object({ streamId: z.string().uuid() }).strict().parse(params);
      const item = videos.get(event.sender.id);
      if (!item?.stream || item.stream.id !== streamId) {
        if (method === "video-stop") return;
        throw new Error("视频预览已停止。");
      }
      if (method === "video-stop") { item.stop(); return; }
      try {
        const result = await item.stream.read();
        if (result.error) item.stop();
        return result;
      } catch (error) { item.stop(); throw error; }
    }
    if (method === "follow-command" && (params as { op?: string })?.op === "start") {
      const owner = event.sender;
      const result = await executePhoneCommand({ action: "phone", method, params }, service, "desktop") as { runId: string };
      if (followOwner && !followOwner.contents.isDestroyed()) followOwner.contents.removeListener("destroyed", followOwner.stop);
      const stop = () => { void service.gameFollower.command({ op: "stop", runId: result.runId }).catch(() => {}); };
      if (owner.isDestroyed()) stop();
      else { owner.once("destroyed", stop); followOwner = { contents: owner, stop }; }
      return result;
    }
    if (method === "camera-start") {
      const input = cameraStartSchema.parse(params);
      const owner = event.sender;
      const controller = new AbortController();
      const stop = () => controller.abort();
      const detached = () => owner.removeListener("destroyed", stop);
      owner.once("destroyed", stop);
      try {
        const result = await service.screenCamera.start(input, { signal: controller.signal, detached });
        if (owner.isDestroyed()) { stop(); throw new Error("扫码窗口已关闭"); }
        return result;
      } catch (error) { detached(); throw error; }
    }
    return executePhoneCommand({ action: "phone", method, params }, service, "desktop");
  });
  if (poll) service.startPolling(); return service;
}
function trusted(url: string, phonesOnly = false): boolean {
  if (isWorkspaceShell(url, path.resolve(__dirname, "../../../public"))) return true;
  try {
    const file = fileURLToPath(new URL(url));
    const allowed = phonesOnly ? ["phones.html"] : ["phones.html", "index.html", "tasks.html", "local-apps.html", "tools.html"];
    return allowed.some(name => path.resolve(file) === path.resolve(__dirname, "../../../public", name));
  } catch { return false; }
}
