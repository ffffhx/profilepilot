const assert = require("node:assert/strict");
const test = require("node:test");

const { ProfileManager } = require("../dist/main/profile-manager.js");
const cdpPage = require("../dist/main/cdp-page.js");
const chromeLaunch = require("../dist/main/chrome-launch.js");
const windowsPlatform = require("../dist/main/windows-platform.js");

function runningProfile(overrides = {}) {
  return {
    id: "isolated:focus-target",
    source: "isolated",
    name: "9223Profile",
    running: true,
    pids: [1111],
    cdpPort: 9223,
    ...overrides
  };
}

function managerWithCachedProfile(profile) {
  const manager = Object.create(ProfileManager.prototype);
  manager.focusProfileCache = new Map([[profile.id, profile]]);
  manager.focusProfileCacheUpdatedAt = Date.now();
  return manager;
}

test("focusProfile uses the recent running-profile cache before a full state scan", async () => {
  const profile = runningProfile();
  const manager = managerWithCachedProfile(profile);
  let stateScans = 0;
  manager.getState = async () => {
    stateScans += 1;
    return { profiles: [profile] };
  };
  manager.tryFocusPublicProfile = async (candidate) => {
    assert.equal(candidate, profile);
    return true;
  };

  await manager.focusProfile(profile.id);

  assert.equal(stateScans, 0);
});

test("focusProfile falls back to a full scan when cached process information fails", async () => {
  const cached = runningProfile({ pids: [1111] });
  const refreshed = runningProfile({ pids: [2222] });
  const manager = managerWithCachedProfile(cached);
  const attemptedPids = [];
  let stateScans = 0;
  manager.getState = async () => {
    stateScans += 1;
    return { profiles: [refreshed] };
  };
  manager.tryFocusPublicProfile = async (candidate) => {
    attemptedPids.push(candidate.pids[0]);
    return candidate === refreshed;
  };

  await manager.focusProfile(cached.id);

  assert.equal(stateScans, 1);
  assert.deepEqual(attemptedPids, [1111, 2222]);
});

test("stopped and expired cache entries are not used for foreground actions", () => {
  const stopped = runningProfile({ running: false, pids: [] });
  const manager = managerWithCachedProfile(stopped);
  assert.equal(manager.getCachedProfileForFocus(stopped.id), null);

  const running = runningProfile();
  manager.focusProfileCache.set(running.id, running);
  manager.focusProfileCacheUpdatedAt = 0;
  assert.equal(manager.getCachedProfileForFocus(running.id), null);
});

function focusHarness(t, options = {}) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: options.platform || "win32" });
  t.after(() => Object.defineProperty(process, "platform", platformDescriptor));
  const profile = runningProfile(options.profile);
  const manager = managerWithCachedProfile(profile);
  const calls = [];
  t.mock.method(cdpPage, "bringCdpPageToFront", async () => {
    calls.push("cdp");
    if (options.cdpError) throw new Error("CDP request failed");
    return true;
  });
  t.mock.method(windowsPlatform, "windowsForegroundProcessId", async () => {
    calls.push("check-foreground");
    return options.foregroundPid === undefined ? profile.pids[0] : options.foregroundPid;
  });
  t.mock.method(chromeLaunch, "focusProfileWindow", async (pids) => {
    calls.push("native");
    assert.deepEqual(pids, profile.pids);
    return options.nativeResult !== false;
  });
  t.mock.method(chromeLaunch, "isAnyMacProcessFrontmost", async () => {
    calls.push("mac-check");
    return true;
  });
  t.mock.method(manager, "getPublicProfile", async () => {
    calls.push("rescan");
    return profile;
  });
  t.mock.method(manager, "focusViaChromeSingleton", async () => {
    calls.push("singleton");
    return options.singletonResult !== false;
  });
  return { manager, profile, calls };
}

test("Windows skips native activation and singleton when CDP leaves the target foreground", async (t) => {
  const h = focusHarness(t);
  await h.manager.focusProfile(h.profile.id);
  assert.deepEqual(h.calls, ["cdp", "check-foreground"]);
});

test("Windows foreground evidence still succeeds when the CDP request reports an error", async (t) => {
  const h = focusHarness(t, { cdpError: true });
  await h.manager.focusProfile(h.profile.id);
  assert.deepEqual(h.calls, ["cdp", "check-foreground"]);
});

for (const foregroundPid of [2222, null]) {
  test(`Windows activates natively after CDP when foreground PID is ${foregroundPid}`, async (t) => {
    const h = focusHarness(t, { foregroundPid });
    await h.manager.focusProfile(h.profile.id);
    assert.deepEqual(h.calls, ["cdp", "check-foreground", "native"]);
  });
}

test("Windows falls back to native activation when CDP fails and the target is background", async (t) => {
  const h = focusHarness(t, { cdpError: true, foregroundPid: 2222 });
  await h.manager.focusProfile(h.profile.id);
  assert.deepEqual(h.calls, ["cdp", "check-foreground", "native"]);
});

test("Windows skips activation for a foreground profile without CDP", async (t) => {
  const h = focusHarness(t, { profile: { cdpPort: null } });
  await h.manager.focusProfile(h.profile.id);
  assert.deepEqual(h.calls, ["check-foreground"]);
});

test("Windows activates a background profile without CDP natively", async (t) => {
  const h = focusHarness(t, { profile: { cdpPort: null }, foregroundPid: 2222 });
  await h.manager.focusProfile(h.profile.id);
  assert.deepEqual(h.calls, ["check-foreground", "native"]);
});

test("Windows reaches singleton only after foreground checks, native activation and refreshed retry fail", async (t) => {
  const h = focusHarness(t, { foregroundPid: 2222, nativeResult: false });
  await h.manager.focusProfile(h.profile.id);
  assert.deepEqual(h.calls, [
    "cdp", "check-foreground", "native", "rescan",
    "cdp", "check-foreground", "native", "singleton"
  ]);
});

test("Windows reports unconfirmed when singleton also fails", async (t) => {
  const h = focusHarness(t, { foregroundPid: null, nativeResult: false, singletonResult: false });
  await assert.rejects(h.manager.focusProfile(h.profile.id), { code: "FOCUS_PROFILE_UNCONFIRMED" });
  assert.equal(h.calls.at(-1), "singleton");
});

test("macOS keeps native activation and its existing independent foreground confirmation", async (t) => {
  const h = focusHarness(t, { platform: "darwin" });
  await h.manager.focusProfile(h.profile.id);
  assert.deepEqual(h.calls, ["cdp", "native", "mac-check"]);
});
