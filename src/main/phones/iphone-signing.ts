import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { iphoneBundleId } from "./iphone-usb";
import { iphoneUdid, type IphoneTools } from "./iphone-tools";

const exec = promisify(execFile);
const PY_MOBILE_VERSION = "11.48.0";
/** Private optional Python environment; no system package updates or Apple authentication. */
export class IphoneSigning {
  private preparing?: Promise<{ ready: boolean }>;
  private signing = false;
  constructor(private tools: IphoneTools) {}
  private python(): string {
    // Wheels contain long paths (notably pywin32). Keep the environment out of deep project/data paths.
    return path.join(os.homedir(), ".profilepilot", "iphone-signing", `pmd-${PY_MOBILE_VERSION}`, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  }
  setup(): Promise<{ ready: boolean }> {
    if (!this.preparing) this.preparing = this.prepare().finally(() => { this.preparing = undefined; });
    return this.preparing;
  }
  private async prepare(): Promise<{ ready: boolean }> {
    if (process.platform !== "win32") throw new Error("Sideloadly 本地签名修复当前用于 Windows；macOS 请用 Xcode 签名安装，或导入已签名 IPA。");
    await fs.mkdir(this.tools.directory, { recursive: true });
    if (!existsSync(this.python())) {
      await fs.mkdir(path.dirname(path.dirname(this.python())), { recursive: true });
      const candidates: Array<[string, string[]]> = [];
      const local = process.env.LOCALAPPDATA;
      if (local) {
        const installed = path.join(local, "Programs", "Python");
        const names = await fs.readdir(installed).catch(() => [] as string[]);
        for (const name of names.filter(name => /^Python3\d+(?:-arm64|-32)?$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })))
          candidates.push([path.join(installed, name, "python.exe"), []]);
        candidates.push([path.join(installed, "Launcher", "py.exe"), ["-3"]]);
      }
      candidates.push(["py", ["-3"]], ["python", []]);
      let created = false;
      for (const [command, prefix] of candidates) {
        try {
          await exec(command, [...prefix, "-c", "import sys; assert sys.version_info >= (3,11)"], { windowsHide: true, timeout: 10000 });
          await exec(command, [...prefix, "-m", "venv", path.dirname(path.dirname(this.python()))], { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 }); created = true; break;
        } catch { /* The GUI app may not inherit the shell's Python PATH. */ }
      }
      if (!created) throw new Error("签名准备需要 Python 3.11 或更新版本，请先安装 Python 后重试。USB 连接本身不依赖 Python。");
    }
    const check = () => exec(this.python(), ["-c", `import importlib.metadata as m; assert m.version('pymobiledevice3') == '${PY_MOBILE_VERSION}'; from pymobiledevice3.lockdown import create_using_usbmux; from pymobiledevice3.services.misagent import MisagentService; from cryptography.hazmat.primitives.serialization import pkcs12`], { windowsHide: true, timeout: 15000 });
    try {
      await check();
    } catch {
      try { await exec(this.python(), ["-m", "pip", "install", "--disable-pip-version-check", `pymobiledevice3==${PY_MOBILE_VERSION}`], { windowsHide: true, timeout: 240000, maxBuffer: 2 * 1024 * 1024 }); await check(); }
      catch { throw new Error("签名工具下载失败，请检查 Python 版本及网络后重试。"); }
    }
    return { ready: true };
  }
  async repair(udid: string, bundleId?: string): Promise<{ bundleId: string; expiresAt: string; nextStep: string }> {
    iphoneUdid.parse(udid); if (bundleId) iphoneBundleId.parse(bundleId);
    if (process.platform !== "win32") throw new Error("此入口用于 Windows 上的 Sideloadly 签名。");
    if (this.signing) throw new Error("已有 iPhone 签名任务正在运行。");
    this.signing = true; let temporary: string | undefined;
    try {
      if (!existsSync(this.python())) throw new Error("请先准备 Windows 签名工具。");
      const device = (await this.tools.devices()).find(item => item.udid === udid);
      if (!device || device.error) throw new Error(device?.error || "请连接所选 iPhone 后再签名。");
      const artifact = await this.tools.prepareWda();
      temporary = await fs.mkdtemp(path.join(this.tools.directory, "signing-")); await fs.chmod(temporary, 0o700);
      // This module is built to dist/main/phones; public is shipped beside dist, including in asar.
      const helper = path.join(this.tools.directory, "sideloadly_identity.py");
      await fs.writeFile(helper, await fs.readFile(path.resolve(__dirname, "../../../public/iphone/sideloadly_identity.py")));
      let output: string;
      try { output = (await exec(this.python(), [helper, udid, temporary, bundleId || ""], { windowsHide: true, timeout: 45000, maxBuffer: 64 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8" } })).stdout; }
      catch (error) {
        const stdout = String((error as { stdout?: string }).stdout || "");
        const code = /"error":\s*"([a-z_]+)"/.exec(stdout)?.[1];
        throw new Error(code === "bundle_ambiguous" ? "手机有多个 WDA 签名，请填写 bundle ID 后重试。" : "请先在 Sideloadly 中使用你的 Apple ID 为准备好的 WDA 安装包签名并安装一次；解锁手机、信任电脑，再重试此步骤。也请确认免费签名尚未过期。");
      }
      const result = z.object({ bundleId: iphoneBundleId, expiresAt: z.string().datetime({ offset: true }) }).parse(JSON.parse(output));
      const signed = path.join(temporary, "signed.ipa");
      await this.tools.run(["sign", "app", `--udid=${udid}`, `--path=${artifact.ipa}`, `--p12file=${path.join(temporary, "identity.p12")}`, `--profile=${path.join(temporary, "profile.mobileprovision")}`, `--bundleid=${result.bundleId}`, `--output=${signed}`], 120000);
      await this.tools.installSigned(udid, signed);
      return { ...result, nextStep: "控制组件及内部测试包已重新签名并安装。请保持手机解锁，启动 USB 连接。" };
    } finally {
      if (temporary) {
        for (const name of ["identity.p12", "profile.mobileprovision", "signed.ipa"]) await fs.unlink(path.join(temporary, name)).catch(() => {});
        await fs.rmdir(temporary).catch(() => {});
      }
      this.signing = false;
    }
  }
}
