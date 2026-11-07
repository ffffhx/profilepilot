import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { phoneGroupFlags } from "./cli-contract";
import { phoneErrorResult, phoneExitCode, phoneResponseError } from "./errors";

export const iphoneHelp = `ppilot phone iphone setup
ppilot phone iphone doctor
ppilot phone iphone devices
ppilot phone iphone prepare-wda
ppilot phone iphone signing-setup
ppilot phone iphone sign-sideloadly --udid <UDID> [--bundle-id <bundleID>]
ppilot phone iphone install-signed --udid <UDID> --ipa <已签名IPA路径>
ppilot phone iphone usb-start --udid <UDID> [--bundle-id <bundleID>] [--name iPhone]
ppilot phone iphone usb-status
ppilot phone iphone usb-stop --udid <UDID>
ppilot phone iphone devmode-reveal --udid <USB列表返回的UDID>
ppilot phone iphone add --endpoint http://127.0.0.1:8100 [--name iPhone]
ppilot phone iphone remove --device <iphone-ID>

Windows/macOS 的 iOS 18+ 真机可使用 USB 启动，也可连接已启动的 WebDriverAgent 本机/局域网地址。
usb-start 在后台准备连接，用 usb-status 查询阶段和设备ID；拔线/失败后不会自动恢复控制。
没有 Mac：prepare-wda 获取安装包，在 Sideloadly 中由本人登录 Apple ID 并签名安装一次。
随后 signing-setup、sign-sideloadly 使用本地开发证书和手机上的有效描述文件为内部测试包补签并安装。
签名工具需 Python 3.11+，不读取 Apple 登录会话；临时签名材料用完删除。免费签名过期后需重新签名。
首次使用需安装签名后的 WebDriverAgent、开启开发者模式并信任电脑。
添加只验证连接；用 phone start --device <ID> --mode view|control 显式开始会话。
操作沿用 phone action/pause/resume/stop。iPhone 不使用 --backend basic，也不支持 Android ADB/APK 命令。
坐标以最近 screenshot 返回的像素为准；内部自动换算 iPhone 的逻辑点，输入后须重新截图。
`;
export async function runIphoneCli(args: string[], request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>, io: Pick<NodeJS.Process, "stdout" | "stderr">): Promise<number> {
  if (!args.length || args.includes("--help")) { io.stdout.write(iphoneHelp); return 0; }
  let dispatched = false;
  try {
    const method = args[0], flags = new Map<string, string>();
    const options = phoneGroupFlags.iphone;
    if (!Object.hasOwn(options, method)) throw new Error("未知 iPhone 命令。运行 ppilot phone iphone --help 查看用法。");
    const allowed = options[method];
    for (let i = 1; i < args.length; i += 2) {
      if (!allowed.includes(args[i]) || flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`参数无效：${args[i]}`);
      flags.set(args[i], args[i + 1]);
    }
    if (allowed.length && !flags.has(allowed[0])) throw new Error(`请提供 ${allowed[0]}。`);
    if (method === "install-signed" && !flags.has("--ipa")) throw new Error("请提供 --ipa。");
    const params: Record<string, string> = {};
    for (const [flag, value] of flags) params[flag === "--device" ? "id" : flag === "--bundle-id" ? "bundleId" : flag.slice(2)] = value;
    dispatched = true;
    const result = await request({ action: "phone", method: method === "remove" ? "iphone-forget" : `iphone-${method}`, params: method === "add"
      ? { ...params, name: flags.get("--name") || "iPhone" } : params });
    if (!result.ok) throw phoneResponseError(result);
    io.stdout.write(JSON.stringify(result, null, 2) + "\n"); return 0;
  } catch (error) { const result = phoneErrorResult(error, dispatched); io.stderr.write(JSON.stringify(result) + "\n"); return phoneExitCode(result.recovery); }
}
