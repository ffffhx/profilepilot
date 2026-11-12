import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DefaultTargetStore } from "./default-targets";
import { defaultDataDir } from "./fs-util";
import { runAgentBrowserWrapper, sessionFromAgentBrowserArgs } from "./agent-browser-wrapper";
import { bundledBrowserExecutable } from "./tasks/browser-runtime";
import { main as runExtensionCli, nativeControlError, nativeControlHelp } from "./native-control/cli";
import { runCaptchaCli } from "./captcha/cli";
import { engineHelp } from "./browser-engine/arguments";
import { controlRecovery } from "../shared/control-recovery";
import { createBrowserDoctor, parseBrowserDoctorArgs, waitForBrowserControl } from "./control-doctor";
import { browserContract, commonBrowserHelp } from "../shared/browser-contract";
import { browserCommandHelp, browserRouteCommands } from "../shared/browser-command-contract";
import { listSiteAdapters } from "./site-adapters/catalog";
import { runGatewaySiteCli } from "./site-adapters/gateway-cli";
import { runXianyuCli } from "./site-adapters/xianyu-cli";

export const browserCliHelp = `ppilot browser CLI (model invocation only for captcha recognize)
One CLI, two connections. Connection options go BEFORE the command.

Profile management (desktop app required):
  ppilot browser default [--json]          Read saved default without starting the App
  ppilot browser profile default [NAME|ID|--clear] [--json]
  ppilot browser profile list [--json]
  ppilot browser profile get <NAME|ID> [--json]
  ppilot browser profile create --name NAME [--json]
  ppilot browser profile rename <NAME|ID> NEW_NAME [--json]
  ppilot browser profile configure <NAME|ID> --hide-automation <on|off> [--json]
  ppilot browser profile start <NAME|ID> [--json]
  ppilot browser profile stop <NAME|ID> [--json]
  ppilot browser profile delete <NAME|ID> --yes [--json]
  Legacy ppilot profile commands remain supported.

Electron applications have their own entry: ppilot electron --help.
The existing browser --cdp entry remains compatible for registered apps.

Site adapters (selected Profile and current task tab; read only):
  ppilot browser sites [SITE]
  ppilot browser --session TASK site --params-file request.json
  ppilot browser --session TASK --cdp PORT site --params-file request.json
  request.json: {"operation":"zhihu.hot","params":{"limit":10}}

Xianyu search, comparison and price tracking:
  ppilot browser xianyu --help

Extension (default): existing signed-in Chrome tabs, independent browser service.
  ppilot browser status
  ppilot browser --profile native:Default doctor
  ppilot browser --profile native:Default --session TASK wait-control --timeout 30000
  ppilot browser --profile native:Default tabs
  ppilot browser --connection extension --help

Gateway: managed Chrome / registered Electron, using the bundled browser driver.
Use the target's ProfilePilot logical port, never its native debugging port.
  ppilot browser --session TASK --cdp PORT snapshot -i
  ppilot browser --session TASK --cdp PORT open https://example.com
  ppilot browser --session TASK --cdp PORT click '@e3'
  ppilot browser --session TASK --cdp PORT status
  ppilot browser --session TASK --cdp PORT handoff --reason "Complete sign-in"
  ppilot browser --session TASK --cdp PORT resume
  ppilot browser --session TASK --cdp PORT complete
  ppilot browser --connection gateway profiles
  ppilot browser --connection gateway --help

CAPTCHA: paid 2Captcha token service or Codex image recognition:
  ppilot browser captcha --help
  ppilot browser --session TASK --profile native:Default captcha solve
  ppilot browser --session TASK --cdp PORT captcha solve
  ppilot browser captcha recognize --image-file challenge.png --kind text

--cdp selects Gateway; otherwise use --connection extension|gateway explicitly.
Session can also come from the Agent host. Keep the same session for a task.
No separate agent-browser or Wrapper installation is needed. Legacy commands
remain compatible. A takeover/conflict never triggers a switch to another route.
`;

const VALUE_OPTIONS = new Set([
  "--session", "--profile", "--root", "--request-id", "--output", "--params", "--params-file",
  "--tab", "--cdp-session", "--timeout", "--format", "--log-level", "--target", "--controller", "--task"
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
      } else if (arg === "--no-auto-dialog" && ["true", "false"].includes(input[index + 1])) {
        args.push(input[++index]);
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
  runtime: { extension?: typeof runExtensionCli; gateway?: typeof runAgentBrowserWrapper; executable?: () => string; captcha?: typeof runCaptchaCli } = {}
): Promise<number> {
  try {
    const route = parseBrowserCliRoute(input);
    let command = route.args[route.commandIndex];
    const tail = route.args.slice(route.commandIndex + 1);
    const narrowHelp = command === "help" && tail.length === 1 ? tail[0]
      : tail.length === 1 && ["--help", "-h"].includes(tail[0]) ? command : undefined;
    if (narrowHelp && !["xianyu", "captcha", "site", "sites"].includes(command)) {
      const help = browserCommandHelp(route.connection, narrowHelp);
      if (!help) invalid(`${route.connection} 连接没有 ${narrowHelp} 的命令说明；运行 ppilot browser --connection ${route.connection} schema 查看可用命令。`);
      io.stdout.write(help); return 0;
    }
    if (command === "default") {
      if (tail.some(arg => arg !== "--json")) invalid("用法：ppilot browser default [--json]。设置默认 Profile 请使用浏览器页面或 profile default。");
      io.stdout.write(JSON.stringify({ ok: true, result: { saved: new DefaultTargetStore(env.CPM_DATA_DIR || defaultDataDir()).profile() } }) + "\n");
      return 0;
    }
    if (command === "xianyu") return await runXianyuCli(route, io, env);
    if (command === "sites") {
      const sites = tail.filter(arg => arg !== "--json");
      if (sites.length > 1) invalid("sites 只接受一个可选网站名。");
      io.stdout.write(JSON.stringify({ ok: true, result: listSiteAdapters(sites[0]) }) + "\n"); return 0;
    }
    if (command === "site" && route.connection === "gateway") {
      const result = await runGatewaySiteCli(route.args, route.commandIndex, route.port, env);
      io.stdout.write(JSON.stringify({ ok: true, result }) + "\n"); return 0;
    }
    if (command === "captcha") return await (runtime.captcha || runCaptchaCli)(route, io, env);
    if (!input.length || route.help || command === "help" || command === "--help" || command === "-h") {
      io.stdout.write(browserCliHelp + "\n" + commonBrowserHelp);
      if (route.connection === "extension") io.stdout.write(`\n${nativeControlHelp}`);
      else io.stdout.write(`${engineHelp}\nAdditional: profiles, use NAME, readiness, cdp, extension, device, bifrost.\n`);
      return 0;
    }
    if (["capabilities", "schema"].includes(command)) {
      const requested = tail.filter(arg => arg !== "--json");
      if (requested.length > 1 || (requested[0] && !browserRouteCommands(route.connection)[requested[0]])) invalid(`用法：ppilot browser --connection ${route.connection} schema [COMMAND]。可用命令：${Object.keys(browserRouteCommands(route.connection)).join(", ")}`);
      io.stdout.write(JSON.stringify({ ok: true, result: { ...browserContract, connection: route.connection,
        ...(requested[0] ? { command: requested[0], operation: browserRouteCommands(route.connection)[requested[0]] } : { routeOperations: browserRouteCommands(route.connection) }),
        runtimeVerified: false, nextStep: "运行目标 doctor/readiness 检查实际可用性。" } }) + "\n"); return 0;
    }
    if (route.connection === "extension" && ["doctor", "readiness", "wait-control"].includes(command)) {
      const options = parseBrowserDoctorArgs(route.args);
      const result = command === "wait-control" ? await waitForBrowserControl(options) : await createBrowserDoctor(options);
      io.stdout.write(JSON.stringify({ ok: true, result }) + "\n"); return 0;
    }
    if (route.connection === "extension") { await (runtime.extension || runExtensionCli)(route.args); return 0; }
    if (command === "doctor") { route.args[route.commandIndex] = command = "readiness"; }
    if (!command && !route.args.includes("--version") && !route.args.includes("-V")) invalid("需要浏览器命令；运行 ppilot browser --help 查看用法。");
    // A trailing output switch is harmless for fixed-arity commands. Preserve
    // literal fill/eval values and option values that happen to be '--json'.
    const arity: Record<string, number> = { status: 0, readiness: 0, complete: 0, release: 0, resume: 0, handoff: 0, profiles: 0,
      observe: 0, action: 0, snapshot: 0, screenshot: 0, open: 1, click: 1, hover: 1, fill: 2, type: 2, eval: 1,
      get: tail[0] === "attr" ? 3 : ["title", "url"].includes(tail[0]) ? 1 : 2 };
    if (tail.at(-1) === "--json" && arity[command] !== undefined && tail.length > arity[command] &&
        !new Set([...VALUE_OPTIONS, "--reason", "--selector", "-s", "-d"]).has(tail.at(-2) || "")) {
      route.args.pop(); route.args.splice(route.commandIndex, 0, "--json"); route.commandIndex++;
    }
    if (["click", "dblclick", "hover", "focus", "fill", "type", "check", "uncheck", "select", "upload", "scrollintoview"].includes(command) &&
        (!tail[0]?.trim() || tail[0] === "--json")) invalid(`${command} 需要非空 selector。PowerShell 中 @e1 会被当作变量展开，请写 '@e1'；例如 ppilot browser --session TASK --cdp PORT ${command} '@e1'${["fill", "type"].includes(command) ? " '文本'" : ""}。`);
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
      ? { code, message: (error as Error).message, exitCode: 64, recovery: controlRecovery(code) }
      : nativeControlError(error);
    const { message, exitCode: _exitCode, ...details } = failure;
    io.stderr.write(`${JSON.stringify({ ok: false, ...details, error: message })}\n`);
    return failure.exitCode;
  }
}
