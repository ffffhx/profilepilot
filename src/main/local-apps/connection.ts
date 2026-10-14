import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { LocalAppAgentState, LocalAppConfig, LocalAppConnectionProgress, LocalAppConnectionResult, LocalAppRuntime, LocalAppView } from "../../shared/local-apps";
import { invalidateProcessRuntime, processRuntime } from "./service-runtime";
import { requestAppQuit } from "./quit";
import type { DebugState } from "./runtime";

interface ConnectionHost {
  config(id: string): LocalAppConfig;
  inspect(config: LocalAppConfig): Promise<LocalAppView>;
  renderer(config: LocalAppConfig): Promise<DebugState>;
  agent(config: LocalAppConfig): Promise<LocalAppAgentState>;
  attach(config: LocalAppConfig): Promise<void>;
  preflight(config: LocalAppConfig): Promise<void>;
  launch(id: string): Promise<void>;
}
interface RestartConsent { token: string; config: string; pid: number; startedAt: string; expires: number; }

export class LocalAppConnector {
  private confirmations = new Map<string, RestartConsent>();
  private progress = new Map<string, LocalAppConnectionProgress>();
  constructor(private host: ConnectionHost) {}
  state(id: string): LocalAppConnectionProgress | undefined { return this.progress.get(id); }
  forget(id: string): void { this.confirmations.delete(id); }
  private phase(id: string, phase: LocalAppConnectionProgress["phase"], message: string): void { this.progress.set(id, { phase, message }); }
  private async observed(config: LocalAppConfig): Promise<LocalAppRuntime> {
    invalidateProcessRuntime();
    return processRuntime(config);
  }
  async connect(id: string, token?: string): Promise<LocalAppConnectionResult> {
    const consent = this.confirmations.get(id);
    this.confirmations.delete(id);
    const config = this.host.config(id);
    if (token && (!consent || token !== consent.token || consent.expires < Date.now() || consent.config !== JSON.stringify(config))) {
      throw new Error("重启确认已失效或应用配置已变化，请重新连接并确认。");
    }
    this.phase(id, "checking", "正在检查并连接应用…");
    try {
      if (config.mode === "service") throw new Error("后台服务不支持 Agent 界面操作。");
      if (!config.cdpPort) throw new Error("请先在连接设置中配置应用的界面调试端口。");
      const renderer = await this.host.renderer(config);
      const agent = await this.host.agent(config);
      if (renderer === "connected") return await this.attach(config);
      if (renderer === "unknown") throw new Error("应用连接端口有响应，但尚未提供可用窗口。请稍后重试，或在连接设置中检查端口。");
      if (agent.sessionId) throw new Error("此应用仍有 Agent 会话，请先停止该任务，再重新连接。");
      if (config.mode !== "launch") throw new Error("此应用由外部启动。请在连接设置中配置启动方式，或自行带调试参数重启后重试连接。");
      await this.host.preflight(config);
      const observed = await this.observed(config);
      const view = await this.host.inspect(config);
      if (view.controls.start) {
        await this.start(config);
        return { status: "connected" };
      }
      if (view.managed && observed.status === "stopped") return await this.waitForConnection(config);
      if (observed.status !== "running" || !observed.pid || !observed.startedAt) {
        throw new Error("暂时无法确认要重启的应用进程，请使用应用自己的入口退出，再重试连接。");
      }
      if (!token) {
        const confirmationToken = randomUUID();
        this.confirmations.set(id, { token: confirmationToken, config: JSON.stringify(config), pid: observed.pid, startedAt: observed.startedAt, expires: Date.now() + 5 * 60_000 });
        return { status: "restart-required", confirmationToken };
      }
      if (observed.pid !== consent!.pid || observed.startedAt !== consent!.startedAt) {
        throw new Error("应用运行实例已变化，本次重启已取消。请重新连接并确认。");
      }
      this.phase(id, "closing", "正在等待应用正常退出；如有保存提示，请先在应用中处理。");
      if (!await requestAppQuit(observed.pid)) {
        throw new Error("无法请求应用正常退出，可能受系统权限限制。请从应用自己的入口退出，然后点击重试连接。");
      }
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const current = await this.observed(config);
        if (current.status === "running" && (current.pid !== observed.pid || current.startedAt !== observed.startedAt)) {
          throw new Error("应用运行实例已变化，本次重启已取消。请重新连接。");
        }
        if ((await this.host.inspect(config)).controls.start) {
          await this.start(config);
          return { status: "connected" };
        }
        await delay(500);
      }
      throw new Error("应用尚未退出，可能有待保存内容或已取消退出。请在应用中处理后重试；本次没有强制关闭应用。");
    } finally { this.progress.delete(id); }
  }
  private async attach(config: LocalAppConfig): Promise<LocalAppConnectionResult> {
    this.phase(config.id, "connecting", "正在验证 Agent 连接…");
    await this.host.attach(config);
    const agent = await this.host.agent(this.host.config(config.id));
    if (!agent.connected || await this.host.renderer(config) !== "connected") throw new Error("应用已打开，但 Agent 连接尚未建立，请稍后重试连接。");
    return { status: "connected" };
  }
  private async start(config: LocalAppConfig): Promise<void> {
    this.phase(config.id, "starting", "正在按连接设置启动应用…");
    await this.host.launch(config.id);
    await this.waitForConnection(config);
  }
  private async waitForConnection(config: LocalAppConfig): Promise<LocalAppConnectionResult> {
    this.phase(config.id, "connecting", "正在等待应用窗口并验证连接…");
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await this.host.renderer(config) === "connected") return this.attach(config);
      const view = await this.host.inspect(config);
      if (view.runtime.status === "failed") throw new Error(view.runtime.error || "应用启动失败，请在连接设置中检查启动命令。");
      await delay(500);
    }
    throw new Error("启动命令已执行，但应用没有开放可用的连接。请在连接设置中确认启动命令已开启界面调试，再重试连接。");
  }
}
