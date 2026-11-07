import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBrowserCliRoute, runBrowserCli } from "./browser-cli";
import { browserGatewayRoot } from "./browser-gateway-client";
import { engineHelp } from "./browser-engine/arguments";
import { electronRegistrationSchema, electronConfigurationSchema, type LocalAppManagementCommand } from "./local-apps/management";
import type { ProfilePilotManagementResponse } from "./profilepilot-management-protocol";
import { commandGuidance, handleControlCliDiscovery, type ControlCliCommands } from './control-cli-contract';
import { z } from 'zod';
import { electronRouting } from './control-routing';

export const electronCommands: ControlCliCommands = {
  list: { summary: '列出已接入应用；--all 查询全部登记及实际状态', options: ['--json', '--all'], example: ['list', '--all'] },
  inspect: { summary: '只读检查实际应用身份、连接和占用', options: ['--json', '--session'], example: ['inspect', 'NAME_OR_ID_FROM_LIST'], notes: ['名称不唯一时使用 list --all 的真实 ID；--session 只用于判断本任务的控制权。'] },
  doctor: { summary: 'inspect 的只读诊断别名', options: ['--json', '--session'], example: ['doctor', 'NAME_OR_ID_FROM_LIST'] },
  connect: { summary: '准备已登记应用连接，不取得其他任务的控制权', options: ['--json', '--confirmation-token'], example: ['connect', 'NAME_OR_ID_FROM_LIST'], notes: ['重启仅接受上次返回且获用户授权的确认令牌；结果未知时先 inspect。'] },
  configure: { summary: '通过受支持入口修正已登记应用启动路径', options: ['--json', '--params-file'], required: ['--params-file'], example: ['configure', 'NAME_OR_ID_FROM_LIST', '--params-file', './connection.json'], input: { ...z.toJSONSchema(electronConfigurationSchema, { io: 'input' }), minProperties: 1 }, notes: ['使用本机实际路径；原生端口和 Agent 逻辑端口不能混用。'] },
  register: { summary: '登记此前未接入的 Electron 应用；不启动、不连接、不控制', options: ['--json', '--params-file'], required: ['--params-file'], example: ['register', '--params-file', './electron.json'],
    input: z.toJSONSchema(electronRegistrationSchema, { io: 'input' }),
    notes: ['端口必须从实际启动配置/本机发现确认且互不冲突，不能复制示例端口。launch 需本机已有 cwd 和启动命令；attach 连接用户指定的已有调试入口。', '名称已存在时拒绝新增；使用 inspect/configure 保留已有登记和会话。'] }
};

interface ElectronTarget { id: string; name: string; port: number }

export function listElectronTargets(homeDir = os.homedir()): ElectronTarget[] {
  let catalog;
  try { catalog = JSON.parse(readFileSync(path.join(browserGatewayRoot(homeDir), "managed-profiles.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (!Array.isArray(catalog.profiles)) throw new Error("应用连接登记无法读取，请在 ProfilePilot 的本地应用中检查连接。");
  return catalog.profiles.filter((entry: Record<string, unknown>) =>
    typeof entry?.profileId === "string" && entry.profileId.startsWith("local-app:") &&
    typeof entry.profileName === "string" && validPort(entry.publicPort) && validPort(entry.electronCdpPort)
  ).map((entry: { profileId: string; profileName: string; publicPort: number }) => ({
    id: entry.profileId, name: entry.profileName, port: entry.publicPort
  }));
}

function validPort(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}

export const electronCliHelp = `ppilot electron · Electron 应用控制

  ppilot electron list [--json]                         查询已接入 Gateway 的应用与 Agent 端口
  ppilot electron list --all [--json]                   查询全部登记及实时连接状态
  ppilot electron inspect NAME_OR_ID [--json]           检查应用进程、调试连接和控制权
  ppilot electron doctor NAME_OR_ID [--session TASK]    按当前任务判断可用性
  ppilot electron register --params-file FILE          登记新目标，不启动或连接
  ppilot electron schema [COMMAND]                     查询命令参数与最小示例
  ppilot electron connect NAME_OR_ID [--json]           连接已有应用；已停止时按登记启动
      [--confirmation-token TOKEN]                     使用本次返回的重启确认，不强制退出
  ppilot electron configure NAME_OR_ID --params-file FILE  修正启动路径；JSON 字段 command/cwd
  ppilot electron --session TASK --cdp PORT snapshot -i  读取应用窗口
  ppilot electron --session TASK --cdp PORT click @e1     点击控件
  ppilot electron --session TASK --cdp PORT screenshot   截图
  ppilot electron --session TASK --cdp PORT tab list     查询应用页面
  ppilot electron --session TASK --cdp PORT status       检查控制权
  ppilot electron --session TASK --cdp PORT handoff      交给用户操作
  ppilot electron --session TASK --cdp PORT complete     完成会话

先用 list --all 核对登记；未登记可用 register，之后 connect；PORT 是 Agent 逻辑端口。
connect 复用应用的连接流程；restart-required 返回确认令牌，未经授权不自动重启。
连接超时先 inspect 核查结果，不重复提交；管理命令不接管或恢复其他 Agent 会话。
只连接 Electron 应用，不接受浏览器 Profile、浏览器扩展连接或原始调试端口。
页面读取、点击、输入与截图复用浏览器引擎；菜单栏、托盘和系统对话框不属于页面控制范围。
Gateway 限制新建和关闭应用窗口。接管、暂停、冲突及会话结束规则与浏览器一致。
连接参数放在命令前；后续命令保持同一 --session 和 --cdp。

`;

export async function runElectronCli(
  input: string[], io: Pick<NodeJS.Process, "stdout" | "stderr"> = process,
  env: NodeJS.ProcessEnv = process.env,
  runtime: { targets?: () => ElectronTarget[]; browser?: typeof runBrowserCli;
    request?: (command: LocalAppManagementCommand) => Promise<ProfilePilotManagementResponse> } = {}
): Promise<number> {
  try {
    const schemaTarget = ['schema', 'capabilities', 'help'].includes(input[0]) ? input[1] : input[0];
    if (schemaTarget && Object.hasOwn(electronCommands, schemaTarget) && handleControlCliDiscovery('electron', input, electronCommands, io)) return 0;
    if (['schema', 'capabilities'].includes(input[0]) && (!input[1] || input[1] === '--json')) {
      if (handleControlCliDiscovery('electron', input, electronCommands, io)) return 0;
    }
    if (!input.includes("--help") && !input.includes("-h") &&
      (["inspect", "doctor", "connect", "configure", "register"].includes(input[0]) || input[0] === "list" && input.includes("--all"))) {
      const sessionIndex = input.indexOf('--session');
      const session = sessionIndex >= 0 ? input[sessionIndex + 1] : undefined;
      const command = parseManagementArgs(input);
      if (!runtime.request) throw new Error("本地应用管理入口不可用，请通过 ppilot electron 运行。");
      try {
        const response = await runtime.request(command);
        if (!response.ok) {
          io.stderr.write(JSON.stringify({ ok: false, ...response.error, ...(response.error.code === 'LOCAL_APP_NOT_FOUND' ? { routing: electronRouting() } : {}), guidance: commandGuidance('electron', input[0], electronCommands) }) + "\n");
          return 1;
        }
        const result = response.data as { status?: string; app?: unknown; apps?: unknown[] };
        io.stdout.write(JSON.stringify({ ok: true, result, ...(result.app ? { routing: electronRouting(result.app, session) } : {}),
          ...(result.apps ? { targets: result.apps.map(app => ({ app, routing: electronRouting(app, session) })) } : {}) }, null, 2) + "\n");
        return result.status === "restart-required" ? 75 : 0;
      } catch (error) {
        io.stderr.write(JSON.stringify({ ok: false, code: "LOCAL_APP_MANAGEMENT_UNAVAILABLE",
          error: error instanceof Error ? error.message : String(error),
          recovery: "请检查 ProfilePilot 状态；connect 结果未知时先 inspect，不自动重放。" }) + "\n");
        return 69;
      }
    }
    const route = parseBrowserCliRoute(input);
    const command = route.args[route.commandIndex];
    // Common page commands use the browser contract, including its narrow
    // schema/help. This local branch never probes or attaches the target.
    const tail = route.args.slice(route.commandIndex);
    if (['schema', 'capabilities'].includes(command) || command && !Object.hasOwn(electronCommands, command) && (tail.includes('--help') || command === 'help' && tail.length > 1)) {
      const stdout = Object.create(io.stdout) as NodeJS.Process['stdout'];
      stdout.write = ((value: any) => io.stdout.write(String(value).replaceAll('ppilot browser', 'ppilot electron'))) as typeof stdout.write;
      const proxy = { stdout, stderr: io.stderr };
      return (runtime.browser || runBrowserCli)(['--connection', 'gateway', ...route.args], proxy, env);
    }
    if (!input.length || route.help || ["help", "--help", "-h"].includes(command)) {
      io.stdout.write(electronCliHelp + engineHelp.replaceAll("ppilot browser", "ppilot electron") + "\n");
      return 0;
    }
    const prefix = route.args.slice(0, route.commandIndex);
    if (route.connection === "extension" && route.explicit || prefix.some(arg => arg === "--profile" || arg.startsWith("--profile="))) {
      throw new Error("Electron 使用 Gateway；请用 --cdp 指定应用的 Agent 逻辑端口。");
    }
    if (["profiles", "use", "connect", "disconnect", "close", "extension", "device", "bifrost", "profile"].includes(command)) {
      throw new Error("此命令属于浏览器管理；Electron 应用请用 list 查询目标，再用 --cdp 指定应用，结束任务用 complete 或 release。");
    }
    const targets = () => (runtime.targets || (() => listElectronTargets(env.HOME || os.homedir())))();
    if (command === "list") {
      if (route.port !== undefined || route.args.some((arg, index) => index !== route.commandIndex && arg !== "--json")) {
        throw new Error("用法：ppilot electron list [--json]");
      }
      io.stdout.write(JSON.stringify({ ok: true, apps: targets(), nextCommand: commandGuidance('electron', 'list', electronCommands),
        note: '此列表只含已接入目标；空列表请用 list --all 核对登记。未登记可使用 register。' }, null, 2) + "\n");
      return 0;
    }
    const local = ["capabilities", "schema", "version"].includes(command) || !command && prefix.some(arg => ["--version", "-V"].includes(arg));
    if (!local && (route.port === undefined || !targets().some(target => target.port === route.port))) {
      throw new Error("请用 ppilot electron list 查询已接入应用，并在命令前用 --cdp 指定其中的 Agent 逻辑端口。");
    }
    return await (runtime.browser || runBrowserCli)(["--connection", "gateway", ...route.args], io, env);
  } catch (error) {
    io.stderr.write(JSON.stringify({ ok: false, code: "ELECTRON_CLI_INVALID_ARGUMENTS", error: error instanceof Error ? error.message : String(error), guidance: commandGuidance('electron', input[0], electronCommands) }) + "\n");
    return 64;
  }
}

function parseManagementArgs(args: string[]): LocalAppManagementCommand {
  const [verb, ...rest] = args;
  const method = verb === 'doctor' ? 'inspect' : verb;
  const values: string[] = [];
  let confirmationToken: string | undefined;
  let paramsFile: string | undefined;
  let json = false, all = false;
  let session: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json" && !json) { json = true; continue; }
    if (arg === "--all" && method === "list" && !all) { all = true; continue; }
    if (arg === '--session' && method === 'inspect' && !session) {
      session = rest[++i];
      if (!session || !/^[A-Za-z0-9._:-]{1,100}$/.test(session)) throw new Error('--session 需要有效的任务名称。');
      continue;
    }
    if (arg === "--params-file" && ['configure', 'register'].includes(method) && !paramsFile) {
      paramsFile = rest[++i];
      if (!paramsFile || paramsFile.startsWith("--")) throw new Error("--params-file 需要 UTF-8 JSON 文件路径。");
      continue;
    }
    if (arg === "--confirmation-token" && method === "connect" && !confirmationToken) {
      confirmationToken = rest[++i];
      if (!confirmationToken || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(confirmationToken))
        throw new Error("--confirmation-token 需要 connect 返回的有效确认令牌。");
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`本地应用管理不支持参数 ${arg}。`);
    values.push(arg);
  }
  if (method === "list" && all && !values.length) return { action: "local-app", method: "list" };
  if (method === 'register' && !values.length && paramsFile) {
    const input = electronRegistrationSchema.parse(JSON.parse(readFileSync(paramsFile, 'utf8').replace(/^\uFEFF/, '')));
    return { action: 'local-app', method: 'register', input };
  }
  if (method === "configure" && values.length === 1 && values[0].trim() && paramsFile) {
    const input: unknown = JSON.parse(readFileSync(paramsFile, "utf8").replace(/^\uFEFF/, ""));
    return { action: 'local-app', method: 'configure', selector: values[0], input: electronConfigurationSchema.parse(input) };
  }
  if ((method === "connect" || method === "inspect") && values.length === 1 && values[0].trim())
    return { action: "local-app", method, selector: values[0], ...(confirmationToken ? { confirmationToken } : {}) };
  throw new Error("用法：ppilot electron list --all | inspect NAME_OR_ID | connect NAME_OR_ID [--confirmation-token TOKEN]");
}
