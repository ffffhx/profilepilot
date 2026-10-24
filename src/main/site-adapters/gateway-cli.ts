import { readFileSync } from "node:fs";
import os from "node:os";
import { sessionFromAgentBrowserArgs } from "../agent-browser-wrapper";
import { requestBrowserGateway, readOrCreateBrowserGatewayDaemonIdentity } from "../browser-gateway-client";
import { planSiteAdapter } from "./catalog";
import { runSiteAdapter, siteEvaluationValue } from "./runner";

/** Uses the same already-acquired Gateway session as raw CDP. Never launches,
 * resumes or chooses an alternative Profile on a failed site read. */
export async function runGatewaySiteCli(args: string[], commandIndex: number, port: number | undefined, env: NodeJS.ProcessEnv): Promise<unknown> {
  const sessionId = sessionFromAgentBrowserArgs(args, env);
  if (!sessionId || !port) throw new Error("site 需要 --session TASK 和 --cdp 逻辑端口；先使用同一会话连接目标。");
  const tail = args.slice(commandIndex + 1);
  if (tail.length !== 2 || !["--params", "--params-file"].includes(tail[0])) throw new Error("site 需要 --params-file PATH 或 --params JSON。");
  const raw = tail[0] === "--params-file" ? readFileSync(tail[1], "utf8") : tail[1];
  if (raw.length > 16000) throw new Error("网站读取参数过大。");
  const input = JSON.parse(raw.replace(/^\uFEFF/, ""));
  planSiteAdapter(input);
  const homeDir = env.PROFILEPILOT_GATEWAY_HOME || env.HOME || os.homedir();
  const daemonInstanceId = readOrCreateBrowserGatewayDaemonIdentity(sessionId, homeDir);
  const targetIndex = args.indexOf("--target");
  const targetId = targetIndex >= 0 && targetIndex < commandIndex ? args[targetIndex + 1] : undefined;
  const rawCdp = async (method: string, params: Record<string, unknown>) => {
    const response = await requestBrowserGateway({ action: "raw-cdp", publicPort: port, sessionId, daemonInstanceId, method, params, targetId, timeoutMs: 15000 }, { homeDir, timeoutMs: 18000 });
    return response.result;
  };
  return runSiteAdapter(input, {
    evaluate: async expression => siteEvaluationValue(await rawCdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })),
    open: async url => { const result = await rawCdp("Page.navigate", { url }) as any; if (result?.errorText) throw new Error(result.errorText); return result; }
  });
}
