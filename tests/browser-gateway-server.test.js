const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { BrowserGatewayControlPlane } = require("../dist/main/browser-gateway-control.js");
const { BrowserGatewayServer, isRawCdpMethodAllowed } = require("../dist/main/browser-gateway-server.js");

class FakeBackend {
  constructor() {
    this.sent = [];
    this.messageListeners = new Set();
    this.closeListeners = new Set();
    this.onSend = null;
  }
  send(message) {
    this.sent.push(message);
    this.onSend?.(message);
  }
  emit(message) {
    for (const listener of this.messageListeners) listener(message);
  }
  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  close() {
    for (const listener of this.closeListeners) listener();
  }
}

async function makeHarness(serverOptions = {}) {
  const port = await freePort();
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-server-"));
  let gateway;
  const control = new BrowserGatewayControlPlane({
    homeDir: home,
    secret: Buffer.alloc(32, 9),
    onEvent: (event) => gateway?.handleControlEvent(event)
  });
  control.registerProfile({ profileId: "profile-a", profileName: "Profile A", publicPort: port });
  gateway = new BrowserGatewayServer(control, { internalSecret: "internal-secret", ...serverOptions });
  const backend = new FakeBackend();
  await gateway.registerBackend({ publicPort: port, backend });
  return {
    port,
    home,
    control,
    gateway,
    backend,
    async cleanup() {
      await gateway.close();
      rmSync(home, { recursive: true, force: true });
    }
  };
}

test("Gateway transparently remaps CDP request ids and broadcasts events", async () => {
  const h = await makeHarness();
  try {
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: { echoed: message.method } })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    const response = nextMessage(ws);
    ws.send(JSON.stringify({ id: 77, method: "Browser.getVersion", params: {} }));
    assert.deepEqual(await response, { id: 77, result: { echoed: "Browser.getVersion" } });
    assert.notEqual(JSON.parse(h.backend.sent[0]).id, 77, "upstream id must be gateway-owned");

    const event = nextMessage(ws);
    h.backend.emit(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: { targetId: "t1" } } }));
    assert.equal((await event).method, "Target.targetCreated");
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("Gateway closes existing Agent sockets as soon as the user takes over", async () => {
  const h = await makeHarness();
  try {
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    const closed = new Promise((resolve) => ws.addEventListener("close", (event) => resolve(event), { once: true }));
    h.control.delegateToUser("cx-one", "user_takeover");
    const event = await closed;
    assert.equal(event.code, 4003);
    assert.match(event.reason, /user_takeover/);
  } finally {
    await h.cleanup();
  }
});

test("Gateway parks Playwright across takeover and replays buffered events before resuming commands", async () => {
  const h = await makeHarness();
  try {
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      const result = message.method === "Target.attachToTarget"
        ? { sessionId: "flat-playwright" }
        : { echoed: message.method };
      queueMicrotask(() => h.backend.emit(JSON.stringify({
        id: message.id,
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        result
      })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-playwright",
      daemonInstanceId: "daemon-playwright",
      driverKind: "playwright-cli",
      driverLabel: "Playwright CLI"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);

    let response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "page-one", flatten: true }
    }));
    assert.deepEqual(await response, { id: 1, result: { sessionId: "flat-playwright" } });
    assert.equal(await h.gateway.quiesceAgentSession(h.port, "cx-playwright", 500), true);

    let closed = false;
    ws.addEventListener("close", () => { closed = true; }, { once: true });
    h.control.delegateToUser("cx-playwright", "user_takeover");

    const sentBeforeBlockedCommand = h.backend.sent.length;
    response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 2,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
      sessionId: "flat-playwright"
    }));
    const blocked = await response;
    assert.equal(blocked.id, 2);
    assert.equal(blocked.sessionId, "flat-playwright");
    assert.equal(blocked.error.code, -32000);
    assert.match(blocked.error.message, /AGENT_USER_IN_CONTROL/);
    assert.equal(h.backend.sent.length, sentBeforeBlockedCommand, "parked commands must never reach Chrome");

    let replayed = false;
    const replay = nextMessage(ws).then((message) => {
      replayed = true;
      return message;
    });
    h.backend.emit(JSON.stringify({
      method: "Runtime.consoleAPICalled",
      sessionId: "flat-playwright",
      params: { type: "log", args: [] }
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(replayed, false, "user-time events must stay hidden while the driver is parked");
    assert.equal(closed, false, "a resumable driver keeps the same physical WebSocket");

    h.control.returnToAgent("cx-playwright");
    assert.deepEqual(await replay, {
      method: "Runtime.consoleAPICalled",
      sessionId: "flat-playwright",
      params: { type: "log", args: [] }
    });

    response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 3,
      method: "Runtime.evaluate",
      params: { expression: "1 + 1" },
      sessionId: "flat-playwright"
    }));
    assert.deepEqual(await response, {
      id: 3,
      result: { echoed: "Runtime.evaluate" },
      sessionId: "flat-playwright"
    });
    assert.equal(closed, false);
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("Gateway Raw CDP uses the same ownership boundary and method policy", async () => {
  const h = await makeHarness();
  try {
    h.control.acquire({ publicPort: h.port, sessionId: "cx-one", daemonInstanceId: "daemon-one" });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      const result = message.method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "t1", type: "page" }] }
        : { ok: true };
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result })));
    };
    assert.deepEqual(await h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      method: "Target.activateTarget",
      params: { targetId: "t1" }
    }), {});
    assert.equal(
      h.backend.sent.map(JSON.parse).some((message) => message.method === "Target.activateTarget"),
      false,
      "Agent Raw CDP must not activate the visible Chrome tab"
    );
    h.backend.sent.length = 0;
    assert.deepEqual(await h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      targetId: "t1"
    }), {});
    assert.equal(
      h.backend.sent.length,
      0,
      "Agent Raw CDP must not leave a synthetic viewport on a real Chrome Profile"
    );
    await assert.rejects(() => h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      method: "Browser.close"
    }), (error) => error.code === "RAW_CDP_METHOD_DENIED");
    const backendCountBeforeDeniedTargetMethods = h.backend.sent.length;
    for (const method of [
      "Target.attachToBrowserTarget",
      "Target.exposeDevToolsProtocol",
      "Target.openDevTools",
      "Target.setRemoteLocations"
    ]) {
      await assert.rejects(() => h.gateway.callRaw({
        publicPort: h.port,
        sessionId: "cx-one",
        daemonInstanceId: "daemon-one",
        method,
        params: method === "Target.setRemoteLocations"
          ? { locations: [{ host: "127.0.0.1", port: 9333 }] }
          : { targetId: "t1" }
      }), (error) => error.code === "RAW_CDP_METHOD_DENIED");
    }
    assert.equal(
      h.backend.sent.length,
      backendCountBeforeDeniedTargetMethods,
      "denied raw Target methods must never reach Chrome"
    );

    h.control.delegateToUser("cx-one", "user_takeover");
    await assert.rejects(() => h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      method: "Runtime.evaluate",
      params: { expression: "1+1" }
    }), (error) => error.code === "AGENT_USER_IN_CONTROL");
  } finally {
    await h.cleanup();
  }
});

test("Gateway keeps Agent-created targets in the background and virtualizes tab activation", async () => {
  const targetChanges = [];
  const h = await makeHarness({ onAgentTargetChange: (port) => targetChanges.push(port) });
  try {
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      const result = message.method === "Target.createTarget"
        ? { targetId: "page-created" }
        : message.method === "Target.attachToTarget"
          ? { sessionId: "flat-page-two" }
          : message.method === "Target.getTargets"
            ? {
                targetInfos: [
                  { targetId: "page-created", type: "page", title: "Created", url: "https://created.test/" },
                  { targetId: "page-two", type: "page", title: "Second", url: "https://second.test/" },
                  { targetId: "page-three", type: "page", title: "Third", url: "https://third.test/" }
                ]
              }
            : { ok: true };
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, sessionId: message.sessionId, result })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-no-focus",
      daemonInstanceId: "daemon-no-focus"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);

    let response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 1,
      method: "Target.createTarget",
      params: { url: "https://created.test/", background: false, focus: true }
    }));
    assert.deepEqual(await response, { id: 1, result: { targetId: "page-created" } });
    const createRequest = h.backend.sent.map(JSON.parse).find((message) => message.method === "Target.createTarget");
    assert.deepEqual(createRequest.params, { url: "https://created.test/", background: true });

    response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 2,
      method: "Target.attachToTarget",
      params: { targetId: "page-two", flatten: true }
    }));
    assert.deepEqual(await response, { id: 2, result: { sessionId: "flat-page-two" } });

    h.backend.sent.length = 0;
    const viewportResponses = collectMessages(ws, 2);
    ws.send(JSON.stringify({
      id: 21,
      method: "Emulation.setDeviceMetricsOverride",
      params: { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      sessionId: "flat-page-two"
    }));
    ws.send(JSON.stringify({
      id: 22,
      method: "Browser.setContentsSize",
      params: { windowId: 9, width: 1280, height: 900 }
    }));
    assert.deepEqual(
      (await viewportResponses).sort((left, right) => left.id - right.id),
      [{ id: 21, result: {}, sessionId: "flat-page-two" }, { id: 22, result: {} }]
    );
    assert.equal(
      h.backend.sent.length,
      0,
      "Agent viewport setters must be virtualized before they reach the real Chrome Profile"
    );

    h.backend.sent.length = 0;
    response = nextMessage(ws);
    ws.send(JSON.stringify({ id: 3, method: "Page.bringToFront", params: {}, sessionId: "flat-page-two" }));
    assert.deepEqual(await response, { id: 3, result: {}, sessionId: "flat-page-two" });
    assert.deepEqual(h.backend.sent.map(JSON.parse).map((message) => message.method), ["Target.getTargets"]);
    assert.equal((await h.gateway.getAgentTarget(h.port, "cx-no-focus")).targetId, "page-two");

    h.backend.sent.length = 0;
    response = nextMessage(ws);
    ws.send(JSON.stringify({ id: 4, method: "Target.activateTarget", params: { targetId: "page-three" } }));
    assert.deepEqual(await response, { id: 4, result: {} });
    assert.deepEqual(h.backend.sent.map(JSON.parse).map((message) => message.method), ["Target.getTargets"]);
    assert.equal((await h.gateway.getAgentTarget(h.port, "cx-no-focus")).targetId, "page-three");
    assert.ok(targetChanges.length >= 3);

    h.backend.sent.length = 0;
    response = nextMessage(ws);
    ws.send(JSON.stringify({ id: 5, method: "Page.bringToFront", params: {}, sessionId: "unknown-flat-session" }));
    assert.match((await response).error.message, /不属于当前 Agent/);
    assert.equal(h.backend.sent.length, 0);
    assert.equal((await h.gateway.getAgentTarget(h.port, "cx-no-focus")).targetId, "page-three");

    h.backend.sent.length = 0;
    response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 6,
      method: "Target.sendMessageToTarget",
      params: {
        sessionId: "flat-page-two",
        message: JSON.stringify({ id: 1, method: "Page.bringToFront", params: {} })
      }
    }));
    assert.match((await response).error.message, /flattened CDP sessions/);
    assert.equal(h.backend.sent.length, 0, "opaque nested CDP must never reach Chrome");

    const deniedTargetCommands = [
      [7, "Target.attachToBrowserTarget", {}],
      [8, "Target.exposeDevToolsProtocol", { targetId: "page-two", bindingName: "cdp" }],
      [9, "Target.openDevTools", { targetId: "page-two" }],
      [10, "Target.setRemoteLocations", { locations: [{ host: "127.0.0.1", port: 9333 }] }]
    ];
    const deniedResponses = collectMessages(ws, deniedTargetCommands.length);
    for (const [id, method, params] of deniedTargetCommands) {
      ws.send(JSON.stringify({ id, method, params }));
    }
    const deniedMessages = await deniedResponses;
    assert.deepEqual(
      new Set(deniedMessages.map((message) => message.id)),
      new Set(deniedTargetCommands.map(([id]) => id))
    );
    for (const denied of deniedMessages) {
      assert.equal(denied.error.code, -32601);
      assert.match(denied.error.message, /disabled by ProfilePilot Gateway/);
    }
    assert.equal(h.backend.sent.length, 0, "denied Agent Target methods must never reach Chrome");

    const closed = new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
    ws.send(JSON.stringify({ method: "Target.activateTarget", params: { targetId: "page-created" } }));
    await closed;
    await waitFor(
      () => h.backend.sent.map(JSON.parse).some((message) => message.method === "Target.detachFromTarget"),
      "Agent child session cleanup"
    );
    assert.equal(
      h.backend.sent.map(JSON.parse).some((message) => message.method === "Target.activateTarget"),
      false,
      "id-less activation must not bypass the virtual response path"
    );
  } finally {
    await h.cleanup();
  }
});

test("Gateway Raw CDP applies the same no-focus target policy", async () => {
  const h = await makeHarness();
  try {
    h.control.acquire({ publicPort: h.port, sessionId: "cx-raw-focus", daemonInstanceId: "daemon-raw-focus" });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      const result = message.method === "Target.createTarget"
        ? { targetId: "raw-created" }
        : message.method === "Target.getTargets"
          ? {
              targetInfos: [
                { targetId: "raw-created", type: "page", title: "Created", url: "https://created.test/" },
                { targetId: "raw-page", type: "page", title: "Raw", url: "https://raw.test/" }
              ]
            }
          : message.method === "Target.attachToTarget"
            ? { sessionId: "raw-flat" }
            : {};
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, sessionId: message.sessionId, result })));
    };

    assert.deepEqual(await h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-raw-focus",
      daemonInstanceId: "daemon-raw-focus",
      method: "Target.createTarget",
      params: { url: "https://created.test/", background: false, focus: true }
    }), { targetId: "raw-created" });
    let sent = h.backend.sent.map(JSON.parse);
    assert.deepEqual(sent.at(-1).params, { url: "https://created.test/", background: true });

    h.backend.sent.length = 0;
    assert.deepEqual(await h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-raw-focus",
      daemonInstanceId: "daemon-raw-focus",
      method: "Page.bringToFront",
      targetId: "raw-page"
    }), {});
    sent = h.backend.sent.map(JSON.parse);
    assert.deepEqual(sent.map((message) => message.method), ["Target.getTargets"]);

    h.backend.sent.length = 0;
    assert.deepEqual(await h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-raw-focus",
      daemonInstanceId: "daemon-raw-focus",
      method: "Target.activateTarget",
      params: { targetId: "raw-page" }
    }), {});
    sent = h.backend.sent.map(JSON.parse);
    assert.deepEqual(sent.map((message) => message.method), ["Target.getTargets"]);
    assert.equal((await h.gateway.getAgentTarget(h.port, "cx-raw-focus")).targetId, "raw-page");
  } finally {
    await h.cleanup();
  }
});

test("Gateway keeps the last requested logical tab when activation validation responses arrive out of order", async () => {
  const h = await makeHarness();
  try {
    const pendingTargetQueries = [];
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      if (message.method === "Target.getTargets") {
        pendingTargetQueries.push(message);
        if (pendingTargetQueries.length === 2) {
          const [first, second] = pendingTargetQueries;
          const result = {
            targetInfos: [
              { targetId: "page-old", type: "page" },
              { targetId: "page-new", type: "page" }
            ]
          };
          queueMicrotask(() => h.backend.emit(JSON.stringify({ id: second.id, result })));
          setTimeout(() => h.backend.emit(JSON.stringify({ id: first.id, result })), 20);
        }
      }
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-order",
      daemonInstanceId: "daemon-order"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    const responses = collectMessages(ws, 2);
    ws.send(JSON.stringify({ id: 1, method: "Target.activateTarget", params: { targetId: "page-old" } }));
    ws.send(JSON.stringify({ id: 2, method: "Target.activateTarget", params: { targetId: "page-new" } }));
    assert.deepEqual(new Set((await responses).map((message) => message.id)), new Set([1, 2]));

    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      queueMicrotask(() => h.backend.emit(JSON.stringify({
        id: message.id,
        result: {
          targetInfos: [
            { targetId: "page-old", type: "page" },
            { targetId: "page-new", type: "page" }
          ]
        }
      })));
    };
    assert.equal((await h.gateway.getAgentTarget(h.port, "cx-order")).targetId, "page-new");
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("Gateway Raw CDP revalidates ownership after asynchronous target resolution", async () => {
  const h = await makeHarness();
  try {
    h.control.acquire({ publicPort: h.port, sessionId: "cx-raw-race", daemonInstanceId: "daemon-raw-race" });
    let resolveTargets;
    const targetsRequested = new Promise((resolve) => {
      resolveTargets = resolve;
    });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      if (message.method !== "Target.getTargets") {
        queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: {} })));
        return;
      }
      resolveTargets(() => h.backend.emit(JSON.stringify({
        id: message.id,
        result: { targetInfos: [{ targetId: "race-page", type: "page" }] }
      })));
    };

    const pending = h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-raw-race",
      daemonInstanceId: "daemon-raw-race",
      method: "Runtime.evaluate",
      params: { expression: "document.title" }
    });
    const respondWithTargets = await targetsRequested;
    h.control.delegateToUser("cx-raw-race", "user_takeover");
    respondWithTargets();
    await assert.rejects(pending, (error) => error.code === "CONTROL_GENERATION_STALE");
    assert.deepEqual(
      h.backend.sent.map(JSON.parse).map((message) => message.method),
      ["Target.getTargets"],
      "no attach or page command may be sent after takeover wins the race"
    );

    await assert.rejects(() => h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-raw-race",
      daemonInstanceId: "daemon-raw-race",
      method: "Target.sendMessageToTarget",
      params: { sessionId: "legacy", message: "{}" }
    }), (error) => error.code === "RAW_CDP_METHOD_DENIED");
  } finally {
    await h.cleanup();
  }
});

test("Gateway loads an unpacked extension only for the active owning Agent", async () => {
  const h = await makeHarness();
  try {
    h.control.acquire({ publicPort: h.port, sessionId: "cx-one", daemonInstanceId: "daemon-one" });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: { id: "extension-one" } })));
    };
    assert.deepEqual(await h.gateway.loadUnpackedExtension({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      extensionPath: "/tmp/fixture-extension"
    }), { id: "extension-one" });
    const sent = h.backend.sent.map(JSON.parse);
    assert.equal(sent.at(-1).method, "Extensions.loadUnpacked");
    assert.deepEqual(sent.at(-1).params, { path: "/tmp/fixture-extension" });

    h.control.delegateToUser("cx-one", "user_takeover");
    await assert.rejects(() => h.gateway.loadUnpackedExtension({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      extensionPath: "/tmp/fixture-extension"
    }), (error) => error.code === "AGENT_USER_IN_CONTROL");
  } finally {
    await h.cleanup();
  }
});

test("Gateway Raw CDP automatically attaches target-scoped methods to a page", async () => {
  const h = await makeHarness();
  try {
    h.control.acquire({ publicPort: h.port, sessionId: "cx-one", daemonInstanceId: "daemon-one" });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      const result = message.method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "page-1", type: "page" }] }
        : message.method === "Target.attachToTarget"
          ? { sessionId: "raw-session-1" }
          : { ok: true };
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, sessionId: message.sessionId, result })));
    };
    assert.deepEqual(await h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      method: "Runtime.evaluate",
      params: { expression: "1+1" }
    }), { ok: true });
    const sent = h.backend.sent.map(JSON.parse);
    assert.deepEqual(sent.map((message) => message.method), [
      "Target.getTargets",
      "Target.attachToTarget",
      "Runtime.evaluate",
      "Target.detachFromTarget"
    ]);
    assert.equal(sent[2].sessionId, "raw-session-1");
  } finally {
    await h.cleanup();
  }
});

test("Gateway Raw CDP prefers the Agent Session's last attached target", async () => {
  const h = await makeHarness();
  try {
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      const result = message.method === "Target.attachToTarget"
        ? { sessionId: message.params.targetId === "page-affinity" ? "agent-flat" : "raw-flat" }
        : { ok: true };
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, sessionId: message.sessionId, result })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-affinity",
      daemonInstanceId: "daemon-affinity"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    const attached = nextMessage(ws);
    ws.send(JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId: "page-affinity", flatten: true } }));
    await attached;
    h.backend.sent.length = 0;
    await h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-affinity",
      daemonInstanceId: "daemon-affinity",
      method: "Runtime.evaluate",
      params: { expression: "document.title" }
    });
    const sent = h.backend.sent.map(JSON.parse);
    assert.deepEqual(sent.map((message) => message.method), [
      "Target.attachToTarget",
      "Runtime.evaluate",
      "Target.detachFromTarget"
    ]);
    assert.equal(sent[0].params.targetId, "page-affinity");
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("Gateway exposes and explicitly activates the Agent Session target", async () => {
  const targetChanges = [];
  const h = await makeHarness({ onAgentTargetChange: (port) => targetChanges.push(port) });
  try {
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      const result = message.method === "Target.attachToTarget"
        ? { sessionId: message.params.targetId === "byte-cloud" ? "agent-flat" : "trusted-flat" }
        : message.method === "Target.getTargets"
          ? {
              targetInfos: [
                { targetId: "byte-cloud", type: "page", title: "云引擎 - 字节云", url: "https://cloud.bytedance.net/engine" },
                { targetId: "bots", type: "page", title: "Bot 管理后台", url: "https://op-bots-boe.bytedance.net/" }
              ]
            }
          : { ok: true };
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, sessionId: message.sessionId, result })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-target",
      daemonInstanceId: "daemon-target"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    const attached = nextMessage(ws);
    ws.send(JSON.stringify({ id: 1, method: "Target.attachToTarget", params: { targetId: "byte-cloud", flatten: true } }));
    await attached;

    assert.deepEqual(await h.gateway.getAgentTarget(h.port, "cx-target"), {
      targetId: "byte-cloud",
      title: "云引擎 - 字节云",
      url: "https://cloud.bytedance.net/engine"
    });
    assert.deepEqual(await h.gateway.activateAgentTarget(
      h.port,
      "cx-target",
      h.control.getProfile(h.port).controlGeneration
    ), {
      targetId: "byte-cloud",
      title: "云引擎 - 字节云",
      url: "https://cloud.bytedance.net/engine"
    });
    assert.deepEqual(targetChanges, [h.port]);
    assert.deepEqual(h.backend.sent.map(JSON.parse).slice(-5).map((message) => message.method), [
      "Target.activateTarget",
      "Target.attachToTarget",
      "Emulation.clearDeviceMetricsOverride",
      "Page.bringToFront",
      "Target.detachFromTarget"
    ]);
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("Gateway target lookup preserves a newer logical target while a stale lookup is in flight", async () => {
  const h = await makeHarness();
  try {
    h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-target-race",
      daemonInstanceId: "daemon-target-race"
    });
    let heldLookup = null;
    let announceHeldLookup;
    const heldLookupReady = new Promise((resolve) => { announceHeldLookup = resolve; });
    let heldNewCreate = null;
    let announceNewCreate;
    const newCreateReady = new Promise((resolve) => { announceNewCreate = resolve; });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      if (message.method === "Target.createTarget") {
        if (message.params.url.includes("new")) {
          heldNewCreate = message;
          announceNewCreate();
        } else {
          queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: { targetId: "page-old" } })));
        }
        return;
      }
      if (message.method === "Target.getTargets" && !heldLookup) {
        heldLookup = message;
        announceHeldLookup();
        return;
      }
      if (message.method === "Target.getTargets") {
        queueMicrotask(() => h.backend.emit(JSON.stringify({
          id: message.id,
          result: {
            targetInfos: [
              { targetId: "page-new", type: "page", title: "New", url: "https://new.test/" }
            ]
          }
        })));
        return;
      }
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: {} })));
    };
    const raw = (method, params) => h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-target-race",
      daemonInstanceId: "daemon-target-race",
      method,
      params
    });
    await raw("Target.createTarget", { url: "https://old.test/" });
    const lookup = h.gateway.getAgentTarget(h.port, "cx-target-race");
    await heldLookupReady;
    const newCreate = raw("Target.createTarget", { url: "https://new.test/" });
    await newCreateReady;
    h.backend.emit(JSON.stringify({ id: heldLookup.id, result: { targetInfos: [] } }));
    assert.equal(await lookup, null, "stale lookup may retire the missing old target but must preserve the pending intent");
    h.backend.emit(JSON.stringify({ id: heldNewCreate.id, result: { targetId: "page-new" } }));
    await newCreate;
    assert.deepEqual(await h.gateway.getAgentTarget(h.port, "cx-target-race"), {
      targetId: "page-new",
      title: "New",
      url: "https://new.test/"
    });
  } finally {
    await h.cleanup();
  }
});

test("Gateway does not assign trusted internal CDP sessions to the Agent connection", async () => {
  const h = await makeHarness();
  try {
    let attachCount = 0;
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      if (message.method === "Target.getTargets") {
        queueMicrotask(() => h.backend.emit(JSON.stringify({
          id: message.id,
          result: {
            targetInfos: [
              { targetId: "page-agent", type: "page", title: "Agent", url: "https://agent.test/" }
            ]
          }
        })));
        return;
      }
      if (message.method === "Target.attachToTarget") {
        attachCount += 1;
        const sessionId = attachCount === 1 ? "agent-flat" : "trusted-flat";
        queueMicrotask(() => {
          if (sessionId === "trusted-flat") {
            h.backend.emit(JSON.stringify({
              method: "Target.attachedToTarget",
              params: {
                sessionId,
                targetInfo: { targetId: "page-agent", type: "page" },
                waitingForDebugger: false
              }
            }));
          }
          h.backend.emit(JSON.stringify({ id: message.id, result: { sessionId } }));
        });
        return;
      }
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: {} })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-internal-session",
      daemonInstanceId: "daemon-internal-session"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    const attached = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "page-agent", flatten: true }
    }));
    assert.equal((await attached).result.sessionId, "agent-flat");
    const agentEvents = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) agentEvents.push(message);
    });

    await h.gateway.activateAgentTarget(
      h.port,
      "cx-internal-session",
      h.control.getProfile(h.port).controlGeneration
    );
    assert.equal(
      h.backend.sent.map(JSON.parse).filter(
        (message) => message.method === "Target.detachFromTarget" && message.params.sessionId === "trusted-flat"
      ).length,
      1,
      "trusted reveal must detach its own CDP session exactly once"
    );
    assert.equal(
      agentEvents.some((message) => message.params?.sessionId === "trusted-flat"),
      false,
      "trusted internal attach events must not leak into the Agent connection"
    );
    const backendCommandCount = h.backend.sent.length;
    const denied = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 2,
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
      sessionId: "trusted-flat"
    }));
    assert.match((await denied).error.message, /不属于当前 Agent/);
    assert.equal(h.backend.sent.length, backendCommandCount, "Agent must not reuse a trusted internal CDP session");

    ws.close();
    await waitFor(() => h.backend.sent.map(JSON.parse).some(
      (message) => message.method === "Target.detachFromTarget" && message.params.sessionId === "agent-flat"
    ), "Agent-owned child session cleanup");
    assert.equal(
      h.backend.sent.map(JSON.parse).filter(
        (message) => message.method === "Target.detachFromTarget" && message.params.sessionId === "trusted-flat"
      ).length,
      1,
      "Agent disconnect must not detach ProfilePilot's trusted CDP session again"
    );
  } finally {
    await h.cleanup();
  }
});

test("Gateway preserves flattened Agent auto-attach ownership without leaking other CDP sessions", async () => {
  const h = await makeHarness();
  try {
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      if (message.method === "Target.setAutoAttach" && message.params.autoAttach === true) {
        queueMicrotask(() => {
          h.backend.emit(JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId: "auto-flat",
              targetInfo: { targetId: "page-auto", type: "page" },
              waitingForDebugger: false
            }
          }));
          h.backend.emit(JSON.stringify({ id: message.id, result: {} }));
        });
        return;
      }
      if (message.method === "Target.getTargets") {
        queueMicrotask(() => h.backend.emit(JSON.stringify({
          id: message.id,
          result: {
            targetInfos: [
              { targetId: "page-auto", type: "page", title: "Auto", url: "https://auto.test/" }
            ]
          }
        })));
        return;
      }
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: {} })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-auto-attach",
      daemonInstanceId: "daemon-auto-attach"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    const autoAttachMessages = collectMessages(ws, 2);
    ws.send(JSON.stringify({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: false }
    }));
    const received = await autoAttachMessages;
    assert.equal(received.some((message) => message.id === 1 && message.result), true);
    assert.equal(received.some((message) => message.params?.sessionId === "auto-flat"), true);
    const upstreamAutoAttach = h.backend.sent.map(JSON.parse).find(
      (message) => message.method === "Target.setAutoAttach" && message.params.autoAttach === true
    );
    assert.equal(upstreamAutoAttach.params.flatten, true, "Agent auto-attach must always use flattened CDP sessions");

    h.backend.sent.length = 0;
    const focused = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 2,
      method: "Page.bringToFront",
      params: {},
      sessionId: "auto-flat"
    }));
    assert.deepEqual(await focused, { id: 2, result: {}, sessionId: "auto-flat" });
    assert.deepEqual(h.backend.sent.map(JSON.parse).map((message) => message.method), ["Target.getTargets"]);

    ws.close();
    await waitFor(() => h.backend.sent.map(JSON.parse).some(
      (message) => message.method === "Target.setAutoAttach" && message.params.autoAttach === false
    ), "Agent auto-attach reset on disconnect");
    assert.equal(h.backend.sent.map(JSON.parse).some(
      (message) => message.method === "Target.detachFromTarget" && message.params.sessionId === "auto-flat"
    ), true);
  } finally {
    await h.cleanup();
  }
});

test("Gateway keeps internal browser-WebSocket attachments out of Agent auto-attach ownership", async () => {
  const h = await makeHarness();
  try {
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      if (message.method === "Target.attachToTarget") {
        queueMicrotask(() => {
          h.backend.emit(JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId: "internal-live-view",
              targetInfo: { targetId: "page-live-view", type: "page" },
              waitingForDebugger: false
            }
          }));
          h.backend.emit(JSON.stringify({ id: message.id, result: { sessionId: "internal-live-view" } }));
        });
        return;
      }
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: {} })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-auto-vs-internal",
      daemonInstanceId: "daemon-auto-vs-internal"
    });
    const agentWs = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    const autoAttachResponse = nextMessage(agentWs);
    agentWs.send(JSON.stringify({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
    }));
    await autoAttachResponse;
    const agentEvents = [];
    agentWs.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) agentEvents.push(message);
    });

    const internalTicket = h.control.issueInternalTicket(h.port);
    const internalWs = await openWebSocket(
      `ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(internalTicket.ticket)}`
    );
    const internalMessages = collectMessages(internalWs, 2);
    internalWs.send(JSON.stringify({
      id: 9,
      method: "Target.attachToTarget",
      params: { targetId: "page-live-view", flatten: true }
    }));
    const received = await internalMessages;
    assert.equal(received.some((message) => message.id === 9 && message.result?.sessionId === "internal-live-view"), true);
    assert.equal(received.some((message) => message.params?.sessionId === "internal-live-view"), true);
    assert.equal(
      agentEvents.some((message) => message.params?.sessionId === "internal-live-view"),
      false,
      "Agent auto-attach must not receive ProfilePilot live-view attachment events"
    );

    internalWs.close();
    await waitFor(() => h.backend.sent.map(JSON.parse).some(
      (message) => message.method === "Target.detachFromTarget" && message.params.sessionId === "internal-live-view"
    ), "internal live-view session cleanup");
    agentWs.close();
    await waitFor(() => h.backend.sent.map(JSON.parse).some(
      (message) => message.method === "Target.setAutoAttach" && message.params.autoAttach === false
    ), "Agent auto-attach reset after internal session cleanup");
    assert.equal(
      h.backend.sent.map(JSON.parse).filter(
        (message) => message.method === "Target.detachFromTarget" && message.params.sessionId === "internal-live-view"
      ).length,
      1,
      "Agent disconnect must not detach the already released internal live-view session"
    );
  } finally {
    await h.cleanup();
  }
});

test("Gateway refuses trusted activation after the expected Session generation changes", async () => {
  const h = await makeHarness();
  try {
    let heldTargets = null;
    let announceTargets;
    const targetsRequested = new Promise((resolve) => { announceTargets = resolve; });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      if (message.method === "Target.attachToTarget") {
        queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: { sessionId: "agent-flat" } })));
      } else if (message.method === "Target.getTargets") {
        heldTargets = message;
        announceTargets();
      } else {
        queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: {} })));
      }
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-activation-generation",
      daemonInstanceId: "daemon-activation-generation"
    });
    const generation = h.control.getProfile(h.port).controlGeneration;
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    const attached = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "page-agent", flatten: true }
    }));
    await attached;

    const activation = h.gateway.activateAgentTarget(
      h.port,
      "cx-activation-generation",
      generation
    );
    await targetsRequested;
    h.control.delegateToUser("cx-activation-generation", "user_takeover");
    h.backend.emit(JSON.stringify({
      id: heldTargets.id,
      result: {
        targetInfos: [
          { targetId: "page-agent", type: "page", title: "Agent", url: "https://agent.test/" }
        ]
      }
    }));
    await assert.rejects(activation, (error) => error.code === "CONTROL_GENERATION_STALE");
    assert.equal(
      h.backend.sent.map(JSON.parse).some((message) => message.method === "Target.activateTarget"),
      false,
      "stale user reveal must not reach Chrome"
    );
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("Gateway HTTP discovery is internal-only and returns a ticketed WebSocket", async () => {
  const h = await makeHarness();
  try {
    const denied = await getJson(h.port, "/json/version", {});
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error_code, "GATEWAY_TICKET_REQUIRED");

    const allowed = await getJson(h.port, "/json/version", { "x-profilepilot-internal": "internal-secret" });
    assert.equal(allowed.status, 200);
    assert.match(allowed.body.webSocketDebuggerUrl, new RegExp(`127\\.0\\.0\\.1:${h.port}`));
    const ws = await openWebSocket(allowed.body.webSocketDebuggerUrl);
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("Gateway page WebSocket attaches a target and hides flattened session ids", async () => {
  const h = await makeHarness();
  try {
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      if (message.method === "Target.getTargets") {
        queueMicrotask(() => h.backend.emit(JSON.stringify({
          id: message.id,
          result: { targetInfos: [{ targetId: "page-1", type: "page", title: "Example", url: "https://example.com" }] }
        })));
      } else if (message.method === "Target.attachToTarget") {
        queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: { sessionId: "flat-page-1" } })));
      } else if (message.method === "Target.detachFromTarget") {
        queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: {} })));
      } else {
        queueMicrotask(() => h.backend.emit(JSON.stringify({
          id: message.id,
          sessionId: message.sessionId,
          result: { echoed: message.method }
        })));
      }
    };
    const listed = await getJson(h.port, "/json/list", { "x-profilepilot-internal": "internal-secret" });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1);
    const ws = await openWebSocket(listed.body[0].webSocketDebuggerUrl);
    const response = nextMessage(ws);
    ws.send(JSON.stringify({ id: 8, method: "Runtime.evaluate", params: { expression: "1+1" } }));
    assert.deepEqual(await response, { id: 8, result: { echoed: "Runtime.evaluate" } });
    const upstream = h.backend.sent.map(JSON.parse).find((message) => message.method === "Runtime.evaluate");
    assert.equal(upstream.sessionId, "flat-page-1");

    const focusResponse = nextMessage(ws);
    ws.send(JSON.stringify({ id: 9, method: "Page.bringToFront", params: {} }));
    assert.deepEqual(await focusResponse, { id: 9, result: { echoed: "Page.bringToFront" } });
    assert.equal(h.backend.sent.map(JSON.parse).at(-1).method, "Page.bringToFront");

    const event = nextMessage(ws);
    h.backend.emit(JSON.stringify({ method: "Runtime.consoleAPICalled", sessionId: "flat-page-1", params: { type: "log" } }));
    assert.deepEqual(await event, { method: "Runtime.consoleAPICalled", params: { type: "log" } });

    let leaked = false;
    ws.addEventListener("message", () => { leaked = true; }, { once: true });
    h.backend.emit(JSON.stringify({ method: "Runtime.consoleAPICalled", sessionId: "another-page", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(leaked, false);
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("Raw CDP policy permits useful domains and denies destructive/secret methods", () => {
  assert.equal(isRawCdpMethodAllowed("Target.activateTarget"), true);
  assert.equal(isRawCdpMethodAllowed("Runtime.evaluate"), true);
  assert.equal(isRawCdpMethodAllowed("Browser.close"), false);
  assert.equal(isRawCdpMethodAllowed("Network.getAllCookies"), false);
  assert.equal(isRawCdpMethodAllowed("Storage.clearDataForOrigin"), false);
  assert.equal(isRawCdpMethodAllowed("Target.attachToBrowserTarget"), false);
  assert.equal(isRawCdpMethodAllowed("Target.exposeDevToolsProtocol"), false);
  assert.equal(isRawCdpMethodAllowed("Target.openDevTools"), false);
  assert.equal(isRawCdpMethodAllowed("Target.sendMessageToTarget"), false);
  assert.equal(isRawCdpMethodAllowed("Target.setRemoteLocations"), false);
  assert.equal(isRawCdpMethodAllowed("SystemInfo.getInfo"), false);
});

test("Gateway handles a burst of concurrent CDP requests without id collisions", async () => {
  const h = await makeHarness();
  try {
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: { sequence: message.params.sequence } })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-burst",
      daemonInstanceId: "daemon-burst"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    const count = 500;
    const responses = collectMessages(ws, count);
    const started = performance.now();
    for (let index = 0; index < count; index += 1) {
      ws.send(JSON.stringify({ id: index + 1, method: "Runtime.evaluate", params: { sequence: index } }));
    }
    const received = await responses;
    const elapsedMs = performance.now() - started;
    assert.equal(new Set(received.map((message) => message.id)).size, count);
    assert.equal(new Set(h.backend.sent.map((text) => JSON.parse(text).id)).size, count);
    assert.ok(elapsedMs < 3_000, `500 request burst took ${elapsedMs.toFixed(1)}ms`);
    ws.close();
  } finally {
    await h.cleanup();
  }
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function openWebSocket(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return ws;
}

async function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", (event) => {
      try {
        resolve(JSON.parse(String(event.data)));
      } catch (error) {
        reject(error);
      }
    }, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

async function collectMessages(ws, count) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const onMessage = (event) => {
      try {
        messages.push(JSON.parse(String(event.data)));
        if (messages.length === count) {
          ws.removeEventListener("message", onMessage);
          resolve(messages);
        }
      } catch (error) {
        reject(error);
      }
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", reject, { once: true });
  });
}

async function waitFor(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function getJson(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
  });
}
