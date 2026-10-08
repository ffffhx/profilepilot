import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { nativeOnboardingPage } from "./native-onboarding-page";
import { nativeExtensionStoreUrl, type InstallProgress, type NativeInstallDriver } from "./native-installer";

export class NativeOnboarding {
  private tickets = new Map<string, { code: string; profileName: string; profileId: string; url: string; expiresAt: number; delivered: boolean; progress: InstallProgress; controller?: AbortController; timer?: NodeJS.Timeout }>();
  private driver?: NativeInstallDriver;
  private changed = () => {};
  constructor(private extensionId: string) {}
  configure(driver: NativeInstallDriver, changed: () => void): void { this.driver?.setMaintenanceListener?.(() => {}); this.driver = driver; this.changed = changed; driver.setMaintenanceListener?.(changed); }
  pending(profileId: string): { url: string; expiresAt: string } | undefined {
    const ticket = [...this.tickets.values()].find(t => t.profileId === profileId && t.expiresAt > Date.now() && !["connected", "cancelled"].includes(t.progress.stage));
    return ticket && { url: ticket.url, expiresAt: new Date(ticket.expiresAt).toISOString() };
  }
  states() {
    const states = new Map([...this.tickets.values()].map(t => [t.profileId, { profileId: t.profileId, ...(t.expiresAt <= Date.now() && !["connected", "cancelled"].includes(t.progress.stage) ? { stage: "failed" as const, message: "连接请求已过期，请返回 ProfilePilot 重新点击授权并连接。" } : t.progress) }]));
    for (const state of this.driver?.maintenanceStates?.() || []) states.set(state.profileId, state);
    return [...states.values()];
  }
  create(port: number, code: string, profileName: string, expiresAt: string, profileId = ""): string {
    for (const [id, item] of this.tickets) if (item.expiresAt <= Date.now() || (profileId && item.profileId === profileId)) {
      item.controller?.abort(); clearTimeout(item.timer); this.tickets.delete(id);
    }
    if ([...this.tickets.values()].some(t => !["connected", "failed", "cancelled", "confirm-tab"].includes(t.progress.stage))) throw new Error("另一个系统 Profile 正在连接，请先完成或取消该连接。");
    const id = randomBytes(24).toString("hex");
    const url = `http://127.0.0.1:${port}/profilepilot-connect/${id}`;
    this.tickets.set(id, { code, profileName, profileId, url, expiresAt: Date.parse(expiresAt), delivered: false, progress: { stage: "preparing", message: "正在准备扩展文件并检测已有连接…" } });
    return url;
  }
  start(url: string, install = false): void {
    const ticket = [...this.tickets.values()].find(t => t.url === url);
    if (!ticket || !this.driver || ticket.delivered || ticket.progress.stage === "connected" || ticket.expiresAt <= Date.now()) return;
    if (ticket.controller && !ticket.controller.signal.aborted && !["failed", "cancelled", "confirm-tab"].includes(ticket.progress.stage)) return;
    if (!install && ticket.controller) return;
    ticket.controller?.abort(); clearTimeout(ticket.timer);
    const controller = new AbortController(); ticket.controller = controller;
    const report = (progress: InstallProgress) => { if (ticket.controller === controller && !controller.signal.aborted) { ticket.progress = { ...ticket.progress, ...progress }; this.changed(); } };
    ticket.timer = setTimeout(() => {
      report({ stage: "failed", message: "连接请求已过期，请返回 ProfilePilot 重新点击授权并连接。" }); controller.abort();
    }, Math.max(0, ticket.expiresAt - Date.now())); ticket.timer.unref();
    report({ stage: "preparing", message: "正在准备扩展文件并检测已有连接…" });
    if (!install) {
      // Slow service-worker startup is not evidence that the extension is absent.
      // Never open a permission-producing CDP connection as a detection fallback.
      clearTimeout(ticket.timer);
      ticket.timer = setTimeout(() => report({ stage: "failed", message: "尚未收到扩展连接。已有配对会继续自动重连；首次使用请完成下方的持久安装，安装后点击“已安装，连接”。" }), 10000);
      ticket.timer.unref();
      if (this.driver.prepare) void this.driver.prepare().then(prepared => {
        if (controller.signal.aborted || ticket.controller !== controller) return;
        report({ ...ticket.progress, extensionPath: prepared.extensionPath, version: prepared.version, mode: nativeExtensionStoreUrl(this.extensionId) ? "store" : "local" });
      }).catch(error => { clearTimeout(ticket.timer); report({ stage: "failed", message: error instanceof Error ? error.message : "扩展文件准备失败，请重新安装 ProfilePilot。" }); });
      return;
    }
    void this.driver.install({ url, profileId: ticket.profileId, signal: controller.signal, report }).catch(error => {
      report({ stage: "failed", message: error instanceof Error ? error.message : "安装未完成，请重试。" });
    });
  }
  connected(profileId: string): void {
    let changed = false;
    for (const t of this.tickets.values()) if (t.profileId === profileId && t.expiresAt > Date.now() && !["connected", "cancelled"].includes(t.progress.stage)) {
      t.controller?.abort(); clearTimeout(t.timer);
      t.progress = { ...t.progress, stage: "connected", message: t.progress.mode === "temporary" ? "连接成功，可以返回 ProfilePilot 开始任务。本次为临时安装；要在 Chrome 重启后保留扩展，请改用本地持久安装或商店安装。" : t.progress.mode === "existing" ? "连接成功，可以返回 ProfilePilot 开始任务。已保留原有安装方式和配对信息。" : "连接成功，可以返回 ProfilePilot 开始任务。以后启动应用和 Chrome 会自动重连，无需重复配对。" };
      changed = true;
    }
    if (changed) this.changed();
  }
  close(): void { for (const t of this.tickets.values()) { t.controller?.abort(); clearTimeout(t.timer); } this.driver?.setMaintenanceListener?.(() => {}); }
  handle(req: IncomingMessage, res: ServerResponse, port: number): void {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const match = /^\/profilepilot-connect\/([a-f0-9]{48})(\/(?:pair|status|open-debugging|local-install|reveal-extension|retry|cancel))?$/.exec(req.url || "");
    if (req.headers.host !== `127.0.0.1:${port}` || !match) { res.writeHead(403); res.end(); return; }
    const ticket = this.tickets.get(match[1]);
    if (!ticket || ticket.expiresAt <= Date.now()) { res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" }); res.end("连接请求已过期，请返回 ProfilePilot 再次点击授权并连接。"); return; }
    const action = match[2];
    if (["/open-debugging", "/local-install", "/reveal-extension", "/retry", "/cancel"].includes(action)) {
      if (req.method !== "POST" || req.headers.origin !== `http://127.0.0.1:${port}` || req.headers["x-profilepilot-onboarding"] !== "1" || !this.driver || ticket.delivered) { res.writeHead(403); res.end(); return; }
      void (async () => {
        if (action === "/cancel") { ticket.controller?.abort(); clearTimeout(ticket.timer); ticket.progress = { stage: "cancelled", message: "连接已取消。返回应用可重新开始。" }; }
        else if (action === "/retry") {
          if (!["failed", "cancelled", "confirm-tab"].includes(ticket.progress.stage)) throw new Error("连接正在进行，请勿重复请求。");
          this.start(ticket.url, true);
        } else if (action === "/local-install" || action === "/reveal-extension") {
          const prepared = await this.driver!.prepare?.();
          if (!prepared) throw new Error("请在 ProfilePilot 设置中打开扩展文件夹。");
          if (ticket.delivered || ticket.progress.stage === "cancelled" || ticket.expiresAt <= Date.now()) throw new Error("连接状态已改变，请刷新连接页。");
          ticket.controller?.abort(); clearTimeout(ticket.timer);
          ticket.progress = { stage: "confirm-tab", mode: "local", extensionPath: prepared.extensionPath, version: prepared.version, message: "在扩展管理页开启开发者模式，点击“加载未打包的扩展程序”，选择下方固定目录。已加载过只需点击扩展的“重新加载”，配对会保留。" };
          if (action === "/local-install") await this.driver!.openExtensions?.(ticket.profileId, ticket.url);
          else await this.driver!.revealExtension?.();
        } else await this.driver!.openSettings(ticket.profileId, ticket.url);
        this.changed(); res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
      })().catch(error => { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: error.message })); });
      return;
    }
    if (req.method !== "GET" && !(action === "/pair" && req.method === "POST")) { res.writeHead(403); res.end(); return; }
    if (action === "/status") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(this.driver?.maintenanceStates?.().find(s => s.profileId === ticket.profileId) || ticket.progress)); return; }
    if (action === "/pair") {
      if (req.headers.origin !== `chrome-extension://${this.extensionId}` || ticket.delivered || ticket.progress.stage === "connected") { res.writeHead(403); res.end(); return; }
      if (ticket.progress.stage === "cancelled") { res.writeHead(410); res.end(); return; }
      ticket.delivered = true;
      ticket.controller?.abort();
      clearTimeout(ticket.timer);
      ticket.progress = { ...ticket.progress, stage: "confirm-tab", message: "扩展已就绪，正在连接当前 Profile。已有配对会自动重连。" }; this.changed();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: ticket.code, profileName: ticket.profileName, expiresAt: ticket.expiresAt })); return;
    }
    const storeUrl = nativeExtensionStoreUrl(this.extensionId);
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
    res.end(nativeOnboardingPage(ticket.profileName, ticket.progress.message, storeUrl, nonce));
  }
}
