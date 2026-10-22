import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { PhoneSessionState } from "../../shared/phones";

export const SCREENSHOT_TRANSFER = "base64-chunks-v1";
const CHUNK_CHARS = 48 * 1024, MAX_CHARS = Math.ceil(5 * 1024 * 1024 / 3) * 4;
const captureReadyTimes = new WeakMap<object, number>();
/** Host monotonic receipt time of a validated descriptor, never phone/JSON metadata. */
export function captureReadyAt(frame: unknown): number | undefined {
  return frame !== null && typeof frame === "object" ? captureReadyTimes.get(frame) : undefined;
}
type Response = { state: PhoneSessionState; result?: unknown };
type Owner = Pick<PhoneSessionState, "instanceId" | "sessionId" | "generation">;
const descriptorSchema = z.object({ mime: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().positive().max(20000), height: z.number().int().positive().max(20000),
  region: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(),
    width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
  transfer: z.object({ protocol: z.literal(1), id: z.string().uuid(), length: z.number().int().positive().max(MAX_CHARS),
    chunkSize: z.literal(CHUNK_CHARS), ttlMs: z.literal(15000) }).strict()
}).strict().refine(frame => !frame.region || frame.region.x < frame.width && frame.region.y < frame.height
  && frame.region.width <= frame.width - frame.region.x && frame.region.height <= frame.height - frame.region.y,
  "截图区域超出原始画面");
const chunkSchema = z.object({ id: z.string().uuid(), offset: z.number().int().nonnegative(),
  base64: z.string().min(1).max(CHUNK_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/), done: z.boolean() }).strict();

/** One immutable capture, fetched in small authenticated responses. Never retakes a screenshot. */
export async function assembleScreenshot(initial: Response, owner: Owner,
  read: (body: Owner & { transferId: string; offset: number }) => Promise<Response>,
  current: () => boolean, now = () => performance.now()): Promise<Response> {
  if (!initial.result || typeof initial.result !== "object" || !("transfer" in initial.result)) return initial;
  const frame = descriptorSchema.parse(initial.result), transfer = frame.transfer;
  if (transfer.length % 4) throw new Error("手机截图传输长度无效。");
  const began = now(), chunks: string[] = [];
  const check = (state: PhoneSessionState) => {
    if (!current() || state.instanceId !== owner.instanceId || state.sessionId !== owner.sessionId
      || state.generation !== owner.generation || !["viewing", "controlling"].includes(state.phase))
      throw new Error("手机会话已改变，本次截图已丢弃。");
    if (now() - began >= transfer.ttlMs) throw new Error("手机截图传输已过期，请重新获取画面。");
  };
  let response = initial;
  for (let offset = 0; offset < transfer.length; offset += CHUNK_CHARS) {
    check(response.state);
    response = await read({ ...owner, transferId: transfer.id, offset });
    check(response.state);
    const chunk = chunkSchema.parse(response.result), expected = Math.min(CHUNK_CHARS, transfer.length - offset);
    if (chunk.id !== transfer.id || chunk.offset !== offset || chunk.base64.length !== expected
      || chunk.done !== (offset + expected === transfer.length) || !chunk.done && chunk.base64.includes("="))
      throw new Error("手机截图分块不完整或已改变，本次画面已丢弃。");
    chunks.push(chunk.base64);
  }
  check(response.state);
  const result = { mime: frame.mime, width: frame.width, height: frame.height,
    ...(frame.region ? { region: frame.region } : {}), base64: chunks.join("") };
  // Preserve descriptor receipt only for this exact, completely assembled image.
  // The association neither crosses JSON/IPC nor changes the public frame shape.
  captureReadyTimes.set(result, began);
  return { state: response.state, result };
}
