import fs from "node:fs/promises";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { followCommandSchema } from "./game-follow";

export async function runGameFollowCli(args: string[], request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>,
  io: Pick<NodeJS.Process, "stdout" | "stderr">): Promise<number> {
  try {
    const [op, ...rest] = args;
    const values = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 2) {
      if (!["--device", "--mode", "--config", "--run-id", "--params-file"].includes(rest[i]) || !rest[i + 1] || values.has(rest[i]))
        throw new Error("视觉跟随参数无效");
      values.set(rest[i], rest[i + 1]);
    }
    const allowed: Record<string, string[]> = { runtime: [], setup: [], status: [], load: [], save: ["--config"],
      start: ["--device", "--mode", "--config"], stop: ["--run-id"], analyze: ["--params-file"] };
    if (!(op in allowed) || [...values.keys()].some(k => !allowed[op].includes(k))) throw new Error("未知视觉跟随命令或参数");
    const read = async (file?: string) => {
      if (!file || (await fs.stat(file)).size > 12_000_000) throw new Error("需要有效的配置文件");
      return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    };
    const params = followCommandSchema.parse(op === "start"
      ? { op, id: values.get("--device"), mode: values.get("--mode") || "observe", config: await read(values.get("--config")) }
      : op === "save" ? { op, config: await read(values.get("--config")) }
      : op === "analyze" ? { ...await read(values.get("--params-file")), op }
      : op === "stop" ? { op, runId: values.get("--run-id") } : { op });
    const response = await request({ action: "phone", method: "follow-command", params });
    io.stdout.write(JSON.stringify(response, null, 2) + "\n"); return response.ok ? 0 : 1;
  } catch (error) { io.stderr.write(JSON.stringify({ ok: false, error: (error as Error).message }) + "\n"); return 1; }
}
