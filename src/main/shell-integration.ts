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
import { bundledBrowserExecutable } from "./tasks/browser-runtime";
import { profilePilotSetupState } from "../shared/profilepilot-setup";
import {
  inspectAgentSkills,
  inspectProfilePilotCliSkill,
  setAgentSkillEnabled as setInstalledAgentSkillEnabled
} from "./agent-skill-integration";
import { inspectInputGuardPermission } from "./input-guard-companion";
import { ProfileManagerError } from "./profile-manager-error";
import { execPortableCommand } from "./portable-command";
import { runWindowsPowerShell } from "./windows-platform";
import { browserServiceLaunchInfo } from './browser-service/launcher';

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
const NODE_RUNTIME_SIGNATURE = "PROFILEPILOT_NODE_RUNTIME";
const LAUNCHER_SIGNATURE = "PROFILEPILOT_AGENT_BROWSER_LAUNCHER";
const BIN_DIR_SIGNATURE = "PROFILEPILOT_AGENT_BROWSER_BIN_DIR";
const MANAGEMENT_CLI_BUNDLE_FILE_NAME = "profilepilot-cli.cjs";
const MANAGEMENT_CLI_LAUNCHER_FILE_NAME = launcherFileName("ppilot");
const MANAGEMENT_CLI_SIGNATURE = "PROFILEPILOT_MANAGEMENT_CLI";
const MANAGEMENT_CLI_BIN_DIR_SIGNATURE = "PROFILEPILOT_MANAGEMENT_CLI_BIN_DIR";
// 生效特征：只要这行 export 在（无论是托管块还是用户手写的），注入就是开着的。
const EFFECTIVE_SIGNATURE = 'AGENT_BROWSER_SESSION="cc-$CLAUDE_CODE_SESSION_ID"';
// Codex 分支的特征行：托管块缺它说明是旧版模板（CODEX_CLI_PATH 检测或目录名身份），
// 重新启用时原位升级。
const CODEX_SIGNATURE = 'AGENT_BROWSER_SESSION="cx-$CODEX_THREAD_ID"';
const WRAPPER_PATH = agentBrowserWrapperPath();
const LAUNCHER_PATH = agentBrowserLauncherPath();
const BIN_DIR_PATH = path.dirname(LAUNCHER_PATH);
const MANAGEMENT_CLI_LAUNCHER_PATH = profilePilotCliLauncherPath();
const MANAGEMENT_CLI_BIN_DIR_PATH = path.dirname(MANAGEMENT_CLI_LAUNCHER_PATH);
const NODE_RUNTIME_PATH = process.execPath;

const INTEGRATION_BLOCK = [
  BEGIN_MARK,
  "# 由 ProfilePilot 管理（可在 App 里一键移除）：为 agent-browser",
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

export function profilePilotCliBundlePath(): string {
  return path.join(integrationHomeDir(), ".profilepilot", "cli", MANAGEMENT_CLI_BUNDLE_FILE_NAME);
}

export function profilePilotCliLauncherPath(): string {
  return path.join(integrationHomeDir(), ".profilepilot", "cli-bin", MANAGEMENT_CLI_LAUNCHER_FILE_NAME);
}

function profilePilotPowerShellLauncherPaths(): string[] {
  return process.platform === "win32" ? ["ppilot.ps1", "profilepilot.ps1"].map(name => path.join(path.dirname(profilePilotCliLauncherPath()), name)) : [];
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
      return { ...base, installed, managed: installed, warning: windowsPathWarning };
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
  const tools: AgentToolDiagnostic[] = await Promise.all([
    inspectBinaryTool({
      key: "agent-browser",
      label: "ProfilePilot TypeScript 浏览器引擎",
      executablePath: agentBrowserPath,
      installCommand: "在 ProfilePilot 中更新 / 重装 CLI",
      verifyCommand: "ppilot browser --connection gateway --version"
    })
  ]);

  const ready = profilePilotSetupState({ managementCli, shellIntegration, skills }).ready;

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

async function inspectBinaryTool(input: {
  key: AgentToolDiagnostic["key"];
  label: string;
  executablePath: string | null;
  installCommand: string;
  verifyCommand: string;
}): Promise<AgentToolDiagnostic> {
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
    const version = (await execPortableCommand(input.executablePath, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3_500,
      env: process.env
    })).trim().split(/\r?\n/, 1)[0] || null;
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

    // Refresh the whole managed block, including removal of obsolete exports.
    if (status.managed && !content.includes(INTEGRATION_BLOCK)) {
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
  const retired = await removeRetiredBrowserWrappers();
  const [status, wrappers, managementCli] = await Promise.all([
    getShellIntegrationStatus(),
    inspectInstalledWrappers(),
    inspectProfilePilotCli()
  ]);
  const selected = wrappers.filter((wrapper) => wrapper.wrapperInstalled || wrapper.launcherInstalled);
  if (!status.supported || !status.installed) {
    return retired;
  }
  if (status.managed && process.platform !== "win32") {
    await refreshManagedIntegrationBlock(status.path);
  }
  if (!selected.length && !managementCli.bundleInstalled) {
    return retired;
  }
  for (const wrapper of selected) {
    await installBrowserDriverWrapper(wrapperDefinition(wrapper.key));
  }
  if (managementCli.bundleInstalled) {
    await setProfilePilotCliEnabled(true);
  }
  return true;
}

async function removeRetiredBrowserWrappers(): Promise<boolean> {
  let removed = false;
  const directory = path.dirname(agentBrowserWrapperPath());
  // Upgrade cleanup only: remove our old bundles and launchers, including files
  // copied between Windows and macOS. Preserve custom scripts and symlinks.
  for (const driver of ["playwright-cli", "chrome-devtools-mcp"]) {
    const signature = `PROFILEPILOT_${driver.replaceAll("-", "_").toUpperCase()}`;
    const bundle = `profilepilot-${driver}-wrapper.cjs`;
    for (const name of [driver, `${driver}.cmd`, bundle]) {
      const filePath = path.join(directory, name);
      try {
        if (!(await fs.lstat(filePath)).isFile()) continue;
        const content = await fs.readFile(filePath, "utf8");
        const managed = name === bundle
          ? content.includes(`${signature}_HARD_STOP_EXIT_CODE`)
          : content.includes(`${signature}_WRAPPER`) && content.includes(bundle);
        if (managed) {
          await fs.rm(filePath, { force: true });
          removed = true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return removed;
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
      const sourceManifest = await fs.readFile(path.join(__dirname, "control-build.json"), "utf8").catch(() => "");
      const installedManifest = await fs.readFile(path.join(path.dirname(profilePilotCliBundlePath()), "control-build.json"), "utf8").catch(() => "");
      upToDate = sourceManifest === installedManifest && upToDate;
      const browserRuntime = JSON.parse(await fs.readFile(path.join(path.dirname(profilePilotCliBundlePath()), "browser-runtime.json"), "utf8"));
      upToDate = browserRuntime.executable === bundledBrowserExecutable() && upToDate;
      for (const file of profilePilotPowerShellLauncherPaths()) {
        upToDate = (await fs.readFile(file, "utf8").catch(() => "")) === windowsPowerShellCliLauncherContent() && upToDate;
      }
    } catch (readError) {
      upToDate = false;
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

const cliSetupMutations = new Map<string, Promise<unknown>>();

export async function setProfilePilotCliEnabled(enabled: boolean): Promise<AgentIntegrationDiagnostic> {
  const key = path.resolve(integrationHomeDir());
  const operation = (cliSetupMutations.get(key) || Promise.resolve()).catch(() => {}).then(() => updateProfilePilotCli(enabled));
  cliSetupMutations.set(key, operation);
  try { return await operation; }
  finally { if (cliSetupMutations.get(key) === operation) cliSetupMutations.delete(key); }
}

async function updateProfilePilotCli(enabled: boolean): Promise<AgentIntegrationDiagnostic> {
  if (enabled) {
    await installProfilePilotCliFiles();
    await setShellIntegrationEnabled(true);
    await setInstalledAgentSkillEnabled("profilepilot", true, integrationHomeDir());
  } else {
    // The Skill installer archives only our own files and retains local/.
    await setInstalledAgentSkillEnabled("profilepilot", false, integrationHomeDir());
    await Promise.all([
      fs.rm(profilePilotCliBundlePath(), { force: true }),
      fs.rm(path.join(path.dirname(profilePilotCliBundlePath()), "control-build.json"), { force: true }),
      fs.rm(path.join(path.dirname(profilePilotCliBundlePath()), "app-launch.json"), { force: true }),
      fs.rm(path.join(path.dirname(profilePilotCliBundlePath()), "browser-service-launch.json"), { force: true }),
      fs.rm(path.join(path.dirname(profilePilotCliBundlePath()), "browser-runtime.json"), { force: true }),
      fs.rm(profilePilotCliLauncherPath(), { force: true }),
      fs.rm(path.join(path.dirname(profilePilotCliLauncherPath()), launcherFileName("profilepilot")), { force: true }),
      ...profilePilotPowerShellLauncherPaths().map(file => fs.rm(file, { force: true }))
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
  // Previous UI versions still use this IPC; migrate them to the same setup.
  return setProfilePilotCliEnabled(enabled);
}

export async function setAgentSkillEnabled(
  key: AgentToolDiagnostic["key"],
  enabled: boolean
): Promise<AgentIntegrationDiagnostic> {
  // Compatibility for old per-tool IPC. Instructions have no CLI prerequisite.
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
  throw new ProfileManagerError(`不支持的 Agent 工具：${key}`, "AGENT_TOOL_UNSUPPORTED");
}

async function installBrowserDriverWrapper(input: {
  toolLabel: string;
  wrapperFileName: string;
  wrapperPath: string;
  launcherPath: string;
  wrapperSignature: string;
}): Promise<void> {
  const browserExecutable = bundledBrowserExecutable();
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
  await writeTextFileAtomic(path.join(path.dirname(input.wrapperPath), "browser-runtime.json"), JSON.stringify({ executable: browserExecutable }));

  const launcher = process.platform === "win32" ? windowsBrowserLauncherContent(input) : [
    "#!/bin/sh",
    `wrapper=\${${input.wrapperSignature}:-${shellQuote(input.wrapperPath)}}`,
    `runtime=\${${NODE_RUNTIME_SIGNATURE}:-${shellQuote(NODE_RUNTIME_PATH)}}`,
    'if command -v node >/dev/null 2>&1 && node -e \'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)\' >/dev/null 2>&1; then',
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
  // Resolve before writing any CLI files. The same TypeScript engine ships on
  // Windows and macOS; it uses the installed Node/Electron runtime.
  const browserExecutable = bundledBrowserExecutable();
  const sourcePath = path.join(__dirname, MANAGEMENT_CLI_BUNDLE_FILE_NAME);
  let source = "";
  try {
    source = await fs.readFile(sourcePath, "utf8");
  } catch (error) {
    throw new ProfileManagerError(
      `找不到 ProfilePilot CLI 编译产物：${sourcePath}（${error instanceof Error ? error.message : String(error)}）`,
      "PROFILEPILOT_CLI_BUNDLE_MISSING"
    );
  }
  await writeTextFileAtomic(profilePilotCliBundlePath(), source);
  const buildManifestPath = path.join(__dirname, "control-build.json");
  const installedManifestPath = path.join(path.dirname(profilePilotCliBundlePath()), "control-build.json");
  try { await writeTextFileAtomic(installedManifestPath, await fs.readFile(buildManifestPath, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.rm(installedManifestPath, { force: true });
  }
  await fs.chmod(profilePilotCliBundlePath(), 0o755).catch(() => undefined);
  await writeTextFileAtomic(path.join(path.dirname(profilePilotCliBundlePath()), "browser-runtime.json"), JSON.stringify({ executable: browserExecutable }));
  // The ADB wrapper is opt-in per phone task. Keep it out of global PATH;
  // phone wrap prepends this directory only for the launched process tree.
  const phoneBin = path.join(path.dirname(profilePilotCliBundlePath()), "phone-bin");
  const phoneLauncherName = process.platform === "win32" ? "adb.exe" : "adb";
  const phoneLauncher = path.join(phoneBin, phoneLauncherName);
  const phoneLauncherBytes = await fs.readFile(path.join(__dirname, "phone-bin", phoneLauncherName));
  await fs.mkdir(phoneBin, { recursive: true });
  const previousPhoneLauncher = await fs.readFile(phoneLauncher).catch(() => null);
  if (!previousPhoneLauncher?.equals(phoneLauncherBytes)) {
    const temporaryPhoneLauncher = `${phoneLauncher}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPhoneLauncher, phoneLauncherBytes, { mode: 0o755 });
    await fs.rename(temporaryPhoneLauncher, phoneLauncher);
  }
  if (process.platform !== "win32") await fs.chmod(phoneLauncher, 0o755);
  const launcher = profilePilotCliLauncherContent();
  await writeTextFileAtomic(profilePilotCliLauncherPath(), launcher);
  await fs.chmod(profilePilotCliLauncherPath(), 0o755).catch(() => undefined);
  // Existing scripts can keep using the previous name during the migration.
  const legacyLauncher = path.join(path.dirname(profilePilotCliLauncherPath()), launcherFileName("profilepilot"));
  await writeTextFileAtomic(legacyLauncher, launcher);
  await fs.chmod(legacyLauncher, 0o755).catch(() => undefined);
  for (const file of profilePilotPowerShellLauncherPaths()) {
    await writeTextFileAtomic(file, windowsPowerShellCliLauncherContent());
  }
  // The terminal can start its shared service without asking the user to open
  // the desktop first. Store paths, never credentials, beside the CLI bundle.
  const projectRoot = path.resolve(__dirname, "../..");
  const packaged = projectRoot.includes(".asar");
  const executable = packaged ? process.execPath : path.join(projectRoot, "node_modules", "electron", "dist",
    process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : process.platform === "win32" ? "electron.exe" : "electron");
  await writeTextFileAtomic(path.join(path.dirname(profilePilotCliBundlePath()), "app-launch.json"), JSON.stringify({
    executable, args: packaged ? ["--background"] : [projectRoot, "--background"],
    cwd: packaged ? path.dirname(process.execPath) : projectRoot
  }));
  await writeTextFileAtomic(path.join(path.dirname(profilePilotCliBundlePath()), 'browser-service-launch.json'), JSON.stringify(browserServiceLaunchInfo(projectRoot)));
}

function profilePilotCliLauncherContent(): string {
  if (process.platform === "win32") {
    return windowsCliLauncherContent();
  }
  return [
    "#!/bin/sh",
    `cli=${shellQuote(profilePilotCliBundlePath())}`,
    `runtime=\${${NODE_RUNTIME_SIGNATURE}:-${shellQuote(NODE_RUNTIME_PATH)}}`,
    'if command -v node >/dev/null 2>&1 && node -e \'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)\' >/dev/null 2>&1; then',
    '  exec node "$cli" "$@"',
    "fi",
    'if [ -x "$runtime" ]; then',
    '  ELECTRON_RUN_AS_NODE=1 exec "$runtime" "$cli" "$@"',
    "fi",
    "printf '%s\\n' '[ProfilePilot] 缺少可用的 Node/Electron runtime，无法启动 ProfilePilot CLI。' >&2",
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
    "node -e \"process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)\" >nul 2>nul",
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
    "node -e \"process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)\" >nul 2>nul",
    "if errorlevel 1 goto profilepilot_electron_runtime",
    "node \"%cli%\" %*",
    "exit /b %errorlevel%",
    ":profilepilot_electron_runtime",
    "if not exist \"%runtime%\" goto profilepilot_missing_runtime",
    "set ELECTRON_RUN_AS_NODE=1",
    "\"%runtime%\" \"%cli%\" %*",
    "exit /b %errorlevel%",
    ":profilepilot_missing_runtime",
    ">&2 echo [ProfilePilot] 缺少可用的 Node/Electron runtime，无法启动 ProfilePilot CLI。",
    "exit /b 127",
    ""
  ].join("\r\n");
}

/** PowerShell discovers .ps1 before .cmd. Keep its arguments out of cmd.exe. */
export function windowsPowerShellCliLauncherContent(cliPath = profilePilotCliBundlePath(), runtimePath = NODE_RUNTIME_PATH): string {
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  return [
    // Windows PowerShell 5.1 otherwise reads non-ASCII installation paths as ANSI.
    "\uFEFF# ProfilePilot PowerShell entry; environment changes stay within this invocation.",
    "$ProgressPreference = 'SilentlyContinue'",
    `$ppilotCli = ${quote(cliPath)}`,
    `$ppilotRuntime = ${quote(runtimePath)}`,
    "$ppilotEnvironment = @{}",
    "foreach ($name in @('AGENT_BROWSER_SESSION', 'PROFILEPILOT_SESSION', 'ELECTRON_RUN_AS_NODE', 'PROFILEPILOT_LAUNCHER_ARGV')) { $ppilotEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }",
    "$ppilotExit = 1",
    "try {",
    "  if (-not $env:AGENT_BROWSER_SESSION -and $env:CLAUDE_CODE_SESSION_ID) { $env:AGENT_BROWSER_SESSION = 'cc-' + $env:CLAUDE_CODE_SESSION_ID }",
    "  if (-not $env:AGENT_BROWSER_SESSION -and $env:CODEX_THREAD_ID) { $env:AGENT_BROWSER_SESSION = 'cx-' + $env:CODEX_THREAD_ID }",
    "  if (-not $env:PROFILEPILOT_SESSION -and $env:AGENT_BROWSER_SESSION) { $env:PROFILEPILOT_SESSION = $env:AGENT_BROWSER_SESSION }",
    "  if ($env:PROFILEPILOT_NODE_RUNTIME) { $ppilotRuntime = $env:PROFILEPILOT_NODE_RUNTIME }",
    "  $ppilotNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
    "  if ($ppilotNode) { $ppilotNodeVersion = & $ppilotNode.Source --version; if ($ppilotNodeVersion -notmatch '^v(\\d+)\\.' -or [int]$Matches[1] -lt 22) { $ppilotNode = $null } }",
    "  if ($ppilotNode) { $ppilotRuntime = $ppilotNode.Source }",
    "  elseif (Test-Path -LiteralPath $ppilotRuntime -PathType Leaf) { $env:ELECTRON_RUN_AS_NODE = '1' }",
    "  else { [Console]::Error.WriteLine('[ProfilePilot] Node/Electron runtime unavailable.'); exit 127 }",
    // Legacy PowerShell cannot reliably encode arbitrary native argv. Base64
    // carries the string array without a shell parser or a temporary secrets file.
    "  $ppilotJson = ConvertTo-Json -InputObject ([string[]]$args) -Compress",
    "  $env:PROFILEPILOT_LAUNCHER_ARGV = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($ppilotJson))",
    "  if ($MyInvocation.ExpectingInput) {",
    "    $OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "    $input | & $ppilotRuntime $ppilotCli --profilepilot-argv-env",
    "  } else { & $ppilotRuntime $ppilotCli --profilepilot-argv-env }",
    "  $ppilotExit = $LASTEXITCODE",
    "} finally {",
    "  foreach ($name in $ppilotEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $ppilotEnvironment[$name], 'Process') }",
    "}",
    "exit $ppilotExit",
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

let windowsPathWarning: string | null = null;

function windowsPathFailure(summary: string, code: string, error: unknown): ProfileManagerError {
  const failure = error as { message?: string; stderr?: string; code?: string | number; killed?: boolean; signal?: string } | null;
  // Electron only transports Error.message. Preserve diagnostics without
  // execFile's command or the encoded user PATH, keeping the summary first.
  const detail = String(failure?.stderr || (failure?.message?.startsWith("Command failed:") ? "" : failure?.message) || "系统未返回错误详情。")
    .replace(/FromBase64String\('[A-Za-z0-9+/=]*'\)/g, "FromBase64String('[PATH 已省略]')");
  return new ProfileManagerError([
    summary, "", `错误代码：${code}`, `系统：${process.platform} ${os.release()}`,
    `退出码：${failure?.code ?? "未返回"}；超时 / 终止：${failure?.killed ? "是" : "否"}；信号：${failure?.signal || "无"}`,
    detail.trim()
  ].join("\n"), code);
}

async function readWindowsUserPath(): Promise<string> {
  if (Object.prototype.hasOwnProperty.call(process.env, "PROFILEPILOT_TEST_WINDOWS_USER_PATH")) {
    return process.env.PROFILEPILOT_TEST_WINDOWS_USER_PATH || "";
  }
  try {
    return await runWindowsPowerShell([
      "$ErrorActionPreference='Stop'",
      "$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
      "try { if ($key) { [Console]::Out.Write([string]$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) } } finally { if ($key) { $key.Dispose() } }"
    ].join("; "), { timeout: 5_000 });
  } catch (error) {
    throw windowsPathFailure("无法读取 Windows 用户 PATH，请稍后重试检查 / 更新。", "WINDOWS_USER_PATH_READ_FAILED", error);
  }
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
  } else if (next !== current) {
    const encoded = Buffer.from(next, "utf8").toString("base64");
    try {
      // .NET's SetEnvironmentVariable(User) broadcasts synchronously after
      // saving. A busy window can outlast our timeout even when the write worked.
      // Persist and verify first, preserving literal %VARIABLE% entries and type.
      await runWindowsPowerShell([
        "$ErrorActionPreference='Stop'",
        `$value=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`,
        "$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
        "try { $kind=[Microsoft.Win32.RegistryValueKind]::ExpandString; if ($key.GetValueNames() -contains 'Path') { $kind=$key.GetValueKind('Path') }; $key.SetValue('Path',$value,$kind); if ([string]$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) -cne $value) { throw 'PATH verification failed' } } finally { $key.Dispose() }"
      ].join("; "), { timeout: 5_000 });
    } catch (error) {
      // A terminated PowerShell may already have written the value. Reconcile
      // actual state before reporting failure or updating this process's PATH.
      let saved: string;
      try { saved = await readWindowsUserPath(); }
      catch (verificationError) {
        const failure = windowsPathFailure("无法确认 Windows 用户 PATH 是否已保存，请重新检查 / 更新。", "WINDOWS_USER_PATH_VERIFY_FAILED", error);
        failure.message += `\n\n回读结果：${verificationError instanceof Error ? verificationError.message : String(verificationError)}`;
        throw failure;
      }
      if (saved !== next) {
        throw windowsPathFailure("无法保存 Windows 用户 PATH，CLI 更新尚未完成。请稍后重试检查 / 更新。", "WINDOWS_USER_PATH_WRITE_FAILED", error);
      }
    }
    // Notify other windows separately. Their response is best-effort and must
    // not turn a verified installation into an error or expose the full PATH.
    windowsPathWarning = null;
    await runWindowsPowerShell([
      "$ErrorActionPreference='Stop'",
      "Add-Type -Namespace ProfilePilot -Name EnvironmentBroadcast -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern void SetLastError(uint error); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint flags, uint timeout, out System.UIntPtr result);'",
      "$result=[UIntPtr]::Zero",
      "[ProfilePilot.EnvironmentBroadcast]::SetLastError(0)",
      "$sent=[ProfilePilot.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]0xffff,0x001A,[UIntPtr]::Zero,'Environment',2,100,[ref]$result)",
      "if ($sent -eq [IntPtr]::Zero) { throw ('Environment notification failed (Win32 error {0})' -f [Runtime.InteropServices.Marshal]::GetLastWin32Error()) }"
    ].join("; "), { timeout: 3_000 }).catch((error) => {
      windowsPathWarning = windowsPathFailure("Windows 用户 PATH 已保存，但环境变更通知未完成。请重新打开终端；若仍未生效，请注销并重新登录 Windows。", "WINDOWS_ENVIRONMENT_NOTIFY_FAILED", error).message;
      console.warn(`[shell-integration] ${windowsPathWarning}`);
    });
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
