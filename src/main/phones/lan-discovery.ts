import { createSocket } from "node:dgram";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { PhoneNearbyApp } from "../../shared/phones";

// Discovery metadata only. These replies never establish identity or control authority.
export const PHONE_DISCOVERY_PORT = 41243;
export const PHONE_DISCOVERY_GROUP = "239.255.80.80";
const protocol = "profilepilot-discovery-v1";
const replySchema = z.object({ protocol: z.literal(protocol), type: z.literal("phone"), nonce: z.string(),
  id: z.string().uuid(), deviceId: z.string().uuid().optional(), name: z.string().min(1).max(100), version: z.string().max(100),
  variant: z.enum(["debug", "release"]), wirelessDebugging: z.enum(["enabled", "disabled", "unconfirmed"]) });
const ipv4 = (value: string) => value.split(".").reduce((result, part) => (result * 256 + Number(part)) >>> 0, 0);
const fromIpv4 = (value: number) => [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join(".");
export function discoveryInterfaces(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()) {
  return Object.values(interfaces).flatMap(values => values || []).filter(value => value.family === "IPv4" && !value.internal &&
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(value.address));
}
export function discoveryReply(data: Buffer, address: string, nonce: string, interfaces = discoveryInterfaces()): PhoneNearbyApp | undefined {
  if (data.length > 2048 || !interfaces.some(value => (ipv4(address) & ipv4(value.netmask)) === (ipv4(value.address) & ipv4(value.netmask)))) return;
  try {
    const result = replySchema.parse(JSON.parse(data.toString("utf8")));
    if (result.nonce !== nonce) return;
    const { id, name, version, variant, wirelessDebugging } = result;
    return { id, ...(result.deviceId ? { deviceId: result.deviceId } : {}), name, version, variant, wirelessDebugging, ip: address };
  } catch { return; }
}
export async function discoverNearbyApps(): Promise<{ apps: PhoneNearbyApp[]; appError: string }> {
  const interfaces = discoveryInterfaces(), found = new Map<string, PhoneNearbyApp>();
  if (!interfaces.length) return { apps: [], appError: "未找到可用的局域网连接，请将电脑和手机连接同一网络。" };
  const nonce = randomBytes(16).toString("hex");
  const request = Buffer.from(JSON.stringify({ protocol, type: "scan", nonce }));
  // One ephemeral socket per adapter avoids Windows/macOS default-route and VPN differences.
  let sent = false;
  await Promise.all(interfaces.map(adapter => new Promise<void>(resolve => {
    const socket = createSocket("udp4");
    let finished = false, retry: NodeJS.Timeout | undefined;
    const finish = () => {
      if (finished) return; finished = true; clearTimeout(timeout); clearTimeout(retry);
      try { socket.close(); } catch { /* Bind may have failed. */ } resolve();
    };
    const timeout = setTimeout(finish, 2400);
    socket.on("error", finish);
    socket.on("message", (data, remote) => {
      const app = discoveryReply(data, remote.address, nonce, [adapter]);
      if (app && found.size < 64) found.set(`${app.id}:${app.ip}`, app);
    });
    socket.bind(0, adapter.address, () => {
      if (finished) return;
      try { socket.setBroadcast(true); socket.setMulticastInterface(adapter.address); socket.setMulticastTTL(1); }
      catch { finish(); return; }
      const broadcast = fromIpv4((ipv4(adapter.address) | ~ipv4(adapter.netmask)) >>> 0);
      const send = () => {
        for (const address of [PHONE_DISCOVERY_GROUP, broadcast]) {
          socket.send(request, PHONE_DISCOVERY_PORT, address, error => { if (!error) sent = true; });
        }
      };
      send(); retry = setTimeout(send, 1000);
    });
  })));
  return { apps: [...found.values()], appError: sent ? "" : "局域网扫描未能发出，请检查本地网络权限和防火墙。" };
}
