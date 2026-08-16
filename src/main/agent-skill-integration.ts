import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentSkillDiagnostic,
  AgentSkillHost,
  AgentSkillTargetDiagnostic,
  BrowserDriverKind
} from "../shared/types";
import { ProfileManagerError } from "./profile-manager-error";

const MANAGED_MARKER_FILE = ".profilepilot-managed.json";

interface AgentSkillDefinition {
  key: BrowserDriverKind;
  label: string;
  skillId: string;
}

const SKILL_DEFINITIONS: AgentSkillDefinition[] = [
  { key: "agent-browser", label: "Agent Browser Gateway", skillId: "agent-browser-cdp" },
  { key: "playwright-cli", label: "Playwright CLI Gateway", skillId: "playwright-cli-profilepilot" },
  { key: "chrome-devtools-mcp", label: "DevTools MCP Gateway", skillId: "chrome-devtools-mcp-profilepilot" }
];

const SKILL_HOSTS: Array<{ host: AgentSkillHost; label: string; root: (homeDir: string) => string }> = [
  { host: "shared", label: "共享 Agent", root: (homeDir) => path.join(homeDir, ".agents", "skills") },
  { host: "codex", label: "Codex", root: (homeDir) => path.join(homeDir, ".codex", "skills") },
  { host: "claude", label: "Claude", root: (homeDir) => path.join(homeDir, ".claude", "skills") }
];

export function agentSkillDefinition(key: BrowserDriverKind): AgentSkillDefinition {
  const definition = SKILL_DEFINITIONS.find((item) => item.key === key);
  if (!definition) {
    throw new ProfileManagerError(`不支持的 Agent 工具：${key}`, "AGENT_TOOL_UNSUPPORTED");
  }
  return definition;
}

export function bundledAgentSkillPath(key: BrowserDriverKind): string {
  const definition = agentSkillDefinition(key);
  return path.join(__dirname, "..", "..", "skills", definition.skillId);
}

export function agentSkillTargetPaths(
  key: BrowserDriverKind,
  homeDir = os.homedir()
): Array<{ host: AgentSkillHost; label: string; path: string }> {
  const definition = agentSkillDefinition(key);
  return SKILL_HOSTS.map((target) => ({
    host: target.host,
    label: target.label,
    path: path.join(target.root(homeDir), definition.skillId)
  }));
}

export async function inspectAgentSkills(homeDir = os.homedir()): Promise<AgentSkillDiagnostic[]> {
  return Promise.all(SKILL_DEFINITIONS.map((definition) => inspectAgentSkill(definition.key, homeDir)));
}

export async function inspectAgentSkill(
  key: BrowserDriverKind,
  homeDir = os.homedir()
): Promise<AgentSkillDiagnostic> {
  const definition = agentSkillDefinition(key);
  const sourcePath = bundledAgentSkillPath(key);
  let sourceContent = "";
  let sourceError: string | null = null;
  try {
    sourceContent = await fs.readFile(path.join(sourcePath, "SKILL.md"), "utf8");
  } catch (error) {
    sourceError = `找不到内置 Skill：${error instanceof Error ? error.message : String(error)}`;
  }

  const targets = await Promise.all(agentSkillTargetPaths(key, homeDir).map(async (target) => {
    const skillFile = path.join(target.path, "SKILL.md");
    let installedContent: string | null = null;
    try {
      installedContent = await fs.readFile(skillFile, "utf8");
    } catch {
      // 缺少 SKILL.md 就视为未安装；目录残留不会被误报为可用 Skill。
    }
    const managed = installedContent !== null && await fileExists(path.join(target.path, MANAGED_MARKER_FILE));
    return {
      ...target,
      installed: installedContent !== null,
      managed,
      upToDate: installedContent !== null && Boolean(sourceContent) && installedContent === sourceContent
    } satisfies AgentSkillTargetDiagnostic;
  }));
  const installedTargetCount = targets.filter((target) => target.installed).length;
  const managedTargetCount = targets.filter((target) => target.managed).length;

  return {
    key,
    label: definition.label,
    skillId: definition.skillId,
    installed: installedTargetCount === targets.length,
    managed: managedTargetCount > 0,
    upToDate: targets.every((target) => target.installed && target.upToDate),
    installedTargetCount,
    managedTargetCount,
    targetCount: targets.length,
    installPath: targets[0].path,
    targets,
    error: sourceError
  };
}

export async function setAgentSkillEnabled(
  key: BrowserDriverKind,
  enabled: boolean,
  homeDir = os.homedir()
): Promise<AgentSkillDiagnostic> {
  const definition = agentSkillDefinition(key);
  if (enabled) {
    const sourcePath = bundledAgentSkillPath(key);
    if (!await fileExists(path.join(sourcePath, "SKILL.md"))) {
      throw new ProfileManagerError(
        `ProfilePilot 安装包中缺少 ${definition.skillId} Skill。`,
        "AGENT_SKILL_SOURCE_MISSING"
      );
    }
    for (const target of agentSkillTargetPaths(key, homeDir)) {
      const existing = await inspectTarget(target, sourcePath);
      if (existing.installed && !existing.managed) {
        // 用户或其它 Skill 管理器已经提供该 Skill，保持原样，不争夺所有权。
        continue;
      }
      await installManagedSkill(sourcePath, target.path, definition.skillId);
    }
  } else {
    for (const target of agentSkillTargetPaths(key, homeDir)) {
      if (await fileExists(path.join(target.path, MANAGED_MARKER_FILE))) {
        await fs.rm(target.path, { recursive: true, force: true });
      }
    }
  }
  return inspectAgentSkill(key, homeDir);
}

async function inspectTarget(
  target: { host: AgentSkillHost; label: string; path: string },
  sourcePath: string
): Promise<AgentSkillTargetDiagnostic> {
  let installedContent: string | null = null;
  let sourceContent = "";
  try {
    [installedContent, sourceContent] = await Promise.all([
      fs.readFile(path.join(target.path, "SKILL.md"), "utf8"),
      fs.readFile(path.join(sourcePath, "SKILL.md"), "utf8")
    ]);
  } catch {
    // 安装路径不存在时由下面的 installed=false 表达。
  }
  const managed = installedContent !== null && await fileExists(path.join(target.path, MANAGED_MARKER_FILE));
  return {
    ...target,
    installed: installedContent !== null,
    managed,
    upToDate: installedContent !== null && Boolean(sourceContent) && installedContent === sourceContent
  };
}

async function installManagedSkill(sourcePath: string, targetPath: string, skillId: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.profilepilot-tmp-${process.pid}-${Date.now()}`;
  await fs.rm(temporaryPath, { recursive: true, force: true });
  try {
    await fs.cp(sourcePath, temporaryPath, { recursive: true });
    await fs.writeFile(path.join(temporaryPath, MANAGED_MARKER_FILE), `${JSON.stringify({
      version: 1,
      skillId,
      managedBy: "ProfilePilot"
    }, null, 2)}\n`, "utf8");
    if (await fileExists(targetPath)) {
      await fs.rm(targetPath, { recursive: true, force: true });
    }
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
