import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { FollowHost } from "./game-follow";
import { cameraProofSchema } from "./screenshot-transfer";

const coordinate = z.number().int().nonnegative().max(19999);
const stepSchema = z.object({ x: coordinate, y: coordinate, mode: z.enum(["continue", "release-newdown"]) }).strict();
export const cameraSampleCommandSchema = z.object({ op: z.literal("camera-sample"), id: z.string().min(1).max(500),
  x: coordinate, y: coordinate, steps: z.array(stepSchema).min(6).max(9).optional(),
  outputDir: z.string().min(1).max(32767).refine(value => path.isAbsolute(value), "采样目录必须是绝对路径") }).strict();
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
    const job = (command.steps ? this.captureSequence(command, abort.signal) : this.capture(command, abort.signal)).finally(() => {
      if (this.pending === job) { this.pending = undefined; this.abort = undefined; }
    });
    this.pending = job; return job;
  }
  async close(): Promise<void> {
    this.closed = true; this.abort?.abort(new Error("镜头采样已取消"));
    await this.pending?.catch(() => {});
  }
  /** An explicit finite diagnostic plan, never used by the autonomous follower. */
  private async captureSequence(command: CameraSampleCommand, signal: AbortSignal) {
    const steps = command.steps!;
    if (steps[0].mode !== "release-newdown" || steps[0].x !== command.x || steps[0].y !== command.y)
      throw new Error("序列首步必须在指定 x/y 新按下镜头");
    const checkCancelled = () => { if (signal.aborted) throw new Error("镜头采样已取消"); };
    checkCancelled();
    await fs.mkdir(command.outputDir);
    const began = this.runtime.now(), startedAt = new Date().toISOString();
    const events: object[] = [], records: Record<string, unknown>[] = [];
    const files: { name: string; content: Buffer | string }[] = [];
    const event = (kind: string, data: object = {}) => events.push({ kind, atMs: this.runtime.now() - began, ...data });
    const plan = { version: 1, deviceId: command.id, steps, ttlMs: TTL_MS, settleMs: SETTLE_MS,
      releaseGuardMs: 160, startedAt, cameraOnly: true };
    // Freeze the plan before acquiring control. Completed and rejected captures
    // are written only after cleanup, together with an explicit partial manifest.
    await fs.writeFile(path.join(command.outputDir, "plan.json"), JSON.stringify(plan, null, 2) + "\n", { flag: "wx" });
    let lease: string | undefined, generation = 0, sequence = 0, attempted = false, failure: unknown;
    let owner: { instanceId: string; sessionId: string; generation: number } | undefined;
    let prior: { point: { x: number; y: number }; sentAt: number; ackAt: number; proof: z.infer<typeof cameraProofSchema> } | undefined;
    const sameOwner = () => {
      if (!lease || !owner) return false;
      const state = this.host.pulseWrapper(lease).state;
      return !!state && state.instanceId === owner.instanceId && state.sessionId === owner.sessionId
        && state.generation === owner.generation && state.mode === "control" && ["controlling", "executing"].includes(state.phase);
    };
    const current = () => {
      checkCancelled();
      if (!sameOwner()) throw new Error("手机会话已改变，镜头采样已停止");
    };
    const touch = async (points: { id: 1; x: number; y: number }[], ttlMs: number, cleanup = false) => {
      if (!cleanup) current();
      const sentAt = this.runtime.now(), sentSequence = ++sequence;
      attempted = true; event("touch-sent", { sequence: sentSequence, points, ttlMs, cleanup });
      const ack = ackSchema.parse(await this.host.live(lease!, generation, { op: "touch", sequence: sentSequence, ttlMs, points }));
      const ackAt = this.runtime.now();
      event("touch-ack", { sequence: ack.acceptedSequence, elapsedMs: ackAt - sentAt, cleanup });
      if (ack.acceptedSequence !== sentSequence) throw new Error("镜头触点确认序号不符");
      if (!cleanup) current();
      return { sentAt, ackAt, sequence: sentSequence };
    };
    const capture = async (label: string) => {
      current(); const requestedAt = this.runtime.now(); event("frame-request", { label });
      const image = imageFrame(await this.host.live(lease!, generation, { op: "frame", cameraFrameProvenance: 1 }));
      const receivedAt = this.runtime.now(); event("frame-received", { label, elapsedMs: receivedAt - requestedAt });
      return { image, requestedAt, receivedAt };
    };
    const keepImage = (name: string, image: ReturnType<typeof imageFrame>) => {
      files.push({ name, content: image.bytes });
      return { image: path.basename(name), mime: image.frame.mime, width: image.frame.width, height: image.frame.height,
        sha256: createHash("sha256").update(image.bytes).digest("hex"), cameraProof: image.frame.cameraProof,
        recordedAt: new Date().toISOString() };
    };
    try {
      checkCancelled();
      const started = await this.host.startWrapper(command.id, "control", "镜头序列诊断", "预声明镜头连续移动与重新按下对照", "app", false);
      lease = started.lease; const state = started.device.state;
      if (!state?.instanceId || !state.sessionId || !Number.isSafeInteger(state.generation)) throw new Error("手机采样会话无效");
      generation = state.generation; owner = { instanceId: state.instanceId, sessionId: state.sessionId, generation };
      current();
      const probe = await this.host.live(lease, generation, { op: "probe" }); current();
      if (probe?.protocol !== 1 || probe?.cameraFrameProvenance !== 1) throw new Error("手机 App 不支持镜头画面凭据，请更新开发版");
      const baselineCapture = await capture("baseline"), baseline = baselineCapture.image.frame; current();
      if (baseline.cameraProof) throw new Error("新采样会话仍有镜头触点，已停止");
      files.push({ name: "baseline.json", content: JSON.stringify(keepImage("baseline.jpg", baselineCapture.image), null, 2) + "\n" });
      if (steps.some(point => point.x >= baseline.width || point.y >= baseline.height)) throw new Error("镜头序列点超出原始画面");
      for (const [index, step] of steps.entries()) {
        current();
        const directory = `step-${String(index + 1).padStart(2, "0")}`, point = { x: step.x, y: step.y };
        const record: Record<string, unknown> = { index: index + 1, directory, mode: step.mode, point, status: "started" };
        records.push(record); event("step-start", { index: index + 1, ...step });
        const previous = prior;
        if (previous && step.mode === "release-newdown") {
          const release = await touch([], 100);
          // ACK only means accepted. Wait beyond the last hold's phone expiry:
          // receipt of its ACK is later than phone.update, so ACK+TTL is an upper
          // bound in host elapsed time. An extra two stroke periods permits UP.
          const releaseWaitMs = Math.max(250, previous.ackAt + TTL_MS + 160 - this.runtime.now());
          event("release-wait", { index: index + 1, releaseWaitMs });
          await this.runtime.wait(releaseWaitMs, signal); current();
          const released = await capture(`${directory}/release`);
          const releaseMetadata = { version: 1, ...keepImage(`${directory}/release.jpg`, released.image),
            touchAck: { sequence: release.sequence, points: [], ttlMs: 100 }, releaseWaitMs,
            timing: { requestAtMs: released.requestedAt - began, receivedAtMs: released.receivedAt - began },
            // Absence of proof is not a game-level camera/UP acknowledgement.
            proofAbsent: !released.image.frame.cameraProof };
          files.push({ name: `${directory}/release.json`, content: JSON.stringify(releaseMetadata, null, 2) + "\n" });
          current();
          if (released.image.frame.width !== baseline.width || released.image.frame.height !== baseline.height) throw new Error("手机分辨率或方向已改变");
          if (released.image.frame.cameraProof) throw new Error("释放后仍有镜头凭据，不能重新按下");
        }
        // Follow touch/frame do not renew SessionState's 8s lease. Keep this
        // finite sequence alive explicitly, without renewing the finger TTL.
        const syncAt = this.runtime.now();
        await this.host.syncWrapper(lease); current();
        event("lease-sync", { index: index + 1, elapsedMs: this.runtime.now() - syncAt });
        const continuing = !!previous && step.mode === "continue";
        if (continuing && this.runtime.now() >= previous.sentAt + TTL_MS) throw new Error("连续镜头保持已过期，禁止改为重新按下");
        const sent = await touch([{ id: 1, ...point }], TTL_MS);
        const withinHold = () => {
          current();
          if (this.runtime.now() >= sent.sentAt + TTL_MS) throw new Error("镜头采样超过 1200ms 保持时限，画面已丢弃");
        };
        withinHold();
        if (continuing && sent.ackAt >= previous.sentAt + TTL_MS) throw new Error("连续镜头确认超过前一保持时限，序列已停止");
        record.touchAck = { sequence: sent.sequence, point, ttlMs: TTL_MS };
        await this.runtime.wait(SETTLE_MS, signal); withinHold();
        const captured = await capture(`${directory}/sample`);
        const proof = captured.image.frame.cameraProof;
        const metadata: Record<string, unknown> = { version: 1, deviceId: command.id, ...keepImage(`${directory}/sample.jpg`, captured.image),
          touchAck: record.touchAck, mode: step.mode, index: index + 1, valid: false,
          timing: { clock: "host-monotonic-durations-ms", sentAtMs: sent.sentAt - began, ackAtMs: sent.ackAt - began,
            frameAtMs: captured.requestedAt - began, receivedAtMs: captured.receivedAt - began,
            ackMs: sent.ackAt - sent.sentAt, waitMs: captured.requestedAt - sent.ackAt,
            frameMs: captured.receivedAt - captured.requestedAt, holdToFrameMs: captured.receivedAt - sent.sentAt } };
        try {
          withinHold();
          if (captured.image.frame.width !== baseline.width || captured.image.frame.height !== baseline.height) throw new Error("手机分辨率或方向已改变");
          const changed = !previous || previous.point.x !== point.x || previous.point.y !== point.y;
          if (!proof || proof.sequence !== sent.sequence || proof.x !== point.x || proof.y !== point.y
            || proof.capturedAtUptimeMs - proof.heldSinceUptimeMs < 250
            || (!continuing || changed) && proof.expiresAtUptimeMs - proof.heldSinceUptimeMs > TTL_MS)
            throw new Error("镜头画面缺少与本次触点一致且稳定的凭据");
          if (previous && (proof.capturedAtUptimeMs <= previous.proof.capturedAtUptimeMs
            || continuing && (proof.epoch !== previous.proof.epoch + (changed ? 1 : 0)
              || (changed ? proof.heldSinceUptimeMs <= previous.proof.capturedAtUptimeMs : proof.heldSinceUptimeMs !== previous.proof.heldSinceUptimeMs))
            || !continuing && (proof.epoch <= previous.proof.epoch || proof.heldSinceUptimeMs <= previous.proof.capturedAtUptimeMs)))
            throw new Error("镜头序列 epoch 或应用时间不连续，不能混用新按下与移动");
          metadata.valid = true; record.status = "captured"; record.cameraProof = proof;
          prior = { point, sentAt: sent.sentAt, ackAt: sent.ackAt, proof };
        } catch (error) { metadata.error = (error as Error).message; throw error; }
        finally { files.push({ name: `${directory}/sample.json`, content: JSON.stringify(metadata, null, 2) + "\n" }); }
      }
    } catch (error) {
      failure = error; const record = records.at(-1);
      if (record?.status === "started") { record.status = "failed"; record.error = (error as Error).message; }
      event("failed", { error: (error as Error).message });
    } finally {
      const cleanupErrors: string[] = [];
      if (lease && attempted) {
        try {
          // User pause/stop or another owner must never receive our cleanup touch.
          if (sameOwner()) await touch([], 100, true);
          else event("cleanup-release-skipped", { reason: "owner-or-phase-changed" });
        } catch (error) { cleanupErrors.push(`释放镜头失败：${(error as Error).message}`); }
      }
      if (lease) {
        try { await this.host.stopWrapper(lease); event("lease-stopped"); }
        catch (error) { cleanupErrors.push(`结束采样会话失败：${(error as Error).message}`); }
      }
      if (cleanupErrors.length) failure = new Error([...(failure ? [(failure as Error).message] : []), ...cleanupErrors].join("；"));
    }
    // Preserve partial diagnostic evidence, labelled incomplete; never return it
    // as a successful calibrated sample. No session or lease secrets are saved.
    if (signal.aborted && !failure) failure = new Error("镜头采样已取消");
    const made = new Set<string>();
    const outputErrors: string[] = [], savedFiles: string[] = [];
    for (const file of files) {
      try {
        const target = path.join(command.outputDir, file.name), directory = path.dirname(target);
        if (directory !== command.outputDir && !made.has(directory)) { await fs.mkdir(directory); made.add(directory); }
        await fs.writeFile(target, file.content, { flag: "wx" }); savedFiles.push(file.name);
      } catch (error) { outputErrors.push(`${file.name}: ${(error as Error).message}`); }
    }
    if (signal.aborted && !failure) failure = new Error("镜头采样已取消");
    if (outputErrors.length) failure = new Error([...(failure ? [(failure as Error).message] : []), "部分诊断文件保存失败"].join("；"));
    const manifest = { ...plan, complete: !failure, error: failure ? (failure as Error).message : "", steps: records, events, savedFiles, outputErrors };
    await fs.writeFile(path.join(command.outputDir, "sequence.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    if (failure) throw new Error(`${(failure as Error).message}；序列诊断保存在 ${command.outputDir}`);
    return { directory: command.outputDir, metadataPath: path.join(command.outputDir, "sequence.json"), ...manifest };
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
