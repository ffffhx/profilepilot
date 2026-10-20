import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { crc32 } from "node:zlib";
import { deviceShell, type AdbRunner } from "./adb";

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxBytes = 24 * 1024 * 1024;
const invalid = () => new Error("手机未返回有效画面，请解锁手机或切换到允许截图的页面。");
const fileTransports = new WeakMap<AdbRunner, Map<string, number>>();

/** Validate every chunk, including IEND; an IHDR alone is not a screenshot. */
export function inspectScreenPng(png: Buffer): { width: number; height: number; complete: boolean } {
  if (png.length < 33 || png.length > maxBytes || !png.subarray(0, 8).equals(signature)
    || png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR") throw invalid();
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || width > 20000 || height > 20000) throw new Error("手机画面尺寸无效。");
  let offset = 8, data = false;
  while (offset < png.length) {
    if (offset + 12 > png.length) break;
    const length = png.readUInt32BE(offset);
    if (length > maxBytes) throw invalid();
    const end = offset + length + 12;
    if (end > png.length) break;
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) throw invalid();
    if (type === "IHDR" && offset !== 8) throw invalid();
    if (type === "IDAT") data = true;
    if (type === "IEND") {
      if (length || !data || end !== png.length) throw invalid();
      return { width, height, complete: true };
    }
    offset = end;
  }
  return { width, height, complete: false };
}

/** Some emulator exec-out transports truncate at 64 KiB. Pull one fresh frame in that case. */
export async function captureAdbScreen(adb: AdbRunner, id: string, signal: AbortSignal, guard: () => void) {
  if (!adb.runBinary) throw new Error("当前 ADB 不支持读取手机画面。");
  const check = () => { guard(); signal.throwIfAborted(); };
  check();
  let transports = fileTransports.get(adb);
  if (!transports) { transports = new Map(); fileTransports.set(adb, transports); }
  if ((transports.get(id) || 0) <= Date.now()) {
    const direct = await adb.runBinary(["-s", id, "exec-out", "screencap", "-p"], 12000, signal);
    check();
    const info = inspectScreenPng(direct);
    if (info.complete) return { png: direct, width: info.width, height: info.height };
    // Avoid throwing away another full capture on every frame of the same stream.
    transports.set(id, Date.now() + 5 * 60_000);
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ppilot-screen-"));
  const local = path.join(directory, "screen.png"), remote = `/data/local/tmp/ppilot-screen-${randomUUID()}.png`;
  let submitted = false;
  try {
    check(); submitted = true;
    await adb.run(["-s", id, "shell", deviceShell(["screencap", "-p", remote])], 12000, undefined, signal);
    check();
    await adb.run(["-s", id, "pull", remote, local], 12000, undefined, signal);
    check();
    if ((await fs.stat(local)).size > maxBytes) throw invalid();
    const png = await fs.readFile(local);
    check();
    const frame = inspectScreenPng(png);
    if (!frame.complete) throw invalid();
    return { png, width: frame.width, height: frame.height };
  } finally {
    // Do not send even cleanup commands after a pause, disconnect or ownership change.
    if (submitted) {
      try { check(); await adb.run(["-s", id, "shell", deviceShell(["rm", "-f", remote])], 3000, undefined, signal); }
      catch { /* A revoked session may leave its uniquely named temporary frame. */ }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}
