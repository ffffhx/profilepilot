import { deviceShell, type AdbRunner } from "./adb";

/** Screen access is a user-initiated device action, independent of any session lease. */
export const WAKE_KEYEVENT = "224";

export function parseScreenSize(output: string): { width: number; height: number } | null {
  const match = output.match(/Override size:\s*(\d+)x(\d+)/) || output.match(/Physical size:\s*(\d+)x(\d+)/);
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  return Number.isInteger(width) && Number.isInteger(height) && width >= 200 && height >= 200
    && width <= 20000 && height <= 20000 ? { width, height } : null;
}

/** A sleeping device can report "not keyguard locked"; trust the power state first. */
export function parseWakefulness(output: string): boolean | null {
  const match = output.match(/mWakefulness=(\w+)/);
  return match ? match[1] === "Awake" : null;
}

/** True/false only for a recognized dump; an unknown build reports null. */
export function parseKeyguardLocked(output: string): boolean | null {
  const dreaming = output.match(/mDreamingLockscreen=(true|false)/);
  const showing = output.match(/mShowingLockscreen=(true|false)/);
  if (!dreaming && !showing) return null;
  return dreaming?.[1] === "true" || showing?.[1] === "true";
}

/** Failures here must not echo argv: the unlock command carries the user's PIN. */
function inputFailure(output: string): boolean {
  return /Exception|Error:|Permission denied/i.test(output);
}

export async function readScreenSize(adb: AdbRunner, id: string, signal?: AbortSignal): Promise<{ width: number; height: number } | null> {
  try { return parseScreenSize(await adb.run(["-s", id, "shell", deviceShell(["wm", "size"])], 8000, undefined, signal)); }
  catch { return null; }
}

export async function keyguardLocked(adb: AdbRunner, id: string, signal?: AbortSignal): Promise<boolean | null> {
  try { return parseKeyguardLocked(await adb.run(["-s", id, "shell", deviceShell(["dumpsys", "window"])], 12000, undefined, signal)); }
  catch { return null; }
}

export async function screenAwake(adb: AdbRunner, id: string, signal?: AbortSignal): Promise<boolean | null> {
  try { return parseWakefulness(await adb.run(["-s", id, "shell", deviceShell(["dumpsys", "power"])], 12000, undefined, signal)); }
  catch { return null; }
}

/** Wake the device. Only an unsecured keyguard is dismissible; a credential stays. */
export async function wakeDevice(adb: AdbRunner, id: string, signal?: AbortSignal): Promise<void> {
  await adb.run(["-s", id, "shell", deviceShell(["input", "keyevent", WAKE_KEYEVENT])], 8000, undefined, signal);
  await adb.run(["-s", id, "shell", deviceShell(["wm", "dismiss-keyguard"])], 8000, undefined, signal).catch(() => "");
}

export interface UnlockSteps {
  /** Swipe the bouncer up before typing. Some builds focus the PIN field directly. */
  swipe?: boolean;
  size?: { width: number; height: number } | null;
}

/**
 * Type the credential on the lock screen. The credential is never retried:
 * a rejected or uncertain attempt leaves the device to the user.
 */
export async function swipeUpBouncer(adb: AdbRunner, id: string, size: { width: number; height: number }, signal?: AbortSignal): Promise<void> {
  const x = Math.round(size.width / 2);
  await adb.run(["-s", id, "shell", deviceShell(["input", "swipe", String(x), String(Math.round(size.height * 0.82)), String(x), String(Math.round(size.height * 0.35)), "200"])], 8000, undefined, signal);
}

export async function enterCredential(adb: AdbRunner, id: string, credential: string, steps: UnlockSteps = {}, signal?: AbortSignal): Promise<void> {
  const { width, height } = steps.size || { width: 0, height: 0 };
  if (steps.swipe && width && height) await swipeUpBouncer(adb, id, { width, height }, signal);
  const typed = await adb.run(["-s", id, "shell", deviceShell(["input", "text", credential])], 8000, undefined, signal);
  if (inputFailure(typed)) throw new Error("手机拒绝输入解锁凭据，请检查系统的 USB 调试安全设置。");
  const submitted = await adb.run(["-s", id, "shell", deviceShell(["input", "keyevent", "66"])], 8000, undefined, signal);
  if (inputFailure(submitted)) throw new Error("手机未接受解锁提交，请在手机上确认。");
}

/** Digits, letters and symbols; `input text` maps spaces to %s and is not used here. */
export function validateCredential(value: string): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,64}$/.test(value)) throw new Error("解锁凭据必须是 1–64 位可打印字符，且不含空格。");
  return value;
}

/** Center of dot 5 and the distance between adjacent dot centers, in pixels. */
export interface PatternLayout { cx: number; cy: number; stepX: number; stepY: number; }

export function validatePattern(value: string): number[] {
  if (typeof value !== "string" || !/^[1-9]{4,9}$/.test(value)) throw new Error("图案必须是 4–9 个 1–9 的数字，例如 1478。");
  const dots = [...value].map(Number);
  if (new Set(dots).size !== dots.length) throw new Error("图案不能包含重复的点。");
  return dots;
}

export function parsePatternLayout(value: string): PatternLayout {
  const parts = value.split(/[,;:\s]+/).filter(Boolean).map(Number);
  if ((parts.length !== 3 && parts.length !== 4) || parts.some(part => !Number.isFinite(part))) throw new Error("图案坐标格式应为 cx,cy,步长或 cx,cy,stepX,stepY。");
  const [cx, cy, stepX, stepY = stepX] = parts;
  if (cx < 0 || cy < 0 || stepX < 20 || stepY < 20 || cx > 20000 || cy > 20000 || stepX > 4000 || stepY > 4000) throw new Error("图案坐标超出屏幕范围。");
  return { cx, cy, stepX, stepY };
}

/** Digit 1–9 maps to the 3×3 grid, left-to-right then top-to-bottom. */
export function patternPoints(dots: number[], layout: PatternLayout): { x: number; y: number }[] {
  return dots.map(dot => ({
    x: Math.round(layout.cx + ((dot - 1) % 3 - 1) * layout.stepX),
    y: Math.round(layout.cy + (Math.floor((dot - 1) / 3) - 1) * layout.stepY)
  }));
}

/**
 * Fallback geometry for a keyguard we cannot measure. Calibrated on a
 * 720×1600 AOSP keyguard: dots centered at 49.9% W / 71.7% H, 25.2% W apart.
 */
export function defaultPatternLayout(width: number, height: number): PatternLayout {
  const step = Math.round(width * 0.252);
  return { cx: Math.round(width / 2), cy: Math.round(height * 0.717), stepX: step, stepY: step };
}

export interface PixelScreen { width: number; height: number; format: number; pixels: Buffer; }

/** `screencap` without -p writes three little-endian uint32s, then raw pixels. */
export function parseRawScreencap(data: Buffer): PixelScreen | null {
  if (data.length < 12) return null;
  const width = data.readUInt32LE(0), height = data.readUInt32LE(4), format = data.readUInt32LE(8);
  if (width < 200 || height < 200 || width > 20000 || height > 20000) return null;
  if (format !== 1 && format !== 2) return null;
  const bytes = width * height * 4;
  if (data.length < 12 + bytes) return null;
  return { width, height, format, pixels: data.subarray(12, 12 + bytes) };
}

/**
 * Find the nine keyguard pattern dots in a lock-screen capture. This is
 * best-effort: secure keyguards can return black pixels, and a busy wallpaper
 * can hide the dots. Callers fall back to a saved or default geometry.
 */
export function detectPatternGrid(screen: PixelScreen): PatternLayout | null {
  const { width, height, pixels } = screen;
  const sample = 2;
  const left = Math.floor(width * 0.05), right = Math.floor(width * 0.95);
  const top = Math.floor(height * 0.35), bottom = Math.floor(height * 0.92);
  const sw = Math.floor((right - left) / sample), sh = Math.floor((bottom - top) / sample);
  if (sw < 3 || sh < 3) return null;
  const bright = new Uint8Array(sw * sh);
  for (let sy = 0; sy < sh; sy++) for (let sx = 0; sx < sw; sx++) {
    const at = ((top + sy * sample) * width + left + sx * sample) * 4;
    const r = pixels[at], g = pixels[at + 1], b = pixels[at + 2];
    if (r > 170 && g > 170 && b > 170 && Math.max(r, g, b) - Math.min(r, g, b) < 40) bright[sy * sw + sx] = 1;
  }
  const seen = new Uint8Array(sw * sh);
  const dots: { x: number; y: number; count: number; width: number; height: number; fill: number }[] = [];
  for (let start = 0; start < bright.length; start++) {
    if (!bright[start] || seen[start]) continue;
    const stack = [start]; seen[start] = 1;
    let count = 0, sumX = 0, sumY = 0, minX = sw, maxX = -1, minY = sh, maxY = -1;
    while (stack.length) {
      const index = stack.pop()!, x = index % sw, y = (index - x) / sw;
      count++; sumX += x; sumY += y;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= sw || ny >= sh) continue;
        const next = ny * sw + nx;
        if (bright[next] && !seen[next]) { seen[next] = 1; stack.push(next); }
      }
    }
    const boxWidth = (maxX - minX + 1) * sample, boxHeight = (maxY - minY + 1) * sample;
    dots.push({
      x: (sumX / count) * sample + left, y: (sumY / count) * sample + top, count,
      width: boxWidth, height: boxHeight, fill: count / ((maxX - minX + 1) * (maxY - minY + 1))
    });
  }
  const minDiameter = width * 0.012, maxDiameter = width * 0.05;
  const circles = dots.filter(dot => {
    const diameter = Math.max(dot.width, dot.height), ratio = dot.width / dot.height;
    return dot.count >= 8 && diameter >= minDiameter && diameter <= maxDiameter
      && ratio > 0.75 && ratio < 1.35 && dot.fill > 0.55;
  });
  if (circles.length !== 9) return null;
  const diameters = circles.map(dot => Math.max(dot.width, dot.height));
  if (Math.max(...diameters) > Math.min(...diameters) * 1.3) return null;
  const sorted = [...circles].sort((a, b) => a.y - b.y);
  const rows = [0, 1, 2].map(row => sorted.slice(row * 3, row * 3 + 3).sort((a, b) => a.x - b.x));
  const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
  const rowY = rows.map(row => (row[0].y + row[1].y + row[2].y) / 3);
  const colX = [0, 1, 2].map(column => (rows[0][column].x + rows[1][column].x + rows[2][column].x) / 3);
  const stepX = (colX[2] - colX[0]) / 2, stepY = (rowY[2] - rowY[0]) / 2;
  if (stepX < width * 0.15 || stepY < width * 0.15 || Math.abs(stepX - stepY) > Math.max(stepX, stepY) * 0.25) return null;
  for (const row of rows) if (spread(row.map(dot => dot.y)) > stepY * 0.35) return null;
  for (let column = 0; column < 3; column++) if (spread(rows.map(row => row[column].x)) > stepX * 0.25) return null;
  return { cx: colX[1], cy: rowY[1], stepX, stepY };
}

/**
 * Draw a pattern as one continuous gesture. A separate `input swipe` per
 * segment lifts the finger and restarts the pattern, so DOWN/MOVE/UP events
 * are injected individually.
 */
export async function drawPattern(adb: AdbRunner, id: string, points: { x: number; y: number }[], signal?: AbortSignal): Promise<void> {
  if (points.length < 2) throw new Error("图案至少需要两个点。");
  const event = (action: "DOWN" | "MOVE" | "UP", point: { x: number; y: number }) =>
    adb.run(["-s", id, "shell", deviceShell(["input", "motionevent", action, String(point.x), String(point.y)])], 8000, undefined, signal);
  let open = false;
  try {
    await event("DOWN", points[0]); open = true;
    for (const point of points.slice(1)) await event("MOVE", point);
    await event("UP", points[points.length - 1]); open = false;
  } finally {
    // Never leave a finger down: the next attempt would start inside a gesture.
    if (open) await event("UP", points[points.length - 1]).catch(() => undefined);
  }
}
