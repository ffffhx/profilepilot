import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import extract from "extract-zip";
import type { AndroidArchive } from "./android-repository";

export interface AndroidCommand {
  file: string; args: string[]; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  input?: string; timeout?: number; output?: (text: string) => void;
}
export function runAndroidCommand(command: AndroidCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { env: command.env, signal: command.signal, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let tail = "", timedOut = false, processError: Error | undefined;
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, command.timeout || 120000);
    const data = (chunk: Buffer) => { const text = chunk.toString("utf8"); tail = (tail + text).slice(-16000); command.output?.(text); };
    child.stdout.on("data", data); child.stderr.on("data", data);
    child.stdin.on("error", () => {}); child.stdin.end(command.input || "");
    child.once("error", error => { processError = error; });
    child.once("close", code => {
      clearTimeout(timeout);
      if (command.signal?.aborted) reject(new Error("操作已取消。"));
      else if (timedOut) reject(new Error("Android 工具运行超时，请检查网络后重试。"));
      else if (processError) reject(processError);
      else if (code !== 0) reject(new Error(tail.trim().slice(-1800) || "Android 工具未能完成操作。"));
      else resolve(tail);
    });
  });
}
export async function downloadAndroidArchive(archive: AndroidArchive, target: string, fetcher: typeof fetch, signal: AbortSignal, progress: (value: number) => void): Promise<void> {
  const response = await fetcher(archive.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60 * 1000)]) });
  if (!response.ok || !response.body) throw new Error(`下载安装包失败（HTTP ${response.status}），请检查网络后重试。`);
  const hash = createHash(archive.algorithm); let bytes = 0, last = -1;
  const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
    bytes += chunk.length;
    if (bytes > archive.bytes + 1024 * 1024) { done(new Error("安装包大小与官方目录不一致。")); return; }
    hash.update(chunk);
    const percent = Math.min(100, Math.floor(bytes / archive.bytes * 100));
    if (percent !== last) { last = percent; progress(percent); }
    done(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body as any), meter, fs.createWriteStream(target, { flags: "wx" }), { signal });
  if (bytes !== archive.bytes || hash.digest("hex").toLowerCase() !== archive.checksum.toLowerCase()) throw new Error("安装包校验失败，请重新下载。");
}
export async function extractAndroidArchive(file: string, target: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (file.endsWith(".zip")) await extract(file, { dir: path.resolve(target), onEntry() { signal.throwIfAborted(); } });
  else {
    // Only checksum-verified Temurin archives reach this path, on macOS/Linux.
    await fs.promises.mkdir(target, { recursive: true });
    await runAndroidCommand({ file: "/usr/bin/tar", args: ["-xzf", file, "-C", target], signal, timeout: 120000 });
  }
  signal.throwIfAborted();
}
export async function removeAndroidStage(stage: string, parent: string): Promise<void> {
  const resolved = path.resolve(stage), base = path.resolve(parent);
  if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith("install-")) throw new Error("Invalid Android staging directory.");
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
