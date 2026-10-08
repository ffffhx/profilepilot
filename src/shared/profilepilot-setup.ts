import type { AgentIntegrationDiagnostic } from "./types";

// The product is ready only when the executable, shell route and bundled
// Agent instructions agree. An unrelated compatible tool cannot satisfy this.
export function profilePilotSetupState(diagnostic: Pick<AgentIntegrationDiagnostic, "managementCli" | "skills" | "shellIntegration"> | null) {
  const cli = diagnostic?.managementCli;
  const skill = diagnostic?.skills.find(item => item.key === "profilepilot") || cli?.skill;
  const hasParts = Boolean(cli?.bundleInstalled || cli?.launcherInstalled || skill?.installedTargetCount);
  const externalMismatch = Boolean(skill && (!skill.managed && skill.installed && !skill.upToDate ||
    skill.targets.some(target => target.installed && !target.managed && !target.upToDate)));
  const ready = Boolean(cli?.installed && cli.upToDate && diagnostic?.shellIntegration.installed && skill?.installed && skill.upToDate);
  const needsUpdate = Boolean(cli?.installed && !cli.upToDate || skill?.installed && !skill.upToDate);
  const status = ready ? "已就绪" : externalMismatch ? "指引需检查" : needsUpdate ? "需要更新" : hasParts ? "需修复" : "未安装";
  return { ready, hasParts, externalMismatch, needsUpdate, status };
}
