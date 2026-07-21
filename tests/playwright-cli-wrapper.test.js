const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE,
  defaultProfilePilotPlaywrightSession,
  ensurePlaywrightCliSessionArg,
  parsePlaywrightCliInvocation,
  playwrightCliSessionStatePath,
  readPlaywrightCliSessionState,
  resolveRealPlaywrightCli,
  rewritePlaywrightCliAttachArgs,
  runPlaywrightCliWrapper,
  sessionFromPlaywrightCliArgs,
  writePlaywrightCliSessionState
} = require("../dist/main/playwright-cli-wrapper.js");

test("Playwright CLI wrapper parses supported session and CDP syntaxes", () => {
  assert.deepEqual(parsePlaywrightCliInvocation([
    "-s=auth",
    "attach",
    "--cdp=http://localhost:9223"
  ]), {
    command: "attach",
    commandIndex: 1,
    explicitSession: "auth",
    cdpEndpoint: "http://localhost:9223",
    cdpPort: 9223
  });
  assert.equal(
    parsePlaywrightCliInvocation(["--session", "cx-one", "attach", "--cdp", "ws://[::1]:9224/devtools/browser/one"]).cdpPort,
    9224
  );
  assert.equal(parsePlaywrightCliInvocation(["attach", "--cdp=chrome"]).cdpPort, undefined);
  assert.equal(sessionFromPlaywrightCliArgs(["--s=cli", "snapshot"], { PLAYWRIGHT_CLI_SESSION: "env" }), "cli");
  assert.equal(sessionFromPlaywrightCliArgs(["snapshot"], { PLAYWRIGHT_CLI_SESSION: "env" }), "env");
});

test("Playwright CLI wrapper rewrites a managed attach without leaking the logical CDP endpoint", () => {
  const endpoint = "ws://127.0.0.1:9223/devtools/browser/gateway?ticket=one";
  assert.deepEqual(rewritePlaywrightCliAttachArgs([
    "--raw",
    "-s", "old",
    "attach",
    "--cdp", "http://127.0.0.1:9223"
  ], "cx-one", endpoint), [
    "-s=cx-one",
    "--raw",
    "attach",
    "--cdp", endpoint
  ]);
  assert.deepEqual(
    ensurePlaywrightCliSessionArg(["--session=old", "snapshot"], "cx-new"),
    ["-s=cx-new", "snapshot"]
  );
});

test("Playwright CLI state is stable per workspace and persisted atomically", () => {
  const home = makeTempDir();
  try {
    const session = defaultProfilePilotPlaywrightSession("/work/one");
    assert.equal(session, defaultProfilePilotPlaywrightSession("/work/one"));
    assert.notEqual(session, defaultProfilePilotPlaywrightSession("/work/two"));
    const state = makeState({ playwrightSession: session, cwd: "/work/one" });
    writePlaywrightCliSessionState(state, home);
    assert.deepEqual(readPlaywrightCliSessionState(session, "/work/one", home), state);
    assert.equal(readPlaywrightCliSessionState(session, "/work/two", home), null);
    assert.match(playwrightCliSessionStatePath(session, "/work/one", home), /\.profilepilot\/playwright-cli\//);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Playwright CLI wrapper resolves the real CLI while skipping its managed launcher", () => {
  const home = makeTempDir();
  try {
    const managedDir = path.join(home, "managed");
    const realDir = path.join(home, "real");
    const managed = executable(path.join(managedDir, "playwright-cli"));
    const real = executable(path.join(realDir, "playwright-cli"));
    assert.deepEqual(resolveRealPlaywrightCli({
      HOME: home,
      PATH: `${managedDir}${path.delimiter}${realDir}`,
      PROFILEPILOT_PLAYWRIGHT_CLI_LAUNCHER: managed
    }, managed), { executable: real });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bundled Playwright wrapper does not execute the embedded agent-browser entrypoint", () => {
  const home = makeTempDir();
  try {
    const playwright = executable(
      path.join(home, "playwright-cli"),
      "#!/bin/sh\nprintf 'PLAYWRIGHT_ONLY\\n'\n"
    );
    const agentBrowser = executable(
      path.join(home, "agent-browser"),
      "#!/bin/sh\nprintf 'UNEXPECTED_AGENT_BROWSER\\n'\n"
    );
    const result = spawnSync(process.execPath, [
      path.join(__dirname, "..", "dist", "main", "profilepilot-playwright-cli-wrapper.cjs"),
      "--version"
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PROFILEPILOT_PLAYWRIGHT_CLI_REAL: playwright,
        PROFILEPILOT_AGENT_BROWSER_REAL: agentBrowser
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "PLAYWRIGHT_ONLY\n");
    assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_AGENT_BROWSER/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed Playwright attach acquires a ticket, records driver identity, and persists the daemon", async () => {
  const home = makeTempDir();
  const requests = [];
  const runs = [];
  try {
    const request = async (value) => {
      requests.push(value);
      if (value.action === "status") return gatewayStatus(profile({ sessionStatus: "stopped" }));
      if (value.action === "acquire") {
        const count = requests.filter((item) => item.action === "acquire").length;
        return {
          ok: true,
          webSocketUrl: `ws://127.0.0.1:9223/devtools/browser/gateway?ticket=${count}`,
          connectionActive: count >= 2
        };
      }
      throw new Error(`Unexpected request ${value.action}`);
    };
    const exitCode = await runPlaywrightCliWrapper([
      "attach",
      "--cdp=http://127.0.0.1:9223"
    ], {
      HOME: home,
      PWD: "/work/profilepilot",
      PROFILEPILOT_SESSION: "cx-ticket"
    }, {
      command: { executable: "/real/playwright-cli" },
      request,
      discoverDaemonPid: () => 4242,
      run: async (_command, args, _env, options) => {
        runs.push({ args, options });
        return spawnResult();
      }
    });

    assert.equal(exitCode, 0);
    assert.equal(runs.length, 1);
    assert.match(runs[0].args[0], /^-s=pw-/);
    assert.match(runs[0].args.join(" "), /ticket=1/);
    assert.doesNotMatch(runs[0].args.join(" "), /--cdp=http:\/\/127\.0\.0\.1:9223/);
    const acquire = requests.find((item) => item.action === "acquire");
    assert.equal(acquire.driverKind, "playwright-cli");
    assert.equal(acquire.driverLabel, "Playwright CLI");
    assert.equal(acquire.sessionId, "cx-ticket");
    const cliSession = runs[0].args[0].slice("-s=".length);
    const state = readPlaywrightCliSessionState(cliSession, "/work/profilepilot", home);
    assert.equal(state.publicPort, 9223);
    assert.equal(state.gatewaySessionId, "cx-ticket");
    assert.equal(state.daemonPid, 4242);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed Playwright attach starts a configured Profile that is not running yet", async () => {
  const home = makeTempDir();
  const dataDir = path.join(home, "profilepilot-data");
  const requests = [];
  let ensureCalls = 0;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, "profiles.json"), JSON.stringify({
      profiles: [{
        id: "work",
        name: "Work Profile",
        dirName: "work-profile",
        fixedCdpPort: 9223
      }]
    }));
    const request = async (value) => {
      requests.push(value);
      if (value.action === "status") return gatewayStatus();
      if (value.action === "acquire") {
        const count = requests.filter((item) => item.action === "acquire").length;
        return {
          ok: true,
          webSocketUrl: `ws://127.0.0.1:9223/devtools/browser/gateway?ticket=auto-${count}`,
          connectionActive: count >= 2
        };
      }
      throw new Error(`Unexpected request ${value.action}`);
    };
    const exitCode = await runPlaywrightCliWrapper([
      "attach",
      "--cdp=http://127.0.0.1:9223"
    ], {
      HOME: home,
      CPM_DATA_DIR: dataDir,
      PWD: "/work/profilepilot",
      PROFILEPILOT_SESSION: "cx-auto-start"
    }, {
      command: { executable: "/real/playwright-cli" },
      request,
      ensureProfileRunning: async (publicPort, status, env, receivedHome) => {
        ensureCalls += 1;
        assert.equal(publicPort, 9223);
        assert.deepEqual(status, gatewayStatus());
        assert.equal(env.CPM_DATA_DIR, dataDir);
        assert.equal(receivedHome, home);
        return gatewayStatus(profile({ sessionStatus: "stopped" }));
      },
      discoverDaemonPid: () => 4242,
      run: async () => spawnResult()
    });

    assert.equal(exitCode, 0);
    assert.equal(ensureCalls, 1);
    assert.ok(requests.some((item) => item.action === "acquire" && item.driverKind === "playwright-cli"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed Playwright attach refuses an old Gateway that cannot preserve handoff", async () => {
  const home = makeTempDir();
  let runCount = 0;
  try {
    const captured = await captureStderr(() => runPlaywrightCliWrapper([
      "attach",
      "--cdp=http://127.0.0.1:9223"
    ], {
      HOME: home,
      PWD: "/work/profilepilot",
      PROFILEPILOT_SESSION: "cx-old-gateway"
    }, {
      command: { executable: "/real/playwright-cli" },
      request: async () => ({
        ...gatewayStatus(profile()),
        protocolVersion: 7
      }),
      ensureGatewayDaemon: async () => ({
        ok: true,
        protocolVersion: 7,
        protocolUpgradeDeferred: true,
        ports: [9223]
      }),
      run: async () => {
        runCount += 1;
        return spawnResult();
      }
    }));

    assert.equal(captured.value, PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE);
    assert.equal(runCount, 0);
    assert.match(captured.stderr, /GATEWAY_PROTOCOL_INCOMPATIBLE/);
    assert.match(captured.stderr, /v7/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Playwright CLI wrapper hard-stops without spawning while the user owns the Profile", async () => {
  const home = makeTempDir();
  const state = makeState();
  let runCount = 0;
  try {
    writePlaywrightCliSessionState(state, home);
    const output = await captureStderr(() => runPlaywrightCliWrapper([
      `-s=${state.playwrightSession}`,
      "snapshot"
    ], {
      HOME: home,
      PWD: state.cwd
    }, {
      command: { executable: "/real/playwright-cli" },
      request: async () => gatewayStatus(profile({
        ownerSessionId: state.gatewaySessionId,
        ownership: "user",
        sessionStatus: "active",
        pendingUserAction: "完成验证码"
      })),
      run: async () => {
        runCount += 1;
        return spawnResult();
      }
    }));
    assert.equal(output.value, PROFILEPILOT_PLAYWRIGHT_CLI_HARD_STOP_EXIT_CODE);
    assert.equal(runCount, 0);
    assert.match(output.stderr, /AGENT_USER_IN_CONTROL/);
    assert.match(output.stderr, /不要重试/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Playwright CLI wrapper automatically reattaches after Return to Agent", async () => {
  const home = makeTempDir();
  const state = makeState();
  const requests = [];
  const runs = [];
  try {
    writePlaywrightCliSessionState(state, home);
    const request = async (value) => {
      requests.push(value);
      if (value.action === "status") {
        return gatewayStatus(profile({
          ownerSessionId: state.gatewaySessionId,
          ownership: "agent",
          sessionStatus: "active",
          connectionActive: false
        }));
      }
      if (value.action === "acquire") {
        const count = requests.filter((item) => item.action === "acquire").length;
        return {
          ok: true,
          webSocketUrl: `ws://127.0.0.1:9223/devtools/browser/gateway?ticket=reconnect-${count}`,
          connectionActive: count >= 2
        };
      }
      throw new Error(`Unexpected request ${value.action}`);
    };
    const captured = await captureStderr(() => runPlaywrightCliWrapper([
      `-s=${state.playwrightSession}`,
      "snapshot"
    ], {
      HOME: home,
      PWD: state.cwd
    }, {
      command: { executable: "/real/playwright-cli" },
      request,
      run: async (_command, args, _env, options) => {
        runs.push({ args, options });
        if (args.includes("attach")) return spawnResult({ stdout: JSON.stringify({ pid: 5151 }) });
        return spawnResult({ stdout: "snapshot" });
      }
    }));

    assert.equal(captured.value, 0);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[0].args.slice(0, 3), [`-s=${state.playwrightSession}`, "--json", "attach"]);
    assert.equal(runs[0].options.forwardOutput, false);
    assert.deepEqual(runs[1].args, [`-s=${state.playwrightSession}`, "snapshot"]);
    assert.match(captured.stderr, /已自动重连/);
    assert.equal(readPlaywrightCliSessionState(state.playwrightSession, state.cwd, home).daemonPid, 5151);
    assert.ok(requests.some((item) => item.action === "acquire" && item.driverKind === "playwright-cli"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Playwright close releases Gateway control even during user takeover", async () => {
  const home = makeTempDir();
  const state = makeState();
  const requests = [];
  try {
    writePlaywrightCliSessionState(state, home);
    const exitCode = await runPlaywrightCliWrapper([
      `-s=${state.playwrightSession}`,
      "close"
    ], {
      HOME: home,
      PWD: state.cwd
    }, {
      command: { executable: "/real/playwright-cli" },
      request: async (value) => {
        requests.push(value);
        if (value.action === "status") return gatewayStatus(profile({
          ownerSessionId: state.gatewaySessionId,
          ownership: "user",
          sessionStatus: "active"
        }));
        if (value.action === "control") return { ok: true };
        throw new Error(`Unexpected request ${value.action}`);
      },
      run: async (_command, args) => {
        assert.deepEqual(args, [`-s=${state.playwrightSession}`, "close"]);
        return spawnResult();
      }
    });

    assert.equal(exitCode, 0);
    assert.ok(requests.some((item) => item.action === "control" && item.command === "stop"));
    assert.equal(readPlaywrightCliSessionState(state.playwrightSession, state.cwd, home), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ordinary Playwright CDP attach remains transparent when the port is not Gateway-managed", async () => {
  const home = makeTempDir();
  const args = ["-s=legacy", "attach", "--cdp=http://127.0.0.1:9333"];
  let seenArgs;
  try {
    const exitCode = await runPlaywrightCliWrapper(args, {
      HOME: home,
      PWD: "/work/legacy"
    }, {
      command: { executable: "/real/playwright-cli" },
      request: async () => gatewayStatus(),
      run: async (_command, value) => {
        seenArgs = value;
        return spawnResult({ status: 23 });
      }
    });
    assert.equal(exitCode, 23);
    assert.deepEqual(seenArgs, args);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ordinary Playwright sessions outside Gateway retain Playwright's own name handling", async () => {
  const home = makeTempDir();
  const args = ["-s=not/profilepilot", "snapshot"];
  let seenArgs;
  try {
    const exitCode = await runPlaywrightCliWrapper(args, {
      HOME: home,
      PWD: "/work/legacy"
    }, {
      command: { executable: "/real/playwright-cli" },
      run: async (_command, value) => {
        seenArgs = value;
        return spawnResult();
      }
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(seenArgs, args);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function gatewayStatus(...profiles) {
  return { ok: true, state: { version: 1, profiles } };
}

function profile(overrides = {}) {
  return {
    publicPort: 9223,
    profileId: "profile-one",
    profileName: "Profile One",
    ownership: "user",
    sessionStatus: "stopped",
    connectionActive: false,
    ...overrides
  };
}

function makeState(overrides = {}) {
  return {
    version: 1,
    playwrightSession: "pw-test",
    gatewaySessionId: "cx-test",
    publicPort: 9223,
    daemonInstanceId: "daemon-test",
    daemonPid: 3131,
    cwd: "/work/profilepilot",
    updatedAt: "2026-07-17T00:00:00.000Z",
    ...overrides
  };
}

function spawnResult(overrides = {}) {
  return {
    status: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...overrides
  };
}

async function captureStderr(callback) {
  const original = process.stderr.write;
  let stderr = "";
  process.stderr.write = (chunk, ...rest) => {
    stderr += String(chunk);
    const completion = rest.find((value) => typeof value === "function");
    if (completion) completion();
    return true;
  };
  try {
    return { value: await callback(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "profilepilot-playwright-cli-"));
}

function executable(filePath, content = "#!/bin/sh\nexit 0\n") {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
  return filePath;
}
