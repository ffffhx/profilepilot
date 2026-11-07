import { z } from "zod";
import { PhonesService, phoneActionSchema, type PhoneCommandSource } from "./service";
import { cameraStartSchema, cameraCommandSchema } from "./screen-camera";
import { followCommandSchema } from "./game-follow";
export type PhoneManagementCommand = { action: "phone"; method: string; params?: unknown };
export async function executePhoneCommand(command: PhoneManagementCommand, service: PhonesService, source: PhoneCommandSource = "external"): Promise<unknown> {
  try { return await executeValidatedPhoneCommand(command, service, source); }
  catch (error) {
    if (error instanceof z.ZodError) throw Object.assign(new Error(`手机参数无效：${[...new Set(error.issues.map(issue => issue.path.join(".") || "params"))].join("、")}。请按 phone --help 修正，不使用失败结果构造动作。`), { code: "PHONE_INVALID_REQUEST" });
    throw error;
  }
}
async function executeValidatedPhoneCommand(command: PhoneManagementCommand, service: PhonesService, source: PhoneCommandSource): Promise<unknown> {
  if (command.method === "internet-configure") return service.internet.configure(command.params);
  if (command.method === "internet-status" || command.method === "internet-pair") {
    z.object({}).strict().parse(command.params || {});
    return command.method === "internet-pair" ? service.internet.pair() : service.internet.status();
  }
  if (command.method === "internet-forget") {
    const { id } = z.object({ id: z.string().regex(/^internet-[a-f0-9-]{36}$/) }).strict().parse(command.params);
    return service.forgetInternet(id);
  }
  if (command.method === "internet-install-status") {
    const { id, jobId } = z.object({ id: z.string().regex(/^internet-[a-f0-9-]{36}$/), jobId: z.string().uuid() }).strict().parse(command.params);
    return service.internetInstallReceipt(id, jobId);
  }
  if (command.method === "iphone-add") return service.iphones.add(command.params);
  if (command.method === "iphone-usb-start") return service.iphones.startUsb(command.params);
  if (command.method === "iphone-signing-setup") { z.object({}).strict().parse(command.params || {}); return service.iphones.signing.setup(); }
  if (command.method === "iphone-sign-sideloadly") {
    const p = z.object({ udid: z.string(), bundleId: z.string().optional() }).strict().parse(command.params);
    return service.iphones.maintain(p.udid, () => service.iphones.signing.repair(p.udid, p.bundleId));
  }
  if (command.method === "iphone-usb-stop") return service.iphones.stopUsb(z.object({ udid: z.string() }).strict().parse(command.params).udid);
  if (command.method === "iphone-usb-status" || command.method === "iphone-prepare-wda") {
    z.object({}).strict().parse(command.params || {});
    return command.method === "iphone-usb-status" ? service.iphones.usb.status() : service.iphones.tools.prepareWda();
  }
  if (command.method === "iphone-install-signed") {
    const p = z.object({ udid: z.string(), ipa: z.string() }).strict().parse(command.params);
    return service.iphones.maintain(p.udid, () => service.iphones.tools.installSigned(p.udid, p.ipa));
  }
  if (["iphone-setup", "iphone-doctor", "iphone-devices"].includes(command.method)) {
    z.object({}).strict().parse(command.params || {});
    return command.method === "iphone-setup" ? service.iphones.tools.setup() : command.method === "iphone-devices" ? service.iphones.tools.devices() : service.iphones.tools.doctor();
  }
  if (command.method === "iphone-devmode-reveal") return service.iphones.tools.revealDeveloperMode(z.object({ udid: z.string() }).strict().parse(command.params).udid);
  if (command.method === "iphone-forget") return service.iphones.forget(z.object({ id: z.string() }).strict().parse(command.params).id);
  const deviceId = command.params && typeof command.params === "object" && "id" in command.params ? String(command.params.id) : "";
  if (deviceId.startsWith("iphone-")) {
    const idOnly = () => z.object({ id: z.string() }).strict().parse(command.params).id;
    if (command.method === "connect") { const p = z.object({ id: z.string(), update: z.boolean().optional() }).strict().parse(command.params); return service.iphones.connect(p.id); }
    if (command.method === "disconnect") return service.iphones.disconnect(idOnly());
    if (command.method === "start") return service.iphones.start(command.params);
    if (command.method === "action") return service.iphones.perform(command.params as any);
    if (["pause", "resume", "stop"].includes(command.method)) {
      const p = z.object({ id: z.string(), expected: z.object({ sessionId: z.string(), generation: z.number().int().nonnegative() }).strict().optional() }).strict().parse(command.params);
      return service.iphones.control(p.id, command.method as "pause" | "resume" | "stop", p.expected);
    }
    if (command.method === "rename") { const p = z.object({ id: z.string(), name: z.string() }).strict().parse(command.params); service.iphones.rename(p.id, p.name); return service.snapshot(); }
    if (command.method === "inspect") { await service.iphones.connect(idOnly()); return service.snapshot(); }
    throw new Error("此命令不适用于 iPhone。使用 start、action、pause、resume、stop；Android 的 ADB、APK 和无障碍设置不能用于 iPhone。");
  }
  if (command.method === "accessibility-repair") {
    const p = z.object({ id: z.string().min(1), autoRestore: z.boolean().optional() }).strict().parse(command.params);
    return service.repairAccessibility(p.id, p.autoRestore);
  }
  if (command.method === "readiness") {
    const p = z.object({ id: z.string().min(1), backend: z.enum(["app", "basic"]).default("app") }).strict().parse(command.params);
    return service.readiness(p.id, p.backend);
  }
  if (command.method === "follow-command") return service.gameFollower.command(followCommandSchema.parse(command.params));
  if (command.method === "host") return service.hostCommand(z.object({ args: z.array(z.string().max(32768)).min(1).max(3) }).strict().parse(command.params).args);
  if (command.method === "wireless-disconnect") return service.disconnectWireless(z.object({ id: z.string() }).strict().parse(command.params).id);
  if (command.method === "disconnect") return service.disconnect(z.object({ id: z.string() }).strict().parse(command.params).id);
  if (command.method === "connect") {
    // Existing desktop "install/connect" buttons retain their explicit setup
    // behavior. The CLI always sends update:false for connection-only use.
    const p = z.object({ id: z.string(), update: z.boolean().default(true) }).strict().parse(command.params);
    return service.prepare(p.id, p.update);
  }
  if (command.method === "adb-start") {
    const p = z.object({ lease: z.string().uuid(), generation: z.number().int().nonnegative(), requestId: z.string().uuid(), args: z.array(z.string()).min(1).max(512), timeoutMs: z.number().int().optional(), cwd: z.string().optional(), stdin: z.boolean().optional() }).strict().parse(command.params);
    return service.adbJobs.start(p);
  }
  if (command.method === "adb-status" || command.method === "adb-cancel") {
    const p = z.object({ lease: z.string().uuid(), jobId: z.string().uuid(), offset: z.number().int().nonnegative().optional() }).strict().parse(command.params);
    return command.method === "adb-status" ? service.adbJobs.status(p.lease, p.jobId, p.offset) : service.adbJobs.cancel(p.lease, p.jobId);
  }
  if (command.method === "adb-input") {
    const p = z.object({ lease: z.string().uuid(), jobId: z.string().uuid(), sequence: z.number().int().nonnegative(), data: z.string().max(87384), eof: z.boolean().optional() }).strict().parse(command.params);
    return service.adbJobs.input(p.lease, p.jobId, p.sequence, p.data, p.eof);
  }
  if (["package-info", "packages", "diagnose"].includes(command.method)) {
    const p = z.object({ id: z.string(), packageName: z.string().optional(), scope: z.enum(["all", "user", "system"]).optional(), filter: z.string().optional() }).strict().parse(command.params);
    return service.inspectPhone(p.id, command.method === "package-info" ? "app" : command.method as "packages" | "diagnose", p);
  }
  if (command.method === "update") return service.prepare(z.object({ id: z.string() }).strict().parse(command.params).id, true);
  if (command.method === "camera-sources") return service.screenCamera.sources();
  if (command.method === "camera-probe") return service.cameraProbe(z.object({ id: z.string() }).strict().parse(command.params).id);
  if (command.method === "camera-start") return service.cameraStart(cameraStartSchema.parse(command.params));
  if (command.method === "camera-command") return service.cameraCommand(cameraCommandSchema.parse(command.params));
  if (command.method === "screen") return service.screen(z.object({ id: z.string() }).strict().parse(command.params).id);
  if (command.method === "android-setup-snapshot") return service.androidSetup.snapshot();
  if (command.method === "android-setup-catalog") return service.androidSetup.catalog();
  if (command.method === "android-setup-cancel") return service.androidSetup.cancel(z.object({ id: z.string().uuid() }).strict().parse(command.params).id);
  if (command.method === "android-setup-start") {
    const imageId = z.string().regex(/^system-images;android-\d+;google_apis;(x86_64|arm64-v8a)$/);
    const licenseToken = z.string().regex(/^[a-f0-9]{64}$/);
    return service.androidSetup.start(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("environment"), licenseToken }).strict(),
      z.object({ kind: z.literal("image"), imageId, licenseToken }).strict(),
      z.object({ kind: z.literal("create"), imageId, name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,49}$/), memoryMb: z.number().int().min(1024).max(16384), storageGb: z.number().int().min(2).max(64) }).strict()
    ]).parse(command.params));
  }
  if (command.method === "inspect") return service.inspect(z.object({ id: z.string() }).strict().parse(command.params).id);
  if (command.method === "basic-start") {
    const p = z.object({ id: z.string(), mode: z.enum(["view", "control"]).default("control"), controller: z.string().default("本机用户"), task: z.string().default("") }).strict().parse(command.params);
    return service.basicStart(p.id, p.mode, p.controller, p.task, source);
  }
  if (command.method === "basic-action") return service.basicPerform(z.object({ id: z.string(), sessionId: z.string(), generation: z.number(), requestId: z.string(), action: phoneActionSchema }).strict().parse(command.params));
  if (command.method === "basic-mode") return service.basicSetMode(z.object({ id: z.string(), sessionId: z.string(), generation: z.number(), mode: z.enum(["view", "control"]) }).strict().parse(command.params));
  if (["basic-pause", "basic-resume", "basic-stop"].includes(command.method)) {
    const { id } = z.object({ id: z.string() }).strict().parse(command.params);
    return service.basicControl(id, command.method.slice(6) as "pause" | "resume" | "stop");
  }
  if (command.method === "wrapper-install") {
    const p = z.object({ lease: z.string().uuid(), generation: z.number().int().nonnegative(), apk: z.string().min(1).max(32768), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(command.params);
    return service.installWrapper(p.lease, p.generation, p.apk, p.sha256);
  }
  if (command.method === "wrapper-internet-launch") {
    const p = z.object({ lease: z.string().uuid(), generation: z.number().int().nonnegative(), packageName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/).max(255) }).strict().parse(command.params);
    return service.internetLaunchWrapper(p.lease, p.generation, p.packageName);
  }
  if (command.method === "wrapper-install-status") return service.installWrapperStatus(z.object({ lease: z.string().uuid() }).strict().parse(command.params).lease);
  if (command.method === "cloud-pair") return service.cloudPair(z.object({ url: z.string().max(2000).optional() }).strict().parse(command.params || {}).url);
  if (command.method === "cloud-forget") return service.cloudForget(z.object({ id: z.string().regex(/^cloud-[a-f0-9-]{36}$/) }).strict().parse(command.params).id);
  if (command.method === "device-discover") return service.discoverDevices();
  if (command.method === "device-add-nearby") return service.addNearby(z.object({ id: z.string().uuid() }).strict().parse(command.params).id);
  if (command.method === "device-add-code") {
    const input = z.object({ code: z.string().max(40), url: z.string().max(2000).optional() }).strict().parse(command.params);
    return service.addDeviceCode(input.code, input.url);
  }
  if (command.method === "device-forget") return service.forgetRegistered(z.object({ id: z.string().regex(/^registered-[a-f0-9-]{36}$/) }).strict().parse(command.params).id);
  const method = z.enum(["list", "connect", "rename", "start", "pause", "resume", "stop", "action", "preview", "settings", "wake", "unlock", "unlock-stored", "unlock-secret-save", "unlock-secret-delete", "unattended", "emulator-list", "emulator-connect", "wireless-discover", "wireless-pair", "wireless-connect", "wrapper-start", "wrapper-pulse", "wrapper-state", "wrapper-action", "wrapper-stop"]).parse(command.method);
  if (method === "emulator-list") return service.listEmulators();
  if (method === "emulator-connect") return service.connectEmulator(z.object({ name: z.string().regex(/^[\w.-]{1,200}$/) }).strict().parse(command.params).name);
  if (method === "wireless-discover") return service.discoverWireless(z.object({ id: z.string().optional() }).strict().parse(command.params || {}).id);
  if (method === "wireless-pair") return service.pairWireless(command.params);
  if (method === "wireless-connect") {
    const input = z.union([z.object({ id: z.string().min(1) }).strict(), z.object({ address: z.string() }).strict()]).parse(command.params);
    return "id" in input ? service.autoConnectWireless(input.id) : service.connectWireless(input);
  }
  if (method === "wrapper-start") {
    const p = z.object({ id: z.string(), mode: z.enum(["view", "control"]), controller: z.string(), task: z.string(), backend: z.enum(["app", "basic"]).default("app") }).strict().parse(command.params);
    return service.startWrapper(p.id, p.mode, p.controller, p.task, p.backend);
  }
  if (method === "wrapper-action") {
    const p = z.object({ lease: z.string().uuid(), generation: z.number().int().nonnegative(), action: phoneActionSchema, requestId: z.string().uuid() }).strict().parse(command.params);
    return service.performWrapper(p.lease, p.generation, p.action, p.requestId);
  }
  if (method.startsWith("wrapper-")) {
    const { lease } = z.object({ lease: z.string().uuid() }).strict().parse(command.params);
    if (method === "wrapper-pulse") return service.pulseWrapper(lease);
    if (method === "wrapper-state") return service.wrapperState(lease);
    return service.stopWrapper(lease);
  }
  if (method === "wake") return service.wake(z.object({ id: z.string().min(1).max(200) }).strict().parse(command.params).id);
  if (method === "unlock-stored") {
    const p = z.object({ id: z.string().min(1).max(200), patternGeometry: z.string().min(1).max(100).optional() }).strict().parse(command.params);
    return service.unlockStored(p.id, p.patternGeometry);
  }
  if (method === "unlock-secret-save") {
    // The value is validated and encrypted in the service; it is never returned.
    const p = z.object({ id: z.string().min(1).max(200), kind: z.enum(["pattern", "credential"]), value: z.string().min(1).max(64), allowAgent: z.boolean().default(true) }).strict().parse(command.params);
    return service.saveUnlockSecret(p.id, { kind: p.kind, value: p.value, allowAgent: p.allowAgent });
  }
  if (method === "unlock-secret-delete") return service.deleteUnlockSecret(z.object({ id: z.string().min(1).max(200) }).strict().parse(command.params).id);
  if (method === "unattended") {
    const p = z.object({ id: z.string().min(1).max(200), op: z.enum(["on", "off", "status"]).default("status") }).strict().parse(command.params);
    return service.unattended(p.id, p.op);
  }
  if (method === "unlock") {
    // Credentials only travel over the local management channel; errors never echo them.
    const p = z.object({ id: z.string().min(1).max(200), credential: z.string().min(1).max(64).optional(), pattern: z.string().min(4).max(9).optional(), patternGeometry: z.string().min(1).max(100).optional() }).strict().parse(command.params);
    if (p.pattern !== undefined) return service.unlockPattern(p.id, p.pattern, p.patternGeometry);
    if (p.credential === undefined) throw new Error("unlock 需要 credential 或 pattern。");
    if (p.patternGeometry !== undefined) throw new Error("patternGeometry 只能和 pattern 一起使用。");
    return service.unlock(p.id, p.credential);
  }
  if (method === "list") { await service.iphones.refresh(); return service.refresh(); }
  if (method === "settings") {
    const input = z.object({ id: z.string(), setting: z.enum(["accessibility", "overlay", "notifications", "developerOptions", "usbDebugging", "wirelessDebugging"]) }).strict().parse(command.params);
    return service.openSettings(input.id, input.setting);
  }
  if (method === "action") return service.perform(z.object({ id: z.string(), sessionId: z.string(), generation: z.number(), requestId: z.string(), action: phoneActionSchema }).strict().parse(command.params));
  if (method === "rename") { const input = z.object({ id: z.string(), name: z.string() }).strict().parse(command.params); await service.rename(input.id, input.name); return service.snapshot(); }
  if (method === "start") { const input = z.object({ id: z.string(), mode: z.enum(["view", "control"]).default("control"), controller: z.string().default("本机用户"), task: z.string().default(""), keepScreenOn: z.boolean().default(true) }).strict().parse(command.params); return service.start(input.id, input.mode, input.controller, input.task, source, input.keepScreenOn); }
  const { id } = z.object({ id: z.string() }).strict().parse(command.params);
  if (method === "preview") return service.preview(id);
  if (method === "pause" || method === "resume" || method === "stop") return service.control(id, method);
  throw new Error("不支持此手机命令。");
}
