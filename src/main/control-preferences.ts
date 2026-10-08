import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { agentSkillTargetPaths } from "./agent-skill-integration";
import type { ControlPreferencesDomain, ControlPreferencesSnapshot, ControlPreferencesUpdate } from "../shared/control-preferences";

const MAX_BYTES = 1024 * 1024;
const writes = new Map<string, Promise<unknown>>();

function definition(domain: ControlPreferencesDomain) {
  if (domain === "browser") return { label: "浏览器控制偏好", file: "browser-routing.md" };
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
    domain, content: primary.content, exists: primary.exists, path: primary.path,
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
