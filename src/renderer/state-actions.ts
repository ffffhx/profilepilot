import { profileApi } from "./api";
import { render } from "./render/render-root";
import { store } from "./state";
import { AgentTakeoverEvent, PublicProfile } from "./types";

const TAKEOVER_HISTORY_LIMIT = 50;

export async function loadState(): Promise<void> {
  store.state = await profileApi().getState();
  const profiles = store.state.profiles || [];

  if (!profiles.some((profile) => profile.id === store.selectedId)) {
    store.selectedId = store.state.currentProfile?.id || profiles[0]?.id || null;
  }
  if (store.openProfileMenuId && !profiles.some((profile) => profile.id === store.openProfileMenuId)) {
    store.openProfileMenuId = null;
  }

  normalizeMigrationProfileSelection(profiles);
  normalizeAccountSyncProfileSelection(profiles);
  render();
}

export async function loadTakeoverHistory(): Promise<void> {
  mergeAgentTakeoverHistory(await profileApi().getTakeoverHistory());
  render();
}

export function mergeAgentTakeoverHistory(events: AgentTakeoverEvent[]): void {
  const byKey = new Map<string, AgentTakeoverEvent>();
  for (const event of [...events, ...store.agentTakeoverHistory]) {
    byKey.set(agentTakeoverKey(event), event);
  }
  store.agentTakeoverHistory = [...byKey.values()]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, TAKEOVER_HISTORY_LIMIT);
}

function agentTakeoverKey(event: AgentTakeoverEvent): string {
  return [event.profileId, event.profileName, event.session || "", event.agent || "", event.at].join("\u0000");
}

export async function refreshGlobalInstructions(): Promise<void> {
  store.globalInstructionsLoading = true;
  render();

  try {
    const snapshot = await profileApi().readGlobalInstructions();
    store.globalInstructions = snapshot;
    if (!snapshot.files.some((file) => file.id === store.activeGlobalInstructionId)) {
      store.activeGlobalInstructionId = snapshot.files[0]?.id || "codex-agents";
    }
  } finally {
    store.globalInstructionsLoading = false;
    render();
  }
}

export async function saveGlobalInstruction(): Promise<void> {
  const editingId = store.editingGlobalInstructionId;
  if (!editingId) {
    return;
  }

  store.globalInstructionsSaving = true;
  render();

  try {
    const snapshot = await profileApi().writeGlobalInstruction({
      id: editingId,
      content: store.globalInstructionDraft
    });
    store.globalInstructions = snapshot;
    store.activeGlobalInstructionId = editingId;
    store.editingGlobalInstructionId = null;
    store.globalInstructionDraft = "";
  } finally {
    store.globalInstructionsSaving = false;
    render();
  }
}

export async function repairClaudeInstructionShell(): Promise<void> {
  store.globalInstructionsSaving = true;
  render();

  try {
    const snapshot = await profileApi().ensureClaudeInstructionShell();
    store.globalInstructions = snapshot;
    store.activeGlobalInstructionId = "claude-memory";
    store.editingGlobalInstructionId = null;
    store.globalInstructionDraft = "";
  } finally {
    store.globalInstructionsSaving = false;
    render();
  }
}

export function normalizeMigrationProfileSelection(profiles: PublicProfile[]): void {
  if (!profiles.length) {
    store.migrationSourceId = null;
    store.migrationTargetId = null;
    store.extensionScan = null;
    store.selectedExtensionIds.clear();
    store.extensionScanPreviewCollapsed = false;
    return;
  }

  if (!profiles.some((profile) => profile.id === store.migrationSourceId)) {
    store.migrationSourceId = store.selectedId || profiles[0].id;
    store.extensionScan = null;
    store.selectedExtensionIds.clear();
    store.extensionScanPreviewCollapsed = false;
  }

  if (!profiles.some((profile) => profile.id === store.migrationTargetId) || store.migrationTargetId === store.migrationSourceId) {
    store.migrationTargetId = profiles.find((profile) => profile.id !== store.migrationSourceId)?.id || null;
  }
}

export function normalizeAccountSyncProfileSelection(profiles: PublicProfile[]): void {
  if (!profiles.length) {
    store.accountSyncSourceId = null;
    store.accountSyncTargetId = null;
    store.accountSyncResult = null;
    store.accountSyncMenuOpen = null;
    return;
  }

  if (!profiles.some((profile) => profile.id === store.accountSyncSourceId)) {
    store.accountSyncSourceId = profiles.find((profile) => profile.userName)?.id || store.selectedId || profiles[0].id;
  }

  if (!profiles.some((profile) => profile.id === store.accountSyncTargetId) || store.accountSyncTargetId === store.accountSyncSourceId) {
    store.accountSyncTargetId =
      profiles.find((profile) => profile.id !== store.accountSyncSourceId && profile.source === "isolated")?.id ||
      profiles.find((profile) => profile.id !== store.accountSyncSourceId)?.id ||
      null;
  }
}

export async function refreshExtensionMigrationDiff(): Promise<void> {
  const activeScan = store.extensionScan?.profileId === store.migrationSourceId ? store.extensionScan : null;
  const extensionIds = activeScan?.extensions
    .filter((extension) => store.selectedExtensionIds.has(extension.id))
    .map((extension) => extension.id) || [];
  if (!store.state || !store.migrationSourceId || !store.migrationTargetId || store.migrationSourceId === store.migrationTargetId || !extensionIds.length) {
    store.extensionMigrationDiff = null;
    store.extensionMigrationDiffLoading = false;
    store.extensionMigrationDiffKey = "";
    render();
    return;
  }

  const key = [
    store.migrationSourceId,
    store.migrationTargetId,
    store.includeExtensionData ? "data" : "nodata",
    store.openInstallPages ? "openpages" : "noopenpages",
    extensionIds.slice().sort().join(",")
  ].join("::");
  if (store.extensionMigrationDiffKey === key && (store.extensionMigrationDiff || store.extensionMigrationDiffLoading)) {
    return;
  }

  const requestId = store.extensionMigrationDiffRequestId + 1;
  store.extensionMigrationDiffRequestId = requestId;
  store.extensionMigrationDiffKey = key;
  store.extensionMigrationDiffLoading = true;
  render();

  try {
    const diff = await profileApi().inspectExtensionMigrationDiff({
      sourceProfileId: store.migrationSourceId,
      targetProfileId: store.migrationTargetId,
      extensionIds,
      includeData: store.includeExtensionData,
      openInstallPages: store.openInstallPages,
      onlyChanged: store.extensionSyncOnlyChanged
    });
    if (store.extensionMigrationDiffRequestId !== requestId) {
      return;
    }
    store.extensionMigrationDiff = diff;
  } catch {
    if (store.extensionMigrationDiffRequestId !== requestId) {
      return;
    }
    store.extensionMigrationDiff = null;
  } finally {
    if (store.extensionMigrationDiffRequestId === requestId) {
      store.extensionMigrationDiffLoading = false;
      render();
    }
  }
}

export function invalidateExtensionMigrationDiff(): void {
  store.extensionMigrationDiffRequestId += 1;
  store.extensionMigrationDiff = null;
  store.extensionMigrationDiffKey = "";
}

export function setMigrationSource(sourceId: string): void {
  store.migrationSourceId = sourceId || null;
  if (!store.state) {
    return;
  }

  if (store.migrationTargetId === store.migrationSourceId) {
    store.migrationTargetId = store.state.profiles.find((profile) => profile.id !== store.migrationSourceId)?.id || null;
  }

  store.extensionScan = null;
  store.selectedExtensionIds.clear();
  store.extensionScanPreviewCollapsed = false;
  store.extensionMigrationResult = null;
  invalidateExtensionMigrationDiff();
}
