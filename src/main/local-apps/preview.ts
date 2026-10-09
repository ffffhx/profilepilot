import type { LocalAppConfig, LocalAppPreview } from "../../shared/local-apps";
import { CdpBrowserClient, requestCdpJson } from "../cdp-client";
import { requestBrowserGateway } from "../browser-gateway-client";
import { LocalAppGateway } from "./gateway";

/** Desktop observation goes through the authenticated Gateway, never the raw app port. */
export class LocalAppWindows {
  constructor(private readonly gateway: LocalAppGateway) {}

  private async binding(config: LocalAppConfig) {
    if (config.mode === "service" || !config.agentPort) throw new Error("请先连接应用，再查看画面。");
    const status = await this.gateway.status();
    const state = this.gateway.state(config, status);
    if (!state.connected) throw new Error("应用尚未连接，请检查应用是否已打开。");
    return state;
  }

  private async client(config: LocalAppConfig): Promise<CdpBrowserClient> {
    const port = config.agentPort!;
    const version = await requestCdpJson<{ Browser: string; webSocketDebuggerUrl: string }>(port, "/json/version");
    const endpoint = new URL(version.webSocketDebuggerUrl);
    if (version.Browser !== "ProfilePilot Gateway" || endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" ||
        Number(endpoint.port) !== port || endpoint.pathname !== "/devtools/browser/gateway" || endpoint.username || endpoint.password) {
      throw new Error("应用连接已变化，请重新连接后再试。");
    }
    return CdpBrowserClient.connect(endpoint.href, 2500);
  }

  private async target(client: CdpBrowserClient, expectedId?: string) {
    const result = await client.send<{ targetInfos: Array<{ type: string; targetId: string; title: string }> }>("Target.getTargets", {}, 2500);
    const pages = result.targetInfos.filter(target => target.type === "page" || target.type === "webview");
    const target = expectedId ? pages.find(target => target.targetId === expectedId) : pages[0];
    if (!target) throw new Error("暂时没有可显示的应用窗口，请先打开应用窗口。");
    return target;
  }

  async preview(config: LocalAppConfig): Promise<LocalAppPreview> {
    const capturedAt = new Date().toISOString();
    let client: CdpBrowserClient | undefined;
    let sessionId: string | undefined;
    try {
      const state = await this.binding(config);
      if (state.sessionId && !state.targetId) return { screenshot: null, title: "", capturedAt, error: "等待 Agent 选择应用窗口。" };
      client = await this.client(config);
      const target = await this.target(client, state.targetId);
      ({ sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true }, 2500));
      const result = await client.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 40, captureBeyondViewport: false }, 4000, sessionId);
      if (!result.data) throw new Error("应用尚未生成画面。");
      return { screenshot: `data:image/jpeg;base64,${result.data}`, title: target.title || config.name, capturedAt };
    } catch (error) {
      console.debug("[local-apps] Preview unavailable:", config.id, (error as Error).message);
      return { screenshot: null, title: "", capturedAt, error: "暂时无法获取画面，请确认应用窗口已打开。" };
    } finally {
      if (client && sessionId) await client.send("Target.detachFromTarget", { sessionId }, 1000).catch(() => {});
      client?.close();
    }
  }

  async show(config: LocalAppConfig): Promise<void> {
    const state = await this.binding(config);
    if (state.sessionId) {
      // Uses the existing trusted reveal operation and validates the Agent's
      // target/generation in the daemon. Showing never takes over the session.
      await requestBrowserGateway({ action: "activate-agent-target", publicPort: config.agentPort! }, { timeoutMs: 8000 });
      return;
    }
    const client = await this.client(config);
    let sessionId: string | undefined;
    try {
      const target = await this.target(client);
      ({ sessionId } = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true }, 2500));
      // This is a trusted user click. Preview above never activates or focuses.
      await client.send("Page.bringToFront", {}, 4000, sessionId);
    } finally {
      if (sessionId) await client.send("Target.detachFromTarget", { sessionId }, 1000).catch(() => {});
      client.close();
    }
  }
}
