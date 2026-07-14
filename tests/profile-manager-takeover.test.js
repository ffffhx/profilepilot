const assert = require("node:assert/strict");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ProfileManager,
  agentBrowserRuntimeProfilesFromPublicProfiles,
  agentControlStatusForClients,
  agentControlNoticePaths,
  areAllAgentControlClientsPaused,
  compatibilityCdpPorts,
  gatewayManagedPortSet,
  makeAgentControlNotice,
  pendingUserActionFromControlNoticeSync,
  stripManagedCdpRuntimeMetadata,
  shouldAutoDisconnectStaleAgentBrowserClient
} = require("../dist/main/profile-manager.js");
const { writeAgentBrowserControlWaitStateSync } = require("../dist/main/agent-browser-session.js");

function runtimeProfile(overrides) {
  return {
    id: "isolated:profile",
    name: "Profile",
    source: "isolated",
    running: false,
    cdpPort: null,
    fixedCdpPort: null,
    clonedFromProfileId: null,
    projectTag: null,
    lastLaunchedAt: null,
    ...overrides
  };
}

test("ProfileManager uses Chinese for the browser control protocol", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "profilepilot-overlay-locale-"));
  const manager = new ProfileManager(dataDir);
  assert.equal(manager.agentOverlayManager.options.locale, "zh");
  await manager.disposeAgentOverlay();
  await rm(dataDir, { recursive: true, force: true });
});

test("ProfileManager recovers pending user action metadata from a wrapper notice", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "profilepilot-pending-user-action-"));
  const directory = path.join(home, ".profilepilot", "agent-control");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "cx-handoff.json"), `${JSON.stringify({
    version: 1,
    controlVersion: 1,
    code: "AGENT_USER_IN_CONTROL",
    reason: "user_takeover",
    ownership: "agentDelegatedToUser",
    handoffState: "quiesced",
    pendingUserAction: "  手动加载   未打包扩展  ",
    message: "等待用户完成",
    hardStop: true,
    profileId: "profile-1",
    profileName: "Profile One",
    pid: process.pid,
    label: "agent-browser",
    session: "cx-handoff",
    at: new Date().toISOString(),
    expiresAt: "9999-12-31T23:59:59.999Z"
  })}\n`);

  assert.equal(
    pendingUserActionFromControlNoticeSync("cx-handoff", home),
    "手动加载 未打包扩展"
  );
  await rm(home, { recursive: true, force: true });
});

test("Gateway authority excludes every managed port from legacy scans while OS runtime only keeps Chrome liveness", () => {
  const status = {
    ok: true,
    ports: [9224, 9225],
    managedPorts: [9223, 9224, 9225, 9226]
  };
  assert.deepEqual([...gatewayManagedPortSet(status)].sort((a, b) => a - b), [9223, 9224, 9225, 9226]);
  assert.deepEqual(compatibilityCdpPorts([9223, 9224, 9225, 9226, 9333], status), [9333]);

  const runtime = new Map([
    ["managed-9225", { pids: [105], browserPids: [105], startedAt: null, cdpPort: 9225, listeningPorts: [9225, 53100] }],
    ["managed-9226", { pids: [106], browserPids: [106], startedAt: null, cdpPort: 9226, listeningPorts: [9226] }],
    ["legacy-9333", { pids: [133], browserPids: [133], startedAt: null, cdpPort: 9333, listeningPorts: [9333] }]
  ]);
  stripManagedCdpRuntimeMetadata(runtime, gatewayManagedPortSet(status));

  assert.deepEqual(runtime.get("managed-9225"), {
    pids: [105],
    browserPids: [105],
    startedAt: null,
    cdpPort: null,
    listeningPorts: [53100]
  });
  assert.deepEqual(runtime.get("managed-9226").pids, [106], "OS process still proves Chrome is running");
  assert.equal(runtime.get("managed-9226").cdpPort, null);
  assert.equal(runtime.get("legacy-9333").cdpPort, 9333, "unmanaged legacy port keeps the old fallback");
});

test("ProfileManager publishes stopped fixed-port Profiles for agent-browser auto-start", () => {
  const profiles = agentBrowserRuntimeProfilesFromPublicProfiles([
    runtimeProfile({ id: "isolated:live", name: "Live", running: true, cdpPort: 9224, fixedCdpPort: 9224 }),
    runtimeProfile({ id: "isolated:stopped", name: "Stopped", running: false, cdpPort: null, fixedCdpPort: 9225 }),
    runtimeProfile({ id: "isolated:plain-running", name: "Plain", running: true, cdpPort: null, fixedCdpPort: 9226 }),
    runtimeProfile({ id: "native:Default", name: "System", source: "native", running: false, cdpPort: null, fixedCdpPort: null })
  ]);

  assert.deepEqual(
    profiles.map((profile) => ({ port: profile.cdpPort, running: profile.running })),
    [{ port: 9224, running: true }, { port: 9225, running: false }]
  );
});

test("ProfileManager takeoverAgentConnections with pids only pauses requested agent drivers", async () => {
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

  assert.deepEqual(manager.terminatedPids, []);
  assert.deepEqual(manager.operations, ["notice:101:user_takeover", "notice:101:user_takeover"]);
  assert.equal(result.targetCount, 1);
  assert.equal(result.successCount, 1);
  assert.equal(result.failureCount, 0);
  assert.equal(result.allStopped, true);
  assert.equal(result.takeovers[0].profileId, "profile-1");
  assert.equal(result.takeovers[0].session, undefined);
});

test("ProfileManager takeoverAgentConnections without filters still pauses every agent driver", async () => {
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

  assert.deepEqual(manager.terminatedPids, []);
  assert.deepEqual(manager.operations, [
    "notice:101:user_takeover",
    "wait-settled:cx-one",
    "lease-delegated:cx-one:true",
    "notice:101:user_takeover",
    "notice:202:user_takeover",
    "wait-settled:cc-two",
    "lease-delegated:cc-two:true",
    "notice:202:user_takeover"
  ]);
  assert.equal(result.targetCount, 2);
  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 0);
  assert.equal(result.allStopped, true);
  assert.deepEqual(
    result.takeovers.map((event) => event.session),
    ["cx-one", "cc-two"]
  );
});

test("ProfileManager takeoverAgentConnections records stop reason for agent-readable notices", async () => {
  const manager = createTakeoverHarness([
    {
      pid: 101,
      label: "agent-browser",
      project: "profilepilot",
      title: "Codex one",
      session: "cx-one"
    }
  ]);

  await manager.takeoverAgentConnections("profile-1", { pids: [101], reason: "user_stop" });

  assert.deepEqual(manager.operations, ["notice:101:user_stop", "terminate:101"]);
  assert.equal(manager.controlNotices[0].target.profileId, "profile-1");
  assert.equal(manager.controlNotices[0].target.profileName, "Profile One");
  assert.equal(manager.controlNotices[0].client.session, "cx-one");
});

test("ProfileManager keeps Input Guard locked until the current browser command settles", async () => {
  const manager = createTakeoverHarness([
    { pid: 101, label: "agent-browser", session: "cx-busy" }
  ]);
  manager.waitForAgentBrowserCommandSettled = async (session) => {
    manager.operations.push(`wait-settled:${session}`);
    return false;
  };

  const result = await manager.takeoverAgentConnections("profile-1", { session: "cx-busy" });

  assert.equal(result.successCount, 0);
  assert.equal(result.failureCount, 1);
  assert.match(result.failures[0].error, /命令尚未结束/);
  assert.deepEqual(manager.operations, ["notice:101:user_takeover", "wait-settled:cx-busy"]);
  assert.doesNotMatch(manager.operations.join("\n"), /lease-delegated/);
});

test("ProfileManager resumeAgentConnections writes a user-return notice without terminating the Agent", async () => {
  const manager = createTakeoverHarness([
    {
      pid: 101,
      label: "agent-browser",
      project: "profilepilot",
      title: "Codex one",
      session: "cx-one"
    }
  ]);

  const result = await manager.resumeAgentConnections("profile-1", { session: "cx-one" });

  assert.deepEqual(manager.operations, ["lease-delegated:cx-one:false", "notice:101:user_return"]);
  assert.deepEqual(manager.terminatedPids, []);
  assert.equal(result.targetCount, 1);
  assert.equal(result.successCount, 1);
  assert.deepEqual(result.failures, []);
});

test("ProfileManager releases a completed agent-browser Session and Profile lease", async () => {
  const manager = createTakeoverHarness([
    {
      pid: 101,
      label: "agent-browser",
      project: "profilepilot",
      session: "cx-one"
    },
    {
      pid: 202,
      label: "Chrome",
      session: "cx-one"
    },
    {
      pid: 303,
      label: "agent-browser",
      session: "cx-other"
    }
  ]);
  const result = await manager.completeAgentConnections("profile-1", { session: "cx-one" });

  assert.deepEqual(manager.operations, ["retire-completed:101"]);
  assert.deepEqual(manager.terminatedPids, [101]);
  assert.equal(manager.controlNotices.length, 0);
  assert.equal(result.targetCount, 1);
  assert.equal(result.successCount, 1);
  assert.deepEqual(result.failures, []);
});

test("ProfileManager orders Gateway revocation between durable notice and user unlock", async () => {
  const manager = createTakeoverHarness([
    { pid: 101, label: "agent-browser", session: "cx-gateway" }
  ]);
  manager.isGatewaySessionManaged = async () => true;
  manager.controlGatewaySession = async (_session, command) => {
    manager.operations.push(`gateway:${command}`);
    return true;
  };
  await manager.takeoverAgentConnections("profile-1", { session: "cx-gateway" });
  assert.deepEqual(manager.operations, [
    "notice:101:user_takeover",
    "gateway:takeover",
    "wait-settled:cx-gateway",
    "lease-delegated:cx-gateway:true",
    "notice:101:user_takeover"
  ]);

  manager.operations.length = 0;
  await manager.resumeAgentConnections("profile-1", { session: "cx-gateway" });
  assert.deepEqual(manager.operations, [
    "gateway:return",
    "lease-delegated:cx-gateway:false",
    "notice:101:user_return"
  ]);

  manager.operations.length = 0;
  await manager.completeAgentConnections("profile-1", { session: "cx-gateway" });
  assert.deepEqual(manager.operations, [
    "notice:101:agent_complete",
    "gateway:complete",
    "gateway:stop",
    "retire-completed:101"
  ]);
});

test("ProfileManager builds ego-style agent control notices with stable codes", () => {
  const target = { profileId: "profile-1", profileName: "Profile One" };
  const client = {
    pid: 101,
    label: "agent-browser",
    session: "cx-one",
    title: "Codex run"
  };

  const takeover = makeAgentControlNotice(target, client, "user_takeover", "2026-07-09T00:00:00.000Z");
  assert.equal(takeover.code, "AGENT_USER_IN_CONTROL");
  assert.equal(takeover.reason, "user_takeover");
  assert.equal(takeover.ownership, "agentDelegatedToUser");
  assert.equal(takeover.hardStop, true);
  assert.equal(takeover.controlVersion, 1);
  assert.equal(takeover.expiresAt, "9999-12-31T23:59:59.999Z");
  assert.match(takeover.action, /不要重试/);

  const stopped = makeAgentControlNotice(target, client, "user_stop", "2026-07-09T00:00:00.000Z");
  assert.equal(stopped.code, "AGENT_TASK_STOPPED");
  assert.equal(stopped.reason, "user_stop");
  assert.equal(stopped.ownership, "user");

  const returned = makeAgentControlNotice(target, client, "user_return", "2026-07-09T00:00:00.000Z");
  assert.equal(returned.code, "AGENT_CONTROL_RETURNED");
  assert.equal(returned.reason, "user_return");
  assert.equal(returned.ownership, "agent");
  assert.equal(returned.hardStop, false);
  assert.match(returned.action, /重新读取页面状态/);

  const completed = makeAgentControlNotice(target, client, "agent_complete", "2026-07-09T00:00:00.000Z");
  assert.equal(completed.code, "AGENT_USER_IN_CONTROL");
  assert.equal(completed.reason, "agent_complete");
  assert.equal(completed.ownership, "agentDelegatedToUser");
  assert.equal(completed.hardStop, true);
  assert.equal(completed.expiresAt, "9999-12-31T23:59:59.999Z");
  assert.match(completed.message, /已完成当前任务/);

  assert.deepEqual(agentControlNoticePaths("/tmp/home", "cx-one", 101), [
    "/tmp/home/.profilepilot/agent-control/cx-one.json",
    "/tmp/home/.agent-browser/cx-one.profilepilot-control.json"
  ]);
  assert.deepEqual(agentControlNoticePaths("/tmp/home", "../bad", 101), ["/tmp/home/.profilepilot/agent-control/pid-101.json"]);
});

test("ProfileManager treats a connected daemon with a takeover notice as paused until resume", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "profilepilot-paused-"));
  const client = { pid: 101, label: "agent-browser", session: "cx-one" };
  const notice = makeAgentControlNotice(
    { profileId: "profile-1", profileName: "Profile One" },
    client,
    "user_takeover",
    "2026-07-10T08:00:00.000Z"
  );
  const [noticePath] = agentControlNoticePaths(home, client.session, client.pid);
  await mkdir(path.dirname(noticePath), { recursive: true });
  await writeFile(noticePath, `${JSON.stringify(notice)}\n`);

  assert.equal(
    await areAllAgentControlClientsPaused([client], home, Date.parse("2026-07-10T08:01:00.000Z")),
    true
  );
  await rm(noticePath, { force: true });
  assert.equal(
    await areAllAgentControlClientsPaused([client], home, Date.parse("2026-07-10T08:01:00.000Z")),
    false
  );
  await rm(home, { recursive: true, force: true });
});

test("ProfileManager distinguishes a live waiting Agent from an offline takeover", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "profilepilot-waiter-state-"));
  const client = { pid: process.pid, label: "agent-browser", session: "cx-waiter" };
  const controlSince = "2026-07-10T08:00:00.000Z";
  const notice = makeAgentControlNotice(
    { profileId: "profile-1", profileName: "Profile One" },
    client,
    "user_takeover",
    controlSince,
    { handoffState: "quiesced" }
  );
  const [noticePath] = agentControlNoticePaths(home, client.session, client.pid);
  await mkdir(path.dirname(noticePath), { recursive: true });
  await writeFile(noticePath, `${JSON.stringify(notice)}\n`);

  const offline = await agentControlStatusForClients(
    [client],
    home,
    Date.parse("2026-07-10T08:01:00.000Z")
  );
  assert.deepEqual(offline, { paused: true, agentOffline: true, controlSince });

  writeAgentBrowserControlWaitStateSync(client.session, process.pid, home);
  const waiting = await agentControlStatusForClients(
    [client],
    home,
    Date.parse("2026-07-10T08:01:00.000Z")
  );
  assert.deepEqual(waiting, { paused: true, agentOffline: false, controlSince });
  await rm(home, { recursive: true, force: true });
});

test("ProfileManager does not unlock user input for a requested but unquiesced takeover", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "profilepilot-requested-"));
  const client = { pid: 101, label: "agent-browser", session: "cx-one" };
  const notice = makeAgentControlNotice(
    { profileId: "profile-1", profileName: "Profile One" },
    client,
    "user_takeover",
    "2026-07-10T08:00:00.000Z",
    { controlVersion: 7, handoffState: "requested" }
  );
  const [noticePath] = agentControlNoticePaths(home, client.session, client.pid);
  await mkdir(path.dirname(noticePath), { recursive: true });
  await writeFile(noticePath, `${JSON.stringify(notice)}\n`);

  assert.equal(
    await areAllAgentControlClientsPaused([client], home, Date.parse("2026-07-10T08:01:00.000Z")),
    false
  );
  await rm(home, { recursive: true, force: true });
});

test("ProfileManager does not keep a completed Session paused after release", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "profilepilot-completed-"));
  const client = { pid: 101, label: "agent-browser", session: "cx-one" };
  const notice = makeAgentControlNotice(
    { profileId: "profile-1", profileName: "Profile One" },
    client,
    "agent_complete",
    "2026-07-10T08:00:00.000Z"
  );
  const [noticePath] = agentControlNoticePaths(home, client.session, client.pid);
  await mkdir(path.dirname(noticePath), { recursive: true });
  await writeFile(noticePath, `${JSON.stringify(notice)}\n`);

  assert.equal(
    await areAllAgentControlClientsPaused([client], home, Date.parse("2099-07-10T08:00:00.000Z")),
    false
  );
  assert.deepEqual(
    await agentControlStatusForClients([client], home, Date.parse("2099-07-10T08:00:00.000Z")),
    { paused: false, agentOffline: false }
  );
  await rm(home, { recursive: true, force: true });
});

test("ProfileManager treats every daemon of one named Session as paused by one Session notice", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "profilepilot-duplicate-daemon-control-"));
  const clients = [
    { pid: 101, label: "agent-browser", session: "cx-one" },
    { pid: 202, label: "agent-browser", session: "cx-one" }
  ];
  const notice = makeAgentControlNotice(
    { profileId: "profile-1", profileName: "Profile One" },
    clients[1],
    "user_takeover",
    "2026-07-10T08:00:00.000Z",
    { handoffState: "quiesced" }
  );
  const [noticePath] = agentControlNoticePaths(home, "cx-one", clients[1].pid);
  await mkdir(path.dirname(noticePath), { recursive: true });
  await writeFile(noticePath, `${JSON.stringify(notice)}\n`);

  assert.equal(
    await areAllAgentControlClientsPaused(clients, home, Date.parse("2026-07-10T08:01:00.000Z")),
    true
  );
  await rm(home, { recursive: true, force: true });
});

test("ProfileManager does not report takeover success when the Agent notice cannot be written", async () => {
  const manager = createTakeoverHarness([
    { pid: 101, label: "agent-browser", session: "cx-one" }
  ]);
  manager.writeAgentControlNotice = async () => {
    throw new Error("notice write failed");
  };

  const result = await manager.takeoverAgentConnections("profile-1");

  assert.equal(result.successCount, 0);
  assert.equal(result.failureCount, 1);
  assert.match(result.failures[0].error, /notice write failed/);
  assert.deepEqual(manager.operations, []);
});

test("ProfileManager auto-disconnects stale agent-browser daemons only", async () => {
  const now = Date.parse("2026-07-09T10:00:00.000Z");
  assert.equal(
    shouldAutoDisconnectStaleAgentBrowserClient(
      { pid: 1, label: "agent-browser", lastActive: "2026-07-09T09:57:59.000Z" },
      now
    ),
    false
  );
  assert.equal(
    shouldAutoDisconnectStaleAgentBrowserClient(
      { pid: 2, label: "agent-browser", lastActive: "2026-07-09T09:59:30.000Z" },
      now
    ),
    false
  );
  assert.equal(
    shouldAutoDisconnectStaleAgentBrowserClient(
      { pid: 3, label: "agent-browser", note: "session「cx-old」的专属 daemon：该目录下近期无活跃会话，可能是会话结束后的残留连接" },
      now
    ),
    true
  );
  assert.equal(
    shouldAutoDisconnectStaleAgentBrowserClient({ pid: 4, label: "Claude Code", lastActive: "2026-07-09T09:50:00.000Z" }, now),
    false
  );

  const manager = createTakeoverHarness([]);
  const oldIso = new Date(Date.now() - 3 * 60_000).toISOString();
  const freshIso = new Date(Date.now() - 30_000).toISOString();
  const profiles = [
    {
      cdpClients: [
        { pid: 101, label: "agent-browser", lastActive: oldIso },
        { pid: 202, label: "agent-browser", lastActive: freshIso },
        { pid: 303, label: "Claude Code", lastActive: oldIso }
      ]
    }
  ];
  const externalInstances = [
    {
      cdpClients: [
        {
          pid: 404,
          label: "agent-browser",
          note: "共享 daemon：该目录下近期无活跃会话，无法从连接判定当前使用者"
        }
      ]
    }
  ];

  await manager.autoDisconnectStaleAgentBrowserClients(profiles, externalInstances);

  assert.deepEqual(manager.terminatedPids, [404]);
  assert.deepEqual(
    profiles[0].cdpClients.map((client) => client.pid),
    [101, 202, 303]
  );
  assert.deepEqual(externalInstances[0].cdpClients, []);
});

function createTakeoverHarness(clients) {
  const manager = Object.create(ProfileManager.prototype);
  manager.terminatedPids = [];
  manager.operations = [];
  manager.controlNotices = [];
  manager.events = {};
  manager.autoDisconnectingCdpPids = new Set();
  manager.resolveTakeoverTarget = async () => ({
    profileId: "profile-1",
    profileName: "Profile One",
    clients
  });
  manager.terminateCdpClient = async (pid) => {
    manager.operations.push(`terminate:${pid}`);
    manager.terminatedPids.push(pid);
  };
  manager.writeAgentControlNotice = async (target, client, reason) => {
    manager.operations.push(`notice:${client.pid}:${reason}`);
    manager.controlNotices.push({ target, client, reason });
  };
  manager.recordTakeoverEvent = async () => {};
  manager.removeAgentBrowserSessionFiles = async () => {};
  manager.retireCompletedAgentBrowserClient = async (client) => {
    manager.operations.push(`retire-completed:${client.pid}`);
    manager.terminatedPids.push(client.pid);
  };
  manager.releaseAgentBrowserProfileLeases = (session) => {
    manager.operations.push(`lease-release:${session}`);
    return [];
  };
  manager.setAgentBrowserProfileLeasesDelegated = (session, delegated) => {
    manager.operations.push(`lease-delegated:${session}:${delegated}`);
    return [];
  };
  manager.waitForAgentBrowserCommandSettled = async (session) => {
    manager.operations.push(`wait-settled:${session}`);
    return true;
  };
  manager.isGatewaySessionManaged = async () => false;
  manager.controlGatewaySession = async () => false;
  return manager;
}
