import { z } from "zod";
import { PhonesService, phoneActionSchema } from "./service";
export type PhoneManagementCommand = { action: "phone"; method: string; params?: unknown };
export async function executePhoneCommand(command: PhoneManagementCommand, service: PhonesService): Promise<unknown> {
  if (command.method === "wrapper-install") {
    const p = z.object({ lease: z.string().uuid(), generation: z.number().int().nonnegative(), apk: z.string().min(1).max(32768), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(command.params);
    return service.installWrapper(p.lease, p.generation, p.apk, p.sha256);
  }
  if (command.method === "wrapper-install-status") return service.installWrapperStatus(z.object({ lease: z.string().uuid() }).strict().parse(command.params).lease);
  if (command.method === "cloud-pair") return service.cloudPair(z.object({ url: z.string().max(2000).optional() }).strict().parse(command.params || {}).url);
  if (command.method === "cloud-forget") return service.cloudForget(z.object({ id: z.string().regex(/^cloud-[a-f0-9-]{36}$/) }).strict().parse(command.params).id);
  const method = z.enum(["list", "connect", "rename", "start", "pause", "resume", "stop", "action", "preview", "settings", "emulator-list", "emulator-connect", "wireless-discover", "wireless-pair", "wireless-connect", "wrapper-start", "wrapper-pulse", "wrapper-state", "wrapper-action", "wrapper-stop"]).parse(command.method);
  if (method === "emulator-list") return service.listEmulators();
  if (method === "emulator-connect") return service.connectEmulator(z.object({ name: z.string().regex(/^[\w.-]{1,200}$/) }).strict().parse(command.params).name);
  if (method === "wireless-discover") return service.discoverWireless(z.object({ id: z.string().optional() }).strict().parse(command.params || {}).id);
  if (method === "wireless-pair") return service.pairWireless(command.params);
  if (method === "wireless-connect") {
    const input = z.union([z.object({ id: z.string().min(1) }).strict(), z.object({ address: z.string() }).strict()]).parse(command.params);
    return "id" in input ? service.autoConnectWireless(input.id) : service.connectWireless(input);
  }
  if (method === "wrapper-start") {
    const p = z.object({ id: z.string(), mode: z.enum(["view", "control"]), controller: z.string(), task: z.string() }).strict().parse(command.params);
    return service.startWrapper(p.id, p.mode, p.controller, p.task);
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
  if (method === "list") return service.refresh();
  if (method === "settings") {
    const input = z.object({ id: z.string(), setting: z.enum(["accessibility", "overlay", "notifications", "developerOptions", "usbDebugging", "wirelessDebugging"]) }).strict().parse(command.params);
    return service.openSettings(input.id, input.setting);
  }
  if (method === "action") return service.perform(z.object({ id: z.string(), sessionId: z.string(), generation: z.number(), requestId: z.string(), action: phoneActionSchema }).strict().parse(command.params));
  if (method === "rename") { const input = z.object({ id: z.string(), name: z.string() }).strict().parse(command.params); await service.rename(input.id, input.name); return service.snapshot(); }
  if (method === "start") { const input = z.object({ id: z.string(), mode: z.enum(["view", "control"]).default("control"), controller: z.string().default("本机用户"), task: z.string().default("") }).strict().parse(command.params); return service.start(input.id, input.mode, input.controller, input.task); }
  const { id } = z.object({ id: z.string() }).strict().parse(command.params);
  if (method === "preview") return service.preview(id);
  if (method === "connect") return service.prepare(id);
  if (method === "pause" || method === "resume" || method === "stop") return service.control(id, method);
  throw new Error("不支持此手机命令。");
}
