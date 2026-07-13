const assert = require("node:assert/strict");
const { mkdirSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  AGENT_BROWSER_PROFILE_LEASE_PENDING_TTL_MS,
  acquireAgentBrowserProfileLeaseSync,
  findConfiguredAgentBrowserProfileByPortSync,
  findAvailableAgentBrowserProfileCandidatesSync,
  findAgentBrowserProfileLeaseForSessionSync,
  readAgentBrowserRuntimeProfilesSync,
  readAgentBrowserProfileLeaseSync,
  readActiveAgentBrowserProfileOccupancySync,
  releaseAgentBrowserProfileLeaseSync,
  releaseAgentBrowserProfileLeasesForSessionSync,
  resolveAgentBrowserProfileTargetSync,
  setAgentBrowserProfileLeasesDelegatedSync,
  updateAgentBrowserProfileLeaseTargetSync,
  writeAgentBrowserRuntimeProfilesSync
} = require("../dist/main/agent-browser-lease.js");
const {
  clientFromDelegatedAgentBrowserProfileLease,
  collapseDuplicateNamedSessionClients
} = require("../dist/main/process-scan.js");

test("agent-browser Profile lease allows one Session and rejects another", () => {
  const home = makeTempHome();
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  const first = acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-owner",
    holderPid: process.pid,
    profileId: "isolated:one",
    profileName: "工作 Profile",
    project: "profilepilot",
    command: "snapshot"
  }, home, now);
  const same = acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-owner",
    holderPid: process.pid,
    profileId: "isolated:one",
    profileName: "工作 Profile",
    command: "click"
  }, home, now + 1_000);
  const blocked = acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cc-other",
    holderPid: process.pid
  }, home, now + 2_000);

  assert.equal(first.ok, true);
  assert.equal(first.status, "acquired");
  assert.equal(same.ok, true);
  assert.equal(same.status, "renewed");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, "conflict");
  assert.equal(blocked.lease.session, "cx-owner");
  assert.equal(blocked.lease.profileName, "工作 Profile");
  assert.equal(readAgentBrowserProfileLeaseSync(9223, home).session, "cx-owner");

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser Profile lease reclaims an expired owner", () => {
  const home = makeTempHome();
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9224,
    session: "cx-expired",
    holderPid: 99_999_991,
    profileId: "isolated:two",
    profileName: "过期 Profile"
  }, home, now);

  const reclaimed = acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9224,
    session: "cx-next",
    holderPid: process.pid
  }, home, now + AGENT_BROWSER_PROFILE_LEASE_PENDING_TTL_MS + 1);

  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.status, "reclaimed");
  assert.equal(reclaimed.replacedLease.session, "cx-expired");
  assert.equal(reclaimed.lease.session, "cx-next");

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser Profile leases release by owner and follow Session switches", () => {
  const home = makeTempHome();
  acquireAgentBrowserProfileLeaseSync({ cdpPort: 9223, session: "cx-one", holderPid: process.pid }, home);
  acquireAgentBrowserProfileLeaseSync({ cdpPort: 9224, session: "cx-one", holderPid: process.pid }, home);

  assert.equal(findAgentBrowserProfileLeaseForSessionSync("cx-one", home).session, "cx-one");
  assert.equal(releaseAgentBrowserProfileLeaseSync(9223, "cc-wrong", home), false);
  assert.deepEqual(releaseAgentBrowserProfileLeasesForSessionSync("cx-one", home, 9224), [9223]);
  assert.equal(readAgentBrowserProfileLeaseSync(9223, home), null);
  assert.equal(readAgentBrowserProfileLeaseSync(9224, home).session, "cx-one");
  assert.equal(releaseAgentBrowserProfileLeaseSync(9224, "cx-one", home), true);

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser Profile lease remains exclusive while delegated to the user", () => {
  const home = makeTempHome();
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-owner",
    holderPid: 99_999_991,
    profileId: "isolated:one",
    profileName: "工作 Profile"
  }, home, now);
  assert.deepEqual(setAgentBrowserProfileLeasesDelegatedSync("cx-owner", true, home, now + 1_000), [9223]);
  const delegated = readAgentBrowserProfileLeaseSync(9223, home);
  assert.equal(delegated.delegatedToUser, true);
  assert.equal(delegated.expiresAt, "9999-12-31T23:59:59.999Z");
  assert.deepEqual(readActiveAgentBrowserProfileOccupancySync(9223, home, now + 1_000), {
    cdpPort: 9223,
    profileId: "isolated:one",
    profileName: "工作 Profile",
    session: "cx-owner",
    ownership: "user",
    agent: "Codex",
    project: null,
    command: null,
    holderPid: 99_999_991,
    daemonPid: null,
    updatedAt: "2026-07-10T00:00:01.000Z"
  });

  const blocked = acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cc-other",
    holderPid: process.pid
  }, home, now + 24 * 60 * 60_000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.lease.session, "cx-owner");

  assert.deepEqual(setAgentBrowserProfileLeasesDelegatedSync("cx-owner", false, home, now + 2_000), [9223]);
  const resumed = readAgentBrowserProfileLeaseSync(9223, home);
  assert.equal(resumed.delegatedToUser, undefined);
  assert.notEqual(resumed.expiresAt, "9999-12-31T23:59:59.999Z");
  rmSync(home, { recursive: true, force: true });
});

test("delegated lease is reclaimable when the live Gateway no longer owns that Profile", () => {
  const home = makeTempHome();
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9224,
    session: "cx-stale",
    holderPid: 99_999_991,
    profileId: "isolated:stale",
    profileName: "旧备用 Profile"
  }, home, now);
  setAgentBrowserProfileLeasesDelegatedSync("cx-stale", true, home, now + 1_000);
  writeGatewayAuthority(home, []);

  assert.equal(readActiveAgentBrowserProfileOccupancySync(9224, home, now + 2_000), null);
  const reclaimed = acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9224,
    session: "cx-current",
    holderPid: process.pid,
    profileId: "isolated:stale",
    profileName: "旧备用 Profile"
  }, home, now + 2_000);
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.status, "reclaimed");
  assert.equal(reclaimed.replacedLease.session, "cx-stale");

  rmSync(home, { recursive: true, force: true });
});

test("delegated lease stays exclusive while the live Gateway still owns that Profile", () => {
  const home = makeTempHome();
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9224,
    session: "cx-owner",
    holderPid: 99_999_991,
    profileId: "isolated:one",
    profileName: "工作 Profile"
  }, home, now);
  setAgentBrowserProfileLeasesDelegatedSync("cx-owner", true, home, now + 1_000);
  writeGatewayAuthority(home, [{
    publicPort: 9224,
    ownerSessionId: "cx-owner",
    sessionStatus: "active"
  }]);

  assert.equal(readActiveAgentBrowserProfileOccupancySync(9224, home, now + 2_000).session, "cx-owner");
  const blocked = acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9224,
    session: "cx-other",
    holderPid: process.pid
  }, home, now + 2_000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.lease.session, "cx-owner");

  rmSync(home, { recursive: true, force: true });
});

test("a delegated Profile lease remains visible after short-lived Session activity expires", () => {
  const client = clientFromDelegatedAgentBrowserProfileLease({
    version: 1,
    cdpPort: 9223,
    profileId: "isolated:work",
    profileName: "Work Profile",
    session: "cx-long-takeover",
    holderPid: 4101,
    daemonPid: 4202,
    agent: "Codex",
    project: "profilepilot",
    command: "snapshot",
    delegatedToUser: true,
    acquiredAt: "2026-07-10T08:00:00.000Z",
    updatedAt: "2026-07-10T08:01:00.000Z",
    expiresAt: "9999-12-31T23:59:59.999Z"
  });

  assert.equal(client.pid, 4202);
  assert.equal(client.session, "cx-long-takeover");
  assert.equal(client.agent, "Codex");
  assert.equal(client.project, "profilepilot");
  assert.equal(client.lastActive, "2026-07-10T08:01:00.000Z");
  assert.match(client.note, /排它绑定继续保留/);
});

test("CDP process scan collapses duplicate daemons owned by the same named Session", () => {
  const byPort = new Map([[9223, [
    {
      pid: 101,
      label: "agent-browser",
      session: "cx-one",
      agent: "Codex",
      lastActive: "2026-07-10T08:00:00.000Z"
    },
    {
      pid: 202,
      label: "agent-browser",
      session: "cx-one",
      agent: "Codex",
      lastActive: "2026-07-10T08:01:00.000Z"
    },
    { pid: 303, label: "Playwright" }
  ]]]);

  collapseDuplicateNamedSessionClients(byPort);

  assert.equal(byPort.get(9223).length, 2);
  assert.equal(byPort.get(9223)[0].session, "cx-one");
  assert.deepEqual(byPort.get(9223)[0].duplicatePids, [202]);
  assert.equal(byPort.get(9223)[0].lastActive, "2026-07-10T08:01:00.000Z");
  assert.match(byPort.get(9223)[0].note, /同一 Session 存在 2 个/);
  assert.equal(byPort.get(9223)[1].pid, 303);
});

test("agent-browser control ownership stays independent across Profiles", () => {
  const home = makeTempHome();
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-profile-a",
    holderPid: process.pid,
    profileId: "isolated:a",
    profileName: "Profile A"
  }, home);
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9224,
    session: "cc-profile-b",
    holderPid: process.pid,
    profileId: "isolated:b",
    profileName: "Profile B"
  }, home);

  setAgentBrowserProfileLeasesDelegatedSync("cx-profile-a", true, home);
  assert.equal(readAgentBrowserProfileLeaseSync(9223, home).delegatedToUser, true);
  assert.equal(readAgentBrowserProfileLeaseSync(9224, home).delegatedToUser, undefined);

  const blockedOnA = acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-third",
    holderPid: process.pid
  }, home);
  const stillOwnsB = acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9224,
    session: "cc-profile-b",
    holderPid: process.pid,
    command: "snapshot"
  }, home);
  assert.equal(blockedOnA.ok, false);
  assert.equal(stillOwnsB.ok, true);
  assert.equal(stillOwnsB.status, "renewed");
  assert.equal(readAgentBrowserProfileLeaseSync(9224, home).session, "cc-profile-b");
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser Profile lease resolves and refreshes Profile identity", () => {
  const home = makeTempHome();
  const dataDir = path.join(home, "profilepilot-data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, "profiles.json"), `${JSON.stringify({
    profiles: [{ id: "stored-one", name: "账号一", dirName: "stored-one-data", fixedCdpPort: 9333 }]
  })}\n`);

  assert.deepEqual(resolveAgentBrowserProfileTargetSync(9333, { CPM_DATA_DIR: dataDir }, home), {
    profileId: "isolated:stored-one",
    profileName: "账号一"
  });
  assert.deepEqual(
    findConfiguredAgentBrowserProfileByPortSync(9333, { CPM_DATA_DIR: dataDir }, home),
    {
      profileId: "isolated:stored-one",
      profileName: "账号一",
      cdpPort: 9333,
      profile: { id: "stored-one", name: "账号一", dirName: "stored-one-data", fixedCdpPort: 9333 },
      registryPath: path.join(dataDir, "profiles.json"),
      userDataDir: path.join(dataDir, "profiles", "stored-one-data")
    }
  );
  assert.equal(findConfiguredAgentBrowserProfileByPortSync(9334, { CPM_DATA_DIR: dataDir }, home), null);

  acquireAgentBrowserProfileLeaseSync({ cdpPort: 9333, session: "cx-one", holderPid: process.pid }, home);
  assert.equal(updateAgentBrowserProfileLeaseTargetSync(9333, {
    profileId: "isolated:live-one",
    profileName: "实时账号"
  }, home), true);
  assert.equal(readAgentBrowserProfileLeaseSync(9333, home).profileName, "实时账号");

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser Profile candidates include registered unoccupied Profiles and sort by CDP port", () => {
  const home = makeTempHome();
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  writeAgentBrowserRuntimeProfilesSync([
    {
      profileId: "isolated:work",
      profileName: "工作 Profile",
      cdpPort: 9223,
      source: "isolated",
      projectTag: "first-project",
      lastLaunchedAt: "2026-07-09T01:00:00.000Z"
    },
    {
      profileId: "isolated:work-clone",
      profileName: "工作 Profile 副本",
      cdpPort: 9226,
      source: "isolated",
      clonedFromProfileId: "isolated:work",
      projectTag: "other-project",
      lastLaunchedAt: "2026-07-09T02:00:00.000Z"
    },
    {
      profileId: "isolated:occupied",
      profileName: "已占用 Profile",
      cdpPort: 9227,
      source: "isolated",
      projectTag: "second-project",
      lastLaunchedAt: "2026-07-09T04:00:00.000Z"
    },
    {
      profileId: "isolated:next",
      profileName: "下一个 Profile",
      cdpPort: 9225,
      source: "isolated",
      running: false,
      lastLaunchedAt: "2026-07-09T05:00:00.000Z"
    },
    {
      profileId: "isolated:project",
      profileName: "项目 Profile",
      cdpPort: 9224,
      source: "isolated",
      projectTag: "second-project",
      lastLaunchedAt: "2026-07-09T03:00:00.000Z"
    }
  ], home, now);
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9227,
    session: "cx-third",
    holderPid: process.pid,
    profileId: "isolated:occupied",
    profileName: "已占用 Profile"
  }, home, now);

  const candidates = findAvailableAgentBrowserProfileCandidatesSync({
    excludedPort: 9223,
    requestedSession: "cc-second"
  }, home, now + 1_000);

  assert.deepEqual(candidates.map((candidate) => candidate.cdpPort), [9224, 9225, 9226]);
  assert.equal(candidates[0].profileName, "项目 Profile");
  assert.equal(candidates[0].alreadyOwnedBySession, false);
  assert.equal(candidates.find((candidate) => candidate.cdpPort === 9225).running, false);
  assert.equal(readAgentBrowserRuntimeProfilesSync(home).profiles.length, 5);

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser Profile candidates reject stale runtime snapshots", () => {
  const home = makeTempHome();
  const now = Date.parse("2026-07-10T00:00:00.000Z");
  writeAgentBrowserRuntimeProfilesSync([
    { profileId: "isolated:one", profileName: "Profile One", cdpPort: 9223 }
  ], home, now);

  assert.deepEqual(findAvailableAgentBrowserProfileCandidatesSync({
    excludedPort: 9224,
    requestedSession: "cx-one"
  }, home, now + 30_001), []);

  rmSync(home, { recursive: true, force: true });
});

function makeTempHome() {
  return path.join(os.tmpdir(), `profilepilot-agent-browser-lease-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function writeGatewayAuthority(home, profiles) {
  const gatewayDir = path.join(home, ".profilepilot", "gateway");
  mkdirSync(gatewayDir, { recursive: true });
  writeFileSync(path.join(gatewayDir, "daemon.pid"), `${process.pid}\n`, "utf8");
  writeFileSync(path.join(gatewayDir, "state.json"), JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    profiles
  }), "utf8");
}
