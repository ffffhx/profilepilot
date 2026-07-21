const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createGatewayChromeDevtoolsMcpEndpointProvider,
  parseChromeDevtoolsMcpProfilePilotConfig,
  prepareChromeDevtoolsMcpLaunchArgs,
  resolveRealChromeDevtoolsMcp,
  rewriteChromeDevtoolsMcpWebSocketArgs,
  runChromeDevtoolsMcpWrapper
} = require("../dist/main/chrome-devtools-mcp-wrapper.js");

test("Chrome DevTools MCP wrapper parses CLI config before env and strips only wrapper options", () => {
  const config = parseChromeDevtoolsMcpProfilePilotConfig([
    "--profilepilot-port", "9224",
    "--headless",
    "--profilepilot-session=cx-cli",
    "--logFile", "/tmp/mcp.log"
  ], {
    PROFILEPILOT_PORT: "9223",
    PROFILEPILOT_SESSION: "cx-env"
  });

  assert.deepEqual(config, {
    enabled: true,
    publicPort: 9224,
    sessionId: "cx-cli",
    passthroughArgs: ["--headless", "--logFile", "/tmp/mcp.log"]
  });
});

test("Chrome DevTools MCP wrapper accepts tool-specific and generic env config", () => {
  assert.deepEqual(parseChromeDevtoolsMcpProfilePilotConfig(["--headless"], {
    PROFILEPILOT_CHROME_DEVTOOLS_MCP_PORT: "9333",
    PROFILEPILOT_CHROME_DEVTOOLS_MCP_SESSION: "cc-browser"
  }), {
    enabled: true,
    publicPort: 9333,
    sessionId: "cc-browser",
    passthroughArgs: ["--headless"]
  });

  const ordinaryArgs = ["--headless", "--isolated"];
  const ordinary = parseChromeDevtoolsMcpProfilePilotConfig(ordinaryArgs, {
    PROFILEPILOT_SESSION: "cx-shell-only",
    CODEX_THREAD_ID: "thread-only"
  });
  assert.equal(ordinary.enabled, false);
  assert.equal(ordinary.passthroughArgs, ordinaryArgs);

  assert.deepEqual(parseChromeDevtoolsMcpProfilePilotConfig([], {
    PROFILEPILOT_PORT: "9223",
    CODEX_THREAD_ID: "thread-one"
  }), {
    enabled: true,
    publicPort: 9223,
    sessionId: "cx-thread-one",
    passthroughArgs: []
  });
});

test("Chrome DevTools MCP wrapper treats arguments after -- as MCP arguments", () => {
  const args = ["--", "--profilepilot-port", "9223", "--profilepilot-session", "cx-literal"];
  assert.deepEqual(parseChromeDevtoolsMcpProfilePilotConfig(args, {}), {
    enabled: false,
    passthroughArgs: args
  });
});

test("Chrome DevTools MCP wrapper rejects incomplete or unsafe ProfilePilot config", () => {
  assert.throws(
    () => parseChromeDevtoolsMcpProfilePilotConfig(["--profilepilot-port=9223"], {}),
    (error) => error.code === "PROFILEPILOT_INCOMPLETE_CONFIG"
  );
  assert.throws(
    () => parseChromeDevtoolsMcpProfilePilotConfig([
      "--profilepilot-port=",
      "--profilepilot-session=cx-one"
    ], {
      PROFILEPILOT_PORT: "9223"
    }),
    (error) => error.code === "PROFILEPILOT_INVALID_ARGUMENT"
  );
  assert.throws(
    () => parseChromeDevtoolsMcpProfilePilotConfig([], {
      PROFILEPILOT_PORT: "70000",
      PROFILEPILOT_SESSION: "cx-one"
    }),
    (error) => error.code === "PROFILEPILOT_INVALID_PORT"
  );
  assert.throws(
    () => parseChromeDevtoolsMcpProfilePilotConfig([], {
      PROFILEPILOT_PORT: "9223",
      PROFILEPILOT_SESSION: "../escape"
    }),
    (error) => error.code === "PROFILEPILOT_INVALID_SESSION"
  );
});

test("Chrome DevTools MCP wrapper replaces direct browser and websocket targets with a ticket endpoint", () => {
  const result = rewriteChromeDevtoolsMcpWebSocketArgs([
    "--browserUrl", "http://127.0.0.1:9222",
    "--ws-endpoint=ws://old.example/devtools/browser/old",
    "--headless",
    "--wsEndpoint", "ws://second-old.example/devtools/browser/old"
  ], "ws://127.0.0.1:9223/devtools/browser/gateway?ticket=abc");

  assert.deepEqual(result, [
    "--headless",
    "--wsEndpoint=ws://127.0.0.1:9223/devtools/browser/gateway?ticket=abc"
  ]);
  assert.throws(
    () => rewriteChromeDevtoolsMcpWebSocketArgs([], "http://127.0.0.1:9223"),
    (error) => error.code === "GATEWAY_INVALID_RESPONSE"
  );
  assert.deepEqual(
    rewriteChromeDevtoolsMcpWebSocketArgs(["--headless", "--", "literal"], "wss://relay.example/one"),
    ["--headless", "--wsEndpoint=wss://relay.example/one", "--", "literal"]
  );
});

test("Chrome DevTools MCP wrapper resolves a real binary while skipping its managed launcher", () => {
  const home = makeTempDir();
  try {
    const managedDir = path.join(home, "managed");
    const realDir = path.join(home, "real");
    const managed = executable(path.join(managedDir, "chrome-devtools-mcp"), "#!/bin/sh\nexit 99\n");
    const real = executable(path.join(realDir, "chrome-devtools-mcp"), "#!/bin/sh\nexit 0\n");
    const result = resolveRealChromeDevtoolsMcp({
      HOME: home,
      PATH: `${managedDir}${path.delimiter}${realDir}`,
      PROFILEPILOT_CHROME_DEVTOOLS_MCP_LAUNCHER: managed
    }, managed);
    assert.deepEqual(result, { executable: real, prefixArgs: [], source: "binary" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("bundled MCP wrapper does not execute the embedded agent-browser entrypoint", () => {
  const home = makeTempDir();
  try {
    const mcp = executable(
      path.join(home, "chrome-devtools-mcp"),
      "#!/bin/sh\nprintf 'MCP_ONLY\\n'\n"
    );
    const agentBrowser = executable(
      path.join(home, "agent-browser"),
      "#!/bin/sh\nprintf 'UNEXPECTED_AGENT_BROWSER\\n'\n"
    );
    const result = spawnSync(process.execPath, [
      path.join(__dirname, "..", "dist", "main", "profilepilot-chrome-devtools-mcp-wrapper.cjs"),
      "--version"
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PROFILEPILOT_CHROME_DEVTOOLS_MCP_REAL: mcp,
        PROFILEPILOT_AGENT_BROWSER_REAL: agentBrowser
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "MCP_ONLY\n");
    assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_AGENT_BROWSER/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Chrome DevTools MCP wrapper falls back to npx with an overridable package spec", () => {
  const home = makeTempDir();
  try {
    const bin = path.join(home, "bin");
    const npx = executable(path.join(bin, "npx"), "#!/bin/sh\nexit 0\n");
    assert.deepEqual(resolveRealChromeDevtoolsMcp({
      HOME: home,
      PATH: bin,
      PROFILEPILOT_CHROME_DEVTOOLS_MCP_PACKAGE: "chrome-devtools-mcp@1.2.3"
    }, path.join(home, "wrapper.cjs")), {
      executable: npx,
      prefixArgs: ["--yes", "chrome-devtools-mcp@1.2.3"],
      source: "npx"
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Gateway endpoint provider sends Chrome DevTools MCP driver identity", async () => {
  let seenRequest;
  let seenOptions;
  const provider = createGatewayChromeDevtoolsMcpEndpointProvider({
    homeDir: "/tmp/profilepilot-home",
    timeoutMs: 4321,
    request: async (request, options) => {
      if (request.action === "status") {
        return { ok: true, ports: [9223] };
      }
      seenRequest = request;
      seenOptions = options;
      return {
        ok: true,
        webSocketUrl: "ws://127.0.0.1:9223/devtools/browser/gateway?ticket=one"
      };
    }
  });
  const endpoint = await provider.getWebSocketUrl({
    publicPort: 9223,
    sessionId: "cx-one",
    daemonInstanceId: "daemon-one",
    daemonPid: 123,
    agent: "Codex",
    project: "profilepilot"
  });

  assert.equal(endpoint, "ws://127.0.0.1:9223/devtools/browser/gateway?ticket=one");
  assert.deepEqual(seenRequest, {
    action: "acquire",
    publicPort: 9223,
    sessionId: "cx-one",
    daemonInstanceId: "daemon-one",
    daemonPid: 123,
    agent: "Codex",
    project: "profilepilot",
    driverKind: "chrome-devtools-mcp",
    driverLabel: "Chrome DevTools MCP"
  });
  assert.deepEqual(seenOptions, { homeDir: "/tmp/profilepilot-home", timeoutMs: 4321 });
});

test("Gateway endpoint provider starts the daemon and configured Profile before acquiring", async () => {
  const calls = [];
  const env = { HOME: "/tmp/profilepilot-home", CPM_DATA_DIR: "/tmp/profilepilot-data" };
  const provider = createGatewayChromeDevtoolsMcpEndpointProvider({
    homeDir: env.HOME,
    env,
    request: async (request) => {
      calls.push(request.action);
      if (request.action === "status" && calls.filter((action) => action === "status").length === 1) {
        const error = new Error("Gateway unavailable");
        error.code = "GATEWAY_UNAVAILABLE";
        throw error;
      }
      if (request.action === "status") return { ok: true, ports: [] };
      if (request.action === "acquire") {
        return {
          ok: true,
          webSocketUrl: "ws://127.0.0.1:9223/devtools/browser/gateway?ticket=started"
        };
      }
      throw new Error(`Unexpected request ${request.action}`);
    },
    ensureGatewayDaemon: async ({ homeDir }) => {
      assert.equal(homeDir, env.HOME);
      calls.push("ensure-daemon");
      return { ok: true };
    },
    ensureProfileRunning: async (publicPort, status, receivedEnv, homeDir) => {
      assert.equal(publicPort, 9223);
      assert.deepEqual(status, { ok: true, ports: [] });
      assert.equal(receivedEnv, env);
      assert.equal(homeDir, env.HOME);
      calls.push("ensure-profile");
      return { ok: true, ports: [9223] };
    }
  });

  const endpoint = await provider.getWebSocketUrl({
    publicPort: 9223,
    sessionId: "cx-auto-start",
    daemonInstanceId: "daemon-auto-start",
    daemonPid: 123
  });

  assert.match(endpoint, /ticket=started$/);
  assert.deepEqual(calls, ["status", "ensure-daemon", "status", "ensure-profile", "acquire"]);
});

test("Gateway endpoint provider refuses to silently downgrade persistent handoff on an old daemon", async () => {
  let ensuredProfile = false;
  const provider = createGatewayChromeDevtoolsMcpEndpointProvider({
    request: async (request) => {
      assert.equal(request.action, "status");
      return { ok: true, protocolVersion: 7, ports: [9223] };
    },
    ensureGatewayDaemon: async () => ({
      ok: true,
      protocolVersion: 7,
      protocolUpgradeDeferred: true,
      ports: [9223]
    }),
    ensureProfileRunning: async () => {
      ensuredProfile = true;
      return { ok: true };
    }
  });

  await assert.rejects(
    provider.getWebSocketUrl({
      publicPort: 9223,
      sessionId: "cx-old-gateway",
      daemonInstanceId: "daemon-old-gateway",
      daemonPid: 123
    }),
    (error) => error.code === "GATEWAY_PROTOCOL_INCOMPATIBLE" && /v7/.test(error.message)
  );
  assert.equal(ensuredProfile, false);
});

test("Chrome DevTools MCP launch preparation is relay-provider agnostic", async () => {
  const home = makeTempDir();
  let context;
  try {
    const config = parseChromeDevtoolsMcpProfilePilotConfig([
      "--profilepilot-port=9223",
      "--profilepilot-session=cx-one",
      "--browserUrl=http://127.0.0.1:9222",
      "--headless"
    ], {});
    const args = await prepareChromeDevtoolsMcpLaunchArgs(config, {
      HOME: home,
      PWD: "/work/profilepilot"
    }, {
      async getWebSocketUrl(value) {
        context = value;
        return "ws://relay.example/session/cx-one";
      }
    });

    assert.deepEqual(args, ["--headless", "--wsEndpoint=ws://relay.example/session/cx-one"]);
    assert.equal(context.publicPort, 9223);
    assert.equal(context.sessionId, "cx-one");
    assert.equal(context.agent, "Codex");
    assert.equal(context.project, "profilepilot");
    assert.match(context.daemonInstanceId, /^daemon-/);
    assert.equal(context.daemonPid, process.pid);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Chrome DevTools MCP wrapper transparently forwards ordinary args and child exit code", async () => {
  const home = makeTempDir();
  try {
    const script = path.join(home, "fake-mcp.js");
    const output = path.join(home, "args.json");
    writeFileSync(script, [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.RECORD_ARGS, JSON.stringify(process.argv.slice(2)));",
      "process.exit(23);"
    ].join("\n"));
    const exitCode = await runChromeDevtoolsMcpWrapper(["--headless", "--isolated=false"], {
      ...process.env,
      RECORD_ARGS: output
    }, {
      command: { executable: process.execPath, prefixArgs: [script], source: "binary" }
    });

    assert.equal(exitCode, 23);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), ["--headless", "--isolated=false"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("managed Chrome DevTools MCP releases its Gateway Session when the stdio server exits", async () => {
  const home = makeTempDir();
  const requests = [];
  try {
    const script = path.join(home, "fake-managed-mcp.js");
    writeFileSync(script, "process.exit(0);\n");
    const exitCode = await runChromeDevtoolsMcpWrapper([
      "--profilepilot-port=9223",
      "--profilepilot-session=cx-managed",
      "--headless"
    ], {
      ...process.env,
      HOME: home
    }, {
      command: { executable: process.execPath, prefixArgs: [script], source: "binary" },
      endpointProvider: {
        async getWebSocketUrl() {
          return "ws://127.0.0.1:9223/devtools/browser/gateway?ticket=managed";
        }
      },
      request: async (request) => {
        requests.push(request);
        return { ok: true };
      }
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(requests, [{
      action: "control",
      sessionId: "cx-managed",
      command: "stop"
    }]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "profilepilot-chrome-devtools-mcp-"));
}

function executable(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
  return filePath;
}
