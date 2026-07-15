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

async function makeHarness() {
  const port = await freePort();
  const home = mkdtempSync(path.join(os.tmpdir(), "profilepilot-gateway-server-"));
  let gateway;
  const control = new BrowserGatewayControlPlane({
    homeDir: home,
    secret: Buffer.alloc(32, 9),
    onEvent: (event) => gateway?.handleControlEvent(event)
  });
  control.registerProfile({ profileId: "profile-a", profileName: "Profile A", publicPort: port });
  gateway = new BrowserGatewayServer(control, { internalSecret: "internal-secret" });
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

test("Gateway Raw CDP uses the same ownership boundary and method policy", async () => {
  const h = await makeHarness();
  try {
    h.control.acquire({ publicPort: h.port, sessionId: "cx-one", daemonInstanceId: "daemon-one" });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: { ok: true } })));
    };
    assert.deepEqual(await h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      method: "Target.activateTarget",
      params: { targetId: "t1" }
    }), { ok: true });
    await assert.rejects(() => h.gateway.callRaw({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      method: "Browser.close"
    }), (error) => error.code === "RAW_CDP_METHOD_DENIED");

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
