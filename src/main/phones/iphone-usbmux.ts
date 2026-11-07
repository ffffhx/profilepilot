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
/** Resolve the exact USB serial for EVERY connection; DeviceIDs can be reused after unplugging. */
export async function forwardIphone(udid: string, open: Dial = dial): Promise<IphoneForward> {
  iphoneUdid.parse(udid);
  const sockets = new Set<net.Socket>(); let stopped = false;
  const track = (socket: net.Socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {}); return socket; };
  const server = net.createServer({ pauseOnConnect: true }, socket => {
    track(socket);
    void (async () => {
      const query = track(open());
      const result = await muxExchange(query, { MessageType: "ListDevices" }).finally(() => query.destroy());
      const list = z.object({ DeviceList: z.array(z.object({ DeviceID: z.number().int().positive(), Properties: z.object({ SerialNumber: z.string(), ConnectionType: z.string() }) })).max(100) }).parse(result);
      const devices = list.DeviceList.filter(item => item.Properties.SerialNumber === udid && item.Properties.ConnectionType === "USB");
      if (stopped || socket.destroyed || devices.length !== 1) throw new Error("所选 iPhone USB 连接已断开。");
      const remote = track(open()); socket.once("close", () => remote.destroy()); remote.once("close", () => socket.destroy());
      // usbmuxd represents the destination port in network byte order inside an integer.
      const connected = z.object({ Number: z.literal(0) }).parse(await muxExchange(remote, { MessageType: "Connect", DeviceID: devices[0].DeviceID, PortNumber: ((8100 & 255) << 8) | (8100 >> 8) }));
      if (stopped || socket.destroyed || connected.Number !== 0) throw new Error("USB 转发已结束。");
      remote.setTimeout(30000, () => remote.destroy()); socket.setTimeout(30000, () => socket.destroy());
      socket.pipe(remote).pipe(socket); remote.resume(); socket.resume();
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  server.on("error", () => { for (const socket of sockets) socket.destroy(); });
  return { endpoint: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, close: async () => {
    if (stopped) return; stopped = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
