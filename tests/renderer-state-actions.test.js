const assert = require("node:assert/strict");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");

function loadStateActions(initialStore = {}) {
  const stateStub = {
    store: {
      agentTakeoverHistory: [],
      extensionScan: { profileId: "source", extensions: [] },
      selectedExtensionIds: new Set(["a", "b"]),
      extensionScanPreviewCollapsed: true,
      selectedId: null,
      migrationSourceId: null,
      migrationTargetId: null,
      accountSyncSourceId: null,
      accountSyncTargetId: null,
      accountSyncResult: { copiedCount: 1 },
      accountSyncMenuOpen: "source",
      ...initialStore
    }
  };
  const renderStub = { render() {} };
  const apiStub = {
    profileApi() {
      throw new Error("profileApi should be stubbed by tests that call async actions");
    }
  };

  const actions = loadTsModule("src/renderer/state-actions.ts", {
    stubs: {
      "src/renderer/api.ts": apiStub,
      "src/renderer/render/render-root.ts": renderStub,
      "src/renderer/state.ts": stateStub
    }
  });

  return { actions, store: stateStub.store };
}

test("renderer mergeAgentTakeoverHistory merges, deduplicates, and sorts newest first", () => {
  const duplicate = takeoverEvent(2, { session: "same-session", sessionTitle: "Same title" });
  const { actions, store } = loadStateActions({
    agentTakeoverHistory: [
      takeoverEvent(1),
      duplicate,
      takeoverEvent(0, { profileId: "persisted-old" })
    ]
  });

  actions.mergeAgentTakeoverHistory([
    takeoverEvent(3),
    duplicate,
    takeoverEvent(4, { agent: "Claude Code" })
  ]);

  assert.deepEqual(
    store.agentTakeoverHistory.map((event) => event.profileId),
    ["profile-4", "profile-3", "profile-2", "profile-1", "persisted-old"]
  );
  assert.equal(store.agentTakeoverHistory.filter((event) => event.session === "same-session").length, 1);
});

test("renderer mergeAgentTakeoverHistory caps merged history at fifty newest events", () => {
  const { actions, store } = loadStateActions();
  const events = Array.from({ length: 55 }, (_, index) => takeoverEvent(index));

  actions.mergeAgentTakeoverHistory(events);

  assert.equal(store.agentTakeoverHistory.length, 50);
  assert.equal(store.agentTakeoverHistory[0].profileId, "profile-54");
  assert.equal(store.agentTakeoverHistory.at(-1).profileId, "profile-5");
});

test("renderer normalizeMigrationProfileSelection clears invalid scan state and keeps source distinct from target", () => {
  const { actions, store } = loadStateActions({
    selectedId: "p2",
    migrationSourceId: "missing-source",
    migrationTargetId: "missing-target"
  });

  actions.normalizeMigrationProfileSelection([
    { id: "p1", source: "native" },
    { id: "p2", source: "isolated" }
  ]);

  assert.equal(store.migrationSourceId, "p2");
  assert.equal(store.migrationTargetId, "p1");
  assert.equal(store.extensionScan, null);
  assert.deepEqual([...store.selectedExtensionIds], []);
  assert.equal(store.extensionScanPreviewCollapsed, false);

  store.extensionScan = { profileId: "p2", extensions: [] };
  store.selectedExtensionIds = new Set(["x"]);
  store.extensionScanPreviewCollapsed = true;
  actions.normalizeMigrationProfileSelection([]);

  assert.equal(store.migrationSourceId, null);
  assert.equal(store.migrationTargetId, null);
  assert.equal(store.extensionScan, null);
  assert.deepEqual([...store.selectedExtensionIds], []);
  assert.equal(store.extensionScanPreviewCollapsed, false);
});

test("renderer normalizeAccountSyncProfileSelection prefers a signed-in source and isolated target", () => {
  const { actions, store } = loadStateActions({
    selectedId: "p3",
    accountSyncSourceId: "missing-source",
    accountSyncTargetId: "missing-target"
  });

  actions.normalizeAccountSyncProfileSelection([
    { id: "p1", source: "native", userName: null },
    { id: "p2", source: "native", userName: "person@example.test" },
    { id: "p3", source: "isolated", userName: null }
  ]);

  assert.equal(store.accountSyncSourceId, "p2");
  assert.equal(store.accountSyncTargetId, "p3");

  actions.normalizeAccountSyncProfileSelection([]);

  assert.equal(store.accountSyncSourceId, null);
  assert.equal(store.accountSyncTargetId, null);
  assert.equal(store.accountSyncResult, null);
  assert.equal(store.accountSyncMenuOpen, null);
});

test.skip("renderer takeover notice preview limit is skipped because renderAgentTakeoverNotice is a private DOM renderer");

function takeoverEvent(index, patch = {}) {
  return {
    profileId: `profile-${index}`,
    profileName: `Profile ${index}`,
    session: `session-${index}`,
    sessionTitle: `Session ${index}`,
    agent: "Codex",
    at: `2026-07-08T12:${String(index).padStart(2, "0")}:00.000Z`,
    ...patch
  };
}
