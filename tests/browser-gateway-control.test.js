const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BrowserGatewayControlError,
  BrowserGatewayControlPlane
} = require("../dist/main/browser-gateway-control.js");

function harness() {
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-control-"));
  let now = Date.parse("2026-07-11T00:00:00.000Z");
  const events = [];
  const control = new BrowserGatewayControlPlane({
    homeDir: home,
    secret: Buffer.alloc(32, 7),
    now: () => now,
    onEvent: (event) => events.push(event)
  });
  control.registerProfile({ profileId: "profile-a", profileName: "Profile A", publicPort: 9223 });
  return {
    home,
    control,
    events,
    advance(ms) { now += ms; },
    cleanup() { rmSync(home, { recursive: true, force: true }); }
  };
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => error instanceof BrowserGatewayControlError && error.code === code);
}

test("Gateway enforces Profile↔Session and Session↔daemon one-to-one bindings", () => {
  const h = harness();
  try {
    const first = h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      daemonPid: 101,
      project: "coze-monorepo",
      branch: "feat/overlay-identity"
    });
    assert.equal(first.profile.ownerSessionId, "cx-one");
    assert.equal(first.profile.daemonInstanceId, "daemon-one");
    assert.equal(first.profile.project, "coze-monorepo");
    assert.equal(first.profile.branch, "feat/overlay-identity");
    assert.equal(first.profile.driverState, "connecting");

    assertCode(() => h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-two",
      daemonInstanceId: "daemon-two"
    }), "PROFILE_LEASE_CONFLICT");

    assertCode(() => h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-duplicate"
    }), "SESSION_DAEMON_DUPLICATE");

    h.control.registerProfile({ profileId: "profile-b", profileName: "Profile B", publicPort: 9224 });
    assertCode(() => h.control.acquire({
      publicPort: 9224,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one"
    }), "SESSION_ALREADY_BOUND");
  } finally {
    h.cleanup();
  }
});

test("Gateway keeps the browser driver identity immutable for an active Session", () => {
  const h = harness();
  try {
    const first = h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-driver",
      daemonInstanceId: "daemon-driver",
      daemonPid: 101,
      driverKind: "playwright-cli",
      driverLabel: "Playwright CLI"
    });
    assert.equal(first.profile.driverKind, "playwright-cli");
    assert.equal(first.profile.driverLabel, "Playwright CLI");

    assertCode(() => h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-driver",
      daemonInstanceId: "daemon-driver",
      driverKind: "chrome-devtools-mcp"
    }), "SESSION_DAEMON_DUPLICATE");
    assert.equal(h.control.getProfile(9223).driverKind, "playwright-cli");
  } finally {
    h.cleanup();
  }
});

test("Gateway tickets are signed, one-shot, expiring and generation-bound", () => {
  const h = harness();
  try {
    const acquired = h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one"
    });
    const identity = h.control.consumeTicket(acquired.ticket);
    assert.equal(identity.sessionId, "cx-one");
    assert.equal(h.control.assertConnectionCanSend(identity).ownership, "agent");
    assertCode(() => h.control.consumeTicket(acquired.ticket), "GATEWAY_TICKET_REPLAYED");

    const next = h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one"
    });
    h.advance(15_001);
    assertCode(() => h.control.consumeTicket(next.ticket), "GATEWAY_TICKET_EXPIRED");

    const current = h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one"
    });
    const currentIdentity = h.control.consumeTicket(current.ticket);
    h.control.delegateToUser("cx-one", "user_takeover");
    assertCode(() => h.control.assertConnectionCanSend(currentIdentity), "CONTROL_GENERATION_STALE");
  } finally {
    h.cleanup();
  }
});

test("Gateway takeover, completion, return and stop are durable explicit transitions", () => {
  const h = harness();
  try {
    h.control.acquire({ publicPort: 9223, sessionId: "cx-one", daemonInstanceId: "daemon-one" });
    const takeover = h.control.delegateToUser("cx-one", "user_takeover", "手动加载未打包扩展");
    assert.equal(takeover.ownership, "user");
    assert.equal(takeover.agentHealth, "waiting");
    assert.equal(takeover.driverState, "parked");
    assert.equal(takeover.pendingUserAction, "手动加载未打包扩展");
    assertCode(() => h.control.delegateToUser("cx-one", "agent_complete"), "PENDING_USER_ACTION");
    assertCode(() => h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one"
    }), "AGENT_USER_IN_CONTROL");

    const returned = h.control.returnToAgent("cx-one");
    assert.equal(returned.ownership, "agent");
    assert.equal(returned.driverState, "connected");
    assert.equal(returned.agentHealth, "online");
    assert.equal(returned.pendingUserAction, undefined);
    const reacquired = h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one"
    });
    assert.equal(h.control.consumeTicket(reacquired.ticket).controlGeneration, returned.controlGeneration);

    const complete = h.control.delegateToUser("cx-one", "agent_complete");
    assert.equal(complete.ownership, "user");
    assert.equal(complete.sessionStatus, "stopped");
    assert.equal(complete.agentHealth, "offline");
    assert.equal(complete.driverState, "disconnected");
    assert.equal(complete.ownerSessionId, undefined);
    assertCode(() => h.control.returnToAgent("cx-one"), "GATEWAY_PROFILE_NOT_FOUND");
    assert.equal(h.control.getProfileForSession("cx-one"), null);
  } finally {
    h.cleanup();
  }
});

test("Gateway tracks driver reconnect separately from Session ownership", () => {
  const h = harness();
  try {
    h.control.acquire({ publicPort: 9223, sessionId: "cx-reconnect", daemonInstanceId: "daemon-reconnect" });
    const connected = h.control.markAgentConnected("cx-reconnect", "daemon-reconnect");
    assert.equal(connected.ownership, "agent");
    assert.equal(connected.sessionStatus, "active");
    assert.equal(connected.agentHealth, "online");
    assert.equal(connected.driverState, "connected");

    const reconnecting = h.control.markAgentReconnecting(
      "cx-reconnect",
      "2026-07-11T00:00:10.000Z",
      "websocket-closed"
    );
    assert.equal(reconnecting.ownership, "agent");
    assert.equal(reconnecting.sessionStatus, "active");
    assert.equal(reconnecting.agentHealth, "offline");
    assert.equal(reconnecting.driverState, "reconnecting");
    assert.equal(reconnecting.reconnectAttempt, 0);
    assert.equal(reconnecting.reconnectDeadlineAt, "2026-07-11T00:00:10.000Z");

    const retry = h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-reconnect",
      daemonInstanceId: "daemon-reconnect"
    });
    assert.equal(retry.profile.driverState, "reconnecting");
    assert.equal(retry.profile.reconnectAttempt, 1);

    const restored = h.control.markAgentConnected("cx-reconnect", "daemon-reconnect");
    assert.equal(restored.driverState, "connected");
    assert.equal(restored.reconnectAttempt, undefined);
    assert.equal(restored.reconnectDeadlineAt, undefined);
  } finally {
    h.cleanup();
  }
});

test("Gateway daemon replacement requires a one-time restart nonce", () => {
  const h = harness();
  try {
    h.control.acquire({ publicPort: 9223, sessionId: "cx-one", daemonInstanceId: "daemon-one" });
    const nonce = h.control.prepareDaemonRestart("cx-one", "daemon-one");
    assertCode(() => h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-two"
    }), "SESSION_DAEMON_DUPLICATE");
    const replaced = h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-two",
      restartNonce: nonce
    });
    assert.equal(replaced.profile.daemonInstanceId, "daemon-two");
    assertCode(() => h.control.acquire({
      publicPort: 9223,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-three",
      restartNonce: nonce
    }), "SESSION_DAEMON_DUPLICATE");
  } finally {
    h.cleanup();
  }
});

test("Gateway state survives process restarts without reviving stopped sessions", () => {
  const h = harness();
  try {
    h.control.acquire({ publicPort: 9223, sessionId: "cx-one", daemonInstanceId: "daemon-one" });
    h.control.delegateToUser("cx-one", "user_takeover");
    const restored = new BrowserGatewayControlPlane({
      homeDir: h.home,
      secret: Buffer.alloc(32, 7)
    });
    assert.equal(restored.getProfile(9223).ownerSessionId, "cx-one");
    assert.equal(restored.getProfile(9223).ownership, "user");
    assertCode(() => restored.acquire({
      publicPort: 9223,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one"
    }), "AGENT_USER_IN_CONTROL");
  } finally {
    h.cleanup();
  }
});
