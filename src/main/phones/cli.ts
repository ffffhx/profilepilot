import fs from "node:fs/promises";
import type { Readable } from "node:stream";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { runPhoneFlowCli } from "./flow-cli";
import { installPhoneApkCli } from "./install-cli";
import { wirelessConnectSchema, wirelessPairSchema } from "./wireless";
import { runScreenCameraCli } from "./screen-camera-cli";
import { executeAdbCli } from "./adb-cli-stream";
import { phoneAppCli } from "./app-cli";
import { runGameFollowCli } from "./game-follow-cli";
import { runIphoneCli } from "./iphone-cli";
import { runInternetPhoneCli } from "./internet-cli";
import { phoneErrorResult, phoneExitCode, phoneResponseError, phoneFailure } from "./errors";
import { readPhoneParams } from "./cli-input";
import { savePhoneFeedbackImage } from './action-feedback';
import type { PhoneActionResult } from '../../shared/phones';
import { phoneBooleanFlags, phoneCommandFlags, phoneGroupFlags, phoneCommandContract, phoneCommandHelp, phoneActionParamsSchema, phoneHostParamsSchema } from "./cli-contract";

export const phoneHelp = `ppilot phone CLI · 手机控制

ppilot phone list
ppilot phone default [--device <设备ID> | --clear]
ppilot phone readiness --device default
ppilot phone internet status
ppilot phone internet configure --params-file <启用和HTTPS地址JSON>
ppilot phone internet pair --output <新配对文件>
ppilot phone internet forget --device <internet-设备ID>
ppilot phone internet install-status --device <internet-设备ID> --job <安装返回的jobId>
ppilot phone schema [命令]
ppilot phone <命令> --help
ppilot phone iphone --help
ppilot phone iphone add --endpoint <WebDriverAgent地址> [--name <名称>]
ppilot phone iphone remove --device <iphone-ID>
ppilot phone readiness|doctor --device <设备ID> [--backend app|basic]
ppilot phone follow runtime|setup|status|load
ppilot phone follow save --config <校准JSON>
ppilot phone follow start --device <设备ID> --config <校准JSON> [--mode observe|control] [--backend app|basic] [--recover-transport true|false]
ppilot phone follow stop --run-id <status返回的任务ID>
ppilot phone follow analyze --params-file <包含config和frame的JSON>
ppilot phone follow camera-sample --device <设备ID> --x <原生X> --y <原生Y> --output <新建绝对目录> [--steps-file <6至9步JSON数组>]
ppilot phone emulator-list
ppilot phone emulator-connect --name <模拟器名称>
ppilot phone connect --device <设备ID>
ppilot phone disconnect --device <设备ID>
ppilot phone update --device <设备ID>
ppilot phone accessibility-repair --device <设备ID> [--auto-restore on|off]
ppilot phone inspect --device <设备ID> [--package <包名>]
ppilot phone packages --device <设备ID> [--scope all|user|system] [--filter <包名片段>]
ppilot phone diagnose --device <设备ID>
ppilot phone exec --device <设备ID> --params-file <ADB参数JSON> [--mode view|control] [--controller <名称>] [--task <任务>]
ppilot phone host --params-file <主机命令JSON>
ppilot phone app --device <设备ID> --params-file <应用操作JSON> [--backend app|basic] [--controller <名称>]
ppilot phone install --device <设备ID> --apk <本地APK文件> [--controller <控制者>]
ppilot phone wireless-discover [--device <设备ID>]
ppilot phone wireless-pair --params-file <配对JSON文件>
ppilot phone wireless-connect --address <手机IP:连接端口>
ppilot phone wireless-connect --device <设备ID>
ppilot phone wireless-disconnect --device <设备ID>
ppilot phone start --device <设备ID> --controller <控制者> --task <任务> [--mode view|control] [--backend app|basic] [--keep-screen-on on|off]
ppilot phone pause|resume|stop --device <设备ID> [--backend app|basic]
ppilot phone wake --device <设备ID>
ppilot phone unattended --device <设备ID> [--op on|off|status]
ppilot phone unlock --device <设备ID> [--pattern 1478] [--pattern-geometry cx,cy,step]
ppilot phone unlock --device <设备ID> --save --kind pattern|credential [--allow-agent on|off]
ppilot phone unlock --device <设备ID> --stored [--pattern-geometry cx,cy,step]
ppilot phone unlock --device <设备ID> --forget
ppilot phone rename --device <设备ID> --name <名称>
ppilot phone action --params-file <JSON文件> [--output <截图文件>] [--backend app|basic]
ppilot phone run --device <设备ID> --file <流程JSON> [--output-dir <报告目录>] [--mode view|control] [--controller <控制者>] [--task <任务>]
ppilot phone wrap --device <设备ID> --controller <控制者> --task <任务> [--mode view|control] -- <程序> [参数...]
ppilot phone adb <ADB兼容命令...>
ppilot phone camera probe --device <设备ID>
ppilot phone camera sources
ppilot phone camera start --params-file <当前控制会话与可选sourceId、crop的JSON>
ppilot phone camera status|apps|launch|tap|key|stop --params-file <会话和操作JSON>
ppilot phone camera preview --params-file <会话JSON> --output <手机App画面.jpg>
ppilot phone camera frame --params-file <会话JSON> --file <当前浏览器二维码截图.png>

emulator-connect 启动或复用指定模拟器，Windows 下会检查窗口并自动缩放归位；不会安装 App 或开始控制。
模拟器窗口跑到屏幕外时，再次运行同一条 emulator-connect 即可修复，不会重启已有模拟器。

屏幕摄像头需要 Android 16+、已更新的配套 App 和有效 control 会话。start 不恢复暂停会话。
sourceId 来自 camera sources；crop 为 0–1 的 x/y/width/height。省略 sourceId 后可用 frame 提供当前 Profile 的截图。
launch 需要 component（来自 apps），tap 需要 x/y（来自 preview），key 仅支持 back。暂停或断线后重新开启摄像头。

无线配对 JSON：{"address":"192.168.1.8:37123","code":"手机显示的6位配对码"}。配对码通过参数文件或 --params-stdin 传入，不放在命令行。
配对端口与连接端口不同；已配对设备优先用 wireless-connect --device 自动发现并验证当前地址。
wireless-discover 返回端口可达性及原因；--device 只查找指定手机，旧地址不可用时自动刷新一次。
成功后使用返回的设备 ID 执行 connect，连接已有配套 App；connect 不安装或更新。
disconnect 断开这台手机所有 USB / Wi-Fi App 连接并停止画面，保留调试通道；须先结束任务，再断开。显式 connect 前不会自动重连 App。
update 明确安装或更新电脑随附的配套 App。inspect 只读查询版本，默认查询 ProfilePilot；不需要配套 App 会话。
accessibility-repair 需要用户授权：通过已配对 App 恢复其无障碍服务，必要时通过 ADB 授予系统设置权限；无需先开启无障碍。
--auto-restore on 保存自动开启无障碍的选择，off 关闭此自动恢复；省略时只修复本次，不改变选择。此命令不会开始或恢复控制会话。
packages 列出或搜索应用；diagnose 读取系统、屏幕、进程和服务诊断，保留原始输出及部分失败。
无线连接不会自动开始控制，也不会恢复已暂停的会话。
免安装：start --backend basic 不安装手机 App。支持截图、坐标点击/滑动、返回/主页/最近应用和基础英文输入。
basic 会话版本在 list 的 basic 字段中；后续 action、pause、resume、stop 也需指定 --backend basic。
坐标操作前先截图；画面有效期 30 秒，输入后需重新截图。中文填写、控件识别及手机端暂停需要 App。
两种模式不会自动切换；先结束当前会话，再执行 update 安装配套 App。断线后须重新开始会话。
install 自动创建安装会话，覆盖更新并保留应用数据；不卸载、不降级、不自动授予权限。支持已连接的 USB 或 Wi-Fi。
安装要求先结束现有任务；暂停、断线或会话改变会停止安装跟踪，不会自动重试；提交到 Android 的安装可能已经完成，请先核对结果。
action JSON: {"id":"设备ID","sessionId":"list 返回的会话ID","generation":1,"requestId":"新的UUID","action":{"kind":"tap","x":100,"y":200}}
操作类型：tap、swipe、text、key(back/home/recents)、snapshot、screenshot、find、click、fill、scroll。
find/click/fill/scroll 使用 selector：resourceId、text、description、className、packageName 与控件状态，按全部条件精确匹配。
fill 支持空字符串清空；click/fill/scroll 必须唯一匹配；scroll 需要 direction: forward|backward。
run 文件：{"version":1,"name":"检查页面","steps":[{"kind":"wait","selector":{"text":"保存"}},{"kind":"click","selector":{"text":"保存"}},{"kind":"assert","selector":{"text":"已保存"}}]}
流程还支持 scrollUntil（selector、container、direction、maxScrolls）。报告不记录输入内容；显式指定 --output-dir 后失败时可保存当前页面和截图。
run 创建独占会话，完成/失败后结束；仅重复观察，不重放输入，也不会恢复暂停的流程。重跑从第一步开始。
先读取 list 中的会话版本；暂停、结束或断线后不得自动恢复或重放输入。
exec 参数文件：{"args":["shell","getprop","ro.build.version.release"],"timeoutMs":120000}。
可加 output（新文件路径）、input（stdin 文件）或 stdin:true；保留二进制字节和 Android 退出码。
exec 自动建立/结束任务；wrap 为现有脚本配置受控 adb。完整命令范围见 ppilot phone adb --help。
app 参数：{"operation":"launch|stop|uninstall|export","packageName":"com.example.app"}；export 另需 outputDir，导出全部 split APK 和 SHA-256。
host 参数：{"args":["server-status"]}；支持 version、host-features、mdns、start-server、kill-server、reconnect offline 和 keygen。
kill-server 会持续停用轮询，直到显式 start-server；改变共享主机连接前必须结束所有手机任务。
控制期间配套 App 默认保持亮屏（--keep-screen-on off 关闭）；熄屏只会暂停，解锁后自动继续，不需要手动恢复。
wake 通过 ADB 点亮屏幕并尝试解除无密码的滑动锁屏，不会尝试身份验证。
unattended 控制配套 App 的“充电时保持 ADB 响应”：开启后仅在充电时持有唤醒锁，锁屏休眠后电脑仍能连接并解锁。
无人值守只在充电时生效，拔电自动释放；也可在手机 App 的“设置 → 无人值守”里开关。
unlock 从标准输入读取 PIN 或密码（不进命令行），点亮、上滑并提交；失败或结果不明不会自动重试。
图案锁用 --pattern：4–9 个不重复的 1–9 数字（如 1478），通过连续的 DOWN/MOVE/UP 绘制。
图案坐标默认从锁屏画面自动检测；检测不到时用上次成功的坐标或按屏幕比例估算。
检测失败或估算不准时，用 --pattern-geometry cx,cy,step 或 cx,cy,stepX,stepY 指定点阵中心与间距。
默认估算约为 cx=屏幕宽/2、cy=屏幕高×0.717、step=屏幕宽×0.252，可按实际锁屏微调。
--save 从标准输入读取凭据（不回显），用系统安全存储加密保存到桌面 App 的数据目录，不会写回命令行或输出。
--stored 使用已保存的凭据解锁；--forget 删除。桌面 App 的“设备详情 → 解锁凭据”可以保存、查看状态和删除。
保存的凭据只在允许命令行与 Agent 使用时才会被 --stored 使用；它保护的是手机丢失，不防电脑账户被入侵。
只管理经过此入口的操作，不会拦截绕过此 CLI 直接使用原生 ADB 的指令。
JSON 参数命令支持 --params-file 或 --params-stdin（二选一，UTF-8）；stdin 不兼用作 ADB 二进制输入。
设备和会话命令输出 JSON；adb 保留兼容的文本/PNG 输出；wrap 保留子程序输出。
截图使用 --output 保存到本地文件。旧命令 ppilot adb 仍作为 ppilot phone adb 的兼容别名。
`;
/** Read a lock credential without putting it in argv, a file, or the result. */
async function readCredential(io: Pick<NodeJS.Process, "stdout" | "stderr">, input: Readable): Promise<string> {
  const stdin = input as NodeJS.ReadStream;
  const value = (line: string) => {
    const credential = line.replace(/[\r\n]+$/g, "");
    if (!credential) throw new Error("未从标准输入读取到解锁凭据。");
    return credential;
  };
  if (stdin.isTTY) {
    io.stderr.write("输入手机 PIN 或密码（不回显），回车确认：");
    return await new Promise<string>((resolve, reject) => {
      let typed = "";
      const wasRaw = stdin.isRaw;
      const cleanup = () => {
        stdin.removeListener("data", onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.pause(); io.stderr.write("\n");
      };
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === "\u0003") { cleanup(); reject(new Error("已取消输入解锁凭据。")); return; }
          if (char === "\r" || char === "\n") {
            cleanup();
            try { resolve(value(typed)); } catch (error) { reject(error); }
            return;
          }
          if (char === "\u007f" || char === "\b") { typed = typed.slice(0, -1); continue; }
          typed += char;
        }
      };
      stdin.setEncoding("utf8"); stdin.setRawMode(true); stdin.resume();
      stdin.on("data", onData);
    });
  }
  const chunks: Buffer[] = [];
  let ended = false;
  await new Promise<void>((resolve, reject) => {
    const done = () => { if (!ended) { ended = true; stdin.pause(); resolve(); } };
    stdin.on("data", chunk => {
      const buffer = Buffer.from(chunk); chunks.push(buffer);
      if (buffer.includes(10)) done();
    });
    stdin.once("end", done); stdin.once("error", reject); stdin.resume();
  });
  return value(Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0]);
}

export async function runPhoneCli(args: string[], request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>, io: Pick<NodeJS.Process, "stdout" | "stderr">, input: Readable = process.stdin): Promise<number> {
  if (!args.length || ["--help", "-h"].includes(args[0])) { io.stdout.write(phoneHelp); return 0; }
  let dispatching = false;
  const dispatch = (command: ProfilePilotManagementCommand) => { dispatching = true; return request(command); };
  try {
    if (args[0] === "schema") {
      if (args.length > 3) throw phoneFailure("PHONE_INVALID_REQUEST", "用法：ppilot phone schema [命令 [子命令]]");
      const group = args.length === 2 ? phoneGroupFlags[args[1]] : undefined;
      io.stdout.write(JSON.stringify(group ? { version: 1, command: `ppilot phone ${args[1]}`, commands: Object.keys(group) } : args[1] ? phoneCommandContract(args.slice(1).join(" ")) : { version: 1, commands: Object.keys(phoneCommandFlags), aliases: { doctor: "readiness" }, groups: Object.keys(phoneGroupFlags) }, null, 2) + "\n");
      return 0;
    }
    if (args.includes("--help") || args.includes("-h") || args.length === 1 && phoneGroupFlags[args[0]]) {
      const group = phoneGroupFlags[args[0]];
      const op = args[1] && !args[1].startsWith("-") ? args[1] : undefined;
      io.stdout.write(group && !op ? `ppilot phone ${args[0]} <命令>\n\n${Object.keys(group).join(" | ")}\n\n使用 ppilot phone ${args[0]} <命令> --help 或 ppilot phone schema ${args[0]} <命令> 查看格式。\n` : phoneCommandHelp(group ? `${args[0]} ${op}` : args[0])); return 0;
    }
    if (args[0] === "iphone") return runIphoneCli(args.slice(1), dispatch, io);
    if (args[0] === "internet") return await runInternetPhoneCli(args.slice(1), dispatch, io, input);
    if (args[0] === "camera") return runScreenCameraCli(args.slice(1), dispatch, io, input);
    if (args[0] === "follow") return runGameFollowCli(args.slice(1), dispatch, io, input);
    const method = args[0] === "doctor" ? "readiness" : args[0];
    if (!phoneCommandFlags[method]) throw new Error("未知手机命令。运行 ppilot phone schema 查看命令列表。");
    const flags = new Map<string, string>();
    const booleans = phoneBooleanFlags;
    for (let index = 1; index < args.length; index++) {
      const key = args[index]; if (key === "--json") continue;
      if (booleans.has(key)) { if (flags.has(key)) throw new Error(`参数重复：${key}`); flags.set(key, "on"); continue; }
      if (!phoneCommandFlags[method].includes(key) || flags.has(key) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`参数无效或缺少值：${key}`);
      flags.set(key, args[++index]);
    }
    const allowed = phoneCommandFlags;
    const backend = flags.get("--backend") || "app";
    if (!["app", "basic"].includes(backend)) throw new Error("--backend 必须为 app 或 basic。");
    for (const key of flags.keys()) if (!allowed[method].includes(key)) throw new Error(`${method} 不支持 ${key}`);
    if (method === "default") {
      if (flags.has("--clear") && flags.has("--device")) throw new Error("--clear 和 --device 只能选择一个。");
      const response = await dispatch({ action: "phone", method, params: flags.has("--clear") ? { id: null } : flags.has("--device") ? { id: flags.get("--device") } : {} });
      io.stdout.write(JSON.stringify(response, null, 2) + "\n"); return response.ok ? 0 : 1;
    }
    if (flags.get("--device") === "default") {
      const response = await dispatch({ action: "phone", method: "default" });
      if (!response.ok) { io.stderr.write(JSON.stringify(response) + "\n"); return 1; }
      const target = response.data as import("../../shared/default-targets").DefaultPhoneStatus;
      if (!target?.saved) throw new Error("尚未设置默认设备，请在手机页面设置或明确指定 --device。");
      if (!target.available || !target.deviceId) throw new Error(`默认设备“${target.saved.name}”未连接，请先连接该设备；不会自动选择其他手机。`);
      flags.set("--device", target.deviceId);
    }
    if (method === "exec") return await executeAdbCli(flags, dispatch, io, input);
    if (method === "app") return await phoneAppCli(flags, dispatch, io, input);
    if (method === "install") {
      const data = await installPhoneApkCli(flags, dispatch);
      io.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + "\n"); return 0;
    }
    if (method === "run") {
      const data = await runPhoneFlowCli(flags, dispatch) as { ok: boolean };
      io.stdout.write(JSON.stringify({ ok: data.ok, data }, null, 2) + "\n"); return data.ok ? 0 : 1;
    }
    let params: unknown = {};
    if (method === "host") {
      params = phoneHostParamsSchema.parse(await readPhoneParams(flags, 32768, input));
    } else if (method === "emulator-connect") {
      const name = flags.get("--name");
      if (!name || !/^[\w.-]{1,200}$/.test(name)) throw new Error("请指定 --name，使用 emulator-list 返回的模拟器名称。");
      params = { name };
    } else if (method === "wireless-connect") {
      const address = flags.get("--address"), id = flags.get("--device");
      if ((!address && !id) || (address && id)) throw new Error("请指定 --device 自动连接，或仅指定 --address IP:连接端口手动连接。");
      params = id ? { id } : wirelessConnectSchema.parse({ address });
    } else if (method === "wireless-discover") {
      params = flags.has("--device") ? { id: flags.get("--device") } : {};
    } else if (method === "wireless-pair") {
      const content = await readPhoneParams(flags, 32768, input);
      // Do not include invalid JSON excerpts or schema inputs containing the code in errors.
      try { params = wirelessPairSchema.parse(content); }
      catch { throw new Error("配对参数无效：请提供 JSON 格式的局域网 address 和 6 位 code。"); }
    } else if (method === "action") {
      params = phoneActionParamsSchema.parse(await readPhoneParams(flags, 32768, input));
    } else if (method !== "list" && method !== "emulator-list" && method !== "wireless-discover") {
      const id = flags.get("--device"); if (!id) throw new Error("请指定 --device，避免操作错误的手机。");
      params = method === "start" ? { id, mode: flags.get("--mode") || "control", controller: flags.get("--controller") || "本机 CLI", task: flags.get("--task") || "" } : method === "rename" ? { id, name: flags.get("--name") } : method === "inspect" ? { id, packageName: flags.get("--package") } : method === "packages" ? { id, scope: flags.get("--scope"), filter: flags.get("--filter") } : { id };
    }
    if (method === "connect") params = { ...(params as { id: string }), update: false };
    if (method === "accessibility-repair" && flags.has("--auto-restore")) {
      if (!["on", "off"].includes(flags.get("--auto-restore")!)) throw new Error("--auto-restore 必须为 on 或 off。");
      params = { ...(params as { id: string }), autoRestore: flags.get("--auto-restore") === "on" };
    }
    if (method === "readiness") params = { ...(params as { id: string }), backend };
    if (method === "unattended") {
      const op = flags.get("--op") ?? "status";
      if (!["on", "off", "status"].includes(op)) throw new Error("--op 必须为 on、off 或 status。");
      params = { ...(params as { id: string }), op };
    }
    if (method === "start" && flags.has("--keep-screen-on")) {
      const value = flags.get("--keep-screen-on");
      if (!["on", "off"].includes(value!)) throw new Error("--keep-screen-on 必须为 on 或 off。");
      params = { ...(params as object), keepScreenOn: value === "on" };
    }
    let requestMethod = method;
    if (method === "unlock") {
      const pattern = flags.get("--pattern");
      const stored = flags.has("--stored"), save = flags.has("--save"), forget = flags.has("--forget");
      if ([stored, save, forget].filter(Boolean).length > 1) throw new Error("--stored、--save、--forget 不能同时使用。");
      if (stored) {
        if (pattern !== undefined || flags.has("--kind") || flags.has("--allow-agent")) throw new Error("--stored 不能和 --pattern、--kind、--allow-agent 一起使用。");
        params = { ...(params as { id: string }), ...(flags.has("--pattern-geometry") ? { patternGeometry: flags.get("--pattern-geometry") } : {}) };
        requestMethod = "unlock-stored";
      } else if (forget) {
        if (pattern !== undefined || flags.has("--pattern-geometry") || flags.has("--kind") || flags.has("--allow-agent")) throw new Error("--forget 不能和其他解锁参数一起使用。");
        requestMethod = "unlock-secret-delete";
      } else if (save) {
        const kind = flags.get("--kind");
        if (!kind || !["pattern", "credential"].includes(kind)) throw new Error("--save 需要 --kind pattern|credential。");
        if (pattern !== undefined || flags.has("--pattern-geometry")) throw new Error("--save 从标准输入读取凭据，不要同时传 --pattern。");
        // No echo and no argv: the value only travels over local IPC.
        const value = await readCredential(io, input);
        if (kind === "pattern" && (!/^[1-9]{4,9}$/.test(value) || new Set(value).size !== value.length)) throw new Error("图案必须是 4–9 个不重复的 1–9 数字。");
        const allowAgent = flags.get("--allow-agent") ?? "on";
        if (!["on", "off"].includes(allowAgent)) throw new Error("--allow-agent 必须为 on 或 off。");
        params = { ...(params as { id: string }), kind, value, allowAgent: allowAgent === "on" };
        requestMethod = "unlock-secret-save";
      } else if (pattern !== undefined) {
        if (!/^[1-9]{4,9}$/.test(pattern) || new Set(pattern).size !== pattern.length) throw new Error("--pattern 必须是 4–9 个不重复的 1–9 数字，例如 1478。");
        params = { ...(params as { id: string }), pattern, ...(flags.has("--pattern-geometry") ? { patternGeometry: flags.get("--pattern-geometry") } : {}) };
      } else {
        if (flags.has("--pattern-geometry")) throw new Error("--pattern-geometry 需要和 --pattern 或 --stored 一起使用。");
        params = { ...(params as { id: string }), credential: await readCredential(io, input) };
      }
      if (flags.has("--kind") && !save) throw new Error("--kind 只能和 --save 一起使用。");
      if (flags.has("--allow-agent") && !save) throw new Error("--allow-agent 只能和 --save 一起使用。");
    }
    if (method === "action") {
      const p = params as Record<string, unknown>;
      if (!p || typeof p !== "object" || typeof p.sessionId !== "string" || !p.sessionId.trim() ||
          typeof p.id !== "string" || !Number.isInteger(p.generation) || typeof p.requestId !== "string") {
        throw Object.assign(new Error("action 需要成功 start/list 返回的 id、sessionId、generation 和新的 requestId；start 失败时停止后续调用，先运行 phone readiness。"), { code: "PHONE_INVALID_REQUEST" });
      }
      if (flags.has('--no-observe')) p.observeAfter = false;
      const kind = (p.action as { kind: string }).kind;
      if (flags.has('--output') && kind !== 'screenshot' && !(backend === 'basic' && p.observeAfter !== false && !['snapshot', 'find'].includes(kind)))
        throw phoneFailure('PHONE_INVALID_REQUEST', '--output 需要 screenshot，或开启自动观察的 basic 输入动作。');
    }
    const response = await dispatch({ action: "phone", method: requestMethod === "readiness" ? requestMethod : backend === "basic" ? `basic-${requestMethod}` : requestMethod === "inspect" ? "package-info" : requestMethod, params });
    if (response.ok && (response.data as PhoneActionResult)?.actionOutcome === 'completed') {
      response.data = await savePhoneFeedbackImage(response.data as PhoneActionResult, flags.get('--output'));
    } else if (response.ok && flags.has("--output")) {
      const data = response.data as { result?: { base64?: string; mime?: string }; state?: unknown };
      if (!["image/jpeg", "image/png"].includes(data.result?.mime || "") || typeof data.result?.base64 !== "string") throw new Error("此操作未返回截图。");
      await fs.writeFile(flags.get("--output")!, Buffer.from(data.result.base64, "base64"));
      response.data = { state: data.state, output: flags.get("--output") };
    }
    const failure = response.ok ? undefined : phoneErrorResult(phoneResponseError(response), true);
    const result = response.ok ? response : { ...response, recovery: failure!.recovery };
    io.stdout.write(JSON.stringify(result, null, 2) + "\n"); return failure ? phoneExitCode(failure.recovery) : 0;
  } catch (error) {
    const failure = phoneErrorResult(error, dispatching);
    io.stderr.write(JSON.stringify(failure) + "\n"); return phoneExitCode(failure.recovery);
  }
}
