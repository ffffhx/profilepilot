const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { loadCli } = require("./cli-test-build.cjs");

const { BrowserGatewayControlPlane } = loadCli("src/main/browser-gateway-control.ts");
const { BrowserGatewayServer, isRawCdpMethodAllowed } = loadCli("src/main/browser-gateway-server.ts");
const { captchaBrowser } = loadCli("src/main/captcha/browser.ts");
const { waitForCaptchaResponse } = loadCli("src/main/captcha/wait.ts");

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

async function makeHarness(serverOptions = {}, kind = "browser") {
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
  await gateway.registerBackend({ publicPort: port, backend, kind });
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

test("background input requests a frame on driver and guarded CDP routes without synthetic ACK or focus", async () => {
  for (const raw of [false, true]) {
    const h = await makeHarness();
    let pendingInput;
    try {
      const reply=(m,result={})=>queueMicrotask(()=>h.backend.emit(JSON.stringify({id:m.id,sessionId:m.sessionId,result})));
      h.backend.onSend=text=>{
        const m=JSON.parse(text);
        if(m.method==='Input.dispatchMouseEvent'){pendingInput=m;return;}
        if(m.method==='Page.captureScreenshot'){
          assert.ok(pendingInput,'frame requested after the input');
          assert.equal(m.sessionId,pendingInput.sessionId);
          assert.equal(m.params.clip,undefined,'render pulses must not resize Chromium views');
          assert.equal(m.params.fromSurface,true);
          assert.equal(m.params.captureBeyondViewport,false);
          reply(pendingInput,{actualChromeAck:true});pendingInput=null;reply(m,{data:'discarded'});return;
        }
        reply(m,m.method==='Target.getTargets'?{targetInfos:[{targetId:'page',type:'page',title:'Fixture',url:'https://example.test'}]}:m.method==='Target.attachToTarget'?{sessionId:'flat'}:{});
      };
      const acquired=h.control.acquire({publicPort:h.port,sessionId:'input',daemonInstanceId:'driver'});
      let result;
      if(raw){result=await h.gateway.callRaw({publicPort:h.port,sessionId:'input',daemonInstanceId:'driver',targetId:'page',method:'Input.dispatchMouseEvent',params:{type:'mouseMoved',x:10,y:20},timeoutMs:500});}
      else {
        const ws=await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
        let response=nextMessage(ws);ws.send(JSON.stringify({id:1,method:'Target.attachToTarget',params:{targetId:'page',flatten:true}}));await response;
        response=nextMessage(ws);ws.send(JSON.stringify({id:2,method:'Input.dispatchMouseEvent',params:{type:'mouseMoved',x:10,y:20},sessionId:'flat'}));result=(await response).result;ws.close();
      }
      assert.deepEqual(result,{actualChromeAck:true});
      const methods=h.backend.sent.map(JSON.parse).map(m=>m.method);
      assert.equal(methods.filter(m=>m==='Input.dispatchMouseEvent').length,1);
      assert.ok(!methods.some(m=>['Page.bringToFront','Target.activateTarget','Emulation.setFocusEmulationEnabled'].includes(m)));
    } finally {await h.cleanup();}
  }
});

test("input frames coalesce during a burst and stop after takeover without masking input errors", async () => {
  const h=await makeHarness();let capture, captureCount=0;
  const reply=(m,payload={result:{}})=>queueMicrotask(()=>h.backend.emit(JSON.stringify({id:m.id,sessionId:m.sessionId,...payload})));
  try {
    h.backend.onSend=text=>{
      const m=JSON.parse(text);
      if(m.method==='Target.attachToTarget')return reply(m,{result:{sessionId:'flat'}});
      if(m.method==='Page.captureScreenshot'){capture=m;captureCount++;return;}
      if(m.method==='Input.dispatchMouseEvent')return reply(m,{error:{code:-32000,message:'actual input failure'}});
      reply(m);
    };
    const lease=h.control.acquire({publicPort:h.port,sessionId:'frames',daemonInstanceId:'driver'});
    const ws=await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(lease.ticket)}`);
    let response=nextMessage(ws);ws.send(JSON.stringify({id:1,method:'Target.attachToTarget',params:{targetId:'page',flatten:true}}));await response;
    for(const id of [2,3]){
      response=nextMessage(ws);ws.send(JSON.stringify({id,method:'Input.dispatchMouseEvent',sessionId:'flat',params:{type:'mouseMoved',x:id,y:id}}));
      assert.equal((await response).error.message,'actual input failure');
    }
    assert.equal(captureCount,1);
    h.control.delegateToUser('frames','user_takeover');
    reply(capture,{result:{data:'discarded'}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(captureCount,1,'no queued rendering after control changes');
    ws.close();
  } finally {await h.cleanup();}
});

// Complete, independently encoded PNG files, not fabricated IHDR headers.
// Keeping these fixtures inline avoids image-library or platform dependencies.
const screenshotPngFixtures = {
  onePixel: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY0iZ+vY/AAYtAuY09dZ/AAAAAElFTkSuQmCC",
  twoPixels: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAARSURBVBhXY0iZ+vY/CDPAGABj9AuVOvfRrAAAAABJRU5ErkJggg==",
  normal: "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAuSURBVEhLY0iZ+vb/QGIGdAF641EHjDpg1AGjDhh1wKgDRh0w6oBRB4w6YNQBABY2r3kHmyLXAAAAAElFTkSuQmCC",
  narrow: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAARSURBVBhXY0iZ+vY/CDNgMADkFRFfhZFg+QAAAABJRU5ErkJggg=="
};

for (const route of ["driver", "raw"]) {
  test(`Gateway ${route} rejects collapsed screenshots and preserves valid captures`, async (t) => {
    const h = await makeHarness();
    let ws;
    let screenshotResult;
    let requestId = 0;
    const screenshotRequests = [];
    try {
      h.backend.onSend = (text) => {
        const message = JSON.parse(text);
        let result = {};
        if (message.method === "Target.getTargets") {
          result = { targetInfos: [{ targetId: "page", type: "page", title: "Screenshot fixture", url: "https://example.test" }] };
        } else if (message.method === "Target.attachToTarget") {
          result = { sessionId: "flat-screenshot" };
        } else if (message.method === "Page.captureScreenshot") {
          screenshotRequests.push(message);
          result = screenshotResult;
        }
        queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, sessionId: message.sessionId, result })));
      };
      const acquired = h.control.acquire({ publicPort: h.port, sessionId: "screenshots", daemonInstanceId: "driver" });
      if (route === "driver") {
        ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
        const response = nextMessage(ws);
        ws.send(JSON.stringify({ id: ++requestId, method: "Target.attachToTarget", params: { targetId: "page", flatten: true } }));
        assert.deepEqual((await response).result, { sessionId: "flat-screenshot" });
      }

      const scenarios = [
        { name: "default PNG rejects a collapsed 1x1 viewport", data: screenshotPngFixtures.onePixel, params: {}, rejected: true },
        { name: "explicit PNG rejects a collapsed 2x2 viewport", data: screenshotPngFixtures.twoPixels, params: { format: "png" }, rejected: true },
        { name: "an intentional 1x1 crop is returned intact", data: screenshotPngFixtures.onePixel, params: { format: "png", clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } } },
        { name: "an intentional crop with a 2x2 bitmap is returned intact", data: screenshotPngFixtures.twoPixels, params: { format: "png", clip: { x: 5, y: 7, width: 1, height: 1, scale: 2 } } },
        { name: "a normal 32x24 PNG is returned intact", data: screenshotPngFixtures.normal, params: { format: "png", fromSurface: true, captureBeyondViewport: false } },
        { name: "a narrow 2x3 PNG is not mistaken for a collapsed viewport", data: screenshotPngFixtures.narrow, params: { format: "png" } }
      ];
      for (const scenario of scenarios) {
        await t.test(scenario.name, async () => {
          screenshotResult = { data: scenario.data };
          const before = screenshotRequests.length;
          if (route === "driver") {
            const response = nextMessage(ws);
            const id = ++requestId;
            ws.send(JSON.stringify({ id, method: "Page.captureScreenshot", params: scenario.params, sessionId: "flat-screenshot" }));
            const message = await response;
            assert.equal(message.id, id, "the screenshot response retains its caller's request id");
            assert.equal(message.sessionId, "flat-screenshot");
            if (scenario.rejected) {
              assert.equal(message.result, undefined, "a failed observation must not expose image data as success");
              assert.equal(message.error.code, -32000);
              assert.match(message.error.message, /SCREENSHOT_INVALID_SIZE/);
            } else {
              assert.equal(message.error, undefined);
              assert.deepEqual(message.result, screenshotResult);
            }
          } else {
            const capture = () => h.gateway.callRaw({
              publicPort: h.port,
              sessionId: "screenshots",
              daemonInstanceId: "driver",
              targetId: "page",
              method: "Page.captureScreenshot",
              params: scenario.params,
              timeoutMs: 500
            });
            if (scenario.rejected) await assert.rejects(capture, /SCREENSHOT_INVALID_SIZE/);
            else assert.deepEqual(await capture(), screenshotResult);
          }
          assert.equal(screenshotRequests.length, before + 1, "invalid observations are not silently recaptured");
          assert.deepEqual(screenshotRequests.at(-1).params, scenario.params, "the caller's crop and capture options reach Chrome unchanged");
        });
      }
    } finally {
      ws?.close();
      await h.cleanup();
    }
  });
}

test("Electron routes virtualize focus and webview activation and cannot create or close the application", async () => {
  const h = await makeHarness({}, "electron");
  try {
    h.backend.onSend = text => {
      const message = JSON.parse(text);
      const result = message.method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "webview", type: "webview", title: "App", url: "file:///app.html" }] }
        : message.method === "Target.attachToTarget" ? { sessionId: "flat-app" } : {};
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, sessionId: message.sessionId, result })));
    };
    const acquired = h.control.acquire({ publicPort: h.port, sessionId: "cx-electron", daemonInstanceId: "daemon-electron" });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    let id = 0;
    const send = async (method, params = {}, sessionId) => {
      const response = nextMessage(ws);
      ws.send(JSON.stringify({ id: ++id, method, params, sessionId }));
      return response;
    };
    assert.ok((await send("Target.attachToTarget", { targetId: "webview", flatten: true })).result);
    assert.ok((await send("Target.activateTarget", { targetId: "webview" })).result);
    assert.ok((await send("Page.bringToFront", {}, "flat-app")).result);
    assert.ok((await send("Browser.setWindowBounds", { windowId: 1, bounds: { windowState: "maximized" } })).result);
    assert.equal((await h.gateway.getAgentTarget(h.port, "cx-electron")).targetId, "webview");
    for (const method of ["Target.createTarget", "Browser.close"]) {
      assert.equal((await send(method, { url: "about:blank" })).error.code, -32601);
    }
    const forbidden = new Set(["Target.activateTarget", "Page.bringToFront", "Browser.setWindowBounds", "Target.createTarget", "Browser.close"]);
    assert.ok(!h.backend.sent.map(JSON.parse).some(message => forbidden.has(message.method)));
    ws.close();
  } finally { await h.cleanup(); }
});

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
    const activity = h.gateway.getAgentActivity(h.port, "cx-one", "daemon-one");
    assert.equal(activity.generation, 1);
    assert.equal(activity.lastCdpMethod, "Browser.getVersion");
    assert.ok(Date.parse(activity.lastCdpAt));

    const event = nextMessage(ws);
    h.backend.emit(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: { targetId: "t1" } } }));
    assert.equal((await event).method, "Target.targetCreated");
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("Gateway does not let background target activity overwrite the Agent tab affinity", async () => {
  const targetChanges = [];
  const h = await makeHarness({
    onAgentTargetChange: (publicPort, change) => targetChanges.push({ publicPort, ...change })
  });
  try {
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      const result = message.method === "Target.attachToTarget"
        ? { sessionId: message.params.targetId === "page-deepseek" ? "flat-deepseek" : "flat-tencent" }
        : { echoed: message.method };
      queueMicrotask(() => h.backend.emit(JSON.stringify({
        id: message.id,
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        result
      })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-target-trace",
      daemonInstanceId: "daemon-target-trace"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);

    let response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "page-deepseek", flatten: true }
    }));
    await response;

    response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 2,
      method: "Target.attachToTarget",
      params: { targetId: "page-tencent", flatten: true }
    }));
    await response;

    response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 3,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
      sessionId: "flat-deepseek"
    }));
    await response;

    response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 4,
      method: "Runtime.callFunctionOn",
      params: { objectId: "background-object", functionDeclaration: "function () { return this.title; }" },
      sessionId: "flat-deepseek"
    }));
    await response;

    assert.deepEqual(targetChanges.map(({ sessionId, previousTargetId, targetId, source }) => ({
      sessionId,
      previousTargetId,
      targetId,
      source
    })), [
      {
        sessionId: "cx-target-trace",
        previousTargetId: null,
        targetId: "page-deepseek",
        source: "agent-cdp-response:Target.attachToTarget"
      },
      {
        sessionId: "cx-target-trace",
        previousTargetId: "page-deepseek",
        targetId: "page-tencent",
        source: "agent-cdp-response:Target.attachToTarget"
      }
    ]);
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("Gateway handoff refuses to activate an unrelated tab when the exact Agent target is missing", async () => {
  const h = await makeHarness();
  try {
    h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-no-target",
      daemonInstanceId: "daemon-no-target"
    });
    const delegated = h.control.delegateToUser("cx-no-target", "user_takeover", "人工登录");
    await assert.rejects(
      () => h.gateway.activateDelegatedAgentTarget(
        h.port,
        "cx-no-target",
        delegated.controlGeneration
      ),
      (error) => error.code === "GATEWAY_AGENT_TARGET_MISMATCH"
    );
    assert.equal(
      h.backend.sent.map(JSON.parse).some((message) => message.method === "Target.activateTarget"),
      false
    );
  } finally {
    await h.cleanup();
  }
});

test("Gateway parks agent-browser across takeover and resumes the same socket on return", async () => {
  const h = await makeHarness();
  try {
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      driverKind: "agent-browser"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    let closed = false;
    ws.addEventListener("close", () => { closed = true; }, { once: true });
    h.control.delegateToUser("cx-one", "user_takeover");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closed, false);
    assert.equal(h.gateway.hasActiveAgentConnection(h.port, "cx-one", "daemon-one"), true);

    h.control.returnToAgent("cx-one");
    const identity = {
      sessionId: "cx-one",
      profileId: acquired.profile.profileId,
      publicPort: h.port,
      daemonInstanceId: "daemon-one",
      controlGeneration: h.control.getProfile(h.port).controlGeneration,
      kind: "agent"
    };
    assert.doesNotThrow(() => h.control.assertConnectionCanSend(identity));
    assert.equal(h.gateway.hasActiveAgentConnection(h.port, "cx-one", "daemon-one"), true);
    assert.equal(closed, false);
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("Gateway parks agent-browser across takeover and replays buffered events before resuming commands", async () => {
  const h = await makeHarness();
  try {
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      const result = message.method === "Target.attachToTarget"
        ? { sessionId: "flat-agent-browser" }
        : { echoed: message.method };
      queueMicrotask(() => h.backend.emit(JSON.stringify({
        id: message.id,
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        result
      })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-agent-browser",
      daemonInstanceId: "daemon-agent-browser",
      driverKind: "agent-browser",
      driverLabel: "agent-browser CLI"
    });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);

    let response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "page-one", flatten: true }
    }));
    assert.deepEqual(await response, { id: 1, result: { sessionId: "flat-agent-browser" } });
    assert.equal(await h.gateway.quiesceAgentSession(h.port, "cx-agent-browser", 500), true);

    let closed = false;
    ws.addEventListener("close", () => { closed = true; }, { once: true });
    h.control.delegateToUser("cx-agent-browser", "user_takeover");

    const sentBeforeBlockedCommand = h.backend.sent.length;
    response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 2,
      method: "Runtime.evaluate",
      params: { expression: "document.title" },
      sessionId: "flat-agent-browser"
    }));
    const blocked = await response;
    assert.equal(blocked.id, 2);
    assert.equal(blocked.sessionId, "flat-agent-browser");
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
      sessionId: "flat-agent-browser",
      params: { type: "log", args: [] }
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(replayed, false, "user-time events must stay hidden while the driver is parked");
    assert.equal(closed, false, "a resumable driver keeps the same physical WebSocket");

    h.control.returnToAgent("cx-agent-browser");
    assert.deepEqual(await replay, {
      method: "Runtime.consoleAPICalled",
      sessionId: "flat-agent-browser",
      params: { type: "log", args: [] }
    });

    response = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 3,
      method: "Runtime.evaluate",
      params: { expression: "1 + 1" },
      sessionId: "flat-agent-browser"
    }));
    assert.deepEqual(await response, {
      id: 3,
      result: { echoed: "Runtime.evaluate" },
      sessionId: "flat-agent-browser"
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
      "Target.setRemoteLocations",
      "Network.deleteCookies",
      "Network.deleteDeviceBoundSession",
      "Page.crash",
      "Page.setDownloadBehavior",
      "Network.futureSensitiveMethod",
      "DOM.futureSensitiveMethod"
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

test("Gateway applies a bounded device preset and clears it before user takeover", async () => {
  const h = await makeHarness();
  try {
    h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-device",
      daemonInstanceId: "daemon-device",
      driverKind: "agent-browser"
    });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      const result = message.method === "Target.getTargets"
        ? {
            targetInfos: [
              { targetId: "mobile-page", type: "page", title: "Mobile", url: "https://example.test/" }
            ]
          }
        : message.method === "Target.attachToTarget"
          ? { sessionId: "device-flat-session" }
          : {};
      queueMicrotask(() => h.backend.emit(JSON.stringify({
        id: message.id,
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        result
      })));
    };

    const emulation = await h.gateway.controlDeviceEmulation({
      publicPort: h.port,
      sessionId: "cx-device",
      daemonInstanceId: "daemon-device",
      command: "emulate",
      preset: "iphone-16-pro"
    });
    assert.deepEqual(emulation, {
      preset: "iphone-16-pro",
      targetId: "mobile-page",
      width: 402,
      height: 874,
      deviceScaleFactor: 3,
      mobile: true,
      maxTouchPoints: 5,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      platform: "iPhone"
    });
    const applied = h.backend.sent.map(JSON.parse);
    const metrics = applied.find((message) => message.method === "Emulation.setDeviceMetricsOverride");
    assert.equal(metrics.sessionId, "device-flat-session");
    assert.deepEqual(
      {
        width: metrics.params.width,
        height: metrics.params.height,
        deviceScaleFactor: metrics.params.deviceScaleFactor,
        mobile: metrics.params.mobile
      },
      { width: 402, height: 874, deviceScaleFactor: 3, mobile: true }
    );
    assert.equal(
      applied.find((message) => message.method === "Emulation.setTouchEmulationEnabled").params.maxTouchPoints,
      5
    );
    assert.match(
      applied.find((message) => message.method === "Emulation.setUserAgentOverride").params.userAgent,
      /iPhone/
    );
    assert.equal(
      applied.find((message) => message.method === "Emulation.setUserAgentOverride").params.platform,
      "iPhone"
    );
    assert.deepEqual(await h.gateway.controlDeviceEmulation({
      publicPort: h.port,
      sessionId: "cx-device",
      daemonInstanceId: "daemon-device",
      command: "status"
    }), emulation);
    h.backend.emit(JSON.stringify({
      method: "Target.detachedFromTarget",
      params: { sessionId: "device-flat-session" }
    }));
    await waitFor(
      () => h.backend.sent.map(JSON.parse).filter(
        (message) => message.method === "Emulation.setDeviceMetricsOverride"
      ).length >= 2,
      "device emulation reapplied after an unexpected target-session detach"
    );
    assert.deepEqual(await h.gateway.controlDeviceEmulation({
      publicPort: h.port,
      sessionId: "cx-device",
      daemonInstanceId: "daemon-device",
      command: "status"
    }), emulation);
    await assert.rejects(() => h.gateway.controlDeviceEmulation({
      publicPort: h.port,
      sessionId: "cx-device",
      daemonInstanceId: "daemon-device",
      command: "emulate",
      preset: "arbitrary-device"
    }), (error) => error.code === "DEVICE_PRESET_NOT_SUPPORTED");

    h.control.delegateToUser("cx-device", "user_takeover");
    await waitFor(
      () => h.backend.sent.map(JSON.parse).some(
        (message) => message.method === "Emulation.clearDeviceMetricsOverride"
      ),
      "device metrics cleared before user control"
    );
    await waitFor(
      () => h.backend.sent.map(JSON.parse).some(
        (message) =>
          message.method === "Emulation.setUserAgentOverride" &&
          message.params.userAgent === ""
      ),
      "mobile UA cleared before user control"
    );
    await waitFor(
      () => h.backend.sent.map(JSON.parse).some(
        (message) =>
          message.method === "Target.detachFromTarget" &&
          message.params.sessionId === "device-flat-session"
      ),
      "device session detached before user control"
    );
  } finally {
    await h.cleanup();
  }
});

test("Gateway preserves a device preset only for an explicit user verification handoff", async () => {
  const h = await makeHarness();
  try {
    h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-device-preview",
      daemonInstanceId: "daemon-device-preview",
      driverKind: "agent-browser"
    });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      const result = message.method === "Target.getTargets"
        ? {
            targetInfos: [
              { targetId: "preview-page", type: "page", title: "Preview", url: "https://example.test/" }
            ]
          }
        : message.method === "Target.attachToTarget"
          ? { sessionId: "preview-device-session" }
          : {};
      queueMicrotask(() => h.backend.emit(JSON.stringify({
        id: message.id,
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        result
      })));
    };

    await h.gateway.controlDeviceEmulation({
      publicPort: h.port,
      sessionId: "cx-device-preview",
      daemonInstanceId: "daemon-device-preview",
      command: "emulate",
      preset: "iphone-16-pro"
    });
    assert.equal(
      h.gateway.prepareDeviceEmulationUserHandoff(h.port, "cx-device-preview"),
      true
    );
    const delegated = h.control.delegateToUser(
      "cx-device-preview",
      "user_takeover",
      "人工验证手机页面"
    );
    await h.gateway.activateDelegatedAgentTarget(
      h.port,
      "cx-device-preview",
      delegated.controlGeneration,
      500,
      true
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      h.backend.sent.map(JSON.parse).some(
        (message) => message.method === "Emulation.clearDeviceMetricsOverride"
      ),
      false,
      "the explicit preview handoff keeps the mobile viewport while Agent commands are revoked"
    );
    assert.equal(h.control.getProfile(h.port)?.ownership, "user");

    h.control.returnToAgent("cx-device-preview");
    await h.gateway.clearDeviceEmulationForSession(h.port, "cx-device-preview");
    assert.equal(
      h.backend.sent.map(JSON.parse).some(
        (message) => message.method === "Emulation.clearDeviceMetricsOverride"
      ),
      true,
      "returning control lets the Agent explicitly restore the desktop viewport"
    );
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

test("Gateway recovers when Chrome loads an unpacked extension but its success response misses the deadline", async () => {
  const h = await makeHarness();
  try {
    h.control.acquire({ publicPort: h.port, sessionId: "cx-one", daemonInstanceId: "daemon-one" });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      if (message.method === "Extensions.loadUnpacked") {
        return;
      }
      if (message.method === "Extensions.getExtensions") {
        queueMicrotask(() => h.backend.emit(JSON.stringify({
          id: message.id,
          result: {
            extensions: [{
              id: "extension-one",
              name: "Fixture Extension",
              version: "0.2.5",
              path: "/tmp/fixture-extension",
              enabled: true
            }]
          }
        })));
      }
    };

    assert.deepEqual(await h.gateway.loadUnpackedExtension({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      extensionPath: "/tmp/fixture-extension",
      extensionVersion: "0.2.5",
      timeoutMs: 5,
      verificationTimeoutMs: 50,
      verificationIntervalMs: 1
    }), {
      id: "extension-one",
      recoveredFromTimeout: true
    });
    assert.deepEqual(
      h.backend.sent.map(JSON.parse).map((message) => message.method),
      ["Extensions.loadUnpacked", "Extensions.getExtensions"]
    );
  } finally {
    await h.cleanup();
  }
});

test("Gateway keeps the original timeout when post-timeout verification finds a different extension version", async () => {
  const h = await makeHarness();
  try {
    h.control.acquire({ publicPort: h.port, sessionId: "cx-one", daemonInstanceId: "daemon-one" });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      if (message.method === "Extensions.getExtensions") {
        queueMicrotask(() => h.backend.emit(JSON.stringify({
          id: message.id,
          result: {
            extensions: [{
              id: "extension-one",
              version: "0.2.4",
              path: "/tmp/fixture-extension",
              enabled: true
            }]
          }
        })));
      }
    };

    await assert.rejects(() => h.gateway.loadUnpackedExtension({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      extensionPath: "/tmp/fixture-extension",
      extensionVersion: "0.2.5",
      timeoutMs: 5,
      verificationTimeoutMs: 15,
      verificationIntervalMs: 1
    }), (error) =>
      error.code === "CDP_CALL_TIMEOUT" &&
      error.method === "Extensions.loadUnpacked"
    );
  } finally {
    await h.cleanup();
  }
});

test("Gateway triggers an enabled extension action only on an owned page target", async () => {
  const h = await makeHarness();
  const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  try {
    h.control.acquire({ publicPort: h.port, sessionId: "cx-one", daemonInstanceId: "daemon-one" });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      const result = message.method === "Extensions.getExtensions"
        ? { extensions: [{ id: extensionId, enabled: true }] }
        : message.method === "Target.getTargets"
          ? message.params?.filter
            ? {
                targetInfos: [{
                  targetId: "tab-1",
                  type: "tab",
                  url: "https://example.test/",
                  browserContextId: "context-1",
                  embedderData: { tabActive: true }
                }]
              }
            : {
                targetInfos: [{
                  targetId: "page-1",
                  type: "page",
                  url: "https://example.test/",
                  browserContextId: "context-1"
                }]
              }
          : {};
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result })));
    };

    assert.deepEqual(await h.gateway.triggerExtensionAction({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      extensionId,
      targetId: "page-1"
    }), {
      extensionId,
      targetId: "page-1",
      actionTargetId: "tab-1"
    });
    assert.deepEqual(
      h.backend.sent.map(JSON.parse).map((message) => [message.method, message.params]),
      [
        ["Extensions.getExtensions", {}],
        ["Target.getTargets", {}],
        ["Target.getTargets", { filter: [{ type: "tab" }] }],
        ["Target.activateTarget", { targetId: "tab-1" }],
        ["Extensions.triggerAction", { id: extensionId, targetId: "tab-1" }]
      ]
    );

    h.control.delegateToUser("cx-one", "user_takeover");
    await assert.rejects(() => h.gateway.triggerExtensionAction({
      publicPort: h.port,
      sessionId: "cx-one",
      daemonInstanceId: "daemon-one",
      extensionId,
      targetId: "page-1"
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
        : message.method === "Target.getTargets"
          ? { targetInfos: [{ targetId: "page-affinity", type: "page" }] }
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
      "Target.getTargets",
      "Target.attachToTarget",
      "Runtime.evaluate",
      "Target.detachFromTarget"
    ]);
    assert.equal(sent[1].params.targetId, "page-affinity");
    ws.close();
  } finally {
    await h.cleanup();
  }
});

test("OOPIF input preserves page affinity and captcha wait evaluates that page instead of the first tab", async () => {
  const changes = [];
  const h = await makeHarness({ onAgentTargetChange: (_port, change) => changes.push(change) });
  const targets = [
    { targetId: "initial-blank", type: "page", url: "about:blank", title: "" },
    { targetId: "captcha-page", type: "page", url: "https://demo.test/captcha", title: "CAPTCHA demo" },
    { targetId: "challenge-frame", type: "iframe", url: "https://challenge.test/", title: "Challenge" },
    { targetId: "nested-frame", type: "iframe" },
    { targetId: "unparented-frame", type: "iframe" }
  ];
  const context = (target) => vm.createContext({
    window: {}, location: { href: target.url || "about:blank" },
    document: { documentElement: { matches: () => false, querySelectorAll: () => target.targetId === "captcha-page"
      ? [{ name: "h-captcha-response", id: "h-captcha-response-fixture", value: "" }]
      : [] } }
  });
  const documents = new Map(targets.map(target => [target.targetId, context(target)]));
  const attachedTargets = new Map();
  const evaluatedTargets = [];
  let nextAttach = 0;
  try {
    const reply = (message, result = {}) => queueMicrotask(() => h.backend.emit(JSON.stringify({
      id: message.id, sessionId: message.sessionId, result
    })));
    h.backend.onSend = text => {
      const message = JSON.parse(text);
      if (message.method === "Target.getTargets") return reply(message, { targetInfos: targets });
      if (message.method === "Target.attachToTarget") {
        const sessionId = `attached-${++nextAttach}`;
        attachedTargets.set(sessionId, message.params.targetId);
        if (message.params.targetId === "challenge-frame") {
          // Explicit reattach replies must retain the ancestry from the event.
          queueMicrotask(() => h.backend.emit(JSON.stringify({
            method: "Target.attachedToTarget", sessionId: "attached-1",
            params: { sessionId, targetInfo: targets[2], waitingForDebugger: false }
          })));
        }
        return reply(message, { sessionId });
      }
      if (message.method === "Runtime.evaluate" && message.params.expression.includes("__profilepilotCaptchaWaitV1")) {
        const target = attachedTargets.get(message.sessionId);
        evaluatedTargets.push(target);
        return reply(message, { result: { value: vm.runInContext(message.params.expression, documents.get(target)) } });
      }
      reply(message);
    };
    const sessionId = "oopif-captcha", daemonInstanceId = "oopif-driver";
    const acquired = h.control.acquire({ publicPort: h.port, sessionId, daemonInstanceId });
    const ws = await openWebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`);
    let id = 0;
    const command = async (method, params, cdpSessionId) => {
      const response = nextMessage(ws);
      ws.send(JSON.stringify({ id: ++id, method, params, sessionId: cdpSessionId }));
      const result = await response;
      assert.equal(result.error, undefined);
      return result;
    };
    await command("Target.attachToTarget", { targetId: "captcha-page", flatten: true });
    await command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    for (const [target, cdpSessionId, parentSessionId] of [
      [targets[2], "challenge-flat", "attached-1"],
      [targets[3], "nested-flat", "challenge-flat"],
      [targets[4], "unparented-flat", undefined]
    ]) {
      const event = nextMessage(ws);
      h.backend.emit(JSON.stringify({
        method: "Target.attachedToTarget", sessionId: parentSessionId,
        params: { sessionId: cdpSessionId, targetInfo: target, waitingForDebugger: false }
      }));
      await event;
      await command("Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 }, cdpSessionId);
      const forwarded = h.backend.sent.map(JSON.parse).filter(m => m.method === "Input.dispatchMouseEvent").at(-1);
      assert.equal(forwarded.sessionId, cdpSessionId, "input must still reach the original iframe session");
      assert.equal((await h.gateway.getAgentTarget(h.port, sessionId))?.targetId, "captcha-page",
        "status must not clear the page affinity after iframe input");
    }
    const reattach = collectMessages(ws, 2);
    ws.send(JSON.stringify({ id: ++id, method: "Target.attachToTarget", params: { targetId: "challenge-frame", flatten: true } }));
    await reattach;
    assert.equal((await h.gateway.getAgentTarget(h.port, sessionId))?.targetId, "captcha-page");
    const browser = captchaBrowser({ connection: "gateway", port: h.port, sessionId }, { HOME: h.home }, {
      identity: () => daemonInstanceId,
      gateway: async request => request.action === "status"
        ? { state: h.control.snapshot() }
        : { result: await h.gateway.callRaw(request) }
    });
    const result = await waitForCaptchaResponse(browser, { timeout: 0 });
    assert.equal(result.status, "pending", "the page contains an empty response field; blank/iframe documents do not");
    assert.equal(result.kind, "hcaptcha");
    assert.equal(result.verified, false);
    assert.deepEqual(evaluatedTargets, ["captcha-page"]);
    assert.ok(changes.every(change => !change || change.targetId === "captcha-page"),
      "no iframe or fallback blank page may become the Agent's tab target");
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
    await waitFor(() => h.backend.sent.map(JSON.parse).some(
      (message) => message.method === "Target.detachFromTarget" && message.params.sessionId === "auto-flat"
    ), "Agent child session cleanup after Auto-Attach reset");
  } finally {
    await h.cleanup();
  }
});

test("Gateway finishes old Agent CDP cleanup before accepting a reconnect for the same Session", async () => {
  const h = await makeHarness();
  try {
    let attachCount = 0;
    let heldAutoAttachReset = null;
    let announceAutoAttachReset;
    const autoAttachResetReady = new Promise((resolve) => {
      announceAutoAttachReset = resolve;
    });
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      if (message.method === "Target.attachToTarget") {
        attachCount += 1;
        const sessionId = attachCount === 1 ? "old-flat" : "new-flat";
        queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: { sessionId } })));
        return;
      }
      if (message.method === "Target.setAutoAttach" && message.params.autoAttach === false) {
        heldAutoAttachReset = message;
        announceAutoAttachReset();
        return;
      }
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: {} })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-clean-reconnect",
      daemonInstanceId: "daemon-clean-reconnect"
    });
    const oldWs = await openWebSocket(
      `ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`
    );

    let response = nextMessage(oldWs);
    oldWs.send(JSON.stringify({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "page-one", flatten: true }
    }));
    assert.equal((await response).result.sessionId, "old-flat");
    response = nextMessage(oldWs);
    oldWs.send(JSON.stringify({
      id: 2,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId: "old-flat"
    }));
    await response;

    const oldClosed = new Promise((resolve) => oldWs.addEventListener("close", resolve, { once: true }));
    oldWs.close();
    await oldClosed;
    await autoAttachResetReady;
    assert.equal(heldAutoAttachReset.sessionId, "old-flat");
    assert.equal(
      h.backend.sent.map(JSON.parse).some(
        (message) => message.method === "Target.detachFromTarget" && message.params.sessionId === "old-flat"
      ),
      false,
      "the old page session must stay alive until its scoped Auto-Attach controller is disabled"
    );

    const reacquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-clean-reconnect",
      daemonInstanceId: "daemon-clean-reconnect"
    });
    let reconnectAccepted = false;
    const reconnect = openWebSocket(
      `ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(reacquired.ticket)}`
    ).then((ws) => {
      reconnectAccepted = true;
      return ws;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(reconnectAccepted, false, "the replacement socket must wait for old CDP cleanup");
    assert.equal(attachCount, 1, "the replacement driver must not attach while old cleanup is pending");

    const resetReleasedAt = Date.now();
    h.backend.emit(JSON.stringify({ id: heldAutoAttachReset.id, result: {} }));
    setTimeout(() => {
      h.backend.emit(JSON.stringify({
        method: "Target.detachedFromTarget",
        params: { sessionId: "late-auto-flat", targetId: "page-one" }
      }));
    }, 20);
    const newWs = await reconnect;
    assert.equal(
      Date.now() - resetReleasedAt >= 55,
      true,
      "the replacement socket must wait for late Auto-Attach lifecycle events to become quiet"
    );
    response = nextMessage(newWs);
    newWs.send(JSON.stringify({
      id: 3,
      method: "Target.attachToTarget",
      params: { targetId: "page-one", flatten: true }
    }));
    assert.equal((await response).result.sessionId, "new-flat");
    response = nextMessage(newWs);
    newWs.send(JSON.stringify({
      id: 4,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId: "new-flat"
    }));
    assert.deepEqual(await response, { id: 4, result: {}, sessionId: "new-flat" });
    assert.equal(
      h.backend.sent.map(JSON.parse).filter(
        (message) => message.method === "Target.setAutoAttach" && message.params.autoAttach === true
      ).length,
      1,
      "the replacement driver must not reinstall Auto-Attach and replace its freshly attached primary session"
    );
    response = nextMessage(newWs);
    newWs.send(JSON.stringify({
      id: 5,
      method: "DOM.enable",
      params: {},
      sessionId: "new-flat"
    }));
    assert.deepEqual(await response, { id: 5, result: {}, sessionId: "new-flat" });
    newWs.close();
  } finally {
    await h.cleanup();
  }
});

test("Gateway follows the tab an Agent actually operates after auto-attach", async () => {
  const h = await makeHarness();
  try {
    h.backend.onSend = (text) => {
      const message = JSON.parse(text);
      if (message.method === "Target.attachToTarget") {
        const sessionId = message.params.targetId === "page-figma" ? "figma-flat" : "trusted-iproyal";
        queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: { sessionId } })));
        return;
      }
      if (message.method === "Target.setAutoAttach" && message.params.autoAttach === true) {
        queueMicrotask(() => {
          h.backend.emit(JSON.stringify({
            method: "Target.attachedToTarget",
            params: {
              sessionId: "iproyal-flat",
              targetInfo: { targetId: "page-iproyal", type: "page" },
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
              { targetId: "page-figma", type: "page", title: "Figma", url: "https://figma.com/design/one" },
              { targetId: "page-iproyal", type: "page", title: "完成订单 - IPRoyal", url: "https://iproyal.com/order" }
            ]
          }
        })));
        return;
      }
      queueMicrotask(() => h.backend.emit(JSON.stringify({ id: message.id, result: {} })));
    };
    const acquired = h.control.acquire({
      publicPort: h.port,
      sessionId: "cx-real-target",
      daemonInstanceId: "daemon-real-target"
    });
    const ws = await openWebSocket(
      `ws://127.0.0.1:${h.port}/devtools/browser/gateway?ticket=${encodeURIComponent(acquired.ticket)}`
    );

    const figmaAttached = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 1,
      method: "Target.attachToTarget",
      params: { targetId: "page-figma", flatten: true }
    }));
    await figmaAttached;

    const autoAttachMessages = collectMessages(ws, 2);
    ws.send(JSON.stringify({
      id: 2,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
    }));
    await autoAttachMessages;

    const passiveSetup = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 3,
      method: "Runtime.enable",
      params: {},
      sessionId: "iproyal-flat"
    }));
    await passiveSetup;
    assert.equal((await h.gateway.getAgentTarget(h.port, "cx-real-target")).targetId, "page-figma");

    const inputCommand = nextMessage(ws);
    ws.send(JSON.stringify({
      id: 4,
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 },
      sessionId: "iproyal-flat"
    }));
    await inputCommand;
    const inputMessages = h.backend.sent.map(JSON.parse);
    const mousePressedIndex = inputMessages.findIndex(
      (message) => message.method === "Input.dispatchMouseEvent" && message.params?.type === "mousePressed"
    );
    const avoidance = inputMessages[mousePressedIndex - 1];
    assert.equal(avoidance.method, "Runtime.evaluate", "HUD avoidance must be queued immediately before the click");
    assert.equal(avoidance.sessionId, "iproyal-flat");
    assert.match(avoidance.params.expression, /document\.elementsFromPoint/);
    assert.match(avoidance.params.expression, /__pp-agent-overlay-avoid/);
    assert.deepEqual(await h.gateway.getAgentTarget(h.port, "cx-real-target"), {
      targetId: "page-iproyal",
      title: "完成订单 - IPRoyal",
      url: "https://iproyal.com/order"
    });

    assert.equal((await h.gateway.activateAgentTarget(
      h.port,
      "cx-real-target",
      h.control.getProfile(h.port).controlGeneration
    )).targetId, "page-iproyal");
    const activation = h.backend.sent
      .map(JSON.parse)
      .filter((message) => message.method === "Target.activateTarget")
      .at(-1);
    assert.equal(activation.params.targetId, "page-iproyal");

    ws.close();
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
