import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import extractZip from "extract-zip";
import { z } from "zod";
import type { IphoneToolsStatus, IphoneUsbDevice, IphoneWdaArtifact } from "../../shared/iphones";
import { downloadVerified, prepareWda } from "./iphone-artifact";

const exec = promisify(execFile);
const toolEnvironment = () => ({ ...process.env, ENABLE_GO_IOS_AGENT: "", GO_IOS_UDID: "", USBMUXD_SOCKET_ADDRESS: process.platform === "win32" ? "tcp://127.0.0.1:27015" : "unix:///var/run/usbmuxd" });
export const GO_IOS_VERSION = "1.3.2";
const archives = {
  win32: { name: "go-ios-win.zip", sha256: "939c6bcaafed183a92afb9f79cc11b1f935fa6389bfc94d3902e3f52c4dff3fe", executable: "ios.exe" },
  darwin: { name: "go-ios-mac.zip", sha256: "100f225bfdd039081bcbdaf45029df3e67032673f3e0ca1fa3c050898c230c57", executable: "ios" }
};
export const iphoneUdid = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{8}-[a-fA-F0-9]{16})$/, "请使用 USB 设备列表返回的 iPhone UDID。");
export type IphoneToolRunner = (executable: string, args: string[], timeoutMs?: number) => Promise<string>;
const runTool: IphoneToolRunner = async (executable, args, timeoutMs = 15000) => {
  try {
    const result = await exec(executable, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: "utf8",
      env: toolEnvironment() });
    return result.stdout;
  } catch (error) {
    const failure = error as Error & { code?: string; killed?: boolean };
    // Command stderr can contain device pairing details. Return a bounded diagnosis instead.
    throw new Error(failure.killed ? "iPhone USB 查询超时，请解锁手机并确认已信任电脑。" : `iPhone USB 工具执行失败（${failure.code || "device-error"}），请确认 Apple 设备驱动、数据线和手机信任状态。`);
  }
};

export class IphoneTools {
  readonly directory: string;
  private preparing?: Promise<IphoneToolsStatus>;
  private preparingWda?: Promise<IphoneWdaArtifact>;
  constructor(root: string, private platform: NodeJS.Platform = process.platform, private fetcher: typeof fetch = fetch, private runner: IphoneToolRunner = runTool) {
    this.directory = path.join(root, "iphone-tools", `go-ios-${GO_IOS_VERSION}-${platform}`);
  }
  private archive() {
    if (this.platform !== "win32" && this.platform !== "darwin") throw new Error("iPhone USB 准备当前支持 Windows 和 macOS。");
    return archives[this.platform];
  }
  executable(): string { return path.join(this.directory, this.archive().executable); }
  spawn(args: string[]): ChildProcess {
    if (!existsSync(this.executable())) throw new Error("请先安装 iPhone USB 连接工具。");
    return spawn(this.executable(), args, { windowsHide: true, stdio: ["ignore", "ignore", "ignore"], env: toolEnvironment() });
  }
  prepareWda(): Promise<IphoneWdaArtifact> {
    if (!this.preparingWda) this.preparingWda = prepareWda(path.dirname(this.directory), this.fetcher).finally(() => { this.preparingWda = undefined; });
    return this.preparingWda;
  }
  async run(args: string[], timeoutMs?: number): Promise<string> {
    if (!existsSync(this.executable())) throw new Error("请先运行 ppilot phone iphone setup，安装 iPhone USB 连接工具。");
    return this.runner(this.executable(), args, timeoutMs);
  }
  async devices(): Promise<IphoneUsbDevice[]> {
    const list = parseGoIosJson(await this.run(["list"]));
    const raw = z.object({ deviceList: z.array(iphoneUdid).max(100) }).parse(list).deviceList;
    return Promise.all(raw.map(async udid => {
      try {
        const info = z.object({ DeviceName: z.string().max(200), ProductVersion: z.string().max(50), ProductType: z.string().max(80), UniqueDeviceID: iphoneUdid }).passthrough().parse(parseGoIosJson(await this.run(["info", `--udid=${udid}`])));
        if (info.UniqueDeviceID !== udid) throw new Error("iPhone 身份与 USB 列表不一致。");
        return { udid, name: info.DeviceName, version: info.ProductVersion, product: info.ProductType };
      } catch (error) { return { udid, name: "iPhone · 等待信任", error: (error as Error).message }; }
    }));
  }
  async doctor(): Promise<IphoneToolsStatus> {
    const status: IphoneToolsStatus = { platform: this.platform, installed: false, version: GO_IOS_VERSION, directory: this.directory, devices: [], nextStep: "安装 USB 连接工具。" };
    try {
      if (!existsSync(this.executable())) return status;
      const version = z.object({ version: z.literal(GO_IOS_VERSION) }).parse(parseGoIosJson(await this.run(["version"], 5000)));
      status.version = version.version; status.installed = true;
      status.devices = await this.devices();
      status.nextStep = status.devices.length ? "选择目标 iPhone，检查开发者模式并安装签名后的 WebDriverAgent。"
        : this.platform === "win32" ? "安装 Microsoft Store 的 Apple 设备应用，再用数据线连接 iPhone，解锁并信任此电脑。" : "用数据线连接 iPhone，解锁并信任此 Mac。";
    } catch (error) { status.error = (error as Error).message; status.nextStep = this.platform === "win32" ? "检查 Apple 设备驱动、USB 数据线和手机上的信任提示。" : "检查 USB 数据线和手机上的信任提示。"; }
    return status;
  }
  setup(): Promise<IphoneToolsStatus> {
    if (this.preparing) return this.preparing;
    this.preparing = this.prepare().finally(() => { this.preparing = undefined; }); return this.preparing;
  }
  private async prepare(): Promise<IphoneToolsStatus> {
    const archive = this.archive();
    if (existsSync(this.executable())) {
      const status = await this.doctor(); if (status.installed) return status;
      await fs.rename(this.executable(), `${this.executable()}.invalid-${Date.now()}`);
    }
    await fs.mkdir(this.directory, { recursive: true });
    const zip = path.join(this.directory, archive.name);
    const content = await downloadVerified(`https://github.com/danielpaulus/go-ios/releases/download/v${GO_IOS_VERSION}/${archive.name}`, archive.sha256, this.fetcher);
    await fs.writeFile(zip, content);
    await extractZip(zip, { dir: this.directory });
    if (this.platform === "darwin") await fs.chmod(this.executable(), 0o755);
    const status = await this.doctor();
    if (!status.installed) throw new Error(status.error || "iPhone 连接工具未通过版本检查。");
    return status;
  }
  async revealDeveloperMode(udid: string): Promise<{ udid: string; nextStep: string }> {
    iphoneUdid.parse(udid);
    const device = (await this.devices()).find(item => item.udid === udid);
    if (!device || device.error) throw new Error(device?.error || "该 iPhone 未连接，请重新读取 USB 列表。");
    await this.run(["devmode", "reveal", `--udid=${udid}`]);
    return { udid, nextStep: "请在 iPhone 的设置 → 隐私与安全性中开启开发者模式，按手机提示重启并确认。" };
  }
  async installSigned(udid: string, ipa: string): Promise<{ nextStep: string }> {
    iphoneUdid.parse(udid);
    const file = path.resolve(z.string().min(1).max(32768).parse(ipa)), stat = await fs.stat(file);
    if (path.extname(file).toLowerCase() !== ".ipa" || !stat.isFile() || stat.size > 200 * 1024 * 1024) throw new Error("请选择已签名的 iPhone IPA 安装包。");
    const device = (await this.devices()).find(item => item.udid === udid);
    if (!device || device.error) throw new Error(device?.error || "该 iPhone 未连接。");
    await this.run(["install", `--path=${file}`, `--udid=${udid}`], 120000);
    return { nextStep: "安装已完成，请在手机上信任开发者证书，再启动 USB 连接。" };
  }
}

/** go-ios may write JSON log lines before its single result. Never parse logs as a device list. */
export function parseGoIosJson(output: string): any {
  try { return JSON.parse(output.trim()); } catch { /* JSON log prefix */ }
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try { const value = JSON.parse(line); if (value && typeof value === "object" && !("level" in value && "msg" in value)) return value; } catch { /* log text */ }
  }
  throw new Error("iPhone USB 工具未返回有效的设备信息。");
}
