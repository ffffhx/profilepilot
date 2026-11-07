import fs from "node:fs/promises";
import type { Readable } from "node:stream";
import { phoneFailure } from "./errors";

/** One JSON object, from exactly one source. Never echo parse excerpts (pairing codes may be present). */
export async function readPhoneParams(flags: Map<string, string>, maxBytes = 32768, stdin: Readable = process.stdin): Promise<Record<string, unknown>> {
  const file = flags.get("--params-file"), fromStdin = flags.has("--params-stdin");
  const invalid = (message: string): never => { throw phoneFailure("PHONE_INVALID_REQUEST", message); };
  if (Number(!!file) + Number(fromStdin) !== 1) invalid("请且仅指定一个 JSON 来源：--params-file <文件> 或 --params-stdin。");
  let text: string;
  if (file) {
    try {
      if ((await fs.stat(file)).size > maxBytes) invalid(`参数 JSON 超过 ${maxBytes} 字节。`);
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "PHONE_INVALID_REQUEST") throw error;
      invalid("无法读取 --params-file；请确认参数文件存在且可读取。");
    }
  } else {
    if ((stdin as NodeJS.ReadStream).isTTY) invalid("--params-stdin 需要通过管道输入 JSON；交互输入请使用参数文件。");
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of stdin) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > maxBytes) invalid(`参数 JSON 超过 ${maxBytes} 字节。`);
        chunks.push(bytes);
      }
      text = Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "PHONE_INVALID_REQUEST") throw error;
      invalid("无法读取 --params-stdin JSON。");
    }
  }
  let value: unknown;
  try { value = JSON.parse(text!.replace(/^\uFEFF/, "")); }
  catch { invalid("参数 JSON 语法无效；内容未发送到手机。请运行 ppilot phone schema <命令> 查看格式。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("参数 JSON 必须是对象。");
  return value as Record<string, unknown>;
}
