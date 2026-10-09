import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { agentSkillTargetPaths } from "./agent-skill-integration";
import type { ControlPreferencesDomain, ControlPreferencesSnapshot, ControlPreferencesUpdate } from "../shared/control-preferences";

const MAX_BYTES = 1024 * 1024;
const writes = new Map<string, Promise<unknown>>();
const electronDefaults = `# Electron 控制偏好

- 使用 ProfilePilot 本地应用中登记的目标，通过 ppilot browser 连接该应用自己的 Agent 逻辑端口，不直连原始调试端口。
- 默认后台读取、点击、输入和截图，不主动激活窗口或抢占前台；不要为了查看界面而重启应用或打开 DevTools。
- 保持一应用一会话。用户接管后停止操作，明确交还后重新观察界面再继续；完成任务后结束会话。
- 控制时使用 ProfilePilot 的控制悬浮标识；需要显示标识时，保持 ProfilePilot 运行并开启悬浮层。标识未显示时先检查状态，不假定已正常显示。
- 应用未登记、调试连接未就绪或目标不明确时，先说明缺少的条件，不擅自切换应用。
- 按实际 Windows / macOS 环境操作；应用自身的启动焦点和原生弹窗不属于后台操作保证。
`;

function definition(domain: ControlPreferencesDomain) {
  if (domain === "browser") return { label: "浏览器控制偏好", file: "browser-routing.md" };
  if (domain === "electron") return { label: "Electron 控制偏好", file: "electron-control.md" };
  if (domain === "phone") return { label: "手机控制偏好", file: "phone-control.md" };
  throw new Error("不支持的控制偏好类型。");
}

async function preferenceFiles(homeDir: string, domain: ControlPreferencesDomain) {
  const config = definition(domain);
  const files: Array<{ label: string; path: string; content: string; exists: boolean }> = [];
  const seen = new Set<string>();
  for (const target of agentSkillTargetPaths("profilepilot", homeDir)) {
    try { await fs.access(path.join(target.path, "SKILL.md")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    // Resolve existing Skill directory links once, so shared client links are
    // not written multiple times. Renderer requests never supply a path.
    const file = path.join(await fs.realpath(target.path), "local", config.file);
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (seen.has(key)) continue;
    seen.add(key);
    let content = "", exists = false;
    try {
      const stat = await fs.stat(file);
      if (stat.size > MAX_BYTES) throw new Error(`${config.label}文件超过 1 MB，请缩小后再编辑。`);
      content = await fs.readFile(file, "utf8"); exists = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    files.push({ label: target.label, path: file, content, exists });
  }
  if (!files.length) throw new Error("请先安装 ProfilePilot CLI 的 Agent 使用指引，再编辑控制偏好。");
  return files;
}

function snapshot(files: Awaited<ReturnType<typeof preferenceFiles>>, domain: ControlPreferencesDomain): ControlPreferencesSnapshot {
  const primary = files.find(file => file.exists) || files[0];
  return {
    domain, content: primary.exists ? primary.content : domain === "electron" ? electronDefaults : primary.content, exists: primary.exists, path: primary.path,
    revision: createHash("sha256").update(JSON.stringify({ domain, files })).digest("hex"),
    locations: files.map(({ label, path }) => ({ label, path })),
    differs: files.some(file => file.exists && file.content !== primary.content)
  };
}

export async function readControlPreferences(domain: ControlPreferencesDomain, homeDir = process.env.HOME || os.homedir()): Promise<ControlPreferencesSnapshot> {
  return snapshot(await preferenceFiles(homeDir, domain), domain);
}

async function writeAtomic(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}

export async function writeControlPreferences(request: ControlPreferencesUpdate, homeDir = process.env.HOME || os.homedir()): Promise<ControlPreferencesSnapshot> {
  if (!request || typeof request.content !== "string" || typeof request.expectedRevision !== "string" || typeof request.syncAll !== "boolean") throw new Error("控制偏好保存参数无效。");
  const config = definition(request.domain);
  if (Buffer.byteLength(request.content, "utf8") > MAX_BYTES) throw new Error(`${config.label}不能超过 1 MB。`);
  const key = path.resolve(homeDir);
  const operation = (writes.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    const files = await preferenceFiles(homeDir, request.domain);
    const current = snapshot(files, request.domain);
    if (current.revision !== request.expectedRevision) throw new Error(`${config.label}已被其他会话修改。你的草稿已保留，请复制草稿后重新读取最新内容再保存。`);
    const selected = request.syncAll ? files : files.filter(file => file.path === current.path);
    const changed: typeof files = [];
    try {
      for (const file of selected) {
        if (file.exists && file.content === request.content) continue;
        await writeAtomic(file.path, request.content);
        changed.push(file);
      }
    } catch (error) {
      // Restore the earlier targets on an ordinary write failure. Never roll
      // back a file that another process has already changed again.
      for (const file of changed.reverse()) {
        if (await fs.readFile(file.path, "utf8").catch(() => null) !== request.content) continue;
        if (file.exists) await writeAtomic(file.path, file.content);
        else await fs.rm(file.path, { force: true });
      }
      throw error;
    }
    return readControlPreferences(request.domain, homeDir);
  });
  writes.set(key, operation);
  try { return await operation; }
  finally { if (writes.get(key) === operation) writes.delete(key); }
}
