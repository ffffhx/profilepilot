const assert = require("node:assert/strict");
const { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE,
  PROFILEPILOT_AGENT_BROWSER_LEASE_CONFLICT_EXIT_CODE,
  PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE,
  agentBrowserCommandName,
  cdpPortFromAgentBrowserArgs,
  clearProfilePilotNoticesForSession,
  consumeProfilePilotReturnNotice,
  findActiveProfilePilotNotice,
  formatControlReturnedNotice,
  formatHardStopNotice,
  formatProfileLeaseConflict,
  replaceCdpPortInAgentBrowserArgs,
  resolveRealAgentBrowser,
  runAgentBrowserWrapper,
  sessionFromAgentBrowserArgs,
  shouldCheckProfilePilotNotice
} = require("../dist/main/agent-browser-wrapper.js");
const {
  acquireAgentBrowserProfileLeaseSync,
  findAgentBrowserProfileLeaseForSessionSync,
  readAgentBrowserProfileLeaseSync,
  setAgentBrowserProfileLeasesDelegatedSync,
  writeAgentBrowserRuntimeProfilesSync
} = require("../dist/main/agent-browser-lease.js");
const {
  agentBrowserSessionActivityPaths,
  clearAgentBrowserCommandStateSync,
  readActiveAgentBrowserCommandStateSync,
  readActiveAgentBrowserControlWaitStateSync,
  readActiveAgentBrowserSessionActivityClientsByPort,
  writeAgentBrowserCommandStateSync,
  writeAgentBrowserSessionActivitySync
} = require("../dist/main/agent-browser-session.js");

test("agent-browser wrapper resolves session from args before env", () => {
  assert.equal(sessionFromAgentBrowserArgs(["--session", "cx-arg", "open"], { AGENT_BROWSER_SESSION: "cx-env" }), "cx-arg");
  assert.equal(sessionFromAgentBrowserArgs(["--session=cx-inline", "open"], { AGENT_BROWSER_SESSION: "cx-env" }), "cx-inline");
  assert.equal(sessionFromAgentBrowserArgs(["open"], { AGENT_BROWSER_SESSION: "cx-env" }), "cx-env");
  assert.equal(sessionFromAgentBrowserArgs(["--session", "../bad", "open"], { AGENT_BROWSER_SESSION: "" }), undefined);
});

test("agent-browser wrapper checks notices only for browser operations", () => {
  assert.equal(agentBrowserCommandName(["--cdp", "9223", "open", "https://example.test"]), "open");
  assert.equal(agentBrowserCommandName(["--session=cx-one", "--cdp=9223", "snapshot"]), "snapshot");
  assert.equal(cdpPortFromAgentBrowserArgs(["--cdp", "9223", "open", "https://example.test"]), 9223);
  assert.equal(cdpPortFromAgentBrowserArgs(["--cdp=ws://127.0.0.1:9224/devtools/browser/one", "snapshot"]), 9224);
  assert.equal(cdpPortFromAgentBrowserArgs(["connect", "9225"]), 9225);
  assert.equal(shouldCheckProfilePilotNotice(["--cdp", "9223", "open", "https://example.test"]), true);
  assert.equal(shouldCheckProfilePilotNotice(["skills", "get", "core"]), false);
  assert.equal(shouldCheckProfilePilotNotice(["session", "list"]), false);
  assert.equal(shouldCheckProfilePilotNotice(["--version"]), false);
});

test("agent-browser wrapper rewrites CDP arguments for a user-approved Profile switch", () => {
  assert.deepEqual(
    replaceCdpPortInAgentBrowserArgs(["--cdp", "9223", "snapshot"], 9224),
    ["--cdp", "9224", "snapshot"]
  );
  assert.deepEqual(
    replaceCdpPortInAgentBrowserArgs(["--session=cx-one", "--cdp=9223", "click", "Save"], 9224),
    ["--session=cx-one", "--cdp=9224", "click", "Save"]
  );
  assert.deepEqual(replaceCdpPortInAgentBrowserArgs(["connect", "9223"], 9224), ["connect", "9224"]);
  assert.deepEqual(replaceCdpPortInAgentBrowserArgs(["snapshot"], 9224), ["--cdp", "9224", "snapshot"]);
});

test("agent-browser wrapper skips the managed child-shell launcher when resolving the real CLI", () => {
  const home = makeTempHome();
  const managedLauncher = path.join(home, ".profilepilot", "bin", "agent-browser");
  const realAgentBrowser = path.join(home, "real", "agent-browser");
  mkdirSync(path.dirname(managedLauncher), { recursive: true });
  mkdirSync(path.dirname(realAgentBrowser), { recursive: true });
  writeFileSync(managedLauncher, "#!/bin/sh\nexit 99\n", "utf8");
  writeFileSync(realAgentBrowser, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(managedLauncher, 0o755);
  chmodSync(realAgentBrowser, 0o755);

  const originalPath = process.env.PATH;
  process.env.PATH = `${path.dirname(managedLauncher)}:${path.dirname(realAgentBrowser)}:/usr/bin:/bin`;
  try {
    assert.equal(resolveRealAgentBrowser({
      HOME: home,
      PATH: process.env.PATH,
      PROFILEPILOT_AGENT_BROWSER_LAUNCHER: managedLauncher
    }, path.join(home, "profilepilot-agent-browser-wrapper.cjs")), realAgentBrowser);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(home, { recursive: true, force: true });
  }
});

test("agent-browser session activity files become synthetic ProfilePilot clients", async () => {
  const home = makeTempHome();
  writeAgentBrowserSessionActivitySync({
    session: "cx-one",
    command: "open",
    cdpPort: 9223,
    pid: process.pid,
    cwd: "/tmp/profilepilot",
    daemonPid: process.pid
  }, home, Date.parse("2026-07-09T00:00:00.000Z"));

  const byPort = await readActiveAgentBrowserSessionActivityClientsByPort(
    [9223],
    home,
    Date.parse("2026-07-09T00:05:00.000Z")
  );
  const clients = byPort.get(9223);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].label, "agent-browser");
  assert.equal(clients[0].session, "cx-one");
  assert.equal(clients[0].agent, "Codex");
  assert.equal(clients[0].project, "profilepilot");

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser session activity remains visible after command process exits", async () => {
  const home = makeTempHome();
  writeAgentBrowserSessionActivitySync({
    session: "cx-dead-command",
    command: "get cdp-url",
    cdpPort: 9224,
    pid: 99_999_999,
    cwd: "/tmp/profilepilot"
  }, home, Date.parse("2026-07-09T00:00:00.000Z"));

  const byPort = await readActiveAgentBrowserSessionActivityClientsByPort(
    [9224],
    home,
    Date.parse("2026-07-09T00:05:00.000Z")
  );
  const clients = byPort.get(9224);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].pid, 99_999_999);
  assert.equal(clients[0].label, "agent-browser");
  assert.equal(clients[0].session, "cx-dead-command");
  assert.match(clients[0].note, /按 Session 保持可见化/);

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser command state tracks every parallel command in one Session", () => {
  const home = makeTempHome();
  const startedAt = new Date().toISOString();
  for (const [commandId, command] of [["cmd-one", "snapshot"], ["cmd-two", "click"]]) {
    writeAgentBrowserCommandStateSync({
      commandId,
      session: "cx-parallel",
      command,
      wrapperPid: process.pid,
      phase: "running",
      startedAt
    }, home);
  }

  assert.ok(readActiveAgentBrowserCommandStateSync("cx-parallel", home));
  clearAgentBrowserCommandStateSync("cx-parallel", "cmd-one", home);
  assert.equal(readActiveAgentBrowserCommandStateSync("cx-parallel", home).commandId, "cmd-two");
  clearAgentBrowserCommandStateSync("cx-parallel", "cmd-two", home);
  assert.equal(readActiveAgentBrowserCommandStateSync("cx-parallel", home), null);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper finds active ProfilePilot hard-stop notices", () => {
  const home = makeTempHome();
  const noticePath = path.join(home, ".agent-browser", "cx-one.profilepilot-control.json");
  mkdirSync(path.dirname(noticePath), { recursive: true });
  writeFileSync(
    noticePath,
    `${JSON.stringify({
      version: 1,
      code: "AGENT_USER_IN_CONTROL",
      reason: "user_takeover",
      ownership: "agentDelegatedToUser",
      message: "用户已接管这个 Profile，AI 浏览器命令已暂停",
      action: "停手",
      hardStop: true,
      profileId: "profile-1",
      profileName: "Profile One",
      pid: 101,
      label: "agent-browser",
      session: "cx-one",
      at: "2026-07-09T00:00:00.000Z",
      expiresAt: "2026-07-09T00:30:00.000Z"
    })}\n`
  );

  const match = findActiveProfilePilotNotice(["--cdp", "9223", "open", "https://example.test"], {
    HOME: home,
    AGENT_BROWSER_SESSION: "cx-one"
  }, Date.parse("2026-07-09T00:05:00.000Z"));

  assert.equal(match.path, noticePath);
  assert.equal(match.notice.code, "AGENT_USER_IN_CONTROL");
  assert.match(formatHardStopNotice(match), /"error_code": "AGENT_USER_IN_CONTROL"/);
  assert.equal(PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE, 75);

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper hard-stops while Agent completion is still draining", () => {
  const home = makeTempHome();
  const noticePath = path.join(home, ".agent-browser", "cx-one.profilepilot-control.json");
  mkdirSync(path.dirname(noticePath), { recursive: true });
  writeFileSync(
    noticePath,
    `${JSON.stringify({
      version: 1,
      code: "AGENT_USER_IN_CONTROL",
      reason: "agent_complete",
      ownership: "agentDelegatedToUser",
      handoffState: "requested",
      message: "Agent 已完成当前任务，浏览器控制权已交还用户",
      action: "等待用户交还",
      hardStop: true,
      profileId: "profile-1",
      profileName: "Profile One",
      pid: 101,
      label: "agent-browser",
      session: "cx-one",
      at: "2026-07-09T00:00:00.000Z",
      expiresAt: "9999-12-31T23:59:59.999Z"
    })}\n`
  );

  const match = findActiveProfilePilotNotice(["snapshot"], {
    HOME: home,
    AGENT_BROWSER_SESSION: "cx-one"
  }, Date.parse("2099-07-10T08:00:00.000Z"));

  assert.equal(match.notice.reason, "agent_complete");
  assert.equal(match.notice.ownership, "agentDelegatedToUser");
  assert.match(formatHardStopNotice(match), /"reason": "agent_complete"/);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper surfaces a takeover created while the real command is running", async () => {
  const home = makeTempHome();
  mkdirSync(home, { recursive: true });
  const fakeAgentBrowser = path.join(home, "fake-agent-browser.js");
  writeFileSync(
    fakeAgentBrowser,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const session = process.env.AGENT_BROWSER_SESSION;
const noticePath = path.join(process.env.HOME, ".agent-browser", session + ".profilepilot-control.json");
fs.mkdirSync(path.dirname(noticePath), { recursive: true });
fs.writeFileSync(noticePath, JSON.stringify({
  version: 1,
  controlVersion: 1,
  code: "AGENT_USER_IN_CONTROL",
  reason: "user_takeover",
  ownership: "agentDelegatedToUser",
  handoffState: "requested",
  message: "用户已接管这个 Profile，AI 浏览器命令已暂停",
  hardStop: true,
  profileId: "profile-1",
  profileName: "Profile One",
  pid: process.pid,
  label: "agent-browser",
  session,
  at: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString()
}) + "\\n");
`
  );
  chmodSync(fakeAgentBrowser, 0o755);
  const writes = captureProcessWrites();
  try {
    const exitCode = await runAgentBrowserWrapper(["open", "https://example.test"], {
      ...process.env,
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-one",
      PROFILEPILOT_AGENT_BROWSER_REAL: fakeAgentBrowser
    });
    assert.equal(exitCode, PROFILEPILOT_AGENT_BROWSER_HARD_STOP_EXIT_CODE);
  } finally {
    writes.restore();
  }
  assert.match(writes.stderr.join(""), /"error_code": "AGENT_USER_IN_CONTROL"/);
  const settledNotice = JSON.parse(readFileSync(
    path.join(home, ".agent-browser", "cx-one.profilepilot-control.json"),
    "utf8"
  ));
  assert.equal(settledNotice.handoffState, "quiesced");
  assert.equal(settledNotice.controlVersion, 2);
  assert.equal(readActiveAgentBrowserCommandStateSync("cx-one", home), null);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper completion releases the Session and Profile lease", async () => {
  const home = makeTempHome();
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-complete",
    holderPid: process.pid,
    profileId: "profile-1",
    profileName: "Profile One",
    project: "profilepilot",
    command: "snapshot"
  }, home);
  writeAgentBrowserSessionActivitySync({
    session: "cx-complete",
    command: "snapshot",
    cdpPort: 9223,
    pid: process.pid,
    cwd: "/tmp/profilepilot"
  }, home);

  const writes = captureProcessWrites();
  let exitCode;
  try {
    exitCode = await runAgentBrowserWrapper(["profilepilot", "complete"], {
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-complete"
    });
  } finally {
    writes.restore();
  }

  assert.equal(exitCode, 0);
  assert.match(writes.stdout.join(""), /"ownership": "user"/);
  assert.match(writes.stdout.join(""), /"released_ports": \[/);
  assert.match(writes.stdout.join(""), /Session 和 Profile 租约已释放/);
  assert.equal(readAgentBrowserProfileLeaseSync(9223, home), null);
  assert.equal(agentBrowserSessionActivityPaths(home, "cx-complete").some((file) => existsSync(file)), false);
  assert.equal(existsSync(path.join(home, ".profilepilot", "agent-control", "cx-complete.json")), false);
  assert.equal(existsSync(path.join(home, ".agent-browser", "cx-complete.profilepilot-control.json")), false);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper requires an explicit reason for handoff", async () => {
  const home = makeTempHome();
  const writes = captureProcessWrites();
  let exitCode;
  try {
    exitCode = await runAgentBrowserWrapper(["profilepilot", "handoff"], {
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-handoff"
    });
  } finally {
    writes.restore();
  }

  assert.equal(exitCode, PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE);
  assert.match(writes.stderr.join(""), /handoff 必须通过 --reason/);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper requires an absolute validated unpacked extension path", async () => {
  const home = makeTempHome();
  const writes = captureProcessWrites();
  let exitCode;
  try {
    exitCode = await runAgentBrowserWrapper([
      "--cdp",
      "9223",
      "profilepilot",
      "extension",
      "load-unpacked",
      "relative/extension"
    ], {
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-extension"
    });
  } finally {
    writes.restore();
  }

  assert.equal(exitCode, PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE);
  assert.match(writes.stderr.join(""), /"error_code": "EXTENSION_PATH_MUST_BE_ABSOLUTE"/);
  assert.equal(readAgentBrowserProfileLeaseSync(9223, home), null);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper waits for the durable user-return event", async () => {
  const home = makeTempHome();
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-wait",
    holderPid: process.pid,
    profileId: "profile-1",
    profileName: "Profile One",
    command: "snapshot"
  }, home);
  setAgentBrowserProfileLeasesDelegatedSync("cx-wait", true, home);
  const noticePath = path.join(home, ".profilepilot", "agent-control", "cx-wait.json");
  const mirrorPath = path.join(home, ".agent-browser", "cx-wait.profilepilot-control.json");
  const takeoverNotice = {
    version: 1,
    controlVersion: 1,
    code: "AGENT_USER_IN_CONTROL",
    reason: "user_takeover",
    ownership: "agentDelegatedToUser",
    handoffState: "quiesced",
    message: "用户已接管",
    action: "等待用户交还",
    hardStop: true,
    profileId: "profile-1",
    profileName: "Profile One",
    pid: process.pid,
    label: "agent-browser",
    session: "cx-wait",
    at: new Date().toISOString(),
    expiresAt: "9999-12-31T23:59:59.999Z"
  };
  for (const filePath of [noticePath, mirrorPath]) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(takeoverNotice)}\n`);
  }

  const writes = captureProcessWrites();
  let exitCode;
  try {
    let settled = false;
    const waiting = runAgentBrowserWrapper(["profilepilot", "wait-control"], {
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-wait"
    });
    waiting.finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(settled, false, "wait-control must not have an implicit business timeout");
    assert.equal(readActiveAgentBrowserControlWaitStateSync("cx-wait", home)?.pid, process.pid);
    setAgentBrowserProfileLeasesDelegatedSync("cx-wait", false, home);
    const returned = {
      ...takeoverNotice,
      controlVersion: 2,
      code: "AGENT_CONTROL_RETURNED",
      reason: "user_return",
      ownership: "agent",
      hardStop: false,
      message: "用户已将浏览器控制权交还 Agent",
      action: "重新 snapshot 后继续",
      at: new Date().toISOString()
    };
    delete returned.handoffState;
    for (const filePath of [noticePath, mirrorPath]) {
      writeFileSync(filePath, `${JSON.stringify(returned)}\n`);
    }
    exitCode = await waiting;
  } finally {
    writes.restore();
  }

  assert.equal(exitCode, 0);
  assert.match(writes.stdout.join(""), /"event_code": "AGENT_CONTROL_RETURNED"/);
  assert.equal(existsSync(noticePath), false);
  assert.equal(existsSync(mirrorPath), false);
  assert.equal(readActiveAgentBrowserControlWaitStateSync("cx-wait", home), null);
  assert.equal(readAgentBrowserProfileLeaseSync(9223, home).delegatedToUser, undefined);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper can clear ProfilePilot notices for explicit resume", async () => {
  const home = makeTempHome();
  const noticePath = path.join(home, ".agent-browser", "cx-one.profilepilot-control.json");
  const mirrorPath = path.join(home, ".profilepilot", "agent-control", "cx-one.json");
  mkdirSync(path.dirname(noticePath), { recursive: true });
  mkdirSync(path.dirname(mirrorPath), { recursive: true });
  writeFileSync(noticePath, "{}\n");
  writeFileSync(mirrorPath, "{}\n");

  const cleared = clearProfilePilotNoticesForSession("cx-one", home);
  assert.deepEqual(cleared, [noticePath, mirrorPath]);
  assert.equal(findActiveProfilePilotNotice(["open", "https://example.test"], { HOME: home, AGENT_BROWSER_SESSION: "cx-one" }), null);
  writeAgentBrowserSessionActivitySync({
    session: "cx-one",
    command: "snapshot",
    cdpPort: 9223,
    pid: process.pid,
    cwd: "/tmp/profilepilot"
  }, home);
  const writes = captureProcessWrites();
  try {
    assert.equal(await runAgentBrowserWrapper(["profilepilot", "resume"], { HOME: home, AGENT_BROWSER_SESSION: "cx-one" }), 0);
    assert.equal(await runAgentBrowserWrapper(["profilepilot", "resume"], { HOME: home }), PROFILEPILOT_AGENT_BROWSER_USAGE_EXIT_CODE);
  } finally {
    writes.restore();
  }
  assert.match(writes.stdout.join(""), /"action": "resume"/);
  assert.match(writes.stderr.join(""), /找不到 AGENT_BROWSER_SESSION/);

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper explicitly releases its Session and Profile lease", async () => {
  const home = makeTempHome();
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-one",
    holderPid: process.pid,
    profileId: "profile-1",
    profileName: "Profile One",
    project: "profilepilot",
    command: "snapshot"
  }, home);
  writeAgentBrowserSessionActivitySync({
    session: "cx-one",
    command: "snapshot",
    cdpPort: 9223,
    pid: process.pid,
    cwd: "/tmp/profilepilot"
  }, home);
  const completionNoticePath = path.join(home, ".agent-browser", "cx-one.profilepilot-control.json");
  mkdirSync(path.dirname(completionNoticePath), { recursive: true });
  writeFileSync(completionNoticePath, `${JSON.stringify({ reason: "agent_complete" })}\n`);
  assert.ok(agentBrowserSessionActivityPaths(home, "cx-one").some((file) => existsSync(file)));

  const writes = captureProcessWrites();
  let exitCode;
  try {
    exitCode = await runAgentBrowserWrapper(["profilepilot", "release"], {
      HOME: home,
      AGENT_BROWSER_SESSION: "cx-one"
    });
  } finally {
    writes.restore();
  }

  assert.equal(exitCode, 0);
  assert.match(writes.stdout.join(""), /"action": "release"/);
  assert.match(writes.stdout.join(""), /"ownership": "user"/);
  assert.match(writes.stdout.join(""), /"clearedNotices"/);
  assert.equal(findAgentBrowserProfileLeaseForSessionSync("cx-one", home), null);
  assert.equal(agentBrowserSessionActivityPaths(home, "cx-one").some((file) => existsSync(file)), false);
  assert.equal(existsSync(completionNoticePath), false);
  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper consumes and reports a user-return notice without hard-stopping", () => {
  const home = makeTempHome();
  const noticePath = path.join(home, ".agent-browser", "cx-one.profilepilot-control.json");
  const mirrorPath = path.join(home, ".profilepilot", "agent-control", "cx-one.json");
  const notice = {
    version: 1,
    code: "AGENT_CONTROL_RETURNED",
    reason: "user_return",
    ownership: "agent",
    message: "用户已将这个 Profile 的浏览器控制权交还 Agent",
    action: "先重新读取页面状态，再继续任务",
    hardStop: false,
    profileId: "profile-1",
    profileName: "Profile One",
    pid: 101,
    label: "agent-browser",
    session: "cx-one",
    at: "2026-07-09T00:10:00.000Z",
    expiresAt: "2026-07-09T00:30:00.000Z"
  };
  mkdirSync(path.dirname(noticePath), { recursive: true });
  mkdirSync(path.dirname(mirrorPath), { recursive: true });
  writeFileSync(noticePath, `${JSON.stringify(notice)}\n`);
  writeFileSync(mirrorPath, `${JSON.stringify(notice)}\n`);

  const match = consumeProfilePilotReturnNotice(
    ["--cdp", "9223", "snapshot"],
    { HOME: home, AGENT_BROWSER_SESSION: "cx-one" },
    Date.parse("2026-07-09T00:11:00.000Z")
  );

  assert.equal(match.notice.code, "AGENT_CONTROL_RETURNED");
  assert.match(formatControlReturnedNotice(match), /"hard_stop": false/);
  assert.match(formatControlReturnedNotice(match), /"event_code": "AGENT_CONTROL_RETURNED"/);
  assert.equal(
    consumeProfilePilotReturnNotice(
      ["snapshot"],
      { HOME: home, AGENT_BROWSER_SESSION: "cx-one" },
      Date.parse("2026-07-09T00:11:00.000Z")
    ),
    null
  );
  assert.equal(findActiveProfilePilotNotice(["snapshot"], { HOME: home, AGENT_BROWSER_SESSION: "cx-one" }), null);

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper ignores expired notices", () => {
  const home = makeTempHome();
  const noticePath = path.join(home, ".profilepilot", "agent-control", "cx-one.json");
  mkdirSync(path.dirname(noticePath), { recursive: true });
  writeFileSync(
    noticePath,
    `${JSON.stringify({
      version: 1,
      code: "AGENT_TASK_STOPPED",
      reason: "user_stop",
      ownership: "user",
      message: "用户已终止这个 Profile 的 AI 浏览器任务",
      hardStop: true,
      profileId: "profile-1",
      profileName: "Profile One",
      pid: 101,
      label: "agent-browser",
      session: "cx-one",
      at: "2026-07-09T00:00:00.000Z",
      expiresAt: "2026-07-09T00:30:00.000Z"
    })}\n`
  );

  assert.equal(
    findActiveProfilePilotNotice(["open", "https://example.test"], { HOME: home, AGENT_BROWSER_SESSION: "cx-one" }, Date.parse("2026-07-09T00:31:00.000Z")),
    null
  );

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper blocks a second Session even when the command omits --cdp", async () => {
  const home = makeTempHome();
  writeAgentBrowserRuntimeProfilesSync([
    {
      profileId: "isolated:work",
      profileName: "工作 Profile",
      cdpPort: 9223,
      projectTag: "first-project"
    },
    {
      profileId: "isolated:alternative",
      profileName: "备用 Profile",
      cdpPort: 9224,
      projectTag: "second-project",
      running: false
    }
  ], home);
  acquireAgentBrowserProfileLeaseSync({
    cdpPort: 9223,
    session: "cx-owner",
    holderPid: process.pid,
    profileId: "isolated:work",
    profileName: "工作 Profile",
    project: "first-project",
    command: "open"
  }, home);
  writeAgentBrowserSessionActivitySync({
    session: "cc-second",
    command: "connect",
    cdpPort: 9223,
    pid: process.pid,
    cwd: "/tmp/second-project"
  }, home);

  const writes = captureProcessWrites();
  let exitCode;
  try {
    exitCode = await runAgentBrowserWrapper(["snapshot"], {
      HOME: home,
      PWD: "/tmp/second-project",
      AGENT_BROWSER_SESSION: "cc-second"
    });
  } finally {
    writes.restore();
  }

  assert.equal(exitCode, PROFILEPILOT_AGENT_BROWSER_LEASE_CONFLICT_EXIT_CODE);
  assert.equal(exitCode, 75);
  assert.match(writes.stderr.join(""), /"error_code": "PROFILE_ALREADY_IN_USE"/);
  assert.match(writes.stderr.join(""), /"hard_stop": true/);
  assert.match(writes.stderr.join(""), /"blocked_profile_hard_stop": true/);
  assert.match(writes.stderr.join(""), /"retryable_with_alternative_profile": true/);
  assert.match(writes.stderr.join(""), /"requires_user_confirmation": true/);
  assert.match(writes.stderr.join(""), /"owner_session": "cx-owner"/);
  assert.match(writes.stderr.join(""), /工作 Profile/);
  assert.match(writes.stderr.join(""), /"auto_switch_allowed": false/);
  assert.match(writes.stderr.join(""), /"recommended_profile_name": "备用 Profile"/);
  assert.match(writes.stderr.join(""), /"recommended_cdp_port": 9224/);
  assert.match(writes.stderr.join(""), /"recommended_command": "agent-browser --cdp 9224 snapshot"/);
  assert.match(writes.stderr.join(""), /"requires_start": true/);
  assert.match(writes.stderr.join(""), /先告知用户当前占用情况，并征得同意/);
  assert.match(writes.stderr.join(""), /Gateway 启动并连接/);
  assert.match(writes.stderr.join(""), /"available_candidate_count": 1/);

  rmSync(home, { recursive: true, force: true });
});

test("agent-browser wrapper hard-stops when no available alternative Profile exists", () => {
  const home = makeTempHome();
  const output = formatProfileLeaseConflict({
    version: 1,
    cdpPort: 9223,
    profileId: "isolated:work",
    profileName: "工作 Profile",
    session: "cx-owner",
    holderPid: process.pid,
    acquiredAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    expiresAt: "2026-07-10T00:30:00.000Z"
  }, "cc-second", ["snapshot"], { HOME: home });

  assert.match(output, /"hard_stop": true/);
  assert.match(output, /"retryable_with_alternative_profile": false/);
  assert.match(output, /"requires_user_confirmation": false/);
  assert.match(output, /"auto_switch_allowed": false/);
  assert.match(output, /"recommended_command": null/);

  rmSync(home, { recursive: true, force: true });
});

function makeTempHome() {
  return path.join(os.tmpdir(), `profilepilot-agent-browser-wrapper-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function captureProcessWrites() {
  const stdout = [];
  const stderr = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = (chunk, ...args) => {
    stdout.push(String(chunk));
    return originalStdoutWrite.call(process.stdout, chunk, ...args);
  };
  process.stderr.write = (chunk, ...args) => {
    stderr.push(String(chunk));
    return originalStderrWrite.call(process.stderr, chunk, ...args);
  };
  return {
    stdout,
    stderr,
    restore() {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  };
}
