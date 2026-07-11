import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ShellIntegrationStatus } from "../shared/types";
import { ProfileManagerError } from "./profile-manager-error";

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
const WRAPPER_SIGNATURE = "PROFILEPILOT_AGENT_BROWSER_WRAPPER";
const NODE_RUNTIME_SIGNATURE = "PROFILEPILOT_NODE_RUNTIME";
// 生效特征：只要这行 export 在（无论是托管块还是用户手写的），注入就是开着的。
const EFFECTIVE_SIGNATURE = 'AGENT_BROWSER_SESSION="cc-$CLAUDE_CODE_SESSION_ID"';
// Codex 分支的特征行：托管块缺它说明是旧版模板（CODEX_CLI_PATH 检测或目录名身份），
// 重新启用时原位升级。
const CODEX_SIGNATURE = 'AGENT_BROWSER_SESSION="cx-$CODEX_THREAD_ID"';
const WRAPPER_PATH = agentBrowserWrapperPath();
const NODE_RUNTIME_PATH = process.execPath;

const INTEGRATION_BLOCK = [
  BEGIN_MARK,
  "# 由 ProfilePilot 管理（可在 App 里一键移除）：AI agent 会话里自动为 agent-browser",
  "# 注入独立 session——防多会话互抢标签页，并让驱动连接可归属到会话。",
  "# 同时为 agent-browser 加一层薄 wrapper：用户接管/终止时，把 ProfilePilot notice",
  "# 转成稳定 hard-stop code；同时按 Profile/CDP 端口加 Session 排他租约。",
  "# Claude Code 用会话 UUID（cc-）；Codex 用 thread UUID（cx-），都精确归属到会话。",
  'if [[ -n "$CLAUDE_CODE_SESSION_ID" && -z "$AGENT_BROWSER_SESSION" ]]; then',
  `  export ${EFFECTIVE_SIGNATURE}`,
  "fi",
  'if [[ -n "$CODEX_THREAD_ID" && -z "$AGENT_BROWSER_SESSION" ]]; then',
  `  export ${CODEX_SIGNATURE}`,
  "fi",
  `export ${WRAPPER_SIGNATURE}=${shellQuote(WRAPPER_PATH)}`,
  `export ${NODE_RUNTIME_SIGNATURE}=${shellQuote(NODE_RUNTIME_PATH)}`,
  `if [[ -n "$AGENT_BROWSER_SESSION" && -r "$${WRAPPER_SIGNATURE}" ]]; then`,
  "  agent-browser() {",
  "    if command -v node >/dev/null 2>&1; then",
  `      command node "$${WRAPPER_SIGNATURE}" "$@"`,
  `    elif [[ -x "$${NODE_RUNTIME_SIGNATURE}" ]]; then`,
  `      ELECTRON_RUN_AS_NODE=1 command "$${NODE_RUNTIME_SIGNATURE}" "$${WRAPPER_SIGNATURE}" "$@"`,
  "    else",
  "      print -u2 '[ProfilePilot] 缺少可用的 Node/Electron runtime，已拒绝绕过浏览器控制保护。'",
  "      return 127",
  "    fi",
  "  }",
  "fi",
  END_MARK
].join("\n");

export function agentBrowserWrapperPath(): string {
  return path.join(os.homedir(), ".profilepilot", "bin", WRAPPER_FILE_NAME);
}

export function shellIntegrationFilePath(): string {
  return path.join(os.homedir(), ".zshenv");
}

export async function getShellIntegrationStatus(): Promise<ShellIntegrationStatus> {
  const filePath = shellIntegrationFilePath();
  const base: ShellIntegrationStatus = {
    supported: process.platform !== "win32",
    installed: false,
    managed: false,
    path: filePath,
    error: null
  };
  if (!base.supported) {
    return base;
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

export async function setShellIntegrationEnabled(enabled: boolean): Promise<ShellIntegrationStatus> {
  const status = await getShellIntegrationStatus();
  if (!status.supported) {
    throw new ProfileManagerError("当前系统不支持这个 shell 集成（仅 macOS/Linux 的 zsh）。", "SHELL_INTEGRATION_UNSUPPORTED");
  }

  if (enabled) {
    await installAgentBrowserWrapper();
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
        !content.includes(NODE_RUNTIME_SIGNATURE) ||
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
  const status = await getShellIntegrationStatus();
  if (!status.supported || !status.installed) {
    return false;
  }
  await installAgentBrowserWrapper();
  if (status.managed) {
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

async function installAgentBrowserWrapper(): Promise<void> {
  const sourcePath = path.join(__dirname, WRAPPER_FILE_NAME);
  let source = "";
  try {
    source = await fs.readFile(sourcePath, "utf8");
  } catch (error) {
    throw new ProfileManagerError(
      `找不到 agent-browser wrapper 编译产物：${sourcePath}（${error instanceof Error ? error.message : String(error)}）`,
      "AGENT_BROWSER_WRAPPER_MISSING"
    );
  }
  const targetPath = agentBrowserWrapperPath();
  await writeTextFileAtomic(targetPath, source);
  await fs.chmod(targetPath, 0o755).catch(() => undefined);
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
