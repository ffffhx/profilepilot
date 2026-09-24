import type { TaskSettings } from "../../shared/tasks";

export function providerEnvironment(settings: TaskSettings, key: string, cwd: string): NodeJS.ProcessEnv {
  const hostname = new URL(settings.baseUrl).hostname;
  const compatible = hostname !== "api.anthropic.com";
  const moonshot = ["api.moonshot.cn", "api.moonshot.ai", "api.kimi.com"].includes(hostname);
  const bearer = (settings.authMode || (moonshot || hostname === "api.deepseek.com" ? "bearer" : "apiKey")) === "bearer";
  return {
    ANTHROPIC_API_KEY: bearer ? undefined : key, ANTHROPIC_AUTH_TOKEN: bearer ? key : undefined,
    ANTHROPIC_BASE_URL: settings.baseUrl, ANTHROPIC_MODEL: settings.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: compatible ? settings.model : undefined,
    ANTHROPIC_DEFAULT_SONNET_MODEL: compatible ? settings.model : undefined,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: compatible ? settings.model : undefined,
    ANTHROPIC_DEFAULT_FABLE_MODEL: compatible ? settings.model : undefined,
    CLAUDE_CODE_SUBAGENT_MODEL: compatible ? settings.model : undefined,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: moonshot && /^kimi-k3(?:\[1m\])?$/.test(settings.model) ? "1000000" : undefined,
    CLAUDECODE: undefined, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CONFIG_DIR: cwd
  };
}
