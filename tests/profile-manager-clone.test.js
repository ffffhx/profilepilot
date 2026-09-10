const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cloneProfileMode,
  findAvailableUnreservedCdpPort,
  ProfileManager,
  repairDuplicateFixedCdpPorts,
  friendlyCloneError,
  isWindowsCrossDataDirAccountSyncUnsupported,
  shouldRestartCloneSource
} = require("../dist/main/profile-manager.js");

test("clone mode and source restart policy distinguish Windows native templates", () => {
  assert.equal(cloneProfileMode("win32", { source: "native" }), "windows-native-template");
  assert.equal(cloneProfileMode("win32", { source: "isolated" }), "account-copy");
  assert.equal(cloneProfileMode("darwin", { source: "native" }), "account-copy");
  assert.equal(shouldRestartCloneSource("win32", true, "native"), false);
  assert.equal(shouldRestartCloneSource("win32", true, "isolated"), true);
  assert.equal(shouldRestartCloneSource("win32", false), false);
  assert.equal(shouldRestartCloneSource("darwin", true), false);
  assert.equal(shouldRestartCloneSource("linux", true), false);
});

test("Windows blocks generic account sync across user-data-dir boundaries", () => {
  const source = { userDataDir: "C:\\Chrome\\User Data" };
  assert.equal(
    isWindowsCrossDataDirAccountSyncUnsupported("win32", source, { userDataDir: "c:\\chrome\\user data\\" }),
    false
  );
  assert.equal(
    isWindowsCrossDataDirAccountSyncUnsupported("win32", source, { userDataDir: "C:\\ProfilePilot\\Work" }),
    true
  );
  assert.equal(
    isWindowsCrossDataDirAccountSyncUnsupported("darwin", source, { userDataDir: "/tmp/work" }),
    false
  );
});

test("Windows clone errors explain a lingering Chrome file lock", () => {
  const busy = Object.assign(new Error("resource busy"), { code: "EBUSY" });
  const friendly = friendlyCloneError(busy, "系统默认 Profile", "win32");

  assert.equal(friendly.code, "CLONE_SOURCE_BUSY");
  assert.match(friendly.message, /Windows 仍在占用源 系统默认 Profile/);
  assert.equal(friendlyCloneError(busy, "系统默认 Profile", "darwin"), busy);
});

test("CDP port allocation skips ports reserved by stopped Profiles", async () => {
  const checked = [];
  const port = await findAvailableUnreservedCdpPort(9223, new Set([9223, 9224]), async (candidate) => {
    checked.push(candidate);
    return candidate;
  });

  assert.equal(port, 9225);
  assert.deepEqual(checked, [9225]);
});

test("duplicate fixed CDP ports keep the established owner and repair later Profiles", async () => {
  const registry = {
    profiles: [
      { id: "old", name: "9223Profile", fixedCdpPort: 9223 },
      { id: "new", name: "系统默认 Profile-1", fixedCdpPort: 9223 },
      { id: "other", name: "9224", fixedCdpPort: 9224 }
    ]
  };

  const repairs = await repairDuplicateFixedCdpPorts(registry, new Map(), async (candidate) => candidate);

  assert.deepEqual(repairs, [{
    profileId: "new",
    profileName: "系统默认 Profile-1",
    previousPort: 9223,
    port: 9225
  }]);
  assert.deepEqual(registry.profiles.map((profile) => profile.fixedCdpPort), [9223, 9225, 9224]);
});

test("duplicate fixed CDP repair preserves the Profile actively bound by Gateway", async () => {
  const registry = {
    profiles: [
      { id: "old", name: "Old", fixedCdpPort: 9223 },
      { id: "active", name: "Active", fixedCdpPort: 9223 },
      { id: "other", name: "Other", fixedCdpPort: 9224 }
    ]
  };

  await repairDuplicateFixedCdpPorts(registry, new Map([[9223, "active"]]), async (candidate) => candidate);

  assert.deepEqual(registry.profiles.map((profile) => profile.fixedCdpPort), [9225, 9223, 9224]);
});

test("cloneProfiles keeps a Windows native source open and uses the lightweight template", async () => {
  const manager = Object.create(ProfileManager.prototype);
  const events = [];
  let sourceRunning = true;

  manager.getState = async () => cloneState(sourceRunning);
  manager.captureProfileRestartPlan = async (profile) => {
    events.push(`capture:${profile.id}`);
    return { profileId: profile.id, profileName: profile.name, cdpPort: null, urls: [] };
  };
  manager.closeProfileIfRunning = async (profileId) => {
    events.push(`close:${profileId}`);
    sourceRunning = false;
  };
  manager.restoreProfileFromRestartPlan = async (plan) => {
    events.push(`restore:${plan.profileId}`);
    sourceRunning = true;
    return 0;
  };
  manager.createProfile = async (name) => {
    events.push(`create:${name}`);
    return { id: "clone-one" };
  };
  manager.syncAccount = async ({ sourceProfileId, targetProfileId }) => {
    events.push(`sync:${sourceProfileId}:${targetProfileId}`);
  };
  manager.syncWindowsNativeAgentTemplate = async (sourceProfileId, targetProfileId) => {
    events.push(`template:${sourceProfileId}:${targetProfileId}`);
  };
  manager.reserveAvailableFixedCdpPort = async (profileId, preferredPort, clonedFromProfileId) => {
    events.push(`reserve:${profileId}:${clonedFromProfileId}`);
    return preferredPort;
  };

  const result = await manager.cloneProfiles({
    sourceProfileId: "native:Default",
    count: 1,
    basePort: 57321
  });

  const lifecycleEvents = events.filter((event) => /^(capture|close|restore):/.test(event));
  assert.deepEqual(lifecycleEvents, []);
  assert.equal(
    events.includes("template:native:Default:isolated:clone-one"),
    process.platform === "win32"
  );
  assert.equal(
    events.includes("sync:native:Default:isolated:clone-one"),
    process.platform !== "win32"
  );
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].profileId, "isolated:clone-one");
  assert.equal(sourceRunning, true);
});

test("cloneProfiles restores a Windows isolated source even when cloning fails", async () => {
  const manager = Object.create(ProfileManager.prototype);
  const events = [];
  let sourceRunning = true;
  const failure = new Error("copy failed");

  manager.getState = async () => cloneState(sourceRunning, "isolated");
  manager.captureProfileRestartPlan = async (profile) => ({
    profileId: profile.id,
    profileName: profile.name,
    cdpPort: null,
    urls: []
  });
  manager.closeProfileIfRunning = async () => {
    events.push("close");
    sourceRunning = false;
  };
  manager.restoreProfileFromRestartPlan = async () => {
    events.push("restore");
    sourceRunning = true;
    return 0;
  };
  manager.createProfile = async () => ({ id: "clone-failed" });
  manager.syncAccount = async () => {
    throw failure;
  };
  manager.deleteProfile = async (profileId) => {
    events.push(`delete:${profileId}`);
  };

  await assert.rejects(
    manager.cloneProfiles({ sourceProfileId: "isolated:source", count: 2, basePort: 57331 }),
    failure
  );
  assert.deepEqual(
    events,
    process.platform === "win32"
      ? ["close", "delete:isolated:clone-failed", "restore"]
      : ["delete:isolated:clone-failed"]
  );
  assert.equal(sourceRunning, true);
});

function cloneState(running, source = "native") {
  const id = source === "native" ? "native:Default" : "isolated:source";
  return {
    profiles: [
      {
        id,
        name: source === "native" ? "系统默认 Profile" : "Agent Work",
        source,
        running,
        pids: running ? [100] : []
      }
    ]
  };
}
