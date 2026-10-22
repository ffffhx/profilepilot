import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { FollowHost } from "./game-follow";
import { cameraProofSchema } from "./screenshot-transfer";

const coordinate = z.number().int().nonnegative().max(19999);
export const cameraSampleCommandSchema = z.object({ op: z.literal("camera-sample"), id: z.string().min(1).max(500),
  x: coordinate, y: coordinate, outputDir: z.string().min(1).max(32767).refine(value => path.isAbsolute(value), "采样目录必须是绝对路径") }).strict();
export type CameraSampleCommand = z.infer<typeof cameraSampleCommandSchema>;
const frameSchema = z.object({ mime: z.literal("image/jpeg"), width: z.number().int().min(100).max(5000),
  height: z.number().int().min(100).max(5000), base64: z.string().min(4).max(7_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  cameraProof: cameraProofSchema.optional() }).strict();
const ackSchema = z.object({ accepted: z.literal(true), acceptedSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const TTL_MS = 1200, SETTLE_MS = 450;
type Runtime = { now: () => number; wait: (ms: number, signal: AbortSignal) => Promise<void> };

/** Validate the native JPEG dimensions without changing any encoded bytes. */
function imageFrame(value: unknown) {
  const frame = frameSchema.parse(value), bytes = Buffer.from(frame.base64, "base64");
  if (bytes.toString("base64") !== frame.base64 || bytes.length < 8 || bytes.readUInt16BE(0) !== 0xffd8
    || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw new Error("原始 JPEG 截图不完整");
  let found = false;
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8 || bytes.readUInt16BE(offset + 3) !== frame.height || bytes.readUInt16BE(offset + 5) !== frame.width)
        throw new Error("原始 JPEG 尺寸与截图元数据不符");
      found = true; break;
    }
    offset += length;
  }
  if (!found) throw new Error("原始 JPEG 缺少有效尺寸");
  return { frame, bytes };
}

/** One explicit point, one hold, one proof frame. No resume, movement, or replay. */
export class CameraSampler {
  private pending?: Promise<unknown>;
  private abort?: AbortController;
  private closed = false;
  constructor(private host: FollowHost, private runtime: Runtime = {
    now: () => performance.now(), wait: async (ms, signal) => { await delay(ms, undefined, { signal }); }
  }) {}
  get busy() { return !!this.pending; }
  sample(input: CameraSampleCommand): Promise<unknown> {
    const command = cameraSampleCommandSchema.parse(input);
    if (this.closed || this.pending) throw new Error("镜头采样正在进行或已关闭");
    const abort = new AbortController(); this.abort = abort;
    const job = this.capture(command, abort.signal).finally(() => {
      if (this.pending === job) { this.pending = undefined; this.abort = undefined; }
    });
    this.pending = job; return job;
  }
  async close(): Promise<void> {
    this.closed = true; this.abort?.abort(new Error("镜头采样已取消"));
    await this.pending?.catch(() => {});
  }
  private async capture(command: CameraSampleCommand, signal: AbortSignal) {
    const checkCancelled = () => { if (signal.aborted) throw new Error("镜头采样已取消"); };
    checkCancelled();
    // Reserving a new directory also tests writability before any phone input.
    // Never merge into or overwrite a user directory; failure leaves it empty.
    await fs.mkdir(command.outputDir);
    let lease: string | undefined, generation = 0, attempted = false;
    let owner: { instanceId: string; sessionId: string; generation: number } | undefined;
    let image: ReturnType<typeof imageFrame> | undefined;
    let metadata: object | undefined, failure: unknown;
    const current = () => {
      checkCancelled();
      const device = this.host.pulseWrapper(lease!), state = device.state;
      if (!state || !owner || state.instanceId !== owner.instanceId || state.sessionId !== owner.sessionId
        || state.generation !== owner.generation || state.mode !== "control"
        || !["controlling", "executing"].includes(state.phase)) throw new Error("手机会话已改变，镜头采样已丢弃");
    };
    try {
      checkCancelled();
      const started = await this.host.startWrapper(command.id, "control", "镜头标定采样", "指定镜头点的单帧标定", "app", false);
      lease = started.lease;
      const state = started.device.state;
      if (!state?.instanceId || !state.sessionId || !Number.isSafeInteger(state.generation)) throw new Error("手机采样会话无效");
      generation = state.generation;
      owner = { instanceId: state.instanceId, sessionId: state.sessionId, generation };
      current();
      const probe = await this.host.live(lease, generation, { op: "probe" });
      current();
      if (probe?.protocol !== 1 || probe?.cameraFrameProvenance !== 1) throw new Error("手机 App 不支持镜头画面凭据，请更新开发版");
      // Probe v1 has no dimensions. Read them before touching, then require the
      // proof frame to retain the exact same native orientation and resolution.
      const baseline = imageFrame(await this.host.live(lease, generation, { op: "frame" })).frame;
      current();
      if (command.x >= baseline.width || command.y >= baseline.height) throw new Error("镜头点超出原始画面");
      const point = { x: command.x, y: command.y }, sentAt = this.runtime.now();
      const withinHold = () => {
        current();
        if (this.runtime.now() - sentAt >= TTL_MS) throw new Error("镜头采样超过 1200ms 保持时限，画面已丢弃");
      };
      attempted = true;
      const ack = ackSchema.parse(await this.host.live(lease, generation,
        { op: "touch", sequence: 1, ttlMs: TTL_MS, points: [{ id: 1, ...point }] }));
      const ackAt = this.runtime.now(); withinHold();
      if (ack.acceptedSequence !== 1) throw new Error("镜头触点确认序号不符");
      await this.runtime.wait(SETTLE_MS, signal); withinHold();
      const frameAt = this.runtime.now();
      image = imageFrame(await this.host.live(lease, generation, { op: "frame", cameraFrameProvenance: 1 }));
      const receivedAt = this.runtime.now(); withinHold();
      const proof = image.frame.cameraProof;
      if (image.frame.width !== baseline.width || image.frame.height !== baseline.height) throw new Error("手机分辨率或方向已改变");
      if (!proof || proof.sequence !== ack.acceptedSequence || proof.x !== point.x || proof.y !== point.y
        || proof.capturedAtUptimeMs - proof.heldSinceUptimeMs < 250
        || proof.expiresAtUptimeMs - proof.heldSinceUptimeMs > TTL_MS)
        throw new Error("镜头画面缺少与本次触点一致且稳定的凭据");
      metadata = { version: 1, deviceId: command.id, image: "sample.jpg", mime: image.frame.mime,
        width: image.frame.width, height: image.frame.height,
        sha256: createHash("sha256").update(image.bytes).digest("hex"),
        touchAck: { sequence: ack.acceptedSequence, point, ttlMs: TTL_MS }, cameraProof: proof,
        timing: { clock: "host-monotonic-durations-ms", ackMs: ackAt - sentAt, waitMs: frameAt - ackAt,
          frameMs: receivedAt - frameAt, holdToFrameMs: receivedAt - sentAt },
        recordedAt: new Date().toISOString() };
    } catch (error) { failure = error; }
    finally {
      // Even an unknown hold outcome gets one new release, never a replay.
      // stopWrapper ends only this owned lease and checks phone ownership again.
      const cleanupErrors: string[] = [];
      if (lease && attempted) {
        try {
          const released = ackSchema.parse(await this.host.live(lease, generation, { op: "touch", sequence: 2, ttlMs: 100, points: [] }));
          if (released.acceptedSequence !== 2) throw new Error("释放确认序号不符");
        } catch (error) { cleanupErrors.push(`释放镜头失败：${(error as Error).message}`); }
      }
      if (lease) {
        try { await this.host.stopWrapper(lease); }
        catch (error) { cleanupErrors.push(`结束采样会话失败：${(error as Error).message}`); }
      }
      if (cleanupErrors.length) failure = new Error([...(failure ? [(failure as Error).message] : []), ...cleanupErrors].join("；"));
    }
    if (failure) throw failure;
    checkCancelled();
    if (!image || !metadata) throw new Error("镜头采样不完整");
    const imagePath = path.join(command.outputDir, "sample.jpg"), metadataPath = path.join(command.outputDir, "sample.json");
    // Exclusive file creation also guards against a concurrent writer after mkdir.
    // If the second write or cancellation fails, remove only files we created.
    const created: string[] = [];
    try {
      for (const [file, content] of [[imagePath, image.bytes], [metadataPath, JSON.stringify(metadata, null, 2) + "\n"]] as const) {
        checkCancelled();
        const handle = await fs.open(file, "wx"); created.push(file);
        try { checkCancelled(); await handle.writeFile(content); }
        finally { await handle.close(); }
        checkCancelled();
      }
    } catch (error) {
      await Promise.all(created.map(file => fs.unlink(file).catch(() => {})));
      throw error;
    }
    return { directory: command.outputDir, imagePath, metadataPath, ...metadata };
  }
}
