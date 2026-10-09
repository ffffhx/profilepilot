import fs from "node:fs/promises";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { runPhoneFlowCli } from "./flow-cli";
import { installPhoneApkCli } from "./install-cli";
import { wirelessConnectSchema, wirelessPairSchema } from "./wireless";

export const phoneHelp = `ppilot phone CLI · 手机控制

ppilot phone list
ppilot phone connect --device <设备ID>
ppilot phone install --device <设备ID> --apk <本地APK文件> [--controller <控制者>]
ppilot phone wireless-discover [--device <设备ID>]
ppilot phone wireless-pair --params-file <配对JSON文件>
ppilot phone wireless-connect --address <手机IP:连接端口>
ppilot phone wireless-connect --device <设备ID>
ppilot phone start --device <设备ID> --controller <控制者> --task <任务> [--mode view|control] [--backend app|basic]
ppilot phone pause|resume|stop --device <设备ID> [--backend app|basic]
ppilot phone rename --device <设备ID> --name <名称>
ppilot phone action --params-file <JSON文件> [--output <截图文件>] [--backend app|basic]
ppilot phone run --device <设备ID> --file <流程JSON> [--output-dir <报告目录>] [--mode view|control] [--controller <控制者>] [--task <任务>]
ppilot phone wrap --device <设备ID> --controller <控制者> --task <任务> [--mode view|control] -- <程序> [参数...]
ppilot phone adb <ADB兼容命令...>

无线配对 JSON：{"address":"192.168.1.8:37123","code":"手机显示的6位配对码"}。配对码只通过文件传入，不放在命令行。
配对端口与连接端口不同；已配对设备优先用 wireless-connect --device 自动发现并验证当前地址。
wireless-discover 返回端口可达性及原因；--device 只查找指定手机，旧地址不可用时自动刷新一次。
成功后使用返回的设备 ID 执行 connect，更新或连接配套 App。
无线连接不会自动开始控制，也不会恢复已暂停的会话。
免安装：start --backend basic 不安装手机 App。支持截图、坐标点击/滑动、返回/主页/最近应用和基础英文输入。
basic 会话版本在 list 的 basic 字段中；后续 action、pause、resume、stop 也需指定 --backend basic。
坐标操作前先截图；画面有效期 30 秒，输入后需重新截图。中文填写、控件识别及手机端暂停需要 App。
两种模式不会自动切换；先结束当前会话，再执行 connect 安装配套 App。断线后须重新开始会话。
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
wrap 会为子进程配置受控 adb；不支持的指令会报错，不会转交原生 ADB。
只管理经过此入口的操作，不会拦截绕过此 CLI 直接使用原生 ADB 的指令。
设备和会话命令输出 JSON；adb 保留兼容的文本/PNG 输出；wrap 保留子程序输出。
截图使用 --output 保存到本地文件。旧命令 ppilot adb 仍作为 ppilot phone adb 的兼容别名。
`;
export async function runPhoneCli(args: string[], request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>, io: Pick<NodeJS.Process, "stdout" | "stderr">): Promise<number> {
  if (!args.length || args.includes("--help") || args.includes("-h")) { io.stdout.write(phoneHelp); return 0; }
  try {
    const method = args[0];
    if (!["list", "connect", "install", "wireless-discover", "wireless-pair", "wireless-connect", "rename", "start", "pause", "resume", "stop", "action", "run"].includes(method)) throw new Error("未知手机命令。运行 ppilot phone --help 查看用法。");
    const flags = new Map<string, string>();
    for (let index = 1; index < args.length; index++) {
      const key = args[index]; if (key === "--json") continue;
      if (!["--device", "--apk", "--address", "--controller", "--task", "--mode", "--name", "--params-file", "--output", "--file", "--output-dir", "--backend"].includes(key) || flags.has(key) || !args[index + 1]) throw new Error(`参数无效：${key}`);
      flags.set(key, args[++index]);
    }
    const allowed: Record<string, string[]> = { list: [], connect: ["--device"], rename: ["--device", "--name"], start: ["--device", "--controller", "--task", "--mode"], pause: ["--device"], resume: ["--device"], stop: ["--device"], action: ["--params-file", "--output"], run: ["--device", "--file", "--output-dir", "--mode", "--controller", "--task"] };
    allowed["wireless-discover"] = ["--device"];
    allowed.install = ["--device", "--apk", "--controller"];
    allowed["wireless-pair"] = ["--params-file"];
    allowed["wireless-connect"] = ["--address", "--device"];
    for (const operation of ["start", "pause", "resume", "stop", "action"]) allowed[operation].push("--backend");
    const backend = flags.get("--backend") || "app";
    if (!["app", "basic"].includes(backend)) throw new Error("--backend 必须为 app 或 basic。");
    for (const key of flags.keys()) if (!allowed[method].includes(key)) throw new Error(`${method} 不支持 ${key}`);
    if (method === "install") {
      const data = await installPhoneApkCli(flags, request);
      io.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + "\n"); return 0;
    }
    if (method === "run") {
      const data = await runPhoneFlowCli(flags, request) as { ok: boolean };
      io.stdout.write(JSON.stringify({ ok: data.ok, data }, null, 2) + "\n"); return data.ok ? 0 : 1;
    }
    let params: unknown = {};
    if (method === "wireless-connect") {
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
    } else if (method !== "list" && method !== "wireless-discover") {
      const id = flags.get("--device"); if (!id) throw new Error("请指定 --device，避免操作错误的手机。");
      params = method === "start" ? { id, mode: flags.get("--mode") || "control", controller: flags.get("--controller") || "本机 CLI", task: flags.get("--task") || "" } : method === "rename" ? { id, name: flags.get("--name") } : { id };
    }
    const response = await request({ action: "phone", method: backend === "basic" ? `basic-${method}` : method, params });
    if (response.ok && flags.has("--output")) {
      const data = response.data as { result?: { base64?: string; mime?: string }; state?: unknown };
      if (!["image/jpeg", "image/png"].includes(data.result?.mime || "") || typeof data.result?.base64 !== "string") throw new Error("此操作未返回截图。");
      await fs.writeFile(flags.get("--output")!, Buffer.from(data.result.base64, "base64"));
      response.data = { state: data.state, output: flags.get("--output") };
    }
    io.stdout.write(JSON.stringify(response, null, 2) + "\n"); return response.ok ? 0 : 1;
  } catch (error) { io.stderr.write(JSON.stringify({ ok: false, error: (error as Error).message }) + "\n"); return 1; }
}
