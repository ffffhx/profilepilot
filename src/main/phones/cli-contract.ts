import { z } from "zod";
import { phoneActionSchema } from "./actions";
import { wirelessPairSchema } from "./wireless";
import { phoneFailure } from "./errors";
import { cameraCommandSchema, cameraStartSchema, cameraLeaseSchema } from "./screen-camera";
import { followCommandSchema } from "./game-follow";

export const phoneBooleanFlags = new Set(["--stored", "--save", "--forget", "--params-stdin", "--clear", "--no-observe"]);
const jsonFlags = ["--params-file", "--params-stdin"];
export const phoneCommandFlags: Record<string, string[]> = {
  list: [], default: ["--device", "--clear"], "emulator-list": [], "emulator-connect": ["--name"],
  readiness: ["--device", "--backend"], connect: ["--device"], disconnect: ["--device"], update: ["--device"],
  "accessibility-repair": ["--device", "--auto-restore"], inspect: ["--device", "--package"],
  packages: ["--device", "--scope", "--filter"], diagnose: ["--device"],
  start: ["--device", "--controller", "--task", "--mode", "--keep-screen-on", "--backend"],
  pause: ["--device", "--backend"], resume: ["--device", "--backend"], stop: ["--device", "--backend"],
  action: [...jsonFlags, "--output", "--backend", "--no-observe"],
  exec: ["--device", ...jsonFlags, "--mode", "--controller", "--task", "--backend"],
  host: [...jsonFlags], app: ["--device", ...jsonFlags, "--backend", "--controller"],
  install: ["--device", "--apk", "--controller"],
  run: ["--device", "--file", "--output-dir", "--mode", "--controller", "--task"],
  "wireless-discover": ["--device"], "wireless-pair": [...jsonFlags],
  "wireless-connect": ["--device", "--address"], "wireless-disconnect": ["--device"],
  rename: ["--device", "--name"], wake: ["--device"], unattended: ["--device", "--op"],
  unlock: ["--device", "--pattern", "--pattern-geometry", "--stored", "--save", "--forget", "--kind", "--allow-agent"]
};
export const phoneGroupFlags: Record<string, Record<string, string[]>> = {
  internet: { status: [], configure: [...jsonFlags], pair: ["--output"], forget: ["--device"], "install-status": ["--device", "--job"] },
  camera: { probe: ["--device"], sources: [], start: [...jsonFlags], status: [...jsonFlags], apps: [...jsonFlags], launch: [...jsonFlags], tap: [...jsonFlags], key: [...jsonFlags], stop: [...jsonFlags], preview: [...jsonFlags, "--output"], frame: [...jsonFlags, "--file"] },
  follow: { runtime: [], setup: [], status: [], load: [], save: ["--config"], start: ["--device", "--mode", "--backend", "--config", "--recover-transport"], stop: ["--run-id"], analyze: [...jsonFlags], "camera-sample": ["--device", "--x", "--y", "--output", "--steps-file"] },
  iphone: { setup: [], doctor: [], devices: [], "prepare-wda": [], "signing-setup": [], "usb-status": [], "usb-start": ["--udid", "--bundle-id", "--name"], "usb-stop": ["--udid"], "devmode-reveal": ["--udid"], "sign-sideloadly": ["--udid", "--bundle-id"], "install-signed": ["--udid", "--ipa"], add: ["--endpoint", "--name"], remove: ["--device"] }
};
export const phoneExecParamsSchema = z.object({ args: z.array(z.string()).min(1).max(512), input: z.string().optional(), output: z.string().optional(),
  stdin: z.boolean().optional(), timeoutMs: z.number().int().min(100).max(3600000).optional() }).strict();
export const phoneAppParamsSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("launch"), packageName: z.string() }).strict(),
  z.object({ operation: z.literal("stop"), packageName: z.string() }).strict(),
  z.object({ operation: z.literal("uninstall"), packageName: z.string(), keepData: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal("export"), packageName: z.string(), outputDir: z.string() }).strict()
]);
export const phoneActionParamsSchema = z.object({ id: z.string().min(1), sessionId: z.string().min(1).max(100), generation: z.number().int().nonnegative(), requestId: z.string().uuid(), action: phoneActionSchema, observeAfter: z.boolean().optional() }).strict();
export const phoneHostParamsSchema = z.object({ args: z.array(z.string()).min(1).max(10) }).strict();
const paramsSchemas: Record<string, z.ZodType> = { action: phoneActionParamsSchema, exec: phoneExecParamsSchema, app: phoneAppParamsSchema, host: phoneHostParamsSchema, "wireless-pair": wirelessPairSchema,
  "internet configure": z.object({ enabled: z.boolean(), port: z.number().int().min(0).max(65535).optional(), advertisedUrl: z.string().max(2048).optional() }).strict() };
const notes: Record<string, string> = {
  "internet status": "读取本电脑 HTTPS 监听与已配对手机。外网连接不需要本地电脑、同一 Wi-Fi 或 Tailscale。",
  "internet configure": "在云端电脑配置 enabled、port 和 advertisedUrl（HTTPS origin）；需允许手机访问此端口。更改端口或停用会断开现有连接，不自动恢复控制。",
  "internet pair": "配对链接仅写入 --output 指定的新文件，有效期三分钟。经手机确认后固定证书身份；删除临时配对文件，不打印链接或凭据。",
  "internet forget": "撤销指定手机的外网配对和现有连接；之后需要重新配对。",
  "internet install-status": "只读查询安装命令返回的 jobId；不开始或恢复控制，不重试安装。回执丢失时使用 inspect 核对实际版本。",
  action: "使用成功 start/list 返回的设备、会话和 generation；requestId 为新 UUID。普通输入默认等待 500ms 并返回 observation；App/iPhone 为控件树，basic 为截图路径。观察失败仍保留 actionOutcome:completed，不重放输入。--no-observe 跳过反馈；snapshot/screenshot/find 不额外观察。",
  start: "默认 control/app。检查 readiness 和现有会话；不会替换占用任务或恢复用户接管。",
  exec: "自动建立并结束独占任务，保留 Android 退出码和二进制输出。JSON 从 --params-stdin 输入时，ADB stdin:true 不能再共用同一标准输入；使用 input 文件。",
  host: "可用 version、host-features、server-status、start-server、kill-server、mdns check/services、reconnect offline、keygen。改变共享连接前先结束所有手机任务。",
  install: "覆盖安装并保留数据。先结束现有任务；提交后超时或接管属于结果未知，先 inspect 核对安装结果。",
  resume: "只在用户明确交还控制后恢复；完成后重新观察，不沿用旧 generation。",
  unlock: "默认从标准输入读取 PIN/密码，不放 argv。--stored 使用已授权保存的凭据；--save --kind 从标准输入保存；--forget 删除。",
  "emulator-connect": "名称来自 emulator-list。启动或复用指定模拟器；Windows 自动检查窗口位置和大小。",
  "wireless-pair": "address 使用配对端口，code 为手机显示的六位配对码。通过参数文件或标准输入传入，不放命令行。",
  "wireless-connect": "--device 自动发现当前地址；--address 指定 IP:连接端口，二选一。连接不会自动开始或恢复控制。",
  default: "查询或设置手机页面的默认设备；--device ID 设置，--clear 清除。普通命令用 --device default 解析当前默认设备；离线时停止，不选择其他手机。",
  readiness: "只读查看连接、权限、屏幕、占用和下一步；doctor 是同义命令。",
  run: "从 --file 读取流程。创建独占会话，完成或失败后结束；仅重复观察，不重放输入。"
};
const values: Record<string, string[]> = { "--backend": ["app", "basic"], "--mode": ["view", "control"], "--scope": ["all", "user", "system"], "--auto-restore": ["on", "off"], "--keep-screen-on": ["on", "off"], "--allow-agent": ["on", "off"], "--op": ["on", "off", "status"], "--kind": ["pattern", "credential"] };
const withoutOp = (schema: z.ZodObject<z.ZodRawShape>) => schema.omit({ op: true });

export function phoneCommandContract(command: string) {
  const method = command === "doctor" ? "readiness" : command;
  const [group, op] = method.split(" ");
  const flags = phoneCommandFlags[method] || phoneGroupFlags[group]?.[op];
  if (!flags) throw phoneFailure("PHONE_INVALID_REQUEST", `未知手机命令：${command}。运行 ppilot phone schema 查看命令列表。`);
  const required = flags.includes("--device") && !["default", "wireless-discover", "wireless-connect"].includes(method) ? ["--device"] : [];
  if (method === "emulator-connect" || method === "rename") required.push("--name");
  if (method === "install") required.push("--apk");
  if (method === "internet pair") required.push("--output");
  if (method === "internet install-status") required.push("--job");
  if (method === "run") required.push("--file");
  if (group === "iphone" && flags.length) required.push(flags[0]);
  if (method === "iphone install-signed") required.push("--ipa");
  if (group === "follow") for (const flag of ["--config", "--run-id", "--x", "--y", "--output"]) if (flags.includes(flag)) required.push(flag);
  if (method === "camera frame") required.push("--file");
  let schema = paramsSchemas[method];
  if (group === "camera" && flags.includes("--params-file")) {
    schema = op === "start" ? cameraStartSchema : op === "frame" ? cameraLeaseSchema.strict()
      : withoutOp(cameraCommandSchema.options.find(option => option.shape.op.safeParse(op).success)!);
  }
  if (method === "follow analyze") schema = withoutOp(followCommandSchema.options.find(option => option.shape.op.safeParse(op).success)!);
  return {
    version: 1, command: `ppilot phone ${command}`, method,
    options: flags.map(name => ({ name, type: phoneBooleanFlags.has(name) ? "boolean" : "string", required: required.includes(name), ...(name === "--mode" && group === "follow" ? { enum: ["observe", "control"] } : values[name] ? { enum: values[name] } : {}) })),
    ...(schema ? { input: { exactlyOneOf: jsonFlags, maxBytes: method === "exec" ? 200000 : method === "follow analyze" ? 12000000 : 32768, schema: z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) } } : {}),
    ...(method === "wireless-connect" ? { exactlyOneOf: ["--device", "--address"] } : {}),
    ...(notes[method] ? { note: notes[method] } : {}),
    output: method === "exec" ? "Android stdout/stderr; original exit code" : "JSON",
    exitCodes: { success: 0, failed: 1, invalidArguments: 2, serviceUnavailable: 69, reconcileOrWait: 75 }, automaticReplay: false
  };
}

export function phoneCommandHelp(command: string): string {
  const c = phoneCommandContract(command);
  const usage = c.options.map(o => {
    const term = o.name + (o.type === "boolean" ? "" : ` <${o.enum?.join("|") || "值"}>`);
    return o.required ? term : `[${term}]`;
  }).join(" ");
  return `${c.command} ${usage}\n\n${c.note || "使用当前设备 ID；不会自动切换手机或控制通道。"}\n${c.input ? "JSON 输入二选一：--params-file <文件> 或 --params-stdin；支持 UTF-8 BOM。\n" : ""}格式：ppilot phone schema ${command}\n`;
}
