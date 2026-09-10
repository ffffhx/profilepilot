const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ProfileManager } = require("../dist/main/profile-manager.js");
const { recoverInterruptedAccountSyncArtifactsForProfile } = require("../dist/main/account-sync.js");

async function fixture(t, emptyTarget = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-sync-cancel-test-"));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), target = path.join(root, "target");
  await fs.mkdir(source); await fs.mkdir(target);
  const prefs = owner => ({
    homepage: `${owner}.example`,
    extensions: { settings: { [owner]: { state: 1 } } },
    protection: { macs: { extensions: { [owner]: "hash" } } }
  });
  for (const file of ["Preferences", "Secure Preferences"]) {
    await fs.writeFile(path.join(source, file), JSON.stringify(prefs("source")));
    if (!emptyTarget) await fs.writeFile(path.join(target, file), JSON.stringify(prefs("target")));
  }
  const profiles = [
    { id: "isolated:source", source: "isolated", name: "source", userDataDir: source, running: false },
    { id: "isolated:target", source: "isolated", name: "target", userDataDir: target, running: false }
  ];
  const manager = Object.create(ProfileManager.prototype);
  manager.getState = async () => ({ profiles });
  manager.recordAccountSync = async () => {};
  manager.resolveAccountSyncLocation = async p => ({
    profilePath: p.id === profiles[0].id ? source : target,
    userDataPath: p.userDataDir, profileDirName: "Default"
  });
  manager.inspectAccountSyncDiff = async () => ({
    items: ["Preferences", "Secure Preferences"].map(relativePath => ({ relativePath, status: "changed" }))
  });
  const sync = (onProgress, signal) => manager.syncAccount(
    { sourceProfileId: profiles[0].id, targetProfileId: profiles[1].id, onlyChanged: false },
    onProgress, signal, undefined, { allowWindowsCrossDataDir: true }
  );
  const read = file => fs.readFile(path.join(target, file), "utf8").then(JSON.parse);
  return { source, target, prefs, sync, read };
}

test("cancel after replacing Preferences preserves target extensions in both files and after recovery", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(f.sync(progress => {
    if (progress.step === "复制账号数据" && progress.message.includes("受保护浏览器设置")) controller.abort();
  }, controller.signal), e => e.code === "OPERATION_CANCELLED");
  await recoverInterruptedAccountSyncArtifactsForProfile(f.target);
  for (const file of ["Preferences", "Secure Preferences"]) {
    const actual = await f.read(file);
    assert.deepEqual(actual.extensions, f.prefs("target").extensions);
    assert.deepEqual(actual.protection.macs.extensions, f.prefs("target").protection.macs.extensions);
  }
  assert.equal((await f.read("Preferences")).homepage, "source.example", "completed account data may remain on cancellation");
});

test("malformed source Preferences never replaces a valid target file", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, "Secure Preferences"), "not json");
  await assert.rejects(f.sync());
  assert.deepEqual(await f.read("Secure Preferences"), f.prefs("target"));
  assert.deepEqual((await f.read("Preferences")).extensions, f.prefs("target").extensions);
});

test("successful sync retains target extensions and strips source installs for an empty target", async t => {
  for (const empty of [false, true]) {
    const f = await fixture(t, empty);
    await f.sync();
    for (const file of ["Preferences", "Secure Preferences"]) {
      const actual = await f.read(file);
      assert.equal(actual.homepage, "source.example");
      assert.deepEqual(actual.extensions, empty ? undefined : f.prefs("target").extensions);
      assert.deepEqual(actual.protection.macs.extensions, empty ? undefined : f.prefs("target").protection.macs.extensions);
    }
  }
});
