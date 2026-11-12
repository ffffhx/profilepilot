const assert = require("node:assert/strict");
const test = require("node:test");
const { loadTsModule } = require("./helpers/load-ts-module.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t) {
  const originalWindow = global.window;
  const profiles = deferred(), connection = deferred();
  let scans = 0, snapshots = 0;
  global.window = { browserConnection: { snapshot: () => { snapshots++; return connection.promise; } } };
  t.after(() => { global.window = originalWindow; });
  const store = { workspace: "tools", busy: false, busyState: null, selectedExtensionIds: new Set() };
  const actions = loadTsModule("src/renderer/state-actions.ts", { stubs: {
    "./state": { store },
    "./api": { profileApi: () => ({ getState: () => { scans++; return profiles.promise; } }) },
    "./view-events": { invalidateView() {} },
    "./util": { formatErrorMessage: error => error.message }
  } });
  return { actions, store, profiles, connection, counts: () => [scans, snapshots] };
}

for (const first of ["profiles", "connection"]) {
  test(`extension refresh stays local until both reads finish (${first} first)`, async t => {
    const { actions, store, profiles, connection, counts } = fixture(t);
    const work = actions.refreshNativeExtensionStatus(true);
    assert.equal(store.nativeExtensionLoading, true);
    assert.equal(store.busy, false);
    assert.equal(store.busyState, null);
    await actions.refreshNativeExtensionStatus(true);
    assert.deepEqual(counts(), [1, 1], "a second click must not start another scan");
    if (first === "profiles") profiles.resolve({ profiles: [] });
    else connection.resolve({ nativeBrowsers: [{ profileId: "native", connected: true }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.nativeExtensionLoading, true);
    if (first === "profiles") connection.resolve({ nativeBrowsers: [] });
    else profiles.resolve({ profiles: [] });
    await work;
    assert.equal(store.nativeExtensionLoading, false);
    assert.deepEqual(counts(), [1, 1], "finishing must not trigger a redundant Profile scan");
  });
}

test("failed Profile scans preserve successful extension results and permit retry", async t => {
  const { actions, store, profiles, connection } = fixture(t);
  const work = actions.refreshNativeExtensionStatus(true);
  profiles.reject(new Error("Profile scan failed"));
  connection.resolve({ nativeBrowsers: [{ profileId: "native", connected: true }] });
  await work;
  assert.equal(store.profileLoadError, "Profile scan failed");
  assert.equal(store.nativeExtensionBrowsers[0].connected, true);
  assert.equal(store.nativeExtensionError, null);
  assert.equal(store.nativeExtensionLoading, false);
});

test("a newer extension event wins over an in-flight refresh failure", async t => {
  const { actions, store, profiles, connection } = fixture(t);
  const work = actions.refreshNativeExtensionStatus(true);
  actions.applyNativeExtensionSnapshot({ nativeBrowsers: [{ profileId: "new", connected: true }] });
  connection.reject(new Error("Old request failed"));
  profiles.resolve({ profiles: [] });
  await work;
  assert.equal(store.nativeExtensionBrowsers[0].profileId, "new");
  assert.equal(store.nativeExtensionError, null);
  assert.equal(store.nativeExtensionLoading, false);
});
