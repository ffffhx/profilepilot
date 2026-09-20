import { profileApi } from "./api";
import { render } from "./render/render-root";
import { store } from "./state";
import { AppState, PublicProfile } from "./types";

const ONBOARDING_STORAGE_KEY = "profilepilot:onboarding:v1:seen";
let onboardingEvaluated = false;

export async function loadState(initial = false): Promise<void> {
  await Promise.all([
    (initial ? profileApi().getInitialState() : profileApi().getState()).then(applyState),
    profileApi().getStartupSettings().then((settings) => {
      store.startupSettings = settings;
      render();
    })
  ]);
  if (store.modal?.kind === "onboarding") {
    void refreshAgentIntegrationDiagnostic().catch(() => undefined);
  }
}

export function applyState(state: AppState): void {
  store.state = state;
  const profiles = store.state.profiles || [];

  if (!profiles.some((profile) => profile.id === store.selectedId)) {
    store.selectedId = store.state.currentProfile?.id || profiles[0]?.id || null;
  }
  if (store.openProfileMenuId && !profiles.some((profile) => profile.id === store.openProfileMenuId)) {
    store.openProfileMenuId = null;
  }

  normalizeMigrationProfileSelection(profiles);
  normalizeAccountSyncProfileSelection(profiles);
  if (!onboardingEvaluated) {
    onboardingEvaluated = true;
    if (store.viewMode === "main" && !onboardingWasSeen() && !store.modal) {
      store.modal = { kind: "onboarding" };
    }
  }
  render();
}

export function markOnboardingSeen(): void {
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
  } catch {
    // localStorage 不可用时只在当前进程展示一次，避免阻断主流程。
  }
}

function onboardingWasSeen(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export async function refreshAgentIntegrationDiagnostic(): Promise<void> {
  store.agentIntegrationLoading = true;
  render();
  try {
    store.agentIntegrationDiagnostic = await profileApi().inspectAgentIntegration();
  } finally {
    store.agentIntegrationLoading = false;
    render();
  }
}

export async function requestInputGuardPermission(): Promise<void> {
  store.inputGuardPermissionLoading = true;
  render();
  try {
    store.agentIntegrationDiagnostic = await profileApi().requestInputGuardPermission();
  } finally {
    store.inputGuardPermissionLoading = false;
    render();
  }
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
      content: store.globalInstructionDraft,
      expectedRevision: store.globalInstructionBaseRevision || undefined
    });
    store.globalInstructions = snapshot;
    store.activeGlobalInstructionId = editingId;
    store.editingGlobalInstructionId = null;
    store.globalInstructionDraft = "";
    store.globalInstructionBaseRevision = "";
    store.globalInstructionOriginal = "";
  } finally {
    store.globalInstructionsSaving = false;
    render();
  }
}

export async function undoGlobalInstruction(): Promise<void> {
  const file = store.globalInstructions?.files.find((item) => item.id === store.activeGlobalInstructionId);
  if (!file) return;
  store.globalInstructionsSaving = true;
  render();
  try {
    store.globalInstructions = await profileApi().undoGlobalInstruction({
      id: file.id,
      expectedRevision: file.revision
    });
    store.editingGlobalInstructionId = null;
    store.globalInstructionDraft = "";
    store.globalInstructionBaseRevision = "";
    store.globalInstructionOriginal = "";
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

export async function refreshProfileReadiness(profileId: string): Promise<void> {
  store.profileReadinessLoading = {
    ...store.profileReadinessLoading,
    [profileId]: true
  };
  render();
  try {
    const receipt = await profileApi().inspectProfileReadiness({ profileId });
    store.profileReadiness = {
      ...store.profileReadiness,
      [profileId]: receipt
    };
  } finally {
    store.profileReadinessLoading = {
      ...store.profileReadinessLoading,
      [profileId]: false
    };
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
