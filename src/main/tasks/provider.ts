import type { TaskSettings } from "../../shared/tasks";

export function buildAnthropicMessagesUrl(baseUrl: string): string {
  const endpoint = new URL(baseUrl);
  if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error("模型服务地址无效。");
  }
  const pathname = endpoint.pathname
    .replace(/\/+$/, "")
    .replace(/\/v1\/messages$/i, "")
    .replace(/\/messages$/i, "")
    .replace(/\/v1$/i, "");
  endpoint.pathname = `${pathname}/v1/messages`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.href;
}

export function shouldDisableThinking(hostname: string): boolean {
  return ["api.deepseek.com", "api.moonshot.cn", "api.moonshot.ai", "api.kimi.com"].includes(hostname.toLowerCase());
}

function normalizeSdkBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const cleaned = url.pathname.replace(/\/+$/, "").replace(/\/v1\/messages$/i, "").replace(/\/messages$/i, "");
    if (cleaned !== url.pathname.replace(/\/+$/, "")) {
      url.pathname = cleaned || "/";
      return url.href.replace(/\/$/, "");
    }
  } catch { /* Preserve original when caller validates separately. */ }
  return baseUrl;
}

export function providerEnvironment(settings: TaskSettings, key: string, cwd: string): NodeJS.ProcessEnv {
  const hostname = new URL(settings.baseUrl).hostname;
  const compatible = hostname !== "api.anthropic.com";
  const moonshot = ["api.moonshot.cn", "api.moonshot.ai", "api.kimi.com"].includes(hostname);
  const bearer = (settings.authMode || (moonshot || hostname === "api.deepseek.com" ? "bearer" : "apiKey")) === "bearer";
  return {
    ANTHROPIC_API_KEY: bearer ? undefined : key, ANTHROPIC_AUTH_TOKEN: bearer ? key : undefined,
    ANTHROPIC_BASE_URL: normalizeSdkBaseUrl(settings.baseUrl), ANTHROPIC_MODEL: settings.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: compatible ? settings.model : undefined,
    ANTHROPIC_DEFAULT_SONNET_MODEL: compatible ? settings.model : undefined,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: compatible ? settings.model : undefined,
    ANTHROPIC_DEFAULT_FABLE_MODEL: compatible ? settings.model : undefined,
    CLAUDE_CODE_SUBAGENT_MODEL: compatible ? settings.model : undefined,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: moonshot && /^kimi-k3(?:\[1m\])?$/.test(settings.model) ? "1000000" : undefined,
    CLAUDECODE: undefined, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CONFIG_DIR: cwd
  };
}
