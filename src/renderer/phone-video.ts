import type { PhoneVideoPacket, PhoneVideoSession } from "../shared/phones";
/** One decoder shared by the sidebar and its enlarged view. The host's bounded
 * long poll prevents an IPC event backlog when the renderer is busy or hidden. */
export class PhoneVideoPreview {
  private generation = 0;
  private target = "";
  private streamId = "";
  private decoder?: VideoDecoder;
  private failed = "";
  private painted = 0;
  lastFrame = 0;
  active = false;
  get supported(): boolean { return typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined" && !!window.phones.videoStart; }
  constructor(private frame: (frame: VideoFrame, packet?: PhoneVideoPacket) => void, private changed: () => void) {}
  setTarget(id: string, basic?: PhoneVideoSession): void {
    const target = id ? JSON.stringify([id, basic]) : "";
    if (this.target === target || id && (this.failed === target || !this.supported)) return;
    this.stop(); this.target = target;
    if (id) void this.run(id, this.generation, target, basic);
  }
  retry(): void { this.failed = ""; }
  stop(): void {
    this.generation++; this.target = ""; this.lastFrame = 0; this.active = false;
    if (this.decoder?.state !== "closed") this.decoder?.close(); this.decoder = undefined;
    const id = this.streamId; this.streamId = "";
    if (id) void window.phones.videoStop(id).catch(() => {});
  }
  private async run(id: string, version: number, target: string, basic?: PhoneVideoSession): Promise<void> {
    let streamId = "", codec = "", failed: Error | undefined;
    const current = () => version === this.generation;
    try {
      ({ streamId } = await window.phones.videoStart(id, basic));
      if (!current()) return;
      this.streamId = streamId;
      const metadata = new Map<number, PhoneVideoPacket>();
      const decoder = new VideoDecoder({ output: frame => {
        try {
          const packet = metadata.get(frame.timestamp); metadata.delete(frame.timestamp);
          if (!current()) return;
          this.lastFrame = Date.now();
          if (performance.now() - this.painted < 1000 / 30) return;
          this.painted = performance.now(); this.active = true;
          this.frame(frame, packet);
        } finally { frame.close(); }
      }, error: error => { failed = error; } });
      this.decoder = decoder;
      while (current()) {
        if (failed) throw failed;
        const batch = await window.phones.videoRead(streamId);
        if (!current()) return;
        if (batch.error) throw new Error(batch.error);
        for (const packet of batch.packets) {
          if (!current()) return;
          if (failed) throw failed;
          const format = `${packet.codec}:${packet.width}:${packet.height}`;
          if (codec !== format || decoder.state === "unconfigured") {
            if (!packet.key) continue;
            const config = { codec: packet.codec, optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" as const };
            if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error("当前系统不支持视频解码。");
            if (!current()) return;
            decoder.configure(config); codec = format; metadata.clear();
          }
          while (decoder.decodeQueueSize > 4 && current() && !failed) await new Promise(resolve => setTimeout(resolve, 16));
          if (!current()) return;
          if (failed) throw failed;
          if (metadata.size > 90) throw new Error("视频解码积压。");
          metadata.set(packet.timestamp, packet);
          decoder.decode(new EncodedVideoChunk({ type: packet.key ? "key" : "delta", timestamp: packet.timestamp, data: packet.data }));
        }
      }
    } catch {
      if (current()) { this.failed = target; this.stop(); this.changed(); }
    } finally {
      if (streamId) void window.phones.videoStop(streamId).catch(() => {});
    }
  }
}
