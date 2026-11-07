import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { adbCommand } from "./adb-command";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { readPhoneParams } from "./cli-input";
import { phoneExecParamsSchema } from "./cli-contract";
import { phoneFailure, phoneResponseError } from "./errors";

type Request = (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>;
export type AdbOutput = { stdout: { write(value: string | Buffer): unknown }; stderr: { write(value: string | Buffer): unknown } };
type IO = AdbOutput;
export async function executeAdbCli(flags: Map<string, string>, request: Request, io: IO, stdin: Readable = process.stdin): Promise<number> {
  const id = flags.get("--device");
  if (!id) throw phoneFailure("PHONE_INVALID_REQUEST", "exec 需要 --device。");
  const input = phoneExecParamsSchema.parse(await readPhoneParams(flags, 200000, stdin));
  if (input.input && input.stdin) throw phoneFailure("PHONE_INVALID_REQUEST", "ADB input 文件和 stdin:true 不能同时使用。");
  if (flags.has("--params-stdin") && input.stdin) throw phoneFailure("PHONE_INVALID_REQUEST", "--params-stdin 已用于 JSON；ADB 输入请使用 input 文件，或改用 --params-file。");
  const command = adbCommand(input.args);
  const mode = flags.get("--mode") || (input.input || input.stdin ? "control" : command.mode);
  if (!["view", "control"].includes(mode)) throw new Error("--mode 必须为 view 或 control。");
  if (mode === "view" && (command.mode === "control" || input.input || input.stdin)) throw new Error("此命令需要 control 模式。");
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const response = await request({ action: "phone", method, params });
    if (!response.ok) throw phoneResponseError(response); return response.data as T;
  };
  let lease: string | undefined, pulse: NodeJS.Timeout | undefined, pulsing: Promise<void> | undefined, failure: Error | undefined;
  let failed = false;
  try {
    const owner = await call<{ lease: string; device: { state: { generation: number } } }>("wrapper-start", {
      id, mode, backend: flags.get("--backend") || "app", controller: flags.get("--controller") || "ProfilePilot CLI", task: flags.get("--task") || `ADB ${input.args[0]}`
    }); lease = owner.lease;
    if (!owner.device?.state || !Number.isInteger(owner.device.state.generation)) throw phoneFailure("PHONE_RESPONSE_MISSING", "手机未返回有效控制会话；ADB 命令尚未提交。");
    pulse = setInterval(() => {
      if (pulsing || failure) return;
      pulsing = call("wrapper-pulse", { lease }).then(() => {}).catch(error => { failure = error; }).finally(() => { pulsing = undefined; });
    }, 1000);
    const code = await streamAdb(input.args, lease, owner.device.state.generation, request, io, input, stdin);
    if (failure) throw failure; return code;
  } catch (error) { failed = true; throw error;
  } finally {
    clearInterval(pulse); await pulsing;
    if (lease) { try { await call("wrapper-stop", { lease }); } catch (error) { if (!failed) throw error; } }
  }
}
export async function streamAdb(args: string[], lease: string, generation: number, request: Request, io: IO,
    options: { output?: string; input?: string; timeoutMs?: number; stdin?: boolean } = {}, stdin: Readable = process.stdin): Promise<number> {
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    const result = await request({ action: "phone", method, params });
    if (!result.ok) throw phoneResponseError(result);
    return result.data as T;
  };
  let jobId: string | undefined, offset = 0, ended = false, sending: Promise<void> = Promise.resolve(), inputError: Error | undefined;
  let file: fs.promises.FileHandle | undefined;
  let source: Readable = stdin;
  const readInput = !!options.input || !!options.stdin;
  const cancelled = () => { if (jobId) void call("adb-cancel", { lease, jobId }).catch(() => {}); };
  try {
    try {
      if (options.input) await fs.promises.access(path.resolve(options.input));
      if (options.output) file = await fs.promises.open(path.resolve(options.output), "wx");
    } catch { throw phoneFailure("PHONE_INVALID_REQUEST", "ADB 输入文件不可读或输出文件已存在/不可创建；命令未发送。"); }
    const start = await call<{ jobId: string }>("adb-start", { lease, generation, requestId: randomUUID(), args,
      cwd: process.cwd(), timeoutMs: options.timeoutMs, stdin: readInput }); jobId = start.jobId;
    process.once("SIGINT", cancelled); process.once("SIGTERM", cancelled);
    let sequence = 0;
    const send = (data: Buffer, eof = false) => {
      sending = sending.then(async () => {
        for (let at = 0; at < data.length; at += 49152) {
          if (ended) return;
          await call("adb-input", { lease, jobId, sequence: sequence++, data: data.subarray(at, at + 49152).toString("base64") });
        }
        if (eof && !ended) await call("adb-input", { lease, jobId, sequence: sequence++, data: "", eof: true });
      }).catch(error => { inputError = error; cancelled(); });
    };
    const onData = (bytes: Buffer) => { source.pause(); send(bytes); void sending.finally(() => { if (!ended && !inputError) source.resume(); }); };
    const onEnd = () => send(Buffer.alloc(0), true);
    const onError = (error: Error) => { inputError = error; cancelled(); };
    if (readInput) { if (options.input) source = fs.createReadStream(path.resolve(options.input)); source.on("data", onData); source.once("end", onEnd); source.once("error", onError); if (source.readableEnded) onEnd(); else source.resume(); }
    try {
      while (true) {
        const result = await call<{ status: string; code: number | null; error?: string; nextOffset: number; drained: boolean; chunks: { channel: "stdout" | "stderr"; data: string }[] }>("adb-status", { lease, jobId, offset });
        for (const chunk of result.chunks) {
          const bytes = Buffer.from(chunk.data, "base64");
          if (file && chunk.channel === "stdout") await file.writeFile(bytes);
          else io[chunk.channel].write(bytes);
        }
        offset = result.nextOffset;
        if (result.status !== "running" && result.drained) {
          if (result.error) io.stderr.write(`[ProfilePilot] ${result.error}\n`);
          if (inputError) throw inputError;
          return result.status === "completed" ? result.code ?? 1 : 75;
        }
        if (result.drained) await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally {
      ended = true;
      if (readInput) { source.pause(); source.off("data", onData); source.off("end", onEnd); source.off("error", onError); }
      await sending;
    }
  } finally {
    ended = true;
    process.off("SIGINT", cancelled); process.off("SIGTERM", cancelled);
    if (source !== stdin) source.destroy();
    if (jobId) await call("adb-cancel", { lease, jobId }).catch(() => {});
    await file?.close();
  }
}
