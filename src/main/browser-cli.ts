import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { runAgentBrowserWrapper, sessionFromAgentBrowserArgs } from "./agent-browser-wrapper";
import { bundledBrowserExecutable } from "./tasks/browser-runtime";
import { main as runExtensionCli, nativeControlError, nativeControlHelp } from "./native-control/cli";

export const browserCliHelp = `ppilot browser CLI (no model invocation)
One CLI, two connections. Connection options go BEFORE the command.

Extension (default): existing signed-in Chrome tabs, independent browser service.
  ppilot browser status
  ppilot browser --profile native:Default tabs
  ppilot browser --connection extension --help

Gateway: managed Chrome / registered Electron, using the bundled browser driver.
Use the target's ProfilePilot logical port, never its native debugging port.
  ppilot browser --session TASK --cdp PORT snapshot -i
  ppilot browser --session TASK --cdp PORT open https://example.com
  ppilot browser --session TASK --cdp PORT click @e3
  ppilot browser --session TASK --cdp PORT status
  ppilot browser --session TASK --cdp PORT handoff --reason "Complete sign-in"
  ppilot browser --session TASK --cdp PORT resume
  ppilot browser --session TASK --cdp PORT complete
  ppilot browser --connection gateway profiles
  ppilot browser --connection gateway --help

--cdp selects Gateway; otherwise use --connection extension|gateway explicitly.
Session can also come from the Agent host. Keep the same session for a task.
No separate agent-browser or Wrapper installation is needed. Legacy commands
remain compatible. A takeover/conflict never triggers a switch to another route.
`;

const VALUE_OPTIONS = new Set([
  "--session", "--profile", "--root", "--request-id", "--output", "--params", "--params-file",
  "--tab", "--cdp-session", "--timeout", "--format", "--log-level", "--target"
]);
const INTERNAL_COMMANDS = new Set(["use", "profiles", "readiness", "status", "handoff", "wait-control", "resume", "complete", "release", "close", "cdp", "extension", "device", "bifrost"]);
const LOCAL_COMMANDS = new Set(["help", "version", "skills"]);

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "BROWSER_CLI_INVALID_ARGUMENTS" });
}

// Only routing options before the verb belong to us. Text, JS, JSON and URLs
// after the verb are opaque driver arguments, even when they look like flags.
export function parseBrowserCliRoute(input: string[]): { connection: "extension" | "gateway"; args: string[]; commandIndex: number; port?: number; help: boolean; explicit: boolean } {
  const args: string[] = [];
  let connection: "extension" | "gateway" | undefined;
  let port: number | undefined;
  let help = false;
  let index = 0;
  for (; index < input.length; index++) {
    const arg = input[index];
    if (!arg.startsWith("-") || arg === "--") break;
    const name = arg.split("=", 1)[0];
    if (name === "--connection" || name === "--cdp") {
      const value = arg.includes("=") ? arg.slice(name.length + 1) : input[++index];
      if (!value || value.startsWith("-")) invalid(`${name} 需要参数。`);
      if (name === "--connection") {
        if (connection || !["extension", "gateway"].includes(value)) invalid("--connection 只能指定一次：extension 或 gateway。");
        connection = value as "extension" | "gateway";
      } else {
        if (port !== undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) invalid("--cdp 需要一个 ProfilePilot 逻辑端口（1–65535）。");
        port = Number(value);
        args.push("--cdp", value);
      }
    } else {
      args.push(arg);
      if (name === "--help" || name === "-h") help = true;
      if (VALUE_OPTIONS.has(name) && !arg.includes("=")) {
        const value = input[++index];
        if (!value || value.startsWith("--")) invalid(`${name} 需要参数。`);
        args.push(value);
      }
    }
  }
  if (connection === "extension" && port !== undefined) invalid("扩展连接不能使用 --cdp；请指定一种连接方式。");
  const commandIndex = args.length;
  args.push(...input.slice(index));
  return { connection: connection || (port === undefined ? "extension" : "gateway"), args, commandIndex, port, help, explicit: Boolean(connection || port !== undefined) };
}

export function browserCliRuntime(bundleDir = __dirname): string {
  const manifest = path.join(bundleDir, "browser-runtime.json");
  if (existsSync(manifest)) {
    const { executable } = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof executable === "string" && path.isAbsolute(executable) && existsSync(executable)) return executable;
    throw new Error("内置浏览器驱动缺失，请在 ProfilePilot 中更新 / 重装 CLI。");
  }
  return bundledBrowserExecutable();
}

export async function runBrowserCli(
  input: string[], io: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
  env: NodeJS.ProcessEnv = process.env,
  runtime: { extension?: typeof runExtensionCli; gateway?: typeof runAgentBrowserWrapper; executable?: () => string } = {}
): Promise<number> {
  try {
    const route = parseBrowserCliRoute(input);
    const command = route.args[route.commandIndex];
    if (!input.length || route.help || command === "help" || command === "--help" || command === "-h") {
      io.stdout.write(browserCliHelp);
      if (route.connection === "extension") io.stdout.write(`\n${nativeControlHelp}`);
      else io.stdout.write("Gateway verbs: open, snapshot, click, fill, eval, screenshot, tab, get, wait…\nLifecycle: status, handoff, wait-control, resume, complete, release.\nAdditional: profiles, use NAME, readiness, cdp, extension, device, bifrost.\nDriver command reference: ppilot browser --connection gateway skills get core\n");
      return 0;
    }
    if (route.connection === "extension") { await (runtime.extension || runExtensionCli)(route.args); return 0; }
    if (!command && !route.args.includes("--version") && !route.args.includes("-V")) invalid("需要浏览器命令；运行 ppilot browser --help 查看用法。");
    if (route.args.slice(0, route.commandIndex).some(arg => arg === "--profile" || arg.startsWith("--profile="))) invalid("Gateway 使用 --cdp 选择目标；--profile 用于扩展连接。");
    const internal = INTERNAL_COMMANDS.has(command);
    const local = LOCAL_COMMANDS.has(command) || !command && route.args.some(arg => arg === "--version" || arg === "-V");
    if (!internal && !local && route.port === undefined) invalid("Gateway 页面操作需要在命令前指定 --cdp 逻辑端口。");
    if (["install", "upgrade", "auth", "session", "sessions", "doctor", "completion", "completions", "profilepilot"].includes(command)) invalid("请使用 ppilot browser --help 中的命令；驱动由 ProfilePilot 统一管理。");
    const gatewayEnv: NodeJS.ProcessEnv = { ...env, PROFILEPILOT_BROWSER_CLI: "1" };
    gatewayEnv.AGENT_BROWSER_SESSION ||= env.PROFILEPILOT_SESSION || (env.CODEX_THREAD_ID ? `cx-${env.CODEX_THREAD_ID}` : env.CLAUDE_CODE_SESSION_ID ? `cc-${env.CLAUDE_CODE_SESSION_ID}` : undefined);
    if (!local && command !== "profiles" && !sessionFromAgentBrowserArgs(route.args, gatewayEnv)) invalid("请用 --session TASK 指定本次任务的会话，并在后续命令中保持一致。");
    // Lifecycle status/end still work when a driver needs repair.
    if (!internal || ["use", "cdp", "device", "extension"].includes(command)) {
      gatewayEnv.PROFILEPILOT_AGENT_BROWSER_REAL = (runtime.executable || browserCliRuntime)();
    }
    const args = [...route.args];
    if (internal) args.splice(route.commandIndex, 0, "profilepilot");
    return await (runtime.gateway || runAgentBrowserWrapper)(args, gatewayEnv);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    const failure = code === "BROWSER_CLI_INVALID_ARGUMENTS"
      ? { code, message: (error as Error).message, exitCode: 64 }
      : nativeControlError(error);
    io.stderr.write(`${JSON.stringify({ ok: false, code: failure.code, error: failure.message })}\n`);
    return failure.exitCode;
  }
}
