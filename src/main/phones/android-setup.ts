import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AndroidSetupAction, AndroidSetupJob, AndroidSetupRuntime, AndroidSetupSnapshot } from "../../shared/android-setup";
import { androidAvdHome, setupSdkRoot } from "./android-paths";
import { ANDROID_REPOSITORY, COMMAND_TOOLS_VERSION, androidHost, parseAndroidCatalog, type AndroidArchive, type AndroidCatalog } from "./android-repository";
import { downloadAndroidArchive, extractAndroidArchive, removeAndroidStage, runAndroidCommand } from "./android-install-io";

export interface AndroidSetupOptions {
  sdkRoot?: string; avdHome?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; arch?: string;
  fetch?: typeof fetch; run?: typeof runAndroidCommand;
  download?: typeof downloadAndroidArchive; extract?: typeof extractAndroidArchive;
  proxy?: () => Promise<string[]>;
}
export class AndroidSetup implements AndroidSetupRuntime {
  readonly sdkRoot: string;
  private env: NodeJS.ProcessEnv;
  private platform: NodeJS.Platform;
  private arch: string;
  private avdHome: string;
  private fetcher: typeof fetch;
  private run: typeof runAndroidCommand;
  private repository?: AndroidCatalog;
  private loading?: Promise<void>;
  private catalogError = "";
  private java = "";
  private javaChecked = false;
  private javaChecking?: Promise<void>;
  private job: AndroidSetupJob | null = null;
  private abort?: AbortController;
  private done?: Promise<void>;
  private closed = false;
  private running() { return this.job?.status === "running"; }
  constructor(private options: AndroidSetupOptions = {}) {
    this.env = options.env || process.env; this.platform = options.platform || process.platform; this.arch = options.arch || os.arch();
    this.sdkRoot = path.resolve(options.sdkRoot || setupSdkRoot(this.env, this.platform));
    this.avdHome = path.resolve(options.avdHome || androidAvdHome(this.env));
    this.fetcher = options.fetch || fetch; this.run = options.run || runAndroidCommand;
  }
  private binary(name: string) { return name + (this.platform === "win32" ? ".exe" : ""); }
  private tools(): string {
    const base = path.join(this.sdkRoot, "cmdline-tools");
    const versions = fs.existsSync(base) ? fs.readdirSync(base).sort().reverse() : [];
    return [COMMAND_TOOLS_VERSION, "latest", ...versions].map(v => path.join(base, v))
      .find(dir => ["sdkmanager", "avdmanager"].every(name => fs.existsSync(path.join(dir, "lib", `${name}-classpath.jar`))) &&
        fs.existsSync(path.join(dir, "source.properties")) && /^Pkg.Revision\s*=\s*19\.0\s*$/m.test(fs.readFileSync(path.join(dir, "source.properties"), "utf8"))) || "";
  }
  private async detectJava(): Promise<void> {
    if (this.javaChecked) return;
    if (this.javaChecking) return this.javaChecking;
    this.javaChecking = (async () => {
      const managed = path.join(this.sdkRoot, ".profilepilot", "java");
      const roots = [this.env.JAVA_HOME, managed,
        this.platform === "win32" ? path.join(this.env.ProgramFiles || "C:\\Program Files", "Android", "Android Studio", "jbr") : "/Applications/Android Studio.app/Contents/jbr/Contents/Home"];
      if (fs.existsSync(managed)) for (const item of fs.readdirSync(managed)) roots.push(path.join(managed, item), path.join(managed, item, "Contents", "Home"));
      for (const candidate of [...new Set(roots.filter(Boolean).map(root => path.join(root!, "bin", this.binary("java")))), "java"]) {
        try {
          const text = await this.run({ file: candidate, args: ["-version"], timeout: 6000 });
          const version = Number(text.match(/version\s+"(\d+)/)?.[1]);
          if (version >= 17) { this.java = candidate; break; }
        } catch { /* Try the next installed runtime. */ }
      }
      this.javaChecked = true;
    })().finally(() => { this.javaChecking = undefined; });
    return this.javaChecking;
  }
  async snapshot(): Promise<AndroidSetupSnapshot> {
    await this.detectJava();
    let supported = true, platformLabel = "暂不支持此系统";
    try { platformLabel = androidHost(this.platform, this.arch).label; } catch { supported = false; }
    const toolsReady = !!this.tools(), javaReady = !!this.java;
    const adbReady = fs.existsSync(path.join(this.sdkRoot, "platform-tools", this.binary("adb")));
    const emulatorReady = [this.binary("emulator"), "package.xml", path.join("lib", "hardware-properties.ini")].every(file => fs.existsSync(path.join(this.sdkRoot, "emulator", file)));
    return { supported, platformLabel, sdkRoot: this.sdkRoot, javaReady, toolsReady, adbReady, emulatorReady, ready: javaReady && toolsReady && adbReady && emulatorReady,
      images: (this.repository?.images || []).map(image => ({ ...image, installed: this.imageInstalled(image.id) })),
      licenses: this.repository?.licenses || [], licenseToken: this.repository?.licenseToken || "", catalogLoaded: !!this.repository, catalogError: this.catalogError, job: this.job && { ...this.job } };
  }
  async catalog(): Promise<AndroidSetupSnapshot> {
    if (this.closed) throw new Error("Android 安装服务已关闭。");
    if (!this.running()) this.javaChecked = false;
    if (!this.loading) this.loading = (async () => {
      try {
        const read = async (url: string) => { const r = await this.fetcher(url, { signal: AbortSignal.timeout(25000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); };
        const [base, images] = await Promise.all([read(ANDROID_REPOSITORY + "repository2-3.xml"), read(ANDROID_REPOSITORY + "sys-img/google_apis/sys-img2-3.xml")]);
        this.repository = parseAndroidCatalog(base, images, this.platform, this.arch); this.catalogError = "";
      } catch (error) { this.catalogError = `无法获取 Android 组件目录，请检查网络后重试。${error instanceof Error ? error.message.slice(0, 160) : ""}`; }
    })().finally(() => { this.loading = undefined; });
    await this.loading; return this.snapshot();
  }
  private imageInstalled(id: string): boolean {
    if (!/^system-images;android-\d+;google_apis;(x86_64|arm64-v8a)$/.test(id)) return false;
    const dir = path.join(this.sdkRoot, ...id.split(";"));
    return ["source.properties", "system.img", "userdata.img"].every(file => fs.existsSync(path.join(dir, file)));
  }
  private checkSpace(dir: string, bytes: number) {
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    const disk = fs.statfsSync(dir);
    if (disk.bavail * disk.bsize < bytes) throw new Error(`磁盘空间不足，请至少预留 ${Math.ceil(bytes / 1024 ** 3)} GB 后重试。`);
  }
  async start(action: AndroidSetupAction): Promise<AndroidSetupSnapshot> {
    if (this.closed) throw new Error("Android 安装服务已关闭。");
    if (this.running()) throw new Error("已有安装或创建任务正在进行，请稍候。");
    androidHost(this.platform, this.arch);
    if (!this.repository) throw new Error("请先获取 Android 组件目录。");
    const snapshot = await this.snapshot();
    if (this.closed) throw new Error("Android 安装服务已关闭。");
    // Recheck after asynchronous environment detection to serialize concurrent IPC calls.
    if (this.running()) throw new Error("已有安装或创建任务正在进行，请稍候。");
    if (action.kind !== "create" && action.licenseToken !== this.repository.licenseToken) throw new Error("请阅读并同意当前 Android 许可协议。");
    if (action.kind !== "environment" && !snapshot.ready) throw new Error("请先安装 Android 环境。");
    if (action.kind !== "environment" && !this.repository.images.some(image => image.id === action.imageId)) throw new Error("请选择适合这台电脑的系统镜像。");
    if (action.kind === "create") {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,49}$/.test(action.name)) throw new Error("设备名称请以英文字母开头，使用字母、数字、下划线或短横线，最多 50 个字符。");
      if (!Number.isInteger(action.memoryMb) || action.memoryMb < 1024 || action.memoryMb > 16384 || !Number.isInteger(action.storageGb) || action.storageGb < 2 || action.storageGb > 64) throw new Error("内存或存储大小无效。");
      if (!this.imageInstalled(action.imageId)) throw new Error("请先下载所选系统镜像。");
      if (this.avdExists(action.name)) throw new Error("已存在同名虚拟设备，请换一个名称。");
      this.checkSpace(this.avdHome, (action.storageGb + 2) * 1024 ** 3);
    } else this.checkSpace(this.sdkRoot, action.kind === "environment" ? 5 * 1024 ** 3 : (this.repository.images.find(i => i.id === action.imageId)!.bytes * 3 + 2 * 1024 ** 3));
    const job: AndroidSetupJob = { id: randomUUID(), kind: action.kind, status: "running", message: "正在准备…", progress: null, error: "", ...(action.kind === "create" ? { deviceName: action.name } : {}) };
    this.job = job; this.abort = new AbortController();
    const signal = this.abort.signal;
    this.done = this.perform(action, signal).then(() => { job.status = "succeeded"; job.progress = 100; job.message = action.kind === "create" ? `已创建 ${action.name}，可以启动并连接。` : action.kind === "image" ? "系统镜像已就绪，可以创建虚拟设备。" : "Android 环境已就绪。"; })
      .catch(error => { job.status = signal.aborted ? "cancelled" : "failed"; job.progress = null; job.message = signal.aborted ? "已取消。已完成安装的组件会保留。" : "操作未完成，可以重试。"; job.error = signal.aborted ? "" : (error instanceof Error ? error.message : String(error)).slice(-1800); });
    return this.snapshot();
  }
  private update(message: string, progress: number | null = null) { if (this.job) { this.job.message = message; this.job.progress = progress; } }
  private avdExists(name: string) { return fs.existsSync(path.join(this.avdHome, name + ".ini")) || fs.existsSync(path.join(this.avdHome, name + ".avd")); }
  private async command(tool: "sdkmanager" | "avdmanager", args: string[], signal: AbortSignal, input = "") {
    const tools = this.tools();
    if (!tools || !this.java) throw new Error("Android 命令行工具或 Java 运行环境未就绪。");
    const proxy = tool === "sdkmanager" ? await this.options.proxy?.() || [] : [];
    return this.run({ file: this.java, args: [`-Dcom.android.sdkmanager.toolsdir=${tools}`, "-cp", path.join(tools, "lib", `${tool}-classpath.jar`), tool === "sdkmanager" ? "com.android.sdklib.tool.sdkmanager.SdkManagerCli" : "com.android.sdklib.tool.AvdManagerCli", ...args, ...proxy],
      env: { ...this.env, ANDROID_HOME: this.sdkRoot, ANDROID_SDK_ROOT: this.sdkRoot, ANDROID_AVD_HOME: this.avdHome }, signal, input, timeout: 60 * 60 * 1000,
      output: text => { const values = [...text.matchAll(/(\d{1,3})%/g)]; if (values.length && this.job) this.job.progress = Math.min(100, Number(values.at(-1)![1])); } });
  }
  private async perform(action: AndroidSetupAction, signal: AbortSignal) {
    if (action.kind === "environment") {
      await this.bootstrap(signal);
      const state = await this.snapshot();
      const packages = [...(!state.adbReady ? ["platform-tools"] : []), ...(!state.emulatorReady ? ["emulator"] : [])];
      if (packages.length) { this.update("正在安装 Android 调试工具和模拟器…"); await this.command("sdkmanager", [`--sdk_root=${this.sdkRoot}`, "--install", ...packages], signal, "y\n".repeat(30)); }
      signal.throwIfAborted();
      if (!(await this.snapshot()).ready) throw new Error("Android 环境尚未完整安装，请重试以补齐缺少的组件。");
    } else if (action.kind === "image") {
      if (!this.imageInstalled(action.imageId)) {
        this.update("正在下载并安装系统镜像，首次下载可能需要较长时间…");
        await this.command("sdkmanager", [`--sdk_root=${this.sdkRoot}`, "--install", action.imageId], signal, "y\n".repeat(30));
      }
      signal.throwIfAborted();
      if (!this.imageInstalled(action.imageId)) throw new Error("系统镜像未完整安装，请重试。");
    } else {
      this.update(`正在创建 ${action.name}…`);
      // Do not use --force: an existing AVD, including one created concurrently, is never replaced.
      if (this.avdExists(action.name)) throw new Error("已存在同名虚拟设备，请换一个名称。");
      // avdmanager ignores ANDROID_AVD_HOME when the directory does not exist.
      fs.mkdirSync(this.avdHome, { recursive: true });
      await this.command("avdmanager", ["create", "avd", "--name", action.name, "--package", action.imageId, "--device", "pixel_6"], signal, "no\n");
      signal.throwIfAborted();
      const config = path.join(this.avdHome, action.name + ".avd", "config.ini");
      if (!fs.existsSync(config) || !fs.existsSync(path.join(this.avdHome, action.name + ".ini"))) throw new Error("未能确认虚拟设备创建结果，请刷新已有设备列表。");
      let content = fs.readFileSync(config, "utf8");
      for (const [key, value] of Object.entries({ "hw.ramSize": action.memoryMb, "disk.dataPartition.size": `${action.storageGb}G`, "hw.keyboard": "yes" })) {
        content = content.split(/\r?\n/).filter(line => line.split("=")[0].trim() !== key).join("\n");
        content += `\n${key}=${value}\n`;
      }
      fs.writeFileSync(config, content);
    }
  }
  private async bootstrap(signal: AbortSignal) {
    fs.mkdirSync(this.sdkRoot, { recursive: true });
    const parent = path.join(this.sdkRoot, ".profilepilot"); fs.mkdirSync(parent, { recursive: true });
    const stage = fs.mkdtempSync(path.join(parent, "install-"));
    try {
      if (!this.tools()) {
        this.update("正在下载 Android 命令行工具…", 0);
        const archive = path.join(stage, "tools.zip"), dest = path.join(stage, "tools");
        await (this.options.download || downloadAndroidArchive)(this.repository!.tools, archive, this.fetcher, signal, p => this.update("正在下载 Android 命令行工具…", p));
        this.update("正在解压 Android 命令行工具…");
        await (this.options.extract || extractAndroidArchive)(archive, dest, signal);
        const source = path.join(dest, "cmdline-tools"), target = path.join(this.sdkRoot, "cmdline-tools", COMMAND_TOOLS_VERSION);
        if (!fs.existsSync(path.join(source, "lib", "avdmanager-classpath.jar"))) throw new Error("命令行工具安装包不完整。");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await this.commitDirectory(source, target, stage);
      }
      if (!this.java) {
        this.update("正在准备 Java 运行环境…");
        const platform = this.platform === "win32" ? "windows" : this.platform === "darwin" ? "mac" : "linux";
        const architecture = this.arch === "arm64" ? "aarch64" : "x64";
        const response = await this.fetcher(`https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=${architecture}&image_type=jdk&os=${platform}&vendor=eclipse`, { signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
        if (!response.ok) throw new Error("无法获取 Java 安装包，请检查网络后重试。");
        const assets: any = await response.json(), pkg = assets?.[0]?.binary?.package;
        const url = new URL(pkg?.link || "https://invalid.invalid");
        if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/adoptium/temurin21-binaries/releases/download/") || !/^[a-f0-9]{64}$/i.test(pkg?.checksum || "") || !Number(pkg?.size)) throw new Error("Java 安装包信息无效。");
        const descriptor: AndroidArchive = { url: url.href, checksum: pkg.checksum, algorithm: "sha256", bytes: Number(pkg.size) };
        const archive = path.join(stage, this.platform === "win32" ? "java.zip" : "java.tar.gz"), dest = path.join(stage, "java");
        await (this.options.download || downloadAndroidArchive)(descriptor, archive, this.fetcher, signal, p => this.update("正在下载 Java 运行环境…", p));
        this.update("正在解压 Java 运行环境…");
        await (this.options.extract || extractAndroidArchive)(archive, dest, signal);
        await this.commitDirectory(dest, path.join(parent, "java"), stage);
        this.javaChecked = false; await this.detectJava();
        if (!this.java) throw new Error("Java 运行环境未能启动，请检查安装目录权限后重试。");
      }
    } finally { await removeAndroidStage(stage, parent); }
  }
  private async commitDirectory(source: string, target: string, stage: string) {
    // Repair only the requested fixed tool version/runtime, never the user's latest tools.
    const allowed = [path.join(this.sdkRoot, "cmdline-tools", COMMAND_TOOLS_VERSION), path.join(this.sdkRoot, ".profilepilot", "java")];
    if (!allowed.includes(target)) throw new Error("Invalid Android installation target.");
    const backup = path.join(stage, "previous-" + path.basename(target));
    const previous = fs.existsSync(target);
    if (previous) await fs.promises.rename(target, backup);
    try { await fs.promises.rename(source, target); }
    catch (error) { if (previous) await fs.promises.rename(backup, target); throw error; }
  }
  async cancel(id: string): Promise<AndroidSetupSnapshot> {
    if (this.job?.id !== id) throw new Error("安装任务已变化，请刷新后重试。");
    if (this.job.status === "running") { this.update("正在取消，请稍候…"); this.abort?.abort(); }
    return this.snapshot();
  }
  async close() { this.closed = true; this.abort?.abort(); await this.done; }
}
