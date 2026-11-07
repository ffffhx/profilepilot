import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { readPhoneParams } from "./cli-input";
import { phoneFailure, phoneResponseError } from "./errors";

const operations: Record<string, string[]> = { status: [], configure: ["--params-file", "--params-stdin"], pair: ["--output"], forget: ["--device"], "install-status": ["--device", "--job"] };
export async function runInternetPhoneCli(args: string[], request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>,
  io: Pick<NodeJS.Process, "stdout" | "stderr">, input: Readable) {
  const op = args[0], allowed = operations[op];
  if (!allowed) throw phoneFailure("PHONE_INVALID_REQUEST", "使用 phone internet status、configure、pair、forget 或 install-status。");
  const flags = new Map<string, string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--json") continue;
    if (!allowed.includes(flag) || flags.has(flag)) throw phoneFailure("PHONE_INVALID_REQUEST", `无效的外网控制参数：${flag}`);
    if (flag === "--params-stdin") { flags.set(flag, "on"); continue; }
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw phoneFailure("PHONE_INVALID_REQUEST", `缺少参数值：${flag}`);
    flags.set(flag, args[++i]);
  }
  const params = op === "configure" ? await readPhoneParams(flags, 8192, input)
    : op === "forget" ? { id: flags.get("--device") } : op === "install-status" ? { id: flags.get("--device"), jobId: flags.get("--job") } : {};
  if (op === "forget" && !flags.get("--device")) throw phoneFailure("PHONE_INVALID_REQUEST", "forget 需要 --device。");
  if (op === "install-status" && (!flags.get("--device") || !flags.get("--job"))) throw phoneFailure("PHONE_INVALID_REQUEST", "install-status 需要 --device 和 --job。");
  if (op === "pair") {
    const output = flags.get("--output");
    if (!output) throw phoneFailure("PHONE_INVALID_REQUEST", "pair 需要 --output 新文件路径；配对凭据不会输出到日志。");
    const file = path.resolve(output);
    const handle = await fs.open(file, "wx", 0o600);
    try {
      const reply = await request({ action: "phone", method: "internet-pair", params });
      if (!reply.ok) throw phoneResponseError(reply);
      const pair = reply.data as { uri: string; expiresAt: number; computer: string; endpoint: string };
      await handle.writeFile(JSON.stringify(pair), "utf8");
      io.stdout.write(JSON.stringify({ ok: true, data: { file, expiresAt: pair.expiresAt, computer: pair.computer, endpoint: pair.endpoint } }, null, 2) + "\n");
    } finally { await handle.close(); }
    return 0;
  }
  const reply = await request({ action: "phone", method: `internet-${op}`, params });
  if (!reply.ok) throw phoneResponseError(reply);
  io.stdout.write(JSON.stringify(reply, null, 2) + "\n"); return 0;
}
