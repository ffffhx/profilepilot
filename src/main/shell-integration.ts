import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentIntegrationDiagnostic,
  AgentToolDiagnostic,
  AgentWrapperDiagnostic,
  ProfilePilotCliDiagnostic,
  ShellIntegrationStatus
} from "../shared/types";
import { resolveRealAgentBrowser } from "./agent-browser-wrapper";
import {
  inspectAgentSkills,
  inspectProfilePilotCliSkill,
  setAgentSkillEnabled as setInstalledAgentSkillEnabled
} from "./agent-skill-integration";
import { resolveRealChromeDevtoolsMcp } from "./chrome-devtools-mcp-wrapper";
import { inspectInputGuardPermission } from "./input-guard-companion";
import { resolveRealPlaywrightCli } from "./playwright-cli-wrapper";
import { ProfileManagerError } from "./profile-manager-error";
import { execPortableCommandSync } from "./portable-command";
import { runWindowsPowerShell } from "./windows-platform";

// 会话识别 shell 集成：往 ~/.zshenv 写一个托管块，在 AI agent 会话的 shell 里
// 自动注入 AGENT_BROWSER_SESSION。效果：
//   · 每个 agent 会话独占一个 agent-browser daemon（防多会话互抢标签页/连接漂移）；
//   · daemon 的 sock 文件名携带身份，本工具能据此归属“哪个会话在驱动”。
// 两家都有会话级环境变量，身份都能精确到会话：
//   · Claude Code：CLAUDE_CODE_SESSION_ID → cc-<会话UUID>；
//   · Codex：CODEX_THREAD_ID → cx-<会话UUID>（thread id 就是 rollout 档案名末尾的 UUID，
//     0.142+ 实测每条 shell 命令的环境里都有；旧版曾用的 CODEX_CLI_PATH 已不存在）。
// 选 ~/.zshenv 是因为 zsh 无论交互与否都会读它——agent 跑命令用的正是非交互 shell
//（Codex 起的也是用户默认 shell /bin/zsh，实测会 source 它）。

const BEGIN_MARK = "# >>> ProfilePilot session integration >>>";
const END_MARK = "# <<< ProfilePilot session integration <<<";
const WRAPPER_FILE_NAME = "profilepilot-agent-browser-wrapper.cjs";
const LAUNCHER_FILE_NAME = launcherFileName("agent-browser");
const WRAPPER_SIGNATURE = "PROFILEPILOT_AGENT_BROWSER_WRAPPER";
const PLAYWRIGHT_WRAPPER_FILE_NAME = "profilepilot-playwright-cli-wrapper.cjs";
const PLAYWRIGHT_LAUNCHER_FILE_NAME = launcherFileName("playwright-cli");
const PLAYWRIGHT_WRAPPER_SIGNATURE = "PROFILEPILOT_PLAYWRIGHT_CLI_WRAPPER";
const PLAYWRIGHT_LAUNCHER_SIGNATURE = "PROFILEPILOT_PLAYWRIGHT_CLI_LAUNCHER";
const MCP_WRAPPER_FILE_NAME = "profilepilot-chrome-devtools-mcp-wrapper.cjs";
const MCP_LAUNCHER_FILE_NAME = launcherFileName("chrome-devtools-mcp");
const MCP_WRAPPER_SIGNATURE = "PROFILEPILOT_CHROME_DEVTOOLS_MCP_WRAPPER";
const MCP_LAUNCHER_SIGNATURE = "PROFILEPILOT_CHROME_DEVTOOLS_MCP_LAUNCHER";
const NODE_RUNTIME_SIGNATURE = "PROFILEPILOT_NODE_RUNTIME";
const LAUNCHER_SIGNATURE = "PROFILEPILOT_AGENT_BROWSER_LAUNCHER";
const BIN_DIR_SIGNATURE = "PROFILEPILOT_AGENT_BROWSER_BIN_DIR";
const MANAGEMENT_CLI_BUNDLE_FILE_NAME = "profilepilot-cli.cjs";
const MANAGEMENT_CLI_LAUNCHER_FILE_NAME = launcherFileName("profilepilot");
const MANAGEMENT_CLI_SIGNATURE = "PROFILEPILOT_MANAGEMENT_CLI";
const MANAGEMENT_CLI_BIN_DIR_SIGNATURE = "PROFILEPILOT_MANAGEMENT_CLI_BIN_DIR";
// 生效特征：只要这行 export 在（无论是托管块还是用户手写的），注入就是开着的。
const EFFECTIVE_SIGNATURE = 'AGENT_BROWSER_SESSION="cc-$CLAUDE_CODE_SESSION_ID"';
// Codex 分支的特征行：托管块缺它说明是旧版模板（CODEX_CLI_PATH 检测或目录名身份），
// 重新启用时原位升级。
const CODEX_SIGNATURE = 'AGENT_BROWSER_SESSION="cx-$CODEX_THREAD_ID"';
const WRAPPER_PATH = agentBrowserWrapperPath();
const LAUNCHER_PATH = agentBrowserLauncherPath();
const PLAYWRIGHT_WRAPPER_PATH = playwrightCliWrapperPath();
const PLAYWRIGHT_LAUNCHER_PATH = playwrightCliLauncherPath();
const MCP_WRAPPER_PATH = chromeDevtoolsMcpWrapperPath();
const MCP_LAUNCHER_PATH = chromeDevtoolsMcpLauncherPath();
const BIN_DIR_PATH = path.dirname(LAUNCHER_PATH);
const MANAGEMENT_CLI_LAUNCHER_PATH = profilePilotCliLauncherPath();
const MANAGEMENT_CLI_BIN_DIR_PATH = path.dirname(MANAGEMENT_CLI_LAUNCHER_PATH);
const NODE_RUNTIME_PATH = process.execPath;

const INTEGRATION_BLOCK = [
  BEGIN_MARK,
  "# 由 ProfilePilot 管理（可在 App 里一键移除）：为已选择的浏览器工具",
  "# 注入统一 Session，并让对应 Gateway Wrapper 在新 Agent 会话中生效。",
  "# 用户接管/终止时 wrapper 输出稳定 hard-stop code，Profile/CDP 端口保持排他。",
  "# Claude Code 用会话 UUID（cc-）；Codex 用 thread UUID（cx-），都精确归属到会话。",
  'if [[ -n "$CLAUDE_CODE_SESSION_ID" && -z "$AGENT_BROWSER_SESSION" ]]; then',
  `  export ${EFFECTIVE_SIGNATURE}`,
  "fi",
  'if [[ -n "$CODEX_THREAD_ID" && -z "$AGENT_BROWSER_SESSION" ]]; then',
  `  export ${CODEX_SIGNATURE}`,
  "fi",
  'if [[ -n "$AGENT_BROWSER_SESSION" && -z "$PROFILEPILOT_SESSION" ]]; then',
  '  export PROFILEPILOT_SESSION="$AGENT_BROWSER_SESSION"',
  "fi",
  `export ${WRAPPER_SIGNATURE}=${shellQuote(WRAPPER_PATH)}`,
  `export ${PLAYWRIGHT_WRAPPER_SIGNATURE}=${shellQuote(PLAYWRIGHT_WRAPPER_PATH)}`,
  `export ${PLAYWRIGHT_LAUNCHER_SIGNATURE}=${shellQuote(PLAYWRIGHT_LAUNCHER_PATH)}`,
  `export ${MCP_WRAPPER_SIGNATURE}=${shellQuote(MCP_WRAPPER_PATH)}`,
  `export ${MCP_LAUNCHER_SIGNATURE}=${shellQuote(MCP_LAUNCHER_PATH)}`,
  `export ${NODE_RUNTIME_SIGNATURE}=${shellQuote(NODE_RUNTIME_PATH)}`,
  `export ${LAUNCHER_SIGNATURE}=${shellQuote(LAUNCHER_PATH)}`,
  `export ${BIN_DIR_SIGNATURE}=${shellQuote(BIN_DIR_PATH)}`,
  `export ${MANAGEMENT_CLI_SIGNATURE}=${shellQuote(MANAGEMENT_CLI_LAUNCHER_PATH)}`,
  `export ${MANAGEMENT_CLI_BIN_DIR_SIGNATURE}=${shellQuote(MANAGEMENT_CLI_BIN_DIR_PATH)}`,
  `if [[ -x "$${MANAGEMENT_CLI_SIGNATURE}" && -d "$${MANAGEMENT_CLI_BIN_DIR_SIGNATURE}" ]]; then`,
  '  case ":$PATH:" in',
  `    *":$${MANAGEMENT_CLI_BIN_DIR_SIGNATURE}:"*) ;;`,
  `    *) export PATH="$${MANAGEMENT_CLI_BIN_DIR_SIGNATURE}:$PATH" ;;`,
  "  esac",
  "fi",
  `if [[ -n "$AGENT_BROWSER_SESSION" && -d "$${BIN_DIR_SIGNATURE}" ]]; then`,
  '  case ":$PATH:" in',
  `    *":$${BIN_DIR_SIGNATURE}:"*) ;;`,
  `    *) export PATH="$${BIN_DIR_SIGNATURE}:$PATH" ;;`,
  "  esac",
  "fi",
  END_MARK
].join("\n");

export function agentBrowserWrapperPath(): string {
  return path.join(integrationHomeDir(), ".profilepilot", "bin", WRAPPER_FILE_NAME);
}

export function agentBrowserLauncherPath(): string {
  return path.join(integrationHomeDir(), ".profilepilot", "bin", LAUNCHER_FILE_NAME);
}

export function playwrightCliWrapperPath(): string {
  return path.join(integrationHomeDir(), ".profilepilot", "bin", PLAYWRIGHT_WRAPPER_FILE_NAME);
}

export function playwrightCliLauncherPath(): string {
  return path.join(integrationHomeDir(), ".profilepilot", "bin", PLAYWRIGHT_LAUNCHER_FILE_NAME);
}

export function chromeDevtoolsMcpWrapperPath(): string {
  return path.join(integrationHomeDir(), ".profilepilot", "bin", MCP_WRAPPER_FILE_NAME);
}

export function chromeDevtoolsMcpLauncherPath(): string {
  return path.join(integrationHomeDir(), ".profilepilot", "bin", MCP_LAUNCHER_FILE_NAME);
}

export function profilePilotCliBundlePath(): string {
  return path.join(integrationHomeDir(), ".profilepilot", "cli", MANAGEMENT_CLI_BUNDLE_FILE_NAME);
}

export function profilePilotCliLauncherPath(): string {
  return path.join(integrationHomeDir(), ".profilepilot", "cli-bin", MANAGEMENT_CLI_LAUNCHER_FILE_NAME);
}

export function shellIntegrationFilePath(): string {
  return process.platform === "win32"
    ? "HKCU\\Environment\\Path"
    : path.join(integrationHomeDir(), ".zshenv");
}

export async function getShellIntegrationStatus(): Promise<ShellIntegrationStatus> {
  const filePath = shellIntegrationFilePath();
  const base: ShellIntegrationStatus = {
    supported: true,
    installed: false,
    managed: false,
    path: filePath,
    error: null
  };
  if (process.platform === "win32") {
    try {
      const userPath = await readWindowsUserPath();
      const installed = windowsIntegrationPathEntries().every((entry) => windowsPathIncludes(userPath, entry));
      return { ...base, installed, managed: installed };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
  }

  let content = "";
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") {
      return base; // 文件不存在＝未安装，不算错误。
    }
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }

  return {
    ...base,
    installed: content.includes(EFFECTIVE_SIGNATURE),
    managed: content.includes(BEGIN_MARK)
  };
}

export async function inspectAgentIntegration(): Promise<AgentIntegrationDiagnostic> {
  const [shellIntegration, wrappers, skills, managementCli, inputGuard] = await Promise.all([
    getShellIntegrationStatus(),
    inspectInstalledWrappers(),
    inspectAgentSkills(integrationHomeDir()),
    inspectProfilePilotCli(),
    inspectInputGuardPermission()
  ]);
  const agentBrowserPath = resolveRealAgentBrowser(process.env, agentBrowserWrapperPath());
  const playwrightCommand = resolveRealPlaywrightCli(process.env, playwrightCliWrapperPath());
  const mcpCommand = resolveRealChromeDevtoolsMcp(process.env, chromeDevtoolsMcpWrapperPath());
  const tools: AgentToolDiagnostic[] = [
    inspectBinaryTool({
      key: "agent-browser",
      label: "agent-browser",
      executablePath: agentBrowserPath,
      installCommand: "npm install -g agent-browser && agent-browser install",
      verifyCommand: "agent-browser --version"
    }),
    inspectBinaryTool({
      key: "playwright-cli",
      label: "Playwright CLI",
      executablePath: playwrightCommand?.executable || null,
      installCommand: "npm install -g @playwright/cli@latest",
      verifyCommand: "playwright-cli --version"
    }),
    inspectBinaryTool({
      key: "chrome-devtools-mcp",
      label: "Chrome DevTools MCP",
      executablePath: mcpCommand?.executable || null,
      installCommand: "npm install -g chrome-devtools-mcp@latest",
      verifyCommand: "chrome-devtools-mcp --version"
    })
  ];

  const ready = tools.some((tool) => {
    const wrapper = wrappers.find((item) => item.key === tool.key);
    const skill = skills.find((item) => item.key === tool.key);
    return tool.availability === "installed" &&
      Boolean(wrapper?.wrapperInstalled && wrapper.launcherInstalled) &&
      Boolean(skill?.installed) &&
      shellIntegration.installed;
  });

  return {
    inspectedAt: new Date().toISOString(),
    ready,
    shellIntegration,
    wrapperDirectory: BIN_DIR_PATH,
    tools,
    wrappers,
    skills,
    managementCli,
    inputGuard
  };
}

function inspectBinaryTool(input: {
  key: AgentToolDiagnostic["key"];
  label: string;
  executablePath: string | null;
  installCommand: string;
  verifyCommand: string;
}): AgentToolDiagnostic {
  if (!input.executablePath) {
    return {
      ...input,
      availability: "missing",
      version: null,
      source: null,
      error: null
    };
  }
  try {
    const version = execPortableCommandSync(input.executablePath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3_500,
      env: process.env
    }).trim().split(/\r?\n/, 1)[0] || null;
    return {
      ...input,
      availability: "installed",
      version,
      source: "binary",
      error: null
    };
  } catch (probeError) {
    return {
      ...input,
      availability: "error",
      version: null,
      source: "binary",
      error: probeError instanceof Error ? probeError.message : String(probeError)
    };
  }
}

export async function inspectInstalledWrappers(): Promise<AgentWrapperDiagnostic[]> {
  const definitions: Array<Omit<AgentWrapperDiagnostic, "wrapperInstalled" | "launcherInstalled">> = [
    {
      key: "agent-browser",
      label: "agent-browser",
      wrapperPath: agentBrowserWrapperPath(),
      launcherPath: agentBrowserLauncherPath()
    },
    {
      key: "playwright-cli",
      label: "Playwright CLI",
      wrapperPath: playwrightCliWrapperPath(),
      launcherPath: playwrightCliLauncherPath()
    },
    {
      key: "chrome-devtools-mcp",
      label: "Chrome DevTools MCP",
      wrapperPath: chromeDevtoolsMcpWrapperPath(),
      launcherPath: chromeDevtoolsMcpLauncherPath()
    }
  ];
  return Promise.all(definitions.map(async (definition) => {
    const [wrapperInstalled, launcherInstalled] = await Promise.all([
      isExecutable(definition.wrapperPath),
      isExecutable(definition.launcherPath)
    ]);
    return { ...definition, wrapperInstalled, launcherInstalled };
  }));
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function setShellIntegrationEnabled(enabled: boolean): Promise<ShellIntegrationStatus> {
  const status = await getShellIntegrationStatus();
  if (!status.supported) {
    throw new ProfileManagerError("当前系统不支持这个 shell 集成（仅 macOS/Linux 的 zsh）。", "SHELL_INTEGRATION_UNSUPPORTED");
  }

  if (process.platform === "win32") {
    await setWindowsIntegrationPathEnabled(enabled);
    return getShellIntegrationStatus();
  }

  if (enabled) {
    let content = "";
    try {
      content = await fs.readFile(status.path, "utf8");
    } catch {
      // 文件不存在：从空内容开始。
    }

    // 托管块在但模板是旧版（缺 Codex 分支或 agent-browser wrapper）：原位升级为最新模板。
    if (
      status.managed &&
      (!content.includes(CODEX_SIGNATURE) ||
        !content.includes(WRAPPER_SIGNATURE) ||
        !content.includes(PLAYWRIGHT_WRAPPER_SIGNATURE) ||
        !content.includes(PLAYWRIGHT_LAUNCHER_SIGNATURE) ||
        !content.includes(MCP_WRAPPER_SIGNATURE) ||
        !content.includes(MCP_LAUNCHER_SIGNATURE) ||
        !content.includes("PROFILEPILOT_SESSION") ||
        !content.includes(NODE_RUNTIME_SIGNATURE) ||
        !content.includes(LAUNCHER_SIGNATURE) ||
        !content.includes(BIN_DIR_SIGNATURE) ||
        !content.includes(MANAGEMENT_CLI_SIGNATURE) ||
        !content.includes(MANAGEMENT_CLI_BIN_DIR_SIGNATURE) ||
        !content.includes(`export ${NODE_RUNTIME_SIGNATURE}=${shellQuote(NODE_RUNTIME_PATH)}`))
    ) {
      const begin = content.indexOf(BEGIN_MARK);
      const end = content.indexOf(END_MARK);
      if (begin !== -1 && end > begin) {
        const next = `${content.slice(0, begin)}${INTEGRATION_BLOCK}${content.slice(end + END_MARK.length)}`;
        await writeTextFileAtomic(status.path, next);
        return getShellIntegrationStatus();
      }
    }

    // 已生效（含用户手写的版本）就不重复写，保持幂等。
    if (status.installed) {
      return status;
    }
    const next = content ? `${content.replace(/\n*$/, "\n\n")}${INTEGRATION_BLOCK}\n` : `${INTEGRATION_BLOCK}\n`;
    await writeTextFileAtomic(status.path, next);
    return getShellIntegrationStatus();
  }

  if (!status.installed) {
    return status;
  }
  if (!status.managed) {
    throw new ProfileManagerError(
      `这段注入是手动写进 ${status.path} 的（没有本工具的托管标记），请手动编辑移除。`,
      "SHELL_INTEGRATION_NOT_MANAGED"
    );
  }
  const content = await fs.readFile(status.path, "utf8");
  const begin = content.indexOf(BEGIN_MARK);
  const end = content.indexOf(END_MARK);
  if (begin === -1 || end === -1 || end < begin) {
    throw new ProfileManagerError("托管块标记不完整，请手动检查文件。", "SHELL_INTEGRATION_MARK_BROKEN");
  }
  const next = `${content.slice(0, begin).replace(/\n+$/, "\n")}${content.slice(end + END_MARK.length).replace(/^\n+/, "\n")}`
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
  await writeTextFileAtomic(status.path, next);
  return getShellIntegrationStatus();
}

// App 升级后，已启用的 shell 集成仍会引用同一个固定路径。启动时刷新该路径，
// 避免新版本的通知协议已经生效，而当前终端继续执行旧 wrapper。
export async function refreshAgentBrowserWrapperIfInstalled(): Promise<boolean> {
  const [status, wrappers, managementCli] = await Promise.all([
    getShellIntegrationStatus(),
    inspectInstalledWrappers(),
    inspectProfilePilotCli()
  ]);
  const selected = wrappers.filter((wrapper) => wrapper.wrapperInstalled || wrapper.launcherInstalled);
  if (!status.supported || !status.installed || (!selected.length && !managementCli.installed)) {
    return false;
  }
  for (const wrapper of selected) {
    await installBrowserDriverWrapper(wrapperDefinition(wrapper.key));
  }
  if (managementCli.installed) {
    await installProfilePilotCliFiles();
  }
  if (status.managed && process.platform !== "win32") {
    await refreshManagedIntegrationBlock(status.path);
  }
  return true;
}

async function refreshManagedIntegrationBlock(filePath: string): Promise<void> {
  const content = await fs.readFile(filePath, "utf8");
  const begin = content.indexOf(BEGIN_MARK);
  const end = content.indexOf(END_MARK);
  if (begin === -1 || end <= begin) {
    return;
  }
  const currentBlock = content.slice(begin, end + END_MARK.length);
  if (currentBlock === INTEGRATION_BLOCK) {
    return;
  }
  const next = `${content.slice(0, begin)}${INTEGRATION_BLOCK}${content.slice(end + END_MARK.length)}`;
  await writeTextFileAtomic(filePath, next);
}

export async function setAgentWrapperEnabled(
  key: AgentToolDiagnostic["key"],
  enabled: boolean
): Promise<AgentIntegrationDiagnostic> {
  const definition = wrapperDefinition(key);
  if (enabled) {
    const diagnostic = await inspectAgentIntegration();
    const tool = diagnostic.tools.find((item) => item.key === key);
    if (tool?.availability !== "installed") {
      throw new ProfileManagerError(
        `请先安装并重新检测 ${definition.toolLabel}，再安装 Wrapper。`,
        "AGENT_TOOL_REQUIRED"
      );
    }
    await installBrowserDriverWrapper(definition);
    await setShellIntegrationEnabled(true);
  } else {
    await Promise.all([
      fs.rm(definition.wrapperPath, { force: true }),
      fs.rm(definition.launcherPath, { force: true })
    ]);
    const [remaining, managementCli] = await Promise.all([
      inspectInstalledWrappers(),
      inspectProfilePilotCli()
    ]);
    if (!remaining.some((wrapper) => wrapper.wrapperInstalled || wrapper.launcherInstalled) && !managementCli.installed) {
      const status = await getShellIntegrationStatus();
      if (status.installed && status.managed) {
        await setShellIntegrationEnabled(false);
      }
    }
  }
  return inspectAgentIntegration();
}

export async function inspectProfilePilotCli(): Promise<ProfilePilotCliDiagnostic> {
  const [bundleInstalled, launcherInstalled, skill] = await Promise.all([
    isExecutable(profilePilotCliBundlePath()),
    isExecutable(profilePilotCliLauncherPath()),
    inspectProfilePilotCliSkill(integrationHomeDir())
  ]);
  let upToDate = false;
  let error: string | null = null;
  if (bundleInstalled && launcherInstalled) {
    try {
      const [source, installed, launcher] = await Promise.all([
        fs.readFile(path.join(__dirname, MANAGEMENT_CLI_BUNDLE_FILE_NAME), "utf8"),
        fs.readFile(profilePilotCliBundlePath(), "utf8"),
        fs.readFile(profilePilotCliLauncherPath(), "utf8")
      ]);
      upToDate = source === installed && launcher === profilePilotCliLauncherContent();
    } catch (readError) {
      error = readError instanceof Error ? readError.message : String(readError);
    }
  }
  return {
    installed: bundleInstalled && launcherInstalled,
    bundleInstalled,
    launcherInstalled,
    upToDate,
    bundlePath: profilePilotCliBundlePath(),
    launcherPath: profilePilotCliLauncherPath(),
    skill,
    error
  };
}

export async function setProfilePilotCliEnabled(enabled: boolean): Promise<AgentIntegrationDiagnostic> {
  if (enabled) {
    await installProfilePilotCliFiles();
    await setShellIntegrationEnabled(true);
  } else {
    await Promise.all([
      fs.rm(profilePilotCliBundlePath(), { force: true }),
      fs.rm(profilePilotCliLauncherPath(), { force: true })
    ]);
    await Promise.all([
      fs.rmdir(path.dirname(profilePilotCliBundlePath())).catch(() => undefined),
      fs.rmdir(path.dirname(profilePilotCliLauncherPath())).catch(() => undefined)
    ]);
    const wrappers = await inspectInstalledWrappers();
    if (!wrappers.some((wrapper) => wrapper.wrapperInstalled || wrapper.launcherInstalled)) {
      const status = await getShellIntegrationStatus();
      if (status.installed && status.managed) {
        await setShellIntegrationEnabled(false);
      }
    }
  }
  return inspectAgentIntegration();
}

export async function setProfilePilotCliSkillEnabled(enabled: boolean): Promise<AgentIntegrationDiagnostic> {
  if (enabled) {
    const cli = await inspectProfilePilotCli();
    if (!cli.installed) {
      throw new ProfileManagerError("请先安装 ProfilePilot 管理 CLI，再安装配套 Skill。", "PROFILEPILOT_CLI_REQUIRED");
    }
  }
  await setInstalledAgentSkillEnabled("profilepilot-cli", enabled, integrationHomeDir());
  return inspectAgentIntegration();
}

export async function setAgentSkillEnabled(
  key: AgentToolDiagnostic["key"],
  enabled: boolean
): Promise<AgentIntegrationDiagnostic> {
  if (enabled) {
    const diagnostic = await inspectAgentIntegration();
    const tool = diagnostic.tools.find((item) => item.key === key);
    const wrapper = diagnostic.wrappers.find((item) => item.key === key);
    if (tool?.availability !== "installed") {
      throw new ProfileManagerError("请先安装真实工具，再安装配套 Skill。", "AGENT_TOOL_REQUIRED");
    }
    if (!wrapper?.wrapperInstalled || !wrapper.launcherInstalled) {
      throw new ProfileManagerError("请先安装这个工具的 Wrapper，再安装配套 Skill。", "AGENT_WRAPPER_REQUIRED");
    }
  }
  await setInstalledAgentSkillEnabled(key, enabled, integrationHomeDir());
  return inspectAgentIntegration();
}

function wrapperDefinition(key: AgentToolDiagnostic["key"]): {
  toolLabel: string;
  wrapperFileName: string;
  wrapperPath: string;
  launcherPath: string;
  wrapperSignature: string;
} {
  if (key === "agent-browser") {
    return {
      toolLabel: "agent-browser",
      wrapperFileName: WRAPPER_FILE_NAME,
      wrapperPath: agentBrowserWrapperPath(),
      launcherPath: agentBrowserLauncherPath(),
      wrapperSignature: WRAPPER_SIGNATURE
    };
  }
  if (key === "playwright-cli") {
    return {
      toolLabel: "Playwright CLI",
      wrapperFileName: PLAYWRIGHT_WRAPPER_FILE_NAME,
      wrapperPath: playwrightCliWrapperPath(),
      launcherPath: playwrightCliLauncherPath(),
      wrapperSignature: PLAYWRIGHT_WRAPPER_SIGNATURE
    };
  }
  if (key === "chrome-devtools-mcp") {
    return {
      toolLabel: "Chrome DevTools MCP",
      wrapperFileName: MCP_WRAPPER_FILE_NAME,
      wrapperPath: chromeDevtoolsMcpWrapperPath(),
      launcherPath: chromeDevtoolsMcpLauncherPath(),
      wrapperSignature: MCP_WRAPPER_SIGNATURE
    };
  }
  throw new ProfileManagerError(`不支持的 Agent 工具：${key}`, "AGENT_TOOL_UNSUPPORTED");
}

async function installBrowserDriverWrapper(input: {
  toolLabel: string;
  wrapperFileName: string;
  wrapperPath: string;
  launcherPath: string;
  wrapperSignature: string;
}): Promise<void> {
  const sourcePath = path.join(__dirname, input.wrapperFileName);
  let source = "";
  try {
    source = await fs.readFile(sourcePath, "utf8");
  } catch (error) {
    throw new ProfileManagerError(
      `找不到 ${input.toolLabel} wrapper 编译产物：${sourcePath}（${error instanceof Error ? error.message : String(error)}）`,
      "BROWSER_DRIVER_WRAPPER_MISSING"
    );
  }
  await writeTextFileAtomic(input.wrapperPath, source);
  await fs.chmod(input.wrapperPath, 0o755).catch(() => undefined);

  const launcher = process.platform === "win32" ? windowsBrowserLauncherContent(input) : [
    "#!/bin/sh",
    `wrapper=\${${input.wrapperSignature}:-${shellQuote(input.wrapperPath)}}`,
    `runtime=\${${NODE_RUNTIME_SIGNATURE}:-${shellQuote(NODE_RUNTIME_PATH)}}`,
    'if command -v node >/dev/null 2>&1; then',
    '  exec node "$wrapper" "$@"',
    "fi",
    'if [ -x "$runtime" ]; then',
    '  ELECTRON_RUN_AS_NODE=1 exec "$runtime" "$wrapper" "$@"',
    "fi",
    "printf '%s\\n' '[ProfilePilot] 缺少可用的 Node/Electron runtime，已拒绝绕过浏览器控制保护。' >&2",
    "exit 127",
    ""
  ].join("\n");
  await writeTextFileAtomic(input.launcherPath, launcher);
  await fs.chmod(input.launcherPath, 0o755).catch(() => undefined);
}

async function installProfilePilotCliFiles(): Promise<void> {
  const sourcePath = path.join(__dirname, MANAGEMENT_CLI_BUNDLE_FILE_NAME);
  let source = "";
  try {
    source = await fs.readFile(sourcePath, "utf8");
  } catch (error) {
    throw new ProfileManagerError(
      `找不到 ProfilePilot 管理 CLI 编译产物：${sourcePath}（${error instanceof Error ? error.message : String(error)}）`,
      "PROFILEPILOT_CLI_BUNDLE_MISSING"
    );
  }
  await writeTextFileAtomic(profilePilotCliBundlePath(), source);
  await fs.chmod(profilePilotCliBundlePath(), 0o755).catch(() => undefined);
  const launcher = profilePilotCliLauncherContent();
  await writeTextFileAtomic(profilePilotCliLauncherPath(), launcher);
  await fs.chmod(profilePilotCliLauncherPath(), 0o755).catch(() => undefined);
}

function profilePilotCliLauncherContent(): string {
  if (process.platform === "win32") {
    return windowsCliLauncherContent();
  }
  return [
    "#!/bin/sh",
    `cli=${shellQuote(profilePilotCliBundlePath())}`,
    `runtime=\${${NODE_RUNTIME_SIGNATURE}:-${shellQuote(NODE_RUNTIME_PATH)}}`,
    'if command -v node >/dev/null 2>&1; then',
    '  exec node "$cli" "$@"',
    "fi",
    'if [ -x "$runtime" ]; then',
    '  ELECTRON_RUN_AS_NODE=1 exec "$runtime" "$cli" "$@"',
    "fi",
    "printf '%s\\n' '[ProfilePilot] 缺少可用的 Node/Electron runtime，无法启动管理 CLI。' >&2",
    "exit 127",
    ""
  ].join("\n");
}

function windowsBrowserLauncherContent(input: {
  wrapperPath: string;
  wrapperSignature: string;
}): string {
  return [
    "@echo off",
    "setlocal",
    ...windowsSessionEnvironmentLines(),
    `set "wrapper=${batchValue(input.wrapperPath)}"`,
    `if defined ${input.wrapperSignature} set "wrapper=%${input.wrapperSignature}%"`,
    `set "runtime=${batchValue(NODE_RUNTIME_PATH)}"`,
    `if defined ${NODE_RUNTIME_SIGNATURE} set "runtime=%${NODE_RUNTIME_SIGNATURE}%"`,
    "where node >nul 2>nul",
    "if errorlevel 1 goto profilepilot_electron_runtime",
    "node \"%wrapper%\" %*",
    "exit /b %errorlevel%",
    ":profilepilot_electron_runtime",
    "if not exist \"%runtime%\" goto profilepilot_missing_runtime",
    "set ELECTRON_RUN_AS_NODE=1",
    "\"%runtime%\" \"%wrapper%\" %*",
    "exit /b %errorlevel%",
    ":profilepilot_missing_runtime",
    ">&2 echo [ProfilePilot] 缺少可用的 Node/Electron runtime，已拒绝绕过浏览器控制保护。",
    "exit /b 127",
    ""
  ].join("\r\n");
}

function windowsCliLauncherContent(): string {
  return [
    "@echo off",
    "setlocal",
    ...windowsSessionEnvironmentLines(),
    `set "cli=${batchValue(profilePilotCliBundlePath())}"`,
    `set "runtime=${batchValue(NODE_RUNTIME_PATH)}"`,
    `if defined ${NODE_RUNTIME_SIGNATURE} set "runtime=%${NODE_RUNTIME_SIGNATURE}%"`,
    "where node >nul 2>nul",
    "if errorlevel 1 goto profilepilot_electron_runtime",
    "node \"%cli%\" %*",
    "exit /b %errorlevel%",
    ":profilepilot_electron_runtime",
    "if not exist \"%runtime%\" goto profilepilot_missing_runtime",
    "set ELECTRON_RUN_AS_NODE=1",
    "\"%runtime%\" \"%cli%\" %*",
    "exit /b %errorlevel%",
    ":profilepilot_missing_runtime",
    ">&2 echo [ProfilePilot] 缺少可用的 Node/Electron runtime，无法启动管理 CLI。",
    "exit /b 127",
    ""
  ].join("\r\n");
}

function windowsSessionEnvironmentLines(): string[] {
  return [
    "if not defined AGENT_BROWSER_SESSION if defined CLAUDE_CODE_SESSION_ID set \"AGENT_BROWSER_SESSION=cc-%CLAUDE_CODE_SESSION_ID%\"",
    "if not defined AGENT_BROWSER_SESSION if defined CODEX_THREAD_ID set \"AGENT_BROWSER_SESSION=cx-%CODEX_THREAD_ID%\"",
    "if not defined PROFILEPILOT_SESSION if defined AGENT_BROWSER_SESSION set \"PROFILEPILOT_SESSION=%AGENT_BROWSER_SESSION%\""
  ];
}

async function readWindowsUserPath(): Promise<string> {
  if (Object.prototype.hasOwnProperty.call(process.env, "PROFILEPILOT_TEST_WINDOWS_USER_PATH")) {
    return process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH || "";
  }
  return (await runWindowsPowerShell(
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable('Path','User')",
    { timeout: 5_000 }
  )).trim();
}

async function setWindowsIntegrationPathEnabled(enabled: boolean): Promise<void> {
  const current = await readWindowsUserPath();
  const managedEntries = windowsIntegrationPathEntries();
  const remaining = current
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !managedEntries.some((managed) => sameWindowsPath(entry, managed)));
  const nextEntries = enabled ? [...managedEntries, ...remaining] : remaining;
  const next = nextEntries.join(";");
  if (Object.prototype.hasOwnProperty.call(process.env, "PROFILEPILOT_TEST_WINDOWS_USER_PATH")) {
    process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH = next;
  } else {
    const encoded = Buffer.from(next, "utf8").toString("base64");
    await runWindowsPowerShell([
      `$value=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
      "[Environment]::SetEnvironmentVariable('Path',$value,'User')",
      "Add-Type -Namespace ProfilePilot -Name EnvironmentBroadcast -MemberDefinition '[DllImport(\"user32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'",
      "$result=[UIntPtr]::Zero",
      "[void][ProfilePilot.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff,0x001A,[UIntPtr]::Zero,'Environment',2,2000,[ref]$result)"
    ].join("; "), { timeout: 8_000 });
  }
  const processPath = process.env.PATH || "";
  const processRemaining = processPath
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => !managedEntries.some((managed) => sameWindowsPath(entry, managed)));
  process.env.PATH = (enabled ? [...managedEntries, ...processRemaining] : processRemaining).join(path.delimiter);
}

function windowsIntegrationPathEntries(): string[] {
  return [BIN_DIR_PATH, MANAGEMENT_CLI_BIN_DIR_PATH];
}

function windowsPathIncludes(pathValue: string, candidate: string): boolean {
  return pathValue.split(";").some((entry) => sameWindowsPath(entry, candidate));
}

function sameWindowsPath(left: string, right: string): boolean {
  const normalize = (value: string) => path.win32.normalize(value.trim().replace(/^"|"$/g, "")).replace(/[\\/]+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function batchValue(value: string): string {
  return value.replace(/%/g, "%%").replace(/"/g, '""');
}

function launcherFileName(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function integrationHomeDir(): string {
  return process.env.HOME || os.homedir();
}

async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.profilepilot-tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
