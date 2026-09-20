const assert = require("node:assert/strict");
const test = require("node:test");
const { ProfileManager } = require("../dist/main/profile-manager.js");

function manager() {
  const instance = Object.create(ProfileManager.prototype);
  instance.displayState = null;
  instance.initialStateInFlight = null;
  return instance;
}

test("page entry reuses a completed snapshot without starting a process scan", async () => {
  const instance = manager();
  const state = { profiles: [{ id: "existing" }] };
  instance.displayState = state;
  instance.getState = () => { throw new Error("unexpected full scan"); };
  assert.equal(instance.getCachedState(), state);
  assert.equal(await instance.getInitialState(), state);
});

test("concurrent first pages share one scan and a failed scan can be retried", async () => {
  const instance = manager();
  let reject;
  let scans = 0;
  instance.getState = () => { scans++; return new Promise((_, fail) => { reject = fail; }); };
  const main = instance.getInitialState();
  const mini = instance.getInitialState();
  assert.equal(main, mini);
  assert.equal(scans, 1);
  reject(new Error("temporary scan failure"));
  await assert.rejects(main, /temporary scan failure/);
  const recovered = { profiles: [] };
  instance.getState = async () => { scans++; return recovered; };
  assert.equal(await instance.getInitialState(), recovered);
  assert.equal(scans, 2);
});
