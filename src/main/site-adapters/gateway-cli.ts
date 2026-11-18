import { readFileSync } from "node:fs";
import os from "node:os";
import {
  acquireAgentBrowserProfileLeaseSync,
  releaseAgentBrowserProfileLeaseSync
} from "../agent-browser-lease";
import {
  findActiveProfilePilotNotice,
  sessionFromAgentBrowserArgs
} from "../agent-browser-wrapper";
import {
  requestBrowserGateway,
  readOrCreateBrowserGatewayDaemonIdentity,
  type GatewayControlRequest,
  type GatewayControlResponse
} from "../browser-gateway-client";
import { planSiteAdapter } from "./catalog";
import { runSiteAdapter, siteEvaluationValue } from "./runner";

export interface GatewaySiteCliDeps {
  requestGateway?: (
    request: GatewayControlRequest,
    options?: { homeDir?: string; timeoutMs?: number }
  ) => Promise<GatewayControlResponse>;
}

/** Verifies local Profile lease and establishes/verifies Gateway session ownership
 * before raw-cdp execution. Never launches an unstarted browser, resumes a
 * user-delegated session, or switches to an alternative Profile on conflict. */
export async function runGatewaySiteCli(
  args: string[],
  commandIndex: number,
  port: number | undefined,
  env: NodeJS.ProcessEnv,
  deps: GatewaySiteCliDeps = {}
): Promise<unknown> {
  const sessionId = sessionFromAgentBrowserArgs(args, env);
  if (!sessionId || !port) throw new Error("site 需要 --session TASK 和 --cdp 逻辑端口；先使用同一会话连接目标。");
  const tail = args.slice(commandIndex + 1);
  if (tail.length !== 2 || !["--params", "--params-file"].includes(tail[0])) throw new Error("site 需要 --params-file PATH 或 --params JSON。");
  const raw = tail[0] === "--params-file" ? readFileSync(tail[1], "utf8") : tail[1];
  if (raw.length > 16000) throw new Error("网站读取参数过大。");
  const homeDir = env.PROFILEPILOT_GATEWAY_HOME || env.HOME || os.homedir();
  const adaptersDir = env.PROFILEPILOT_SITE_ADAPTERS_DIR?.trim() || undefined;
  const input = JSON.parse(raw.replace(/^\uFEFF/, ""));
  planSiteAdapter(input, { homeDir, adaptersDir });

  const activeNotice = findActiveProfilePilotNotice(args, env);
  if (activeNotice) {
    throw Object.assign(
      new Error(activeNotice.notice.message || "当前会话控制权已暂停或结束，不能继续执行网站读取。"),
      { code: activeNotice.notice.code }
    );
  }

  const targetIndex = args.indexOf("--target");
  const requestedTargetId = targetIndex >= 0 && targetIndex < commandIndex ? args[targetIndex + 1] : undefined;
  const leaseAcquisition = acquireAgentBrowserProfileLeaseSync(
    {
      cdpPort: port,
      session: sessionId,
      holderPid: process.pid,
      ...(requestedTargetId ? { targetId: requestedTargetId, allowSharedProfile: true } : {}),
      command: "site"
    },
    homeDir
  );
  if (!leaseAcquisition.ok) {
    const conflictSession = leaseAcquisition.lease.session;
    throw Object.assign(
      new Error(
        `端口 ${port} 的 Profile 已被会话 ${conflictSession} 占用，site 读取不会自动切换到其他 Profile。`
      ),
      { code: "PROFILE_LEASE_CONFLICT" }
    );
  }

  const daemonInstanceId = readOrCreateBrowserGatewayDaemonIdentity(sessionId, homeDir);
  const sendGateway = deps.requestGateway || requestBrowserGateway;
  let acquiredTargetId = requestedTargetId;
  try {
    const acquireResponse = await sendGateway(
      {
        action: "acquire",
        publicPort: port,
        sessionId,
        daemonInstanceId,
        driverKind: "agent-browser",
        driverLabel: "ppilot browser site CLI",
        ...(requestedTargetId ? { targetId: requestedTargetId, allowSharedProfile: true } : {})
      },
      { homeDir, timeoutMs: 5000 }
    );
    if (!acquiredTargetId && typeof acquireResponse.targetId === "string" && acquireResponse.targetId.trim()) {
      acquiredTargetId = acquireResponse.targetId.trim();
    }
  } catch (error) {
    if (leaseAcquisition.status === "acquired") {
      releaseAgentBrowserProfileLeaseSync(port, sessionId, homeDir);
    }
    throw error;
  }

  const rawCdp = async (method: string, params: Record<string, unknown>) => {
    const response = await sendGateway(
      {
        action: "raw-cdp",
        publicPort: port,
        sessionId,
        daemonInstanceId,
        method,
        params,
        targetId: acquiredTargetId,
        timeoutMs: 15000
      },
      { homeDir, timeoutMs: 18000 }
    );
    return response.result;
  };
  const result = await runSiteAdapter(input, {
    cacheScope: `${port}:${sessionId}:${daemonInstanceId}`,
    homeDir,
    adaptersDir,
    check: () => {
      const notice = findActiveProfilePilotNotice(args, env);
      if (notice) {
        throw Object.assign(new Error(notice.notice.message || "会话控制权已变更，停止网站读取。"), {
          code: notice.notice.code
        });
      }
    },
    evaluate: async expression => siteEvaluationValue(await rawCdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })),
    open: async url => { const nav = await rawCdp("Page.navigate", { url }) as any; if (nav?.errorText) throw new Error(nav.errorText); return nav; }
  });
  acquireAgentBrowserProfileLeaseSync(
    {
      cdpPort: port,
      session: sessionId,
      holderPid: process.pid,
      ...(acquiredTargetId ? { targetId: acquiredTargetId, allowSharedProfile: true } : {}),
      command: "site"
    },
    homeDir
  );
  return result;
}
