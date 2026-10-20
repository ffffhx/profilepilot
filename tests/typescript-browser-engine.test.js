const assert = require("node:assert/strict");
const test = require("node:test");
const { parseEngineCommand, splitCommand } = require("../dist/main/browser-engine/arguments");
const { EngineTransport } = require("../dist/main/browser-engine/transport");
const { EngineReferences } = require("../dist/main/browser-engine/snapshot");
const { BrowserEngine } = require("../dist/main/browser-engine/engine");

test("engine parses only global prefixes, preserving command text and Chinese payloads", () => {
  const parsed = parseEngineCommand(["--session", "test", "--json", "--timeout=2000", "fill", "#name", "--cdp 1234 中文"]);
  assert.equal(parsed.session, "test");
  assert.equal(parsed.timeout, 2000);
  assert.deepEqual(parsed.args, ["fill", "#name", "--cdp 1234 中文"]);
  assert.equal(parsed.endpoint, undefined);
  for (const args of [["--session", "../escape", "snapshot"], ["--timeout", "NaN"], ["--cdp"], ["--browser", "chrome"]])
    assert.throws(() => parseEngineCommand(args), error => error.code === "BROWSER_INVALID_ARGUMENTS");
  assert.deepEqual(splitCommand(`fill '#name' '$(must remain text) 中文'`), ["fill", "#name", "$(must remain text) 中文"]);
  assert.throws(() => splitCommand(`fill "#name`));
});

test("transport multiplexes independent CDP request IDs and rejects pending calls on disconnect", async () => {
  const original = global.WebSocket;
  let socket;
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() { super(); socket = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    receive(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
  }
  global.WebSocket = FakeSocket;
  try {
    const transport = await EngineTransport.connect("ws://127.0.0.1/fixture");
    const received = []; transport.onmessage = message => received.push(message);
    transport.send({ id: 1, method: "Runtime.evaluate", sessionId: "page-session" });
    const internal = transport.request("Browser.getVersion");
    assert.notEqual(socket.sent[0].id, socket.sent[1].id);
    socket.receive({ id: socket.sent[1].id, result: { product: "fixture" } });
    assert.deepEqual(await internal, { product: "fixture" });
    assert.equal(received.length, 0);
    socket.receive({ id: socket.sent[0].id, result: { value: 7 }, sessionId: "page-session" });
    await new Promise(setImmediate);
    assert.deepEqual(received[0], { id: 1, result: { value: 7 }, sessionId: "page-session" });
    let listenersReady = false, sawContext = false;
    transport.onmessage = message => {
      if (message.method === "frame-ready") Promise.resolve().then(() => {}).then(() => { listenersReady = true; });
      if (message.method === "context-ready") { assert.equal(listenersReady, true); sawContext = true; }
    };
    socket.receive({ method: "frame-ready" });
    socket.receive({ method: "context-ready" });
    await new Promise(setImmediate);
    assert.equal(sawContext, true, "drain frame initialization promises before delivering context events");
    const pending = transport.request("Target.getTargets");
    const rejected = assert.rejects(pending, error => error.code === "BROWSER_DISCONNECTED");
    transport.close(); await rejected;
    await assert.rejects(transport.request("Browser.getVersion"), error => error.code === "BROWSER_DISCONNECTED");
  } finally { global.WebSocket = original; }
});

test("refs are scoped to snapshot and page identity, and never recycled", async () => {
  const refs = new EngineReferences();
  const frame = {};
  const page = { mainFrame: () => frame, ariaSnapshot: async () => '- button "Click" [ref=e1]', getByRef: source => ({ source }) };
  const first = await refs.snapshot(page, frame, []);
  const id = Object.keys(first.refs)[0];
  assert.deepEqual(refs.locator(page, frame, `@${id}`), { source: "e1" });
  assert.throws(() => refs.locator({}, frame, `@${id}`), error => error.code === "BROWSER_STALE_REF");
  const second = await refs.snapshot(page, frame, []);
  assert.notEqual(Object.keys(second.refs)[0], id);
  assert.throws(() => refs.locator(page, frame, `@${id}`), error => error.code === "BROWSER_STALE_REF");
  refs.clear();
  assert.throws(() => refs.locator(page, frame, Object.keys(second.refs)[0]));
});

test("batch prevalidates session and transport boundaries before any input", async () => {
  const engine = new BrowserEngine();
  let executions = 0;
  const frame = { isDetached: () => false, evaluate: () => { executions++; } };
  engine.browser = { isConnected: () => true };
  engine.context = { setDefaultTimeout() {} };
  engine.transport = { request: async () => ({}) };
  engine.page = { isClosed: () => false };
  engine.frame = frame;
  for (const command of ["--session other eval 1", "--cdp 9222 eval 1", "connect ws://localhost", "close", "batch 'eval 1'"]) {
    await assert.rejects(engine.execute({ session: "fixture", json: true, timeout: 1000,
      args: ["batch", "eval 1", command] }), error => error.code === "BROWSER_INVALID_ARGUMENTS");
  }
  assert.equal(executions, 0);
});
