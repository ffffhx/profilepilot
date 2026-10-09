const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTsModule } = require("./helpers/load-ts-module");
const { localAppAvailability, localAppAgentLabel } = loadTsModule("src/shared/local-app-presentation.ts");

const running = () => ({
  mode:"launch", runtime:{status:"running"}, controls:{start:false},
  debug:{renderer:true,main:true}, agent:{connected:true}
});
test("availability requires a live protected UI connection, not just an open debug port", () => {
  const app = running();
  assert.equal(localAppAvailability(app).ready, true);
  app.agent.connected = false;
  assert.equal(localAppAvailability(app).ready, false);
  app.agent.connected = true; app.debug.renderer = false;
  assert.equal(localAppAvailability(app).ready, false);
  app.debug.renderer = true; app.runtime.status = "stopped";
  assert.equal(localAppAvailability(app).ready, false);
  app.runtime.status = "running"; app.mode = "service";
  assert.equal(localAppAvailability(app).label, "不支持界面操作");
});
test("Agent status separates occupancy, handoff and connection activity", () => {
  const app = running();
  assert.equal(localAppAgentLabel(app), "未被使用");
  Object.assign(app.agent, {sessionId:"session",ownership:"agent",connectionActive:false});
  assert.equal(localAppAgentLabel(app), "等待重新连接");
  app.agent.connectionActive = true;
  assert.equal(localAppAgentLabel(app), "正在操作");
  app.agent.ownership = "user";
  assert.equal(localAppAgentLabel(app), "已由你接管");
});

function fixture({ state = {}, targets, captureError, endpoint, browser } = {}) {
  const calls = [], gatewayCalls = [];
  let closed = false, opened = false;
  const client = {
    send: async (method, params, timeout, sessionId) => {
      calls.push({method,params,sessionId});
      if (method === "Target.getTargets") return {targetInfos:targets || [{targetId:"first",type:"page",title:"Other window"},{targetId:"owned",type:"page",title:"Agent window"}]};
      if (method === "Target.attachToTarget") return {sessionId:"observer"};
      if (method === "Page.captureScreenshot") { if (captureError) throw Error("PRIVATE RAW ERROR"); return {data:"anBlZw=="}; }
      return {};
    },
    close: () => { closed = true; }
  };
  const { LocalAppWindows } = loadTsModule("src/main/local-apps/preview.ts", {stubs:{
    "../cdp-client": {
      requestCdpJson: async () => ({Browser:browser || "ProfilePilot Gateway",webSocketDebuggerUrl:endpoint || "ws://127.0.0.1:9123/devtools/browser/gateway?ticket=fixture"}),
      CdpBrowserClient:{connect:async () => {opened = true; return client;}}
    },
    "../browser-gateway-client": {requestBrowserGateway:async (...args) => {gatewayCalls.push(args);}},
    "./gateway": {}
  }});
  const windows = new LocalAppWindows({status:async () => ({}),state:() => ({connected:true,...state})});
  return { windows, config:{id:"app",mode:"launch",agentPort:9123,name:"App"}, calls,gatewayCalls,
    closed:() => closed, opened:() => opened };
}
test("preview follows the owned window, releases its observer, and never focuses or claims", async () => {
  const f = fixture({state:{sessionId:"agent",targetId:"owned"}});
  const image = await f.windows.preview(f.config);
  assert.equal(image.title, "Agent window");
  assert.match(image.screenshot, /^data:image\/jpeg;base64,/);
  assert.equal(f.calls.find(c => c.method === "Target.attachToTarget").params.targetId, "owned");
  assert.equal(f.calls.find(c => c.method === "Page.captureScreenshot").sessionId, "observer");
  assert.equal(f.calls.at(-1).method, "Target.detachFromTarget");
  assert.ok(f.closed());
  assert.equal(f.gatewayCalls.length, 0);
  assert.equal(f.calls.some(c => /bringToFront|activateTarget|Input\./.test(c.method)), false);
});
test("missing Agent window never falls back to another window", async () => {
  for (const targetId of [undefined, "missing"]) {
    const f = fixture({state:{sessionId:"agent",targetId}});
    assert.equal((await f.windows.preview(f.config)).screenshot, null);
    assert.equal(f.calls.some(c => c.method === "Page.captureScreenshot"), false);
    assert.equal(f.calls.some(c => c.method === "Target.attachToTarget"), false);
  }
});
test("capture errors detach, close and give a readable nontechnical message", async () => {
  const f = fixture({captureError:true});
  const image = await f.windows.preview(f.config);
  assert.equal(image.screenshot, null);
  assert.match(image.error, /请确认应用窗口已打开/);
  assert.doesNotMatch(image.error, /PRIVATE RAW ERROR/);
  assert.equal(f.calls.at(-1).method, "Target.detachFromTarget");
  assert.ok(f.closed());
});
test("preview rejects raw or redirected endpoints", async () => {
  for (const options of [
    {browser:"Chrome"}, {endpoint:"ws://localhost:9123/devtools/browser/gateway"},
    {endpoint:"ws://127.0.0.1:9222/devtools/browser/gateway"},
    {endpoint:"ws://127.0.0.1:9123/devtools/browser/raw"}
  ]) {
    const f = fixture(options);
    assert.equal((await f.windows.preview(f.config)).screenshot, null);
    assert.equal(f.opened(), false);
  }
});
test("show uses the trusted Agent reveal or the selected idle app without taking ownership", async () => {
  const active = fixture({state:{sessionId:"agent",targetId:"owned"}});
  await active.windows.show(active.config);
  assert.equal(active.gatewayCalls[0][0].action, "activate-agent-target");
  assert.equal(active.opened(), false);
  const idle = fixture();
  await idle.windows.show(idle.config);
  assert.ok(idle.calls.some(c => c.method === "Page.bringToFront" && c.sessionId === "observer"));
  assert.equal(idle.calls.at(-1).method, "Target.detachFromTarget");
  assert.ok(idle.closed());
});
