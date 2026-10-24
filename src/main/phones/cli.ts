import fs from "node:fs/promises";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { runPhoneFlowCli } from "./flow-cli";
import { installPhoneApkCli } from "./install-cli";
import { wirelessConnectSchema, wirelessPairSchema } from "./wireless";
import { runScreenCameraCli } from "./screen-camera-cli";
import { executeAdbCli } from "./adb-cli-stream";
import { phoneAppCli } from "./app-cli";
import { runGameFollowCli } from "./game-follow-cli";
import { controlRecovery } from "../../shared/control-recovery";

export const phoneHelp = `ppilot phone CLI · 手机控制

ppilot phone list
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
ppilot phone start --device <设备ID> --controller <控制者> --task <任务> [--mode view|control] [--backend app|basic]
ppilot phone pause|resume|stop --device <设备ID> [--backend app|basic]
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

无线配对 JSON：{"address":"192.168.1.8:37123","code":"手机显示的6位配对码"}。配对码只通过文件传入，不放在命令行。
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
只管理经过此入口的操作，不会拦截绕过此 CLI 直接使用原生 ADB 的指令。
设备和会话命令输出 JSON；adb 保留兼容的文本/PNG 输出；wrap 保留子程序输出。
截图使用 --output 保存到本地文件。旧命令 ppilot adb 仍作为 ppilot phone adb 的兼容别名。
`;
export async function runPhoneCli(args: string[], request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>, io: Pick<NodeJS.Process, "stdout" | "stderr">): Promise<number> {
  if (!args.length || args.includes("--help") || args.includes("-h")) { io.stdout.write(phoneHelp); return 0; }
  if (args[0] === "camera") return runScreenCameraCli(args.slice(1), request, io);
  if (args[0] === "follow") return runGameFollowCli(args.slice(1), request, io);
  let dispatching = false;
  try {
    const method = args[0] === "doctor" ? "readiness" : args[0];
    if (!["accessibility-repair", "readiness", "list", "emulator-list", "emulator-connect", "connect", "disconnect", "update", "inspect", "packages", "diagnose", "exec", "host", "app", "install", "wireless-discover", "wireless-pair", "wireless-connect", "wireless-disconnect", "rename", "start", "pause", "resume", "stop", "action", "run"].includes(method)) throw new Error("未知手机命令。运行 ppilot phone --help 查看用法。");
    const flags = new Map<string, string>();
    for (let index = 1; index < args.length; index++) {
      const key = args[index]; if (key === "--json") continue;
      if (!["--auto-restore", "--device", "--apk", "--address", "--controller", "--task", "--mode", "--name", "--params-file", "--output", "--file", "--output-dir", "--backend", "--package", "--scope", "--filter"].includes(key) || flags.has(key) || !args[index + 1]) throw new Error(`参数无效：${key}`);
      flags.set(key, args[++index]);
    }
    const allowed: Record<string, string[]> = { list: [], connect: ["--device"], rename: ["--device", "--name"], start: ["--device", "--controller", "--task", "--mode"], pause: ["--device"], resume: ["--device"], stop: ["--device"], action: ["--params-file", "--output"], run: ["--device", "--file", "--output-dir", "--mode", "--controller", "--task"] };
    allowed["wireless-discover"] = ["--device"];
    allowed["emulator-list"] = [];
    allowed["emulator-connect"] = ["--name"];
    allowed.install = ["--device", "--apk", "--controller"];
    allowed.update = ["--device"];
    allowed.disconnect = ["--device"];
    allowed["accessibility-repair"] = ["--device", "--auto-restore"];
    allowed.inspect = ["--device", "--package"];
    allowed.packages = ["--device", "--scope", "--filter"];
    allowed.diagnose = ["--device"];
    allowed.readiness = ["--device", "--backend"];
    allowed.exec = ["--device", "--params-file", "--mode", "--controller", "--task", "--backend"];
    allowed.host = ["--params-file"];
    allowed.app = ["--device", "--params-file", "--backend", "--controller"];
    allowed["wireless-disconnect"] = ["--device"];
    allowed["wireless-pair"] = ["--params-file"];
    allowed["wireless-connect"] = ["--address", "--device"];
    for (const operation of ["start", "pause", "resume", "stop", "action"]) allowed[operation].push("--backend");
    const backend = flags.get("--backend") || "app";
    if (!["app", "basic"].includes(backend)) throw new Error("--backend 必须为 app 或 basic。");
    for (const key of flags.keys()) if (!allowed[method].includes(key)) throw new Error(`${method} 不支持 ${key}`);
    if (method === "exec") { dispatching = true; return await executeAdbCli(flags, request, io); }
    if (method === "app") { dispatching = true; return await phoneAppCli(flags, request, io); }
    if (method === "install") {
      dispatching = true;
      const data = await installPhoneApkCli(flags, request);
      io.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + "\n"); return 0;
    }
    if (method === "run") {
      dispatching = true;
      const data = await runPhoneFlowCli(flags, request) as { ok: boolean };
      io.stdout.write(JSON.stringify({ ok: data.ok, data }, null, 2) + "\n"); return data.ok ? 0 : 1;
    }
    let params: unknown = {};
    if (method === "host") {
      const file = flags.get("--params-file"); if (!file || (await fs.stat(file)).size > 32768) throw new Error("host 需要有效的 --params-file。");
      params = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
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
      const file = flags.get("--params-file");
      if (!file) throw new Error("wireless-pair 需要 --params-file（address 和 code）。");
      if ((await fs.stat(file)).size > 32768) throw new Error("参数文件过大。");
      const content = await fs.readFile(file, "utf8");
      // Do not include invalid JSON excerpts or schema inputs containing the code in errors.
      try { params = wirelessPairSchema.parse(JSON.parse(content.replace(/^\uFEFF/, ""))); }
      catch { throw new Error("配对参数无效：请提供 JSON 格式的局域网 address 和 6 位 code。"); }
    } else if (method === "action") {
      const file = flags.get("--params-file"); if (!file) throw new Error("action 需要 --params-file。");
      if ((await fs.stat(file)).size > 32768) throw new Error("参数文件过大。"); params = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
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
    if (method === "action") {
      const p = params as Record<string, unknown>;
      if (!p || typeof p !== "object" || typeof p.sessionId !== "string" || !p.sessionId.trim() ||
          typeof p.id !== "string" || !Number.isInteger(p.generation) || typeof p.requestId !== "string") {
        throw Object.assign(new Error("action 需要成功 start/list 返回的 id、sessionId、generation 和新的 requestId；start 失败时停止后续调用，先运行 phone readiness。"), { code: "PHONE_INVALID_REQUEST" });
      }
    }
    dispatching = true;
    const response = await request({ action: "phone", method: method === "readiness" ? method : backend === "basic" ? `basic-${method}` : method === "inspect" ? "package-info" : method, params });
    if (response.ok && flags.has("--output")) {
      const data = response.data as { result?: { base64?: string; mime?: string }; state?: unknown };
      if (!["image/jpeg", "image/png"].includes(data.result?.mime || "") || typeof data.result?.base64 !== "string") throw new Error("此操作未返回截图。");
      await fs.writeFile(flags.get("--output")!, Buffer.from(data.result.base64, "base64"));
      response.data = { state: data.state, output: flags.get("--output") };
    }
    const result = response.ok ? response : { ...response, recovery: controlRecovery(response.error.code) };
    io.stdout.write(JSON.stringify(result, null, 2) + "\n"); return response.ok ? 0 : 1;
  } catch (error) {
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : dispatching ? "PHONE_EXECUTION_ERROR" : "PHONE_INVALID_REQUEST";
    io.stderr.write(JSON.stringify({ ok: false, code, error: (error as Error).message, recovery: controlRecovery(code) }) + "\n"); return 1;
  }
}
