import os from "node:os";
import { randomUUID } from "node:crypto";
import { requestBrowserGateway, readOrCreateBrowserGatewayDaemonIdentity } from "../browser-gateway-client";
import { requestNativeControl } from "../native-control/cli";
import { CaptchaError } from "./provider";

export interface CaptchaBrowserOptions { connection: "extension" | "gateway"; sessionId: string; profileId?: string; root?: string; port?: number; targetId?: string; }
export interface CaptchaBrowser { evaluate(expression: string): Promise<any>; }

export function captchaBrowser(options: CaptchaBrowserOptions, env: NodeJS.ProcessEnv, runtime: {
  native?: typeof requestNativeControl; gateway?: typeof requestBrowserGateway; identity?: typeof readOrCreateBrowserGatewayDaemonIdentity;
} = {}): CaptchaBrowser {
  let generation: unknown;
  const native = runtime.native || requestNativeControl;
  const gateway = runtime.gateway || requestBrowserGateway;
  const homeDir = env.HOME || os.homedir();
  const nativeRoot = options.root || env.PROFILEPILOT_NATIVE_ROOT;
  const daemonId = options.connection === 'gateway' ? (runtime.identity || readOrCreateBrowserGatewayDaemonIdentity)(options.sessionId, homeDir) : '';
  return {
    async evaluate(expression) {
      // Recheck the original ownership generation on every poll and before
      // applying. Never acquire, resume, choose a new Profile or change route.
      let profile: any;
      if (options.connection === 'extension') {
        const status = await native({ requestId: randomUUID(), method: 'status', params: {} }, nativeRoot);
        profile = status.profiles?.find((p: any) => p.ownerSessionId === options.sessionId && (!options.profileId || p.profileId === options.profileId));
      } else {
        const status = await gateway({ action: 'status' }, { homeDir });
        profile = (status.state as { profiles?: any[] })?.profiles?.find(p => p.publicPort === options.port && p.ownerSessionId === options.sessionId);
      }
      if (!profile || profile.ownership !== 'agent' || profile.pausedByBrowser || profile.connected === false) throw new CaptchaError('CAPTCHA_CONTROL_CHANGED', '当前会话未持有浏览器控制权；请检查 status，不会自动 claim / resume。', 75);
      if (profile.controlGeneration === undefined || (generation !== undefined && generation !== profile.controlGeneration)) throw new CaptchaError('CAPTCHA_CONTROL_CHANGED', '解题期间浏览器控制状态已变化；不会填回旧结果。', 75);
      generation = profile.controlGeneration;
      const params = { expression, returnByValue: true, awaitPromise: false, timeout: 5000 };
      const response: any = options.connection === 'extension'
        ? await native({ requestId: randomUUID(), method: 'cdp', profileId: options.profileId, sessionId: options.sessionId, params: { method: 'Runtime.evaluate', params } }, nativeRoot)
        : (await gateway({ action: 'raw-cdp', publicPort: options.port!, sessionId: options.sessionId, daemonInstanceId: daemonId, method: 'Runtime.evaluate', params, targetId: options.targetId }, { homeDir, timeoutMs: 15000 })).result;
      if (response?.exceptionDetails || !response?.result || !('value' in response.result)) throw new CaptchaError('CAPTCHA_EVALUATION_FAILED', '页面脚本未返回有效结果；请观察当前页面，勿重放填回操作。', 75);
      return response.result.value;
    }
  };
}
