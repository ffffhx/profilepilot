const assert = require("node:assert/strict");
const test = require("node:test");

const { ProfileManager } = require("../dist/main/profile-manager.js");

test("ProfileManager takeoverAgentConnections with pids only stops requested agent drivers", async () => {
  const manager = createTakeoverHarness([
    {
      pid: 101,
      label: "agent-browser",
      project: "profilepilot",
      title: "Sessionless one"
    },
    {
      pid: 202,
      label: "agent-browser",
      project: "profilepilot",
      title: "Sessionless two"
    },
    {
      pid: 303,
      label: "Chrome"
    }
  ]);

  const result = await manager.takeoverAgentConnections("profile-1", { pids: [101] });

  assert.deepEqual(manager.terminatedPids, [101]);
  assert.equal(result.targetCount, 1);
  assert.equal(result.successCount, 1);
  assert.equal(result.failureCount, 0);
  assert.equal(result.allStopped, true);
  assert.equal(result.takeovers[0].profileId, "profile-1");
  assert.equal(result.takeovers[0].session, undefined);
});

test("ProfileManager takeoverAgentConnections without filters still stops every agent driver", async () => {
  const manager = createTakeoverHarness([
    {
      pid: 101,
      label: "agent-browser",
      project: "profilepilot",
      title: "Codex one",
      session: "cx-one"
    },
    {
      pid: 202,
      label: "Claude Code",
      title: "Claude two",
      session: "cc-two"
    },
    {
      pid: 303,
      label: "Chrome"
    }
  ]);

  const result = await manager.takeoverAgentConnections("profile-1");

  assert.deepEqual(manager.terminatedPids, [101, 202]);
  assert.equal(result.targetCount, 2);
  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 0);
  assert.equal(result.allStopped, true);
  assert.deepEqual(
    result.takeovers.map((event) => event.session),
    ["cx-one", "cc-two"]
  );
});

function createTakeoverHarness(clients) {
  const manager = Object.create(ProfileManager.prototype);
  manager.terminatedPids = [];
  manager.events = {};
  manager.resolveTakeoverTarget = async () => ({
    profileId: "profile-1",
    profileName: "Profile One",
    clients
  });
  manager.terminateCdpClient = async (pid) => {
    manager.terminatedPids.push(pid);
  };
  manager.recordTakeoverEvent = async () => {};
  return manager;
}
