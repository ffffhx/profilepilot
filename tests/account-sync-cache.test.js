const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  copyWindowsLegacyOsCryptKey,
  inspectAccountSyncPathDiff,
  isAccountSyncServiceWorkerCachePath,
  pruneServiceWorkerCacheStorage,
  shouldCopyAccountSyncPathEntry
} = require("../dist/main/account-sync.js");

test("account sync skips Service Worker CacheStorage but keeps registrations", () => {
  const workerRoot = path.join("C:", "Profiles", "Default", "Service Worker");
  assert.equal(shouldCopyAccountSyncPathEntry(workerRoot, workerRoot), true);
  assert.equal(shouldCopyAccountSyncPathEntry(workerRoot, path.join(workerRoot, "Database")), true);
  assert.equal(shouldCopyAccountSyncPathEntry(workerRoot, path.join(workerRoot, "ScriptCache")), true);
  assert.equal(
    shouldCopyAccountSyncPathEntry(workerRoot, path.join(workerRoot, "CacheStorage")),
    false
  );
  assert.equal(
    shouldCopyAccountSyncPathEntry(workerRoot, path.join(workerRoot, "CacheStorage", "index.txt")),
    false
  );

  const profileRoot = path.join("C:", "Profiles", "Default");
  assert.equal(
    isAccountSyncServiceWorkerCachePath(profileRoot, path.join(profileRoot, "Service Worker", "CacheStorage")),
    true
  );
  assert.equal(
    isAccountSyncServiceWorkerCachePath(profileRoot, path.join(profileRoot, "Service Worker", "Database")),
    false
  );

  const webStorageRoot = path.join(profileRoot, "WebStorage");
  assert.equal(
    shouldCopyAccountSyncPathEntry(webStorageRoot, path.join(webStorageRoot, "42", "CacheStorage", "asset")),
    false
  );
  assert.equal(
    shouldCopyAccountSyncPathEntry(webStorageRoot, path.join(webStorageRoot, "42", "IndexedDB", "data")),
    true
  );
});

test("account sync diff ignores excluded cache files", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-cache-diff-"));
  const sourceProfile = path.join(home, "source", "Default");
  const targetProfile = path.join(home, "target", "Default");
  const sourceWorker = path.join(sourceProfile, "Service Worker");
  const targetWorker = path.join(targetProfile, "Service Worker");
  mkdirSync(path.join(sourceWorker, "Database"), { recursive: true });
  mkdirSync(path.join(sourceWorker, "CacheStorage"), { recursive: true });
  mkdirSync(path.join(targetWorker, "Database"), { recursive: true });
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  writeFileSync(path.join(sourceWorker, "Database", "index"), "registration");
  writeFileSync(path.join(targetWorker, "Database", "index"), "registration");
  writeFileSync(path.join(sourceWorker, "CacheStorage", "large.bin"), "cache-only");
  utimesSync(path.join(sourceWorker, "Database", "index"), timestamp, timestamp);
  utimesSync(path.join(targetWorker, "Database", "index"), timestamp, timestamp);

  try {
    const result = await inspectAccountSyncPathDiff(
      { userDataPath: path.join(home, "source"), profilePath: sourceProfile, profileDirName: "Default" },
      { userDataPath: path.join(home, "target"), profilePath: targetProfile, profileDirName: "Default" },
      { label: "Service Worker", relativePath: "Service Worker" }
    );
    assert.equal(result.status, "same");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Windows isolated clone copies only the legacy DPAPI key", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-os-crypt-"));
  const sourceRoot = path.join(home, "source");
  const targetRoot = path.join(home, "target");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(targetRoot, { recursive: true });
  writeFileSync(
    path.join(sourceRoot, "Local State"),
    JSON.stringify({ os_crypt: { encrypted_key: "legacy-source", app_bound_encrypted_key: "app-bound-source" } })
  );
  writeFileSync(
    path.join(targetRoot, "Local State"),
    JSON.stringify({ os_crypt: { encrypted_key: "legacy-target", app_bound_encrypted_key: "app-bound-target" }, keep: true })
  );
  const sourceLocation = { userDataPath: sourceRoot, profilePath: path.join(sourceRoot, "Default"), profileDirName: "Default" };
  const targetLocation = { userDataPath: targetRoot, profilePath: path.join(targetRoot, "Default"), profileDirName: "Default" };

  try {
    assert.equal(await copyWindowsLegacyOsCryptKey(sourceLocation, targetLocation), true);
    const target = JSON.parse(readFileSync(path.join(targetRoot, "Local State"), "utf8"));
    assert.equal(target.os_crypt.encrypted_key, "legacy-source");
    assert.equal(target.os_crypt.app_bound_encrypted_key, "app-bound-target");
    assert.equal(target.keep, true);
    assert.equal(await copyWindowsLegacyOsCryptKey(sourceLocation, targetLocation), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("pruneServiceWorkerCacheStorage removes only CacheStorage", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-sw-cache-"));
  const worker = path.join(home, "Service Worker");
  mkdirSync(path.join(worker, "CacheStorage", "blob"), { recursive: true });
  mkdirSync(path.join(worker, "Database"), { recursive: true });
  writeFileSync(path.join(worker, "CacheStorage", "blob", "asset.bin"), "cache");
  writeFileSync(path.join(worker, "Database", "index"), "keep");

  try {
    assert.equal(await pruneServiceWorkerCacheStorage(home), true);
    assert.equal(await pruneServiceWorkerCacheStorage(home), false);
    const { existsSync } = require("node:fs");
    assert.equal(existsSync(path.join(worker, "CacheStorage")), false);
    assert.equal(existsSync(path.join(worker, "Database", "index")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
