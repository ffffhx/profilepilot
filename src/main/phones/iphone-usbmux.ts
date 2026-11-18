import net from "node:net";
import plist from "plist";
import { z } from "zod";
import { iphoneUdid } from "./iphone-tools";

type Dial = () => net.Socket;
const dial: Dial = () => process.platform === "win32" ? net.connect(27015, "127.0.0.1") : net.connect("/var/run/usbmuxd");
const client = { ClientVersionString: "ProfilePilot", ProgName: "ProfilePilot", kLibUSBMuxVersion: 3 };

/** One bounded usbmuxd plist exchange. Leave bytes after Connect's reply on the socket. */
export function muxExchange(socket: net.Socket, message: Record<string, any>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(plist.build({ ...client, ...message })), header = Buffer.alloc(16);
    header.writeUInt32LE(16 + body.length); header.writeUInt32LE(1, 4); header.writeUInt32LE(8, 8); header.writeUInt32LE(1, 12);
    let buffer: Buffer = Buffer.alloc(0);
    const cleanup = () => { clearTimeout(timer); socket.off("data", data); socket.off("error", failed); socket.off("close", closed); };
    const failed = (error: Error) => { cleanup(); socket.destroy(); reject(error); };
    const closed = () => failed(new Error("Apple USB 连接已断开。"));
    const timer = setTimeout(() => failed(new Error("Apple USB 连接超时，请解锁并信任电脑。")), 5000);
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 16) return;
      const size = buffer.readUInt32LE(0);
      if (size < 16 || size > 2 * 1024 * 1024 || buffer.readUInt32LE(4) !== 1 || buffer.readUInt32LE(8) !== 8 || buffer.readUInt32LE(12) !== 1)
        return failed(new Error("Apple USB 响应格式无效。"));
      if (buffer.length < size) return;
      try {
        const xml = buffer.subarray(16, size).toString("utf8");
        if (/<!ENTITY/i.test(xml)) throw new Error("Apple USB 响应格式无效。");
        const value = plist.parse(xml); socket.pause(); cleanup();
        if (buffer.length > size) socket.unshift(buffer.subarray(size));
        resolve(value);
      } catch { failed(new Error("Apple USB 响应格式无效。")); }
    };
    socket.on("data", data); socket.once("error", failed); socket.once("close", closed);
    socket.write(Buffer.concat([header, body])); socket.resume();
  });
}

export interface IphoneForward { endpoint: string; close(): Promise<void>; }
export interface IphoneForwardOptions { cacheTtlMs?: number; now?: () => number; }

/** Resolve the exact USB serial with optional short-lived caching (default 5s on system usbmuxd). */
export async function forwardIphone(udid: string, open: Dial = dial, options: IphoneForwardOptions = {}): Promise<IphoneForward> {
  iphoneUdid.parse(udid);
  const cacheTtlMs = options.cacheTtlMs ?? (open === dial ? 5000 : 0);
  const now = options.now ?? Date.now;
  let cachedDevice: { id: number; at: number } | undefined;
  let pendingLookup: Promise<number> | undefined;
  const sockets = new Set<net.Socket>(); let stopped = false;
  const track = (socket: net.Socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {}); return socket; };

  const lookupDeviceId = async (forceRefresh = false): Promise<number> => {
    if (!forceRefresh && cacheTtlMs > 0 && cachedDevice && now() - cachedDevice.at < cacheTtlMs) {
      return cachedDevice.id;
    }
    if (!forceRefresh && pendingLookup) return pendingLookup;
    const work = (async () => {
      const query = track(open());
      const result = await muxExchange(query, { MessageType: "ListDevices" }).finally(() => query.destroy());
      const list = z.object({ DeviceList: z.array(z.object({ DeviceID: z.number().int().positive(), Properties: z.object({ SerialNumber: z.string(), ConnectionType: z.string() }) })).max(100) }).parse(result);
      const devices = list.DeviceList.filter(item => item.Properties.SerialNumber === udid && item.Properties.ConnectionType === "USB");
      if (stopped || devices.length !== 1) {
        cachedDevice = undefined;
        throw new Error("所选 iPhone USB 连接已断开。");
      }
      const id = devices[0].DeviceID;
      if (cacheTtlMs > 0) cachedDevice = { id, at: now() };
      return id;
    })();
    const tracked: Promise<number> = work.finally(() => {
      if (pendingLookup === tracked) pendingLookup = undefined;
    });
    pendingLookup = tracked;
    return tracked;
  };

  const server = net.createServer({ pauseOnConnect: true }, socket => {
    track(socket);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    void (async () => {
      let deviceId = await lookupDeviceId(false);
      if (stopped || socket.destroyed) throw new Error("所选 iPhone USB 连接已断开。");
      const connectOnce = async (targetDeviceId: number) => {
        const remote = track(open());
        remote.setNoDelay(true);
        remote.setKeepAlive(true, 10000);
        try {
          // usbmuxd represents the destination port in network byte order inside an integer.
          const reply = await muxExchange(remote, { MessageType: "Connect", DeviceID: targetDeviceId, PortNumber: ((8100 & 255) << 8) | (8100 >> 8) });
          const connected = z.object({ Number: z.number().int() }).parse(reply);
          if (stopped || socket.destroyed || connected.Number !== 0) {
            remote.destroy();
            return undefined;
          }
          return remote;
        } catch (error) {
          remote.destroy();
          throw error;
        }
      };
      let remote: net.Socket | undefined;
      try {
        remote = await connectOnce(deviceId);
      } catch {
        cachedDevice = undefined;
      }
      if (!remote && cacheTtlMs > 0 && !stopped && !socket.destroyed) {
        cachedDevice = undefined;
        deviceId = await lookupDeviceId(true);
        remote = await connectOnce(deviceId);
      }
      if (!remote || stopped || socket.destroyed) {
        cachedDevice = undefined;
        throw new Error("USB 转发已结束。");
      }
      const upstream = remote;
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
      upstream.setTimeout(30000, () => upstream.destroy());
      socket.setTimeout(30000, () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
      upstream.resume();
      socket.resume();
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  server.on("error", () => { for (const socket of sockets) socket.destroy(); });
  return { endpoint: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close: async () => {
    if (stopped) return; stopped = true; cachedDevice = undefined;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
