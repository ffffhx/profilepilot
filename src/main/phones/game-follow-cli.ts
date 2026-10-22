import fs from "node:fs/promises";
import path from "node:path";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { followCommandSchema } from "./game-follow";
import { cameraSampleCommandSchema } from "./camera-sample";

export async function runGameFollowCli(args: string[], request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>,
  io: Pick<NodeJS.Process, "stdout" | "stderr">): Promise<number> {
  try {
    const [op, ...rest] = args;
    const values = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 2) {
      if (!["--device", "--mode", "--backend", "--config", "--run-id", "--params-file", "--recover-transport", "--x", "--y", "--output"].includes(rest[i]) || !rest[i + 1] || values.has(rest[i]))
        throw new Error("视觉跟随参数无效");
      values.set(rest[i], rest[i + 1]);
    }
    const allowed: Record<string, string[]> = { runtime: [], setup: [], status: [], load: [], save: ["--config"],
      start: ["--device", "--mode", "--backend", "--config", "--recover-transport"], stop: ["--run-id"], analyze: ["--params-file"],
      "camera-sample": ["--device", "--x", "--y", "--output"] };
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
      x: Number(values.get("--x")), y: Number(values.get("--y")), outputDir: path.resolve(values.get("--output")!) }) : followCommandSchema.parse(op === "start"
      ? { op, id: values.get("--device"), mode: values.get("--mode") || "observe", backend: values.get("--backend") || "app",
        ...(values.has("--recover-transport") ? { recoverTransport: values.get("--recover-transport") === "true" } : {}), config: await read(values.get("--config")) }
      : op === "save" ? { op, config: await read(values.get("--config")) }
      : op === "analyze" ? { ...await read(values.get("--params-file")), op }
      : op === "stop" ? { op, runId: values.get("--run-id") } : { op });
    const response = await request({ action: "phone", method: "follow-command", params });
    io.stdout.write(JSON.stringify(response, null, 2) + "\n"); return response.ok ? 0 : 1;
  } catch (error) { io.stderr.write(JSON.stringify({ ok: false, error: (error as Error).message }) + "\n"); return 1; }
}
