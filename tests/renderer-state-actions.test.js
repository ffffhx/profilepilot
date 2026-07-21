const assert = require("node:assert/strict");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");

function loadStateActions(initialStore = {}) {
  const stateStub = {
    store: {
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
