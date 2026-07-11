import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_INBOUND_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_OUTBOUND_BUFFER_BYTES = 32 * 1024 * 1024;

export class GatewayWebSocketPeer {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private fragmentOpcode: number | null = null;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private closed = false;
  onText: ((message: string) => void) | null = null;
  onClose: (() => void) | null = null;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.once("close", () => this.finish());
    socket.once("error", () => this.finish());
  }

  static accept(request: IncomingMessage, socket: Socket, head?: Buffer): GatewayWebSocketPeer {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || request.headers.upgrade?.toLowerCase() !== "websocket") {
      throw new Error("Invalid WebSocket upgrade");
    }
    const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n"));
    const peer = new GatewayWebSocketPeer(socket);
    if (head?.length) peer.handleData(head);
    return peer;
  }

  sendText(message: string): void {
    if (this.closed) return;
    if (this.socket.writableLength > MAX_OUTBOUND_BUFFER_BYTES) {
      this.close(1013, "outbound backpressure");
      return;
    }
    this.socket.write(encodeFrame(0x1, Buffer.from(message)));
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    try {
      this.socket.write(encodeFrame(0x8, payload));
      this.socket.end();
      // Do not let an uncooperative client keep Gateway shutdown in FIN_WAIT_2 forever.
      // destroySoon flushes the close frame and then releases the fd without waiting for peer FIN.
      this.socket.destroySoon();
    } finally {
      this.finish();
    }
  }

  private handleData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.parseFrame()) {
      // Drain complete frames.
    }
  }

  private parseFrame(): boolean {
    if (this.buffer.length < 2) return false;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = Boolean(first & 0x80);
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return false;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return false;
      const wide = this.buffer.readBigUInt64BE(2);
      if (wide > BigInt(MAX_INBOUND_MESSAGE_BYTES)) {
        this.close(1009, "message too large");
        return false;
      }
      length = Number(wide);
      offset = 10;
    }
    if (!masked) {
      this.close(1002, "client frames must be masked");
      return false;
    }
    if (length > MAX_INBOUND_MESSAGE_BYTES || this.buffer.length < offset + 4 + length) {
      if (length > MAX_INBOUND_MESSAGE_BYTES) this.close(1009, "message too large");
      return false;
    }
    const mask = this.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }

    if (opcode >= 0x8 && (!fin || length > 125)) {
      this.close(1002, "invalid control frame");
      return false;
    }
    if (opcode === 0x8) {
      this.close(1000);
      return false;
    }
    if (opcode === 0x9) {
      this.socket.write(encodeFrame(0xA, payload));
      return true;
    }
    if (opcode === 0xA) return true;
    if (opcode !== 0x0 && opcode !== 0x1 && opcode !== 0x2) {
      this.close(1002, "unsupported opcode");
      return false;
    }

    if (opcode !== 0x0) {
      if (this.fragmentOpcode !== null) {
        this.close(1002, "unexpected data frame");
        return false;
      }
      this.fragmentOpcode = opcode;
    } else if (this.fragmentOpcode === null) {
      this.close(1002, "unexpected continuation");
      return false;
    }
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > MAX_INBOUND_MESSAGE_BYTES) {
      this.close(1009, "message too large");
      return false;
    }
    if (!fin) return true;
    const message = Buffer.concat(this.fragments, this.fragmentBytes);
    const messageOpcode = this.fragmentOpcode;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    if (messageOpcode === 0x1 || messageOpcode === 0x2) {
      this.onText?.(message.toString("utf8"));
    }
    return true;
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const size = payload.length;
  let header: Buffer;
  if (size < 126) {
    header = Buffer.from([0x80 | opcode, size]);
  } else if (size <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(size, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(size), 2);
  }
  return Buffer.concat([header, payload]);
}
