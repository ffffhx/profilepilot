import { isIPv4, createConnection } from "node:net";
import { z } from "zod";
import type { AdbRunner } from "./adb";
import type { PhoneDevice, PhoneWirelessDiscovery, PhoneWirelessService } from "../../shared/phones";
import { WirelessFailure, wirelessEvidence, sanitizeWirelessOutput } from "./wireless-diagnostics";

export function wirelessAddress(value: string): string {
  const match = value.trim().match(/^([0-9.]+):([0-9]{1,5})$/);
  if (!match || !isIPv4(match[1])) throw new Error("请输入手机显示的局域网 IPv4 地址和端口，例如 192.168.1.8:37123。");
  const [a, b] = match[1].split(".").map(Number), port = Number(match[2]);
  if (!(a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254)
      || port < 1 || port > 65535) throw new Error("请使用同一局域网中手机显示的地址和有效端口。");
  return `${match[1]}:${port}`;
}
export const wirelessConnectSchema = z.object({ address: z.string().max(80).transform(wirelessAddress) }).strict();
export const wirelessPairSchema = z.object({ address: z.string().max(80).transform(wirelessAddress), code: z.string().trim().regex(/^\d{6}$/, "配对码应为手机显示的 6 位数字。") }).strict();
export function parseWirelessServices(text: string): PhoneWirelessService[] {
  const result: PhoneWirelessService[] = [];
  for (const line of text.split(/\r?\n/)) {
    // DNS-SD collision resolution may append " (2)" to the instance name.
    // Read the fixed service-type/address columns without splitting that name.
    const match = line.trim().match(/^(.+?)\s+_adb-tls-(pairing|connect)\._tcp\.?\s+(\S+)$/);
    if (!match) continue;
    try {
      const address = wirelessAddress(match[3]), kind = match[2] as "pairing" | "connect";
      if (!result.some(item => item.kind === kind && item.address === address)) result.push({ name: match[1].slice(0, 200), kind, address });
    } catch { /* Not a supported local IPv4 endpoint. */ }
  }
  return result;
}
export async function discoverWireless(adb: AdbRunner): Promise<PhoneWirelessDiscovery> {
  const began = Date.now();
  try { return { services: parseWirelessServices(await adb.run(["mdns", "services"], 6000)), error: "" }; }
  catch (error) {
    const failure = new WirelessFailure("discovery", undefined, began, wirelessEvidence(error));
    return { services: [], error: failure.message, diagnostic: failure.details.wireless };
  }
}
// Reports are hints, not connection authority. Use only a fresh report from the
// selected phone's authenticated channel; never join arbitrary IPs to old ports.
export interface VerifiedWirelessEndpoint { hardwareId: string; address: string; at: number; }
export function wirelessCandidates(services: PhoneWirelessService[], routes: PhoneDevice[], now: number, recent: Iterable<VerifiedWirelessEndpoint> = []) {
  const reports = routes.flatMap(device => [
    ...(device.connection === "device" && device.companion === "ready" && device.confirmedAt != null && device.state?.readiness?.network
      ? [{ at: device.confirmedAt, network: device.state.readiness.network }] : []),
    ...(device.cloud?.paired && device.cloud.report?.readiness.network && device.cloud.reportedAt != null
      ? [{ at: device.cloud.reportedAt, network: device.cloud.report.readiness.network }] : [])
  ]).filter(report => now - report.at >= 0 && now - report.at < 45000).sort((a, b) => b.at - a.at);
  // The newest authenticated observation wins; combining old/new IPs revives stale advertisements.
  const report = reports[0];
  const phoneIps = [...new Set(report?.network.wifiIpv4 || [])];
  const hardware = [...new Set(routes.map(device => device.hardwareId || (device.transport === "usb" ? device.id : "")).filter(Boolean))];
  const result: PhoneWirelessService[] = [];
  if (report) {
    for (const endpoint of report.network.adbEndpoints || []) {
      if (endpoint.ageMs + now - report.at >= 45000 || !phoneIps.includes(endpoint.address.split(":")[0])) continue;
      if (result.some(item => item.kind === "connect" && item.address === endpoint.address)) continue;
      result.push({ name: "手机上报", kind: "connect", address: wirelessAddress(endpoint.address), source: "phone" });
    }
  }
  // A verified live ADB route can be newer than its mDNS advertisement.
  for (const device of routes) {
    if (device.connection !== "device" || device.transport !== "wifi" || !device.hardwareId) continue;
    try {
      const address = wirelessAddress(device.id);
      if (phoneIps.length && !phoneIps.includes(address.split(":")[0])) continue;
      if (!result.some(item => item.address === address)) result.push({ name: device.name, kind: "connect", address, source: "adb" });
    } catch { /* mDNS transport IDs are resolved through their advertisement below. */ }
  }
  for (const service of services) {
    const host = service.address.split(":")[0];
    // A current phone report invalidates advertisements for its former address.
    if (phoneIps.length && !phoneIps.includes(host)) continue;
    if (!phoneIps.includes(host) && !hardware.some(id => service.name.startsWith(`adb-${id}-`))) continue;
    if (!result.some(item => item.kind === service.kind && item.address === service.address)) result.push({ ...service, source: "mdns" });
  }
  // Restarting the host ADB server can temporarily empty its mDNS cache while
  // the phone still listens on the same port. Only retry a route verified in
  // THIS desktop process within the last minute, never historical saved IPs.
  for (const endpoint of recent) {
    if (!hardware.includes(endpoint.hardwareId) || now - endpoint.at < 0 || now - endpoint.at >= 60000) continue;
    try {
      const address = wirelessAddress(endpoint.address);
      if (phoneIps.length && !phoneIps.includes(address.split(":")[0])) continue;
      if (!result.some(item => item.kind === "connect" && item.address === address))
        result.push({ name: "最近验证的连接", kind: "connect", address, source: "adb" });
    } catch { /* Invalid hints never become connection targets. */ }
  }
  return { services: result.slice(0, 16), phoneIps };
}

export function probeWireless(address: string): Promise<{ reachable: boolean; reason: string }> {
  const [host, port] = wirelessAddress(address).split(":");
  return new Promise(resolve => {
    const socket = createConnection({ host, port: Number(port) });
    const finish = (reachable: boolean, reason: string) => { socket.destroy(); resolve({ reachable, reason }); };
    socket.setTimeout(1200, () => finish(false, "连接超时，请检查同一网络、设备隔离或防火墙"));
    socket.once("connect", () => finish(true, "端口可达，连接时仍需验证配对"));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(false, error.code === "ECONNREFUSED"
      ? "端口拒绝连接，地址可能已过期或无线调试服务未启动" : "地址暂不可达，请检查手机当前网络"));
  });
}

export async function pairWireless(adb: AdbRunner, input: unknown): Promise<{ address: string }> {
  const { address, code } = wirelessPairSchema.parse(input);
  const began = Date.now();
  let output: string;
  try {
    // Keep the short-lived code out of argv, process listings, logs and storage.
    output = await adb.run(["pair", address], 20000, `${code}\n`);
  } catch (error) {
    throw new WirelessFailure("pairing", address, began, wirelessEvidence(error));
  }
  if (!output.includes(`Successfully paired to ${address}`)) throw new WirelessFailure("pairing", address, began, { exitCode: 0, stdout: sanitizeWirelessOutput(output) });
  return { address };
}
export async function connectWireless(adb: AdbRunner, input: unknown): Promise<string> {
  const { address } = wirelessConnectSchema.parse(input);
  const began = Date.now();
  let output: string;
  try { output = await adb.run(["connect", address], 15000); }
  catch (error) {
    throw new WirelessFailure("connection", address, began, wirelessEvidence(error));
  }
  if (!output.split(/\r?\n/).some(line => line.trim() === `connected to ${address}` || line.trim() === `already connected to ${address}`)) {
    throw new WirelessFailure("connection", address, began, { exitCode: 0, stdout: sanitizeWirelessOutput(output) });
  }
  return address;
}
