import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import extractZip from "extract-zip";
import plist from "plist";
import { ZipFile } from "yazl";
import { z } from "zod";
import { iphoneBundleId } from "./iphone-usb";
import { iphoneUdid, type IphoneTools } from "./iphone-tools";

const exec = promisify(execFile);
const PY_MOBILE_VERSION = "11.48.0";

export type ExecRunner = (file: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;

export interface MacCodesignIdentity {
  hash: string;
  name: string;
}

export function parseMacCodesignIdentities(output: string): MacCodesignIdentity[] {
  const identities: MacCodesignIdentity[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/i.exec(line);
    if (!match) continue;
    identities.push({ hash: match[1].toUpperCase(), name: match[2] });
  }
  identities.sort((a, b) => {
    const devA = /Apple Development|iPhone Developer/i.test(a.name) ? 0 : 1;
    const devB = /Apple Development|iPhone Developer/i.test(b.name) ? 0 : 1;
    return devA - devB;
  });
  return identities;
}

/** Private optional signing environment: Sideloadly repair on Windows, native codesign on macOS. */
export class IphoneSigning {
  private preparing?: Promise<{ ready: boolean }>;
  private signing = false;
  constructor(
    private tools: IphoneTools,
    private platform: NodeJS.Platform = process.platform,
    private runExec: ExecRunner = exec as unknown as ExecRunner,
    private profileDirs?: string[]
  ) {}

  private python(): string {
    // Wheels contain long paths (notably pywin32). Keep the environment out of deep project/data paths.
    return path.join(os.homedir(), ".profilepilot", "iphone-signing", `pmd-${PY_MOBILE_VERSION}`, this.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  }

  setup(): Promise<{ ready: boolean }> {
    if (!this.preparing) this.preparing = this.prepare().finally(() => { this.preparing = undefined; });
    return this.preparing;
  }

  private async findMacIdentity(): Promise<MacCodesignIdentity> {
    const { stdout } = await this.runExec("security", ["find-identity", "-v", "-p", "codesigning"], { timeout: 10000 });
    const identities = parseMacCodesignIdentities(stdout);
    const dev = identities.find(item => /Apple Development|iPhone Developer/i.test(item.name)) || identities[0];
    if (!dev) {
      throw new Error("未在 macOS 钥匙串中找到可用的 Apple Development 签名证书。请先在 Xcode → Settings → Accounts 中登录 Apple ID 并生成开发证书。");
    }
    return dev;
  }

  private async findMacProvisioningProfile(udid: string, requestedBundleId?: string): Promise<{ file: string; bundleId: string; expiresAt: string; entitlements: Record<string, unknown> }> {
    const dirs = this.profileDirs || [
      path.join(os.homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles"),
      path.join(os.homedir(), "Library/MobileDevice/Provisioning Profiles"),
      path.join(this.tools.directory, "profiles")
    ];
    const candidates: Array<{ file: string; bundleId: string; expiresAt: Date; entitlements: Record<string, unknown>; wildcard: boolean }> = [];
    for (const dir of dirs) {
      const entries = await fs.readdir(dir).catch(() => [] as string[]);
      for (const entry of entries) {
        if (!entry.endsWith(".mobileprovision") && !entry.endsWith(".provisionprofile")) continue;
        const full = path.join(dir, entry);
        try {
          const { stdout } = await this.runExec("security", ["cms", "-D", "-i", full], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
          const parsed = plist.parse(stdout) as Record<string, any>;
          const expiration = parsed.ExpirationDate instanceof Date ? parsed.ExpirationDate : new Date(String(parsed.ExpirationDate || ""));
          if (Number.isNaN(expiration.getTime()) || expiration.getTime() <= Date.now()) continue;
          const provisioned = Array.isArray(parsed.ProvisionedDevices) ? parsed.ProvisionedDevices.map(String) : [];
          if (!parsed.ProvisionsAllDevices && !provisioned.includes(udid)) continue;
          const entitlements = (parsed.Entitlements && typeof parsed.Entitlements === "object") ? { ...parsed.Entitlements } as Record<string, unknown> : {};
          const appId = String(entitlements["application-identifier"] || "");
          const dot = appId.indexOf(".");
          if (dot <= 0) continue;
          const teamPrefix = appId.slice(0, dot);
          const pattern = appId.slice(dot + 1);
          const wildcard = pattern === "*" || pattern.endsWith(".*");
          let resolvedBundleId = requestedBundleId || "";
          if (wildcard) {
            const prefix = pattern === "*" ? "" : pattern.slice(0, -1);
            if (!resolvedBundleId) {
              resolvedBundleId = prefix ? `${prefix}WebDriverAgentRunner` : `io.github.profilepilot.wda.${teamPrefix.toLowerCase()}`;
            } else if (prefix && !resolvedBundleId.startsWith(prefix)) {
              continue;
            }
          } else {
            if (resolvedBundleId && resolvedBundleId !== pattern) continue;
            resolvedBundleId = pattern;
          }
          iphoneBundleId.parse(resolvedBundleId);
          entitlements["application-identifier"] = `${teamPrefix}.${resolvedBundleId}`;
          candidates.push({ file: full, bundleId: resolvedBundleId, expiresAt: expiration, entitlements, wildcard });
        } catch {
          /* Ignore unreadable or unrelated profile files. */
        }
      }
    }
    candidates.sort((a, b) => {
      if (a.wildcard !== b.wildcard) return a.wildcard ? 1 : -1;
      const wdaA = /webdriveragent|wda/i.test(a.bundleId) ? 0 : 1;
      const wdaB = /webdriveragent|wda/i.test(b.bundleId) ? 0 : 1;
      if (wdaA !== wdaB) return wdaA - wdaB;
      return b.expiresAt.getTime() - a.expiresAt.getTime();
    });
    const best = candidates[0];
    if (!best) {
      throw new Error("未找到包含此 iPhone UDID 且未过期的 iOS 开发描述文件（.mobileprovision）。请先在 Xcode 中连接此 iPhone 创建任意空项目自动生成描述文件，然后重试。");
    }
    return { file: best.file, bundleId: best.bundleId, expiresAt: best.expiresAt.toISOString(), entitlements: best.entitlements };
  }

  private async prepare(): Promise<{ ready: boolean }> {
    if (this.platform === "darwin") {
      await fs.mkdir(this.tools.directory, { recursive: true });
      await this.findMacIdentity();
      await this.runExec("codesign", ["--help"], { timeout: 5000 }).catch(async () => {
        await this.runExec("xcrun", ["--find", "codesign"], { timeout: 5000 });
      });
      return { ready: true };
    }
    if (this.platform !== "win32") throw new Error("本地自动签名当前支持 Windows（Sideloadly）和 macOS（本机开发者证书）。");
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
          await this.runExec(command, [...prefix, "-c", "import sys; assert sys.version_info >= (3,11)"], { windowsHide: true, timeout: 10000 });
          await this.runExec(command, [...prefix, "-m", "venv", path.dirname(path.dirname(this.python()))], { windowsHide: true, timeout: 90000, maxBuffer: 1024 * 1024 }); created = true; break;
        } catch { /* The GUI app may not inherit the shell's Python PATH. */ }
      }
      if (!created) throw new Error("签名准备需要 Python 3.11 或更新版本，请先安装 Python 后重试。USB 连接本身不依赖 Python。");
    }
    const check = () => this.runExec(this.python(), ["-c", `import importlib.metadata as m; assert m.version('pymobiledevice3') == '${PY_MOBILE_VERSION}'; from pymobiledevice3.lockdown import create_using_usbmux; from pymobiledevice3.services.misagent import MisagentService; from cryptography.hazmat.primitives.serialization import pkcs12`], { windowsHide: true, timeout: 15000 });
    try {
      await check();
    } catch {
      try { await this.runExec(this.python(), ["-m", "pip", "install", "--disable-pip-version-check", `pymobiledevice3==${PY_MOBILE_VERSION}`], { windowsHide: true, timeout: 240000, maxBuffer: 2 * 1024 * 1024 }); await check(); }
      catch { throw new Error("签名工具下载失败，请检查 Python 版本及网络后重试。"); }
    }
    return { ready: true };
  }

  private async repairMac(udid: string, bundleId?: string): Promise<{ bundleId: string; expiresAt: string; nextStep: string }> {
    const device = (await this.tools.devices()).find(item => item.udid === udid);
    if (!device || device.error) throw new Error(device?.error || "请连接所选 iPhone 后再签名。");
    const identity = await this.findMacIdentity();
    const profile = await this.findMacProvisioningProfile(udid, bundleId);
    const artifact = await this.tools.prepareWda();
    const temporary = await fs.mkdtemp(path.join(this.tools.directory, "mac-signing-"));
    await fs.chmod(temporary, 0o700);
    try {
      const modes = new Map<string, number>();
      await extractZip(artifact.ipa, { dir: temporary, onEntry: entry => { modes.set(entry.fileName, entry.externalFileAttributes >>> 16); } });
      const appDir = path.join(temporary, "Payload", "WebDriverAgentRunner-Runner.app");
      await fs.copyFile(profile.file, path.join(appDir, "embedded.mobileprovision"));
      await this.rewriteBundleIdPlist(path.join(appDir, "Info.plist"), profile.bundleId);

      const pluginsDir = path.join(appDir, "PlugIns");
      for (const item of await fs.readdir(pluginsDir, { withFileTypes: true }).catch(() => [])) {
        if (!item.isDirectory() || !item.name.endsWith(".xctest")) continue;
        const xctestDir = path.join(pluginsDir, item.name);
        await this.rewriteBundleIdPlist(path.join(xctestDir, "Info.plist"), `${profile.bundleId}.xctrunner`).catch(() => {});
        for (const fw of await fs.readdir(path.join(xctestDir, "Frameworks"), { withFileTypes: true }).catch(() => [])) {
          if (fw.isDirectory() || fw.isFile()) {
            await this.runExec("codesign", ["--force", "--sign", identity.hash, "--timestamp=none", path.join(xctestDir, "Frameworks", fw.name)], { timeout: 30000 });
          }
        }
        await this.runExec("codesign", ["--force", "--sign", identity.hash, "--timestamp=none", xctestDir], { timeout: 30000 });
      }
      for (const fw of await fs.readdir(path.join(appDir, "Frameworks"), { withFileTypes: true }).catch(() => [])) {
        if (fw.isDirectory() || fw.isFile()) {
          await this.runExec("codesign", ["--force", "--sign", identity.hash, "--timestamp=none", path.join(appDir, "Frameworks", fw.name)], { timeout: 30000 });
        }
      }

      const entitlementsFile = path.join(temporary, "entitlements.plist");
      await fs.writeFile(entitlementsFile, plist.build(profile.entitlements as plist.PlistValue), "utf8");
      await this.runExec("codesign", ["--force", "--sign", identity.hash, "--entitlements", entitlementsFile, "--timestamp=none", appDir], { timeout: 45000 });

      const signedIpa = path.join(temporary, "signed.ipa");
      await this.zipPayloadApp(appDir, signedIpa, modes);
      await this.tools.installSigned(udid, signedIpa);
      return {
        bundleId: profile.bundleId,
        expiresAt: profile.expiresAt,
        nextStep: "已使用 macOS 本机开发者证书签名并安装 WebDriverAgent。请保持手机解锁，启动 USB 连接。"
      };
    } finally {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async rewriteBundleIdPlist(plistPath: string, bundleId: string): Promise<void> {
    const raw = await fs.readFile(plistPath);
    // Support XML plists directly via `plist`, or convert binary plists on macOS via `plutil`.
    let text = raw.toString("utf8");
    let wasBinary = false;
    if (raw.subarray(0, 6).toString("ascii") === "bplist") {
      wasBinary = true;
      await this.runExec("plutil", ["-convert", "xml1", plistPath], { timeout: 5000 });
      text = await fs.readFile(plistPath, "utf8");
    }
    const parsed = plist.parse(text) as Record<string, unknown>;
    parsed.CFBundleIdentifier = bundleId;
    await fs.writeFile(plistPath, plist.build(parsed as plist.PlistValue), "utf8");
    if (wasBinary) {
      await this.runExec("plutil", ["-convert", "binary1", plistPath], { timeout: 5000 }).catch(() => {});
    }
  }

  private async zipPayloadApp(appDir: string, destinationIpa: string, modes: Map<string, number>): Promise<void> {
    const zip = new ZipFile();
    async function add(folder: string, relative: string): Promise<void> {
      for (const item of await fs.readdir(folder, { withFileTypes: true })) {
        const full = path.join(folder, item.name);
        const rel = `${relative}/${item.name}`;
        if (item.isSymbolicLink()) continue;
        const stat = await fs.stat(full);
        const mode = modes.get(rel) || (item.isDirectory() ? 0o40755 : (stat.mode & 0o111) ? 0o100755 : 0o100644);
        if (item.isDirectory()) {
          zip.addEmptyDirectory(rel, { mode });
          await add(full, rel);
        } else if (item.isFile()) {
          zip.addFile(full, rel, { mode });
        }
      }
    }
    await add(appDir, "Payload/WebDriverAgentRunner-Runner.app");
    const output = pipeline(zip.outputStream, createWriteStream(destinationIpa));
    zip.end();
    await output;
  }

  async repair(udid: string, bundleId?: string): Promise<{ bundleId: string; expiresAt: string; nextStep: string }> {
    iphoneUdid.parse(udid); if (bundleId) iphoneBundleId.parse(bundleId);
    if (this.signing) throw new Error("已有 iPhone 签名任务正在运行。");
    if (this.platform === "darwin") {
      this.signing = true;
      try { return await this.repairMac(udid, bundleId); }
      finally { this.signing = false; }
    }
    if (this.platform !== "win32") throw new Error("自动签名当前支持 Windows 和 macOS。");
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
      try { output = (await this.runExec(this.python(), [helper, udid, temporary, bundleId || ""], { windowsHide: true, timeout: 45000, maxBuffer: 64 * 1024, env: { ...process.env, PYTHONIOENCODING: "utf-8" } })).stdout; }
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
