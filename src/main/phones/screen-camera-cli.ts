import fs from "node:fs/promises";
import type { Readable } from "node:stream";
import type { ProfilePilotManagementCommand, ProfilePilotManagementResponse } from "../profilepilot-management-protocol";
import { cameraStartSchema, cameraCommandSchema } from "./screen-camera";
import { readPhoneParams } from "./cli-input";
import { phoneErrorResult, phoneExitCode, phoneResponseError } from "./errors";
import { phoneGroupFlags } from "./cli-contract";

export async function runScreenCameraCli(args: string[], request: (command: ProfilePilotManagementCommand) => Promise<ProfilePilotManagementResponse>, io: Pick<NodeJS.Process, "stdout" | "stderr">, input: Readable = process.stdin): Promise<number> {
  let dispatched = false;
  try {
    const op = args[0];
    if (!["probe", "sources", "start", "status", "preview", "apps", "launch", "frame", "tap", "key", "stop"].includes(op)) throw new Error("camera 支持 probe、sources、start、status、preview、apps、launch、frame、tap、key、stop");
    const flags = new Map<string, string>();
    for (let i = 1; i < args.length; i++) {
      const key = args[i];
      if (key === "--json") continue;
      if (key === "--params-stdin" && !flags.has(key)) { flags.set(key, "on"); continue; }
      if (!["--device", "--params-file", "--file", "--output"].includes(key) || flags.has(key) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`参数无效或缺少值：${key}`);
      flags.set(key, args[++i]);
    }
    const allowed = phoneGroupFlags.camera[op];
    for (const key of flags.keys()) if (!allowed.includes(key)) throw new Error(`camera ${op} 不支持 ${key}`);
    let method: string, params: unknown;
    if (op === "sources") { method = "camera-sources"; params = {}; }
    else if (op === "probe") { if (!flags.get("--device")) throw new Error("请指定 --device"); method = "camera-probe"; params = { id: flags.get("--device") }; }
    else {
      const parsed = await readPhoneParams(flags, 32768, input);
      if (op === "frame") {
        const image = flags.get("--file"); if (!image) throw new Error("camera frame 需要 --file 指向当前浏览器二维码截图");
        if ((await fs.stat(image)).size > 700000) throw new Error("二维码截图过大，请裁剪到二维码区域（最多 700 KB）");
        parsed.base64 = (await fs.readFile(image)).toString("base64");
      }
      method = op === "start" ? "camera-start" : "camera-command";
      params = op === "start" ? cameraStartSchema.parse(parsed) : cameraCommandSchema.parse({ ...parsed, op });
    }
    dispatched = true;
    const response = await request({ action: "phone", method, params });
    if (!response.ok) throw phoneResponseError(response);
    if (response.ok && op === "preview" && flags.has("--output")) {
      const data = response.data as { mime: string; base64: string };
      if (data.mime !== "image/jpeg" || typeof data.base64 !== "string") throw new Error("未返回扫码 App 画面");
      await fs.writeFile(flags.get("--output")!, Buffer.from(data.base64, "base64")); response.data = { output: flags.get("--output") };
    }
    io.stdout.write(JSON.stringify(response, null, 2) + "\n"); return response.ok ? 0 : 1;
  } catch (error) { const result = phoneErrorResult(error, dispatched); io.stderr.write(JSON.stringify(result) + "\n"); return phoneExitCode(result.recovery); }
}
