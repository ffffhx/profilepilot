import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PhoneAction, PhoneActionResult, PhoneDevice, PhonesSnapshot } from "../../shared/phones";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { adbCommand } from "./adb-command";
import { streamAdb } from "./adb-cli-stream";

type Request = (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>;
type IO = Pick<NodeJS.Process, "stdout" | "stderr">;
function fail(message: string): never { throw new Error(message); }
export const adbHelp = `ppilot phone CLI · ADB 兼容命令
用法：ppilot phone wrap --device <ID> --controller <名称> --task <任务> [--mode view|control] [--backend app|basic] -- <程序> [参数...]
命令：ppilot phone adb <ADB兼容命令...>
子进程可照常执行 adb，也可使用环境变量 ADB 指向的可执行文件。
支持 shell/exec-in/exec-out、push/pull/sync、install/install-multiple/install-multi-package/uninstall、
logcat/bugreport/jdwp/track-jdwp/track-app、forward/reverse、完整 input、get-state/get-serialno/get-devpath/features、
wait-for-*、reboot/root/unroot/remount/verity/sideload/usb/tcpip/reconnect/attach/detach、emu。
常用 UI 操作与原始 PNG 截图继续通过手机 App 执行；其他命令由桌面托管 ADB 进程。
支持 -s <ID>、-t <transport ID>、-d（USB）、-e（TCP/IP/模拟器），只能选本任务设备。
--output <新文件> 保存二进制输出，--input <文件> 提供二进制 stdin，--timeout-ms <100..3600000> 设置时限。
默认 120 秒。view 仅允许已识别的查询；任意 Shell、stdin、设备写入和未知语法需要 control。
forward/reverse 使用 --no-rebind，只能移除本任务的映射；暂停/结束时清理，不会移除配套 App 通道。
主机 version/host-features/server-status/mdns/start-server/kill-server/keygen 用 phone host；无线连接用 wireless-*。
手机暂停会停止本地进程；结束或失联后任务失效，不自动重试或恢复。退出码 75 表示需核对结果。
中止不能撤销已完成的写入，也不能保证结束已脱离连接的手机后台进程。明确使用 --backend basic 时由桌面管理会话。
`;

export type ParsedAdb = { serial?: string; transportId?: string; transport?: "usb" | "local"; output?: string; input?: string; timeoutMs?: number } & (
  | { kind: "help" | "version" | "state" | "serial" }
  | { kind: "devices"; long: boolean }
  | { kind: "action"; action: PhoneAction }
  | { kind: "command"; args: string[]; mode: "view" | "control" }
);
export function parseAdb(args: string[]): ParsedAdb {
  const input = [...args]; let serial: string | undefined, transportId: string | undefined, transport: "usb" | "local" | undefined, output: string | undefined, stdinFile: string | undefined, timeoutMs: number | undefined;
  while (input[0]?.startsWith("-")) {
    const flag = input.shift();
    if (flag === "--help" || flag === "-h") { if (input.length) fail("help 不接受额外参数。"); return { kind: "help" }; }
    if (flag === "--version") { if (input.length) fail("version 不接受额外参数。"); return { kind: "version" }; }
    if (flag === "-s" && !serial && !transport && !transportId) { serial = input.shift(); if (!serial || serial.startsWith("-")) fail("-s 需要设备 ID。"); }
    else if (flag === "-t" && !serial && !transport && !transportId) { transportId = input.shift(); if (!/^[1-9]\d*$/.test(transportId || "")) fail("-t 需要 transport ID。"); }
    else if ((flag === "-d" || flag === "-e") && !serial && !transport && !transportId) transport = flag === "-d" ? "usb" : "local";
    else if (flag === "--output" && !output) { output = input.shift(); if (!output) fail("--output 需要本地文件路径。"); }
    else if (flag === "--input" && !stdinFile) { stdinFile = input.shift(); if (!stdinFile) fail("--input 需要本地文件路径。"); }
    else if (flag === "--timeout-ms" && timeoutMs === undefined) { const value = input.shift(); timeoutMs = Number(value); if (!/^\d+$/.test(value || "") || timeoutMs < 100 || timeoutMs > 3600000) fail("超时须为 100–3600000 毫秒。"); }
    else fail(`不支持的 ADB 选项：${flag}。不会转交原生 ADB。`);
  }
  const [command, ...tail] = input;
  const selected = { serial, transport, output, ...(transportId ? { transportId } : {}), ...(stdinFile ? { input: stdinFile } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
  if ((output || stdinFile || timeoutMs) && ["devices", "help", "version", "get-state", "get-serialno"].includes(command)) fail("此查询不接受输入/输出文件或超时参数。");
  if (command === "devices" && (tail.length === 0 || tail.length === 1 && tail[0] === "-l")) return { ...selected, kind: "devices", long: tail.length === 1 };
  if (["help", "version", "get-state", "get-serialno"].includes(command) && !tail.length) return { ...selected, kind: ({ help: "help", version: "version", "get-state": "state", "get-serialno": "serial" } as const)[command as "help"] };
  const native = () => { const checked = adbCommand(input); return { ...selected, kind: "command" as const, args: checked.args, mode: checked.mode }; };
  if (!["shell", "exec-out"].includes(command) || stdinFile) return native();
  // Only a fixed grammar of literal numeric input is accepted. No shell is
  // launched; metacharacters, nested sh, redirections and scripts cannot pass.
  const words = tail.length === 1 ? tail[0].trim().split(/\s+/) : tail;
  if (words.join(" ") === "screencap -p") return { ...selected, kind: "action", action: { kind: "screenshot", format: "png" } };
  if (command !== "shell" || words[0] !== "input" || output) return native();
  const actionWords = words.slice(1);
  if (actionWords[0] === "touchscreen") actionWords.shift();
  const [operation, ...values] = actionWords;
  const integer = (value: string, min = 0, max = 20000): number => {
    if (!/^\d+$/.test(value || "")) fail("坐标和时长必须是整数。");
    const number = Number(value); if (number < min || number > max) fail("坐标或时长超出支持范围。"); return number;
  };
  if (operation === "tap" && values.length === 2) return { ...selected, kind: "action", action: { kind: "tap", x: integer(values[0]), y: integer(values[1]) } };
  if (operation === "swipe" && [4, 5].includes(values.length)) return { ...selected, kind: "action", action: { kind: "swipe", x: integer(values[0]), y: integer(values[1]), toX: integer(values[2]), toY: integer(values[3]), duration: values[4] ? integer(values[4], 50, 2000) : 300 } };
  const keys: Record<string, "home" | "back" | "recents"> = { "3": "home", "4": "back", "187": "recents", HOME: "home", BACK: "back", APP_SWITCH: "recents", KEYCODE_HOME: "home", KEYCODE_BACK: "back", KEYCODE_APP_SWITCH: "recents" };
  if (operation === "keyevent" && values.length === 1 && keys[values[0]]) return { ...selected, kind: "action", action: { kind: "key", key: keys[values[0]] } };
  return native();
}
async function call<T>(request: Request, method: string, params: unknown = {}): Promise<T> {
  const response = await request({ action: "phone", method, params });
  if (!response.ok) throw new Error(response.error?.message || "ProfilePilot 拒绝了手机请求。");
  return response.data as T;
}
function selectDevice(parsed: ParsedAdb, device: PhoneDevice): void {
  if (parsed.transportId && parsed.transportId !== device.transportId) fail("ADB transport ID 与托管设备不符。");
  if (parsed.serial && parsed.serial !== device.id || parsed.transport === "usb" && device.transport !== "usb" || parsed.transport === "local" && !["wifi", "emulator"].includes(device.transport)) fail("ADB 目标与托管任务的手机不同，已拒绝跨设备操作。");
}
export async function runAdbCli(args: string[], request: Request, io: IO = process, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const parsed = parseAdb(args);
    if (parsed.kind === "help") { io.stdout.write(adbHelp); return 0; }
    if (parsed.kind === "version") { io.stdout.write("ppilot phone CLI · ADB compatibility v2 (managed commands)\n"); return 0; }
    const lease = env.PROFILEPILOT_PHONE_LEASE;
    if (parsed.kind === "devices") {
      const devices = lease ? [await call<PhoneDevice>(request, "wrapper-state", { lease })] : (await call<PhonesSnapshot>(request, "list")).devices;
      io.stdout.write("List of devices attached\n");
      for (const d of devices.filter(d => d.connection !== "missing")) {
        io.stdout.write(`${d.id}\t${d.connection}${parsed.long ? ` model:${d.model.replace(/\s/g, "_")}` : ""}\n`);
      }
      io.stdout.write("\n"); return 0;
    }
    if (!lease) fail("请通过 ppilot phone wrap 启动工具，以建立手机可见、可暂停的 ADB 会话。");
    const device = await call<PhoneDevice>(request, "wrapper-state", { lease }); selectDevice(parsed, device);
    if (parsed.kind === "serial") { io.stdout.write(device.id + "\n"); return 0; }
    if (parsed.kind === "state") { io.stdout.write(device.connection === "device" ? "device\n" : "offline\n"); return 0; }
    const state = device.state;
    if (!state || !["viewing", "controlling"].includes(state.phase)) fail("手机已暂停、结束或断开，ADB 指令未执行。恢复后请发出新指令，不能重放旧输入。");
    if (parsed.kind === "command") {
      const stdin = !!parsed.input || parsed.args[0] === "exec-in" || parsed.args[0] === "shell" && (parsed.args.length === 1 || parsed.args.includes("-tt"));
      if ((parsed.mode === "control" || stdin) && state.mode !== "control") fail("此 ADB 命令需要 control 会话。");
      return await streamAdb(parsed.args, lease, state.generation, request, io, { output: parsed.output, input: parsed.input, timeoutMs: parsed.timeoutMs, stdin });
    }
    if (parsed.kind !== "action") fail("不支持此 ADB 命令。");
    const response = await call<PhoneActionResult>(request, "wrapper-action", { lease, generation: state.generation, requestId: randomUUID(), action: parsed.action });
    if (parsed.action.kind === "screenshot") {
      const result = response.result as { mime?: string; base64?: string; width?: number; height?: number };
      if (result?.mime !== "image/png" || typeof result.base64 !== "string") fail("手机尚不支持原始 PNG 截图，请在手机工作区更新配套 App。");
      const png = Buffer.from(result.base64, "base64");
      if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.readUInt32BE(16) !== result.width || png.readUInt32BE(20) !== result.height) fail("手机返回的 PNG 尺寸或格式无效。");
      if (parsed.output) await fs.writeFile(parsed.output, png); else io.stdout.write(png);
    }
    return 0;
  } catch (error) { io.stderr.write(`[ppilot phone CLI] ${(error as Error).message}\n`); return 1; }
}

export function parsePhoneWrap(args: string[]) {
  let separator = args.indexOf("--"), commandOffset = 1;
  if (separator < 0) {
    // Windows PowerShell consumes a bare -- when invoking the .ps1 CLI
    // launcher. The first positional program still unambiguously ends our flags.
    separator = 0; commandOffset = 0;
    while (separator + 1 < args.length && ["--device", "--controller", "--task", "--mode", "--backend"].includes(args[separator])) separator += 2;
  }
  if (separator + commandOffset >= args.length || args[separator + commandOffset].startsWith("-")) fail("请用 -- 分隔托管设置和要启动的程序。\n" + adbHelp);
  const flags = new Map<string, string>();
  for (let i = 0; i < separator; i += 2) {
    const key = args[i];
    if (!["--device", "--controller", "--task", "--mode", "--backend"].includes(key) || flags.has(key) || i + 1 >= separator) fail("托管参数无效：" + key);
    flags.set(key, args[i + 1]);
  }
  const id = flags.get("--device"); if (!id) fail("请指定 --device，避免控制错误的手机。");
  const mode = flags.get("--mode") || "control"; if (mode !== "view" && mode !== "control") fail("--mode 只能是 view 或 control。");
  const backend = flags.get("--backend") || "app"; if (backend !== "app" && backend !== "basic") fail("--backend 只能是 app 或 basic。");
  return { id, mode: mode as "view" | "control", backend, controller: flags.get("--controller") || "ADB 托管工具", task: flags.get("--task") || path.basename(args[separator + commandOffset]), command: args.slice(separator + commandOffset) };
}

export function wrapperEnvironment(env: NodeJS.ProcessEnv, bin: string, cli: string, lease: string, id: string, platform = process.platform): NodeJS.ProcessEnv {
  // Windows environment names are case-insensitive. Never leave both Path and
  // PATH, since Node otherwise may select the unmodified entry for a child.
  const result = { ...env }; const keys = Object.keys(result).filter(k => platform === "win32" ? k.toLowerCase() === "path" : k === "PATH");
  const previous = keys.map(k => result[k]).find(Boolean) || ""; for (const k of keys) delete result[k];
  delete result.ELECTRON_RUN_AS_NODE;
  return { ...result, PATH: bin + (platform === "win32" ? ";" : ":") + previous, ADB: path.join(bin, platform === "win32" ? "adb.exe" : "adb"), ANDROID_SERIAL: id, PROFILEPILOT_PHONE_LEASE: lease, PROFILEPILOT_PHONE_RUNTIME: process.execPath, PROFILEPILOT_PHONE_CLI: cli };
}

export async function runPhoneWrap(args: string[], request: Request, io: IO = process, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!args.length || args.length === 1 && ["--help", "-h"].includes(args[0])) { io.stdout.write(adbHelp); return 0; }
  let lease: string | undefined, heartbeat: NodeJS.Timeout | undefined, child: ReturnType<typeof spawn> | undefined;
  let interrupted = false, failed = false;
  const interrupt = () => { interrupted = true; child?.kill("SIGTERM"); };
  try {
    const { command, ...params } = parsePhoneWrap(args);
    const cliRoot = path.basename(__dirname) === "phones" ? path.dirname(__dirname) : __dirname;
    const cli = path.resolve(cliRoot, "profilepilot-cli.cjs");
    // In the bundled CLI __dirname is dist/main or ~/.profilepilot/cli.
    const bin = path.join(cliRoot, "phone-bin"), executable = path.join(bin, process.platform === "win32" ? "adb.exe" : "adb");
    await fs.access(cli); await fs.access(executable);
    const owner = await call<{ lease: string; device: PhoneDevice }>(request, "wrapper-start", params); lease = owner.lease;
    const childEnv = wrapperEnvironment(env, bin, cli, lease, params.id);
    io.stderr.write(`[ProfilePilot] ${params.controller} · ${owner.device.name} · ${params.mode === "view" ? "查看" : "控制"}会话已开始。\n`);
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    let pulsing = false;
    heartbeat = setInterval(() => {
      if (pulsing) return; pulsing = true;
      void call(request, "wrapper-pulse", { lease }).catch(error => {
        if (!failed) io.stderr.write(`[ProfilePilot] ${error.message}\n`);
        failed = true; child?.kill("SIGTERM");
      }).finally(() => { pulsing = false; });
    }, 1500);
    // No intermediate shell: argv, stdin, binary stdout and exit status survive.
    // For .cmd tools on Windows, launch their .exe/script interpreter explicitly.
    child = spawn(command[0], command.slice(1), { env: childEnv, stdio: "inherit", windowsHide: true });
    const code = await new Promise<number>((resolve, reject) => { child!.once("error", reject); child!.once("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1))); });
    return interrupted ? 130 : failed ? 1 : code;
  } catch (error) { io.stderr.write(`[ProfilePilot] ${(error as Error).message}\n`); return 1; }
  finally {
    clearInterval(heartbeat); process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    if (lease) {
      try { await call(request, "wrapper-stop", { lease }); }
      catch { io.stderr.write("[ProfilePilot] 未确认任务清理；已停止托管心跳，失联保护将撤销该任务。\n"); }
    }
  }
}
