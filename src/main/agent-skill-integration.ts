import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AgentSkillDiagnostic, AgentSkillHost, AgentSkillKey, AgentSkillTargetDiagnostic } from "../shared/types";
import { ProfileManagerError } from "./profile-manager-error";

const MANAGED_MARKER_FILE = ".profilepilot-managed.json";
const LEGACY_SKILLS = ["agent-browser-cdp", "playwright-cli-profilepilot", "chrome-devtools-mcp-profilepilot", "profilepilot-cli"];
const LEGACY_KEYS = ["agent-browser", "playwright-cli", "chrome-devtools-mcp", "profilepilot-cli"];
const mutations = new Map<string, Promise<unknown>>();
type Target = Pick<AgentSkillTargetDiagnostic, "host" | "label" | "path">;
type Files = Record<string, string>;

export function agentSkillDefinition(key: AgentSkillKey) {
  if (key !== "profilepilot" && !LEGACY_KEYS.includes(key)) {
    throw new ProfileManagerError(`不支持的 Agent 工具：${key}`, "AGENT_TOOL_UNSUPPORTED");
  }
  // Old IPC callers share the same installed skill.
  return { key: "profilepilot" as const, label: "ProfilePilot Skill", skillId: "profilepilot" };
}

export function bundledAgentSkillPath(key: AgentSkillKey): string {
  return path.join(__dirname, "..", "..", "skills", agentSkillDefinition(key).skillId);
}

export function agentSkillTargetPaths(key: AgentSkillKey, homeDir = os.homedir()): Target[] {
  const { skillId } = agentSkillDefinition(key);
  // Alternate/test homes must never install into the caller's real CODEX_HOME.
  const codexRoot = path.resolve(homeDir) === path.resolve(os.homedir()) && process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME) : path.join(homeDir, ".codex");
  const roots: Array<[AgentSkillHost, string, string]> = [
    ["shared", "共享 Agent", path.join(homeDir, ".agents", "skills")],
    ["codex", "Codex", path.join(codexRoot, "skills")],
    ["claude", "Claude", path.join(homeDir, ".claude", "skills")]
  ];
  return roots.map(([host, label, root]) => ({ host, label, path: path.join(root, skillId) }));
}

export async function inspectAgentSkills(homeDir = os.homedir()): Promise<AgentSkillDiagnostic[]> {
  return [await inspectAgentSkill("profilepilot", homeDir)];
}

export function inspectProfilePilotCliSkill(homeDir = os.homedir()): Promise<AgentSkillDiagnostic> {
  return inspectAgentSkill("profilepilot", homeDir);
}

export async function inspectAgentSkill(key: AgentSkillKey, homeDir = os.homedir()): Promise<AgentSkillDiagnostic> {
  const definition = agentSkillDefinition(key);
  let source: Files | null = null;
  let error: string | null = null;
  try {
    source = await skillFiles(bundledAgentSkillPath(key));
    if (!source["SKILL.md"]) throw new Error("缺少 SKILL.md");
  } catch (cause) {
    error = `找不到内置 Skill：${cause instanceof Error ? cause.message : String(cause)}`;
  }
  const targets = await Promise.all(agentSkillTargetPaths(key, homeDir).map(target => inspectTarget(target, source)));
  const legacySkillPaths: string[] = [];
  for (const target of targets) {
    for (const name of LEGACY_SKILLS) {
      const legacyPath = path.join(path.dirname(target.path), name);
      if (await exists(path.join(legacyPath, "SKILL.md"))) legacySkillPaths.push(legacyPath);
    }
  }
  const installedTargetCount = targets.filter(target => target.installed).length;
  const managedTargetCount = targets.filter(target => target.managed).length;
  return {
    ...definition,
    installed: installedTargetCount === targets.length,
    managed: managedTargetCount > 0,
    upToDate: targets.every(target => target.upToDate),
    installedTargetCount, managedTargetCount, targetCount: targets.length,
    installPath: targets[0].path, targets, error, legacySkillPaths
  };
}

export async function setAgentSkillEnabled(key: AgentSkillKey, enabled: boolean, homeDir = os.homedir()): Promise<AgentSkillDiagnostic> {
  agentSkillDefinition(key);
  const lock = path.resolve(homeDir);
  const operation = (mutations.get(lock) || Promise.resolve()).catch(() => {}).then(() => updateSkill(enabled, homeDir));
  mutations.set(lock, operation);
  try { return await operation; }
  finally { if (mutations.get(lock) === operation) mutations.delete(lock); }
}

async function updateSkill(enabled: boolean, homeDir: string): Promise<AgentSkillDiagnostic> {
  const sourcePath = bundledAgentSkillPath("profilepilot");
  if (enabled && !await exists(path.join(sourcePath, "SKILL.md"))) {
    throw new ProfileManagerError("安装包中缺少 ProfilePilot Skill。", "AGENT_SKILL_SOURCE_MISSING");
  }
  const source = enabled ? await skillFiles(sourcePath) : null;
  for (const target of agentSkillTargetPaths("profilepilot", homeDir)) {
    assertSkillPath(target.path);
    const owned = await isManaged(target.path, "profilepilot");
    if (enabled) {
      const stat = await fs.lstat(target.path).catch(() => null);
      const entries = stat?.isDirectory() ? await fs.readdir(target.path) : [];
      // Existing external skills and directory links remain externally owned.
      if (stat && (!stat.isDirectory() || (!owned && entries.some(name => name !== "local")))) continue;
      // CLI refresh runs at startup too. Do not archive identical guides on
      // every launch; still migrate any older managed skills below.
      if (!owned || !(await inspectTarget(target, source)).upToDate) {
        await installManagedSkill(sourcePath, target, homeDir);
      }
      for (const name of LEGACY_SKILLS) {
        const legacyPath = path.join(path.dirname(target.path), name);
        if (await isManaged(legacyPath, name)) await archive(legacyPath, target.host, homeDir);
      }
    } else if (owned) {
      const backup = await archive(target.path, target.host, homeDir);
      // Preserve personal settings for reinstall without a discoverable SKILL.md.
      if (await exists(path.join(backup, "local"))) {
        await fs.mkdir(target.path, { recursive: true });
        await fs.cp(path.join(backup, "local"), path.join(target.path, "local"), { recursive: true });
      }
    }
  }
  return inspectAgentSkill("profilepilot", homeDir);
}

async function inspectTarget(target: Target, source: Files | null): Promise<AgentSkillTargetDiagnostic> {
  const installed = await exists(path.join(target.path, "SKILL.md"));
  const managed = await isManaged(target.path, "profilepilot");
  let upToDate = false;
  if (installed && source) {
    try { upToDate = JSON.stringify(await skillFiles(target.path)) === JSON.stringify(source); }
    catch { /* Unreadable files or links are not an up-to-date installation. */ }
  }
  return { ...target, installed, managed, upToDate };
}

// Compare every shipped file. Local routing does not make a release stale.
async function skillFiles(root: string): Promise<Files> {
  const files: Files = {};
  async function visit(relative: string) {
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (!relative && (entry.name === "local" || entry.name === MANAGED_MARKER_FILE)) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Skill 文件不能是软链：${name}`);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files[name] = createHash("sha256").update(await fs.readFile(path.join(root, name))).digest("hex");
    }
  }
  await visit("");
  return files;
}

async function isManaged(directory: string, skillId: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const marker = JSON.parse(await fs.readFile(path.join(directory, MANAGED_MARKER_FILE), "utf8"));
    return [1, 2].includes(marker.version) && marker.managedBy === "ProfilePilot" && marker.skillId === skillId;
  } catch { return false; }
}

async function installManagedSkill(sourcePath: string, target: Target, homeDir: string): Promise<void> {
  await fs.mkdir(path.dirname(target.path), { recursive: true });
  const staging = `${target.path}.profilepilot-tmp-${randomUUID()}`;
  let backup: string | null = null;
  try {
    await fs.cp(sourcePath, staging, { recursive: true });
    if (await exists(path.join(target.path, "local"))) {
      await fs.cp(path.join(target.path, "local"), path.join(staging, "local"), { recursive: true });
    }
    await fs.writeFile(path.join(staging, MANAGED_MARKER_FILE), JSON.stringify({
      version: 2, skillId: "profilepilot", managedBy: "ProfilePilot", files: await skillFiles(sourcePath)
    }, null, 2) + "\n", "utf8");
    if (await exists(target.path)) backup = await archive(target.path, target.host, homeDir);
    try { await fs.rename(staging, target.path); }
    catch (error) {
      if (backup) await moveDirectory(backup, target.path);
      throw error;
    }
  } finally {
    assertSkillPath(staging, true);
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function archive(directory: string, host: AgentSkillHost, homeDir: string): Promise<string> {
  assertSkillPath(directory);
  const root = path.resolve(homeDir, ".profilepilot", "skill-backups");
  const destination = path.join(root, `${host}-${path.basename(directory)}-${Date.now()}-${randomUUID()}`);
  if (path.dirname(destination) !== root) throw new Error("无效的 Skill 备份路径。");
  await fs.mkdir(root, { recursive: true });
  await moveDirectory(directory, destination);
  return destination;
}

async function moveDirectory(source: string, destination: string): Promise<void> {
  try { await fs.rename(source, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // A custom CODEX_HOME can be on a different Windows drive / macOS volume.
    await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    // Both paths were resolved and checked by archive(), or are its rollback.
    await fs.rm(source, { recursive: true, force: true });
  }
}

function assertSkillPath(directory: string, staging = false): void {
  const resolved = path.resolve(directory);
  const name = path.basename(resolved);
  if (path.basename(path.dirname(resolved)) !== "skills" ||
    !(name === "profilepilot" || LEGACY_SKILLS.includes(name) || (staging && /^profilepilot\.profilepilot-tmp-[a-f0-9-]+$/.test(name)))) {
    throw new Error(`拒绝修改 Skill 目录以外的路径：${resolved}`);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true; } catch { return false; }
}
