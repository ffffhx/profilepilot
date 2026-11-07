import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { followCommandSchema } from "./game-follow";
import { cameraSampleCommandSchema } from "./camera-sample";
import { readPhoneParams } from "./cli-input";
import { phoneErrorResult, phoneExitCode, phoneResponseError } from "./errors";
import { phoneGroupFlags } from "./cli-contract";

export async function runGameFollowCli(args: string[], request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>,
  io: Pick<NodeJS.Process, "stdout" | "stderr">, input: Readable = process.stdin): Promise<number> {
  let dispatched = false;
  try {
    const [op, ...rest] = args;
    const values = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] === "--params-stdin" && !values.has(rest[i])) { values.set(rest[i], "on"); i--; continue; }
      if (!["--device", "--mode", "--backend", "--config", "--run-id", "--params-file", "--recover-transport", "--x", "--y", "--output", "--steps-file"].includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith("--") || values.has(rest[i]))
        throw new Error("视觉跟随参数无效");
      values.set(rest[i], rest[i + 1]);
    }
    const allowed = phoneGroupFlags.follow;
    if (!(op in allowed) || [...values.keys()].some(k => !allowed[op].includes(k))) throw new Error("未知视觉跟随命令或参数");
    if (values.has("--recover-transport") && !["true", "false"].includes(values.get("--recover-transport")!))
      throw new Error("--recover-transport 仅接受 true 或 false");
    const read = async (file?: string) => {
      if (!file || (await fs.stat(file)).size > 12_000_000) throw new Error("需要有效的配置文件");
      return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    };
    if (op === "camera-sample" && (!values.get("--output") || !/^\d+$/.test(values.get("--x") || "") || !/^\d+$/.test(values.get("--y") || "")))
      throw new Error("镜头采样需要 --device、整数 --x/--y 和新的 --output 目录");
    const params = op === "camera-sample" ? cameraSampleCommandSchema.parse({ op, id: values.get("--device"),
      x: Number(values.get("--x")), y: Number(values.get("--y")), outputDir: path.resolve(values.get("--output")!),
      ...(values.has("--steps-file") ? { steps: await read(values.get("--steps-file")) } : {}) }) : followCommandSchema.parse(op === "start"
      ? { op, id: values.get("--device"), mode: values.get("--mode") || "observe", backend: values.get("--backend") || "app",
        ...(values.has("--recover-transport") ? { recoverTransport: values.get("--recover-transport") === "true" } : {}), config: await read(values.get("--config")) }
      : op === "save" ? { op, config: await read(values.get("--config")) }
      : op === "analyze" ? { ...await readPhoneParams(values, 12000000, input), op }
      : op === "stop" ? { op, runId: values.get("--run-id") } : { op });
    dispatched = true;
    const response = await request({ action: "phone", method: "follow-command", params });
    if (!response.ok) throw phoneResponseError(response);
    io.stdout.write(JSON.stringify(response, null, 2) + "\n"); return response.ok ? 0 : 1;
  } catch (error) { const result = phoneErrorResult(error, dispatched); io.stderr.write(JSON.stringify(result) + "\n"); return phoneExitCode(result.recovery); }
}
