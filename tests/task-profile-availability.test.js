const assert = require("node:assert/strict");
const test = require("node:test");
const { loadTsModule } = require("./helpers/load-ts-module.js");
const { taskProfileAvailability } = loadTsModule("src/renderer/task-profile-availability.ts");

const profile = (overrides = {}) => ({
  id: "p1", running: true, cdpClients: [], gatewayControl: null, agentBrowserOccupancy: null, ...overrides
});
const task = (overrides = {}) => ({ profileId: "p1", status: "running", ...overrides });

test("connected system profiles start without a selected tab and still respect task ownership", () => {
  const native = profile({ source: "native" });
  const state = { profileId: "p1", connected: false };
  assert.match(taskProfileAvailability(native, []).label, /尚未配对/);
  assert.match(taskProfileAvailability(native, [], [state]).label, /离线/);
  state.connected = true;
  assert.match(taskProfileAvailability(native, [], [state]).label, /更新或重新加载/);
  state.taskTabs = true;
  assert.equal(taskProfileAvailability(native, [], [state]).available, true);
  assert.match(taskProfileAvailability(native, [], [state]).label, /自动新开标签页/);
  state.ownerSessionId = "existing-session"; state.ownership = "user";
  assert.match(taskProfileAvailability(native, [], [state]).label, /用户接管/);
  assert.equal(taskProfileAvailability(native, [], [state]).available, false);
  delete state.ownerSessionId; state.pausedByBrowser = true;
  assert.equal(taskProfileAvailability(native, [], [state]).available, false);
});

test("both running and stopped browsers can be idle", () => {
  assert.deepEqual(taskProfileAvailability(profile(), []), { available: true, label: "空闲" });
  assert.deepEqual(taskProfileAvailability(profile({ running: false }), []), { available: true, label: "空闲 · 未启动" });
});

test("disconnected and user-owned Gateway sessions remain occupied", () => {
  const gatewayControl = { sessionStatus: "active", ownerSessionId: "session-1", ownership: "agent", connectionActive: false };
  assert.equal(taskProfileAvailability(profile({ gatewayControl }), []).available, false);
  assert.match(taskProfileAvailability(profile({ gatewayControl: { ...gatewayControl, ownership: "user" } }), []).label, /用户接管/);
});

test("lease reservations remain occupied without a running browser or driver", () => {
  for (const ownership of ["agent", "user"]) {
    const state = taskProfileAvailability(profile({ running: false, agentBrowserOccupancy: { ownership } }), []);
    assert.equal(state.available, false);
    assert.match(state.label, ownership === "user" ? /用户接管/ : /预留/);
  }
});

test("Gateway status takes precedence over stale legacy client scans", () => {
  const cdpClients = [{ session: "old-session" }];
  assert.equal(taskProfileAvailability(profile({ cdpClients }), []).available, false);
  const gatewayControl = { sessionStatus: "stopped", ownerSessionId: null, connectionActive: false };
  assert.equal(taskProfileAvailability(profile({ cdpClients, gatewayControl }), []).available, true);
  assert.equal(taskProfileAvailability(profile({ gatewayControl: { ...gatewayControl, connectionActive: true } }), []).available, false);
});

test("queued and running tasks reserve their selected browser before connecting", () => {
  for (const status of ["queued", "running"]) {
    assert.equal(taskProfileAvailability(profile(), [task({ status })]).available, false);
    assert.equal(taskProfileAvailability(profile(), [task({ status, profileId: "p2" })]).available, true);
  }
});

test("paused and waiting tasks retain only browsers they have prepared", () => {
  for (const status of ["paused", "waiting_user"]) {
    assert.equal(taskProfileAvailability(profile(), [task({ status, port: 9223 })]).available, false);
    assert.equal(taskProfileAvailability(profile(), [task({ status })]).available, true);
  }
});

test("finished tasks and stale activity do not keep a browser busy", () => {
  for (const status of ["completed", "partial", "failed", "cancelled"]) {
    assert.equal(taskProfileAvailability(profile({ agentActivity: { text: "old task" } }), [task({ status, port: 9223 })]).available, true);
  }
});
