import { isIPv4, createConnection } from "node:net";
import { z } from "zod";
import type { AdbRunner } from "./adb";
import type { PhoneDevice, PhoneWirelessDiscovery, PhoneWirelessService } from "../../shared/phones";

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
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3 || !/^_adb-tls-(pairing|connect)\._tcp\.?$/.test(parts[1])) continue;
    try {
      const address = wirelessAddress(parts[2]), kind = parts[1].includes("pairing") ? "pairing" : "connect";
      if (!result.some(item => item.kind === kind && item.address === address)) result.push({ name: parts[0].slice(0, 200), kind, address });
    } catch { /* Not a supported local IPv4 endpoint. */ }
  }
  return result;
}
export async function discoverWireless(adb: AdbRunner): Promise<PhoneWirelessDiscovery> {
  try { return { services: parseWirelessServices(await adb.run(["mdns", "services"], 6000)), error: "" }; }
  catch (error) {
    return { services: [], error: (error as { code?: string }).code === "ENOENT"
      ? "未找到 ADB，请安装 Android Platform Tools 后重试。"
      : "自动发现暂不可用，可手动输入手机显示的地址。检查 Platform Tools 版本、同网连接及防火墙。" };
  }
}
// Reports are hints, not connection authority. Use only a fresh report from the
// selected phone's authenticated channel; never join arbitrary IPs to old ports.
export function wirelessCandidates(services: PhoneWirelessService[], routes: PhoneDevice[], now: number) {
  const reports = routes.filter(device => device.cloud?.paired && device.cloud.report && device.cloud.reportedAt !== null
    && now - device.cloud.reportedAt >= 0 && now - device.cloud.reportedAt < 45000);
  const phoneIps = [...new Set(reports.flatMap(device => device.cloud!.report!.readiness.network?.wifiIpv4 || []))];
  const hardware = [...new Set(routes.map(device => device.hardwareId || (device.transport === "usb" ? device.id : "")).filter(Boolean))];
  const result: PhoneWirelessService[] = [];
  for (const device of reports) {
    const cloud = device.cloud!;
    for (const endpoint of cloud.report!.readiness.network?.adbEndpoints || []) {
      if (endpoint.ageMs + now - cloud.reportedAt! >= 45000 || !phoneIps.includes(endpoint.address.split(":")[0])) continue;
      if (result.some(item => item.kind === "connect" && item.address === endpoint.address)) continue;
      result.push({ name: "手机上报", kind: "connect", address: wirelessAddress(endpoint.address), source: "phone" });
    }
  }
  for (const service of services) {
    const host = service.address.split(":")[0];
    // A current phone report invalidates advertisements for its former address.
    if (phoneIps.length && !phoneIps.includes(host)) continue;
    if (!phoneIps.includes(host) && !hardware.some(id => service.name.startsWith(`adb-${id}-`))) continue;
    if (!result.some(item => item.kind === service.kind && item.address === service.address)) result.push({ ...service, source: "mdns" });
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

function connectionError(output: string): Error {
  const reason = /refused|10061|拒绝/i.test(output) ? "端口拒绝连接，地址可能已过期。请重新发现；仍失败时重新开启手机无线调试。"
    : /authenticate|authentication|unauthorized|pairing/i.test(output) ? "此电脑尚未通过无线调试认证，请在手机上重新配对。"
    : /timed? out|10060|unreachable|超时/i.test(output) ? "网络连接超时。请检查同一网络、访客网络隔离及防火墙。"
    : "请重新发现当前地址；首次使用需要在手机上完成无线调试配对。";
  return new Error("手机未建立无线连接：" + reason);
}
export async function pairWireless(adb: AdbRunner, input: unknown): Promise<{ address: string }> {
  const { address, code } = wirelessPairSchema.parse(input);
  let output: string;
  try {
    // Keep the short-lived code out of argv, process listings, logs and storage.
    output = await adb.run(["pair", address], 20000, `${code}\n`);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") throw new Error("未找到 ADB，请安装 Android Platform Tools 后重试。");
    throw new Error("配对未完成。请保持手机配对码窗口打开，核对配对地址和最新的 6 位码；同时确认两端处于同一局域网。");
  }
  if (!output.includes(`Successfully paired to ${address}`)) throw new Error("手机未确认配对成功。请重新打开「使用配对码配对」，输入新的配对地址和配对码。");
  return { address };
}
export async function connectWireless(adb: AdbRunner, input: unknown): Promise<string> {
  const { address } = wirelessConnectSchema.parse(input);
  let output: string;
  try { output = await adb.run(["connect", address], 15000); }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") throw new Error("未找到 ADB，请安装 Android Platform Tools 后重试。");
    throw connectionError((error as Error).message);
  }
  if (!output.split(/\r?\n/).some(line => line.trim() === `connected to ${address}` || line.trim() === `already connected to ${address}`)) {
    throw connectionError(output);
  }
  return address;
}
