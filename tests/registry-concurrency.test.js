const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { ProfileManager } = require("../dist/main/profile-manager.js");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-registry-test-"));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manager = new ProfileManager(directory);
  const read = manager.loadRegistry.bind(manager);
  // Widen the read/write race without a barrier that assumes concurrent reads.
  manager.loadRegistry = async () => { const value = await read(); await delay(10); return value; };
  return { manager, directory, read };
}

test("concurrent profile creation retains every record and directory", async (t) => {
  const { manager, directory, read } = await fixture(t);
  const created = await Promise.all(Array.from({ length: 8 }, (_, i) => manager.createProfile(`profile-${i}`)));
  const registry = await read();
  assert.deepEqual(new Set(registry.profiles.map(p => p.id)), new Set(created.map(p => p.id)));
  assert.equal((await fs.readdir(path.join(directory, "profiles"))).length, 8);
});

test("metadata updates and port reservations preserve unrelated concurrent changes", async (t) => {
  const { manager, read } = await fixture(t);
  const a = await manager.createProfile("a"), b = await manager.createProfile("b");
  const publicId = `isolated:${a.id}`;
  const [, , portA, portB] = await Promise.all([
    manager.renameProfile(publicId, "renamed"),
    manager.setStoredCloneMeta(publicId, { projectTag: "project" }),
    manager.reserveAvailableFixedCdpPort(a.id, 45000),
    manager.reserveAvailableFixedCdpPort(b.id, 45000)
  ]);
  const registry = await read();
  const stored = registry.profiles.find(p => p.id === a.id);
  assert.equal(stored.name, "renamed");
  assert.equal(stored.projectTag, "project");
  assert.equal(stored.fixedCdpPort, portA);
  assert.notEqual(portA, portB);
});

test("failed delete rollback does not overwrite a concurrent create", async (t) => {
  const { manager, read } = await fixture(t);
  const original = await manager.createProfile("original");
  manager.getState = async () => ({ profiles: [{ ...original, id: `isolated:${original.id}`, source: "isolated", running: false }] });
  let concurrent;
  manager.moveToTrash = async () => {
    concurrent = manager.createProfile("concurrent");
    await delay(30);
    throw new Error("simulated trash failure");
  };
  await assert.rejects(manager.deleteIsolatedProfile(original.id), /simulated trash failure/);
  const created = await concurrent;
  assert.deepEqual(new Set((await read()).profiles.map(p => p.id)), new Set([original.id, created.id]));
});

test("a failed update releases the queue and a corrupt registry is preserved", async (t) => {
  const { manager, directory, read } = await fixture(t);
  await assert.rejects(manager.updateRegistry(() => { throw new Error("failed mutation"); }), /failed mutation/);
  const created = await manager.createProfile("after failure");
  assert.equal((await read()).profiles[0].id, created.id);
  const file = path.join(directory, "profiles.json");
  await fs.writeFile(file, "{broken");
  await assert.rejects(manager.createProfile("must not overwrite"), e => e.code === "REGISTRY_READ_FAILED");
  assert.equal(await fs.readFile(file, "utf8"), "{broken");
});
