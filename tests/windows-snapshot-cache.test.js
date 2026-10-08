const assert = require("node:assert/strict");
const test = require("node:test");
const { loadTsModule } = require("./helpers/load-ts-module.js");

function fixture(t) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const scans = [];
  const api = loadTsModule("src/main/windows-platform.ts", { stubs: {
    "node:util": { promisify: () => (executable) => executable === "netstat"
      ? Promise.resolve({ stdout: "" })
      : new Promise((resolve, reject) => scans.push({
        resolve: () => resolve({ stdout: '{"processes":[]}' }), reject
      })) }
  } });
  return { api, scans, advance: ms => { now += ms; } };
}

test("slow Windows scans share in-flight work and stay cached after completion", async t => {
  const { api, scans, advance } = fixture(t);
  const first = api.getWindowsSystemSnapshot();
  advance(1500);
  const concurrent = api.getWindowsSystemSnapshot();
  assert.equal(scans.length, 1, "a slow scan must not start another PowerShell process");
  scans[0].resolve();
  const snapshot = await first;
  assert.equal(await concurrent, snapshot);
  advance(700);
  assert.equal(await api.getWindowsSystemSnapshot(), snapshot);
  assert.equal(scans.length, 1);
  advance(51);
  const fresh = api.getWindowsSystemSnapshot();
  assert.equal(scans.length, 2, "completed snapshots still expire promptly");
  scans[1].resolve();
  assert.notEqual(await fresh, snapshot);
});

test("invalidated and failed Windows scans cannot replace newer cached results", async t => {
  const { api, scans } = fixture(t);
  const old = api.getWindowsSystemSnapshot();
  api.invalidateWindowsSystemSnapshot();
  const fresh = api.getWindowsSystemSnapshot();
  scans[1].resolve();
  const snapshot = await fresh;
  scans[0].resolve();
  await old;
  assert.equal(await api.getWindowsSystemSnapshot(), snapshot);
  const failed = api.getWindowsSystemSnapshot(true);
  scans[2].reject(new Error("temporary scan failure"));
  await assert.rejects(failed, /temporary scan failure/);
  const retry = api.getWindowsSystemSnapshot();
  assert.equal(scans.length, 4);
  scans[3].resolve();
  await retry;
});
