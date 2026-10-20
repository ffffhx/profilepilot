import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url);
const { BrowserGatewayDaemon } = require("../dist/main/browser-gateway-daemon");
const { requestBrowserGateway } = require("../dist/main/browser-gateway-client");
const { getDirectChromeCommand } = require("../dist/main/chrome-launch");
const { parseCliResult, WrapperBrowser } = require("../dist/main/tasks/browser");
const { retireAgentBrowserSessionSync } = require("../dist/main/agent-browser-lease");
const { sendEngineCommand } = require("../dist/main/browser-engine/service");
const root = await mkdtemp(path.join(os.tmpdir(), "pp-ts-engine-"));
const home = path.join(root, "home");
await mkdir(home);
const session = `ts-engine-${randomUUID()}`;
const env = { ...process.env, HOME: home, PROFILEPILOT_GATEWAY_HOME: home, CPM_DATA_DIR: path.join(root, "data"), AGENT_BROWSER_SOCKET_DIR: path.join(home, ".agent-browser"), ELECTRON_RUN_AS_NODE: "1" };
if (process.env.PP_ENGINE_EMPTY_PATH === "1") env.PATH = "";
const cliHost = process.env.PP_ENGINE_HOST || process.execPath;
const cliEntry = process.env.PP_ENGINE_CLI || path.resolve("dist/main/profilepilot-cli.cjs");
const daemon = new BrowserGatewayDaemon(home);
let chromePid, port, electron;
const server = http.createServer((req, res) => {
  if (req.url === "/file") { res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="report.txt"' }); res.end("typescript-download"); return; }
  if (req.url === "/api") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"original":true}'); return; }
  res.setHeader("Content-Type", "text/html;charset=utf-8");
  if (req.url === "/frame") { res.end('<button onclick="this.textContent=\'Frame clicked\'">Frame button</button>'); return; }
  res.end(`<!doctype html><meta charset="utf-8"><title>TS engine fixture</title>
    <h1>TypeScript engine</h1><label>Name<input id="name"></label><label>Password<input type="password"></label>
    <button id="increment" onclick="document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1">Increment</button>
    <output id="count">0</output><button disabled>Disabled button</button>
    <label>Agree<input id="agree" type="checkbox"></label><select id="city"><option>Shanghai</option><option>Beijing</option></select>
    <input id="file" type="file"><a id="download" href="/file" download>Download</a>
    <iframe id="frame" src="/frame"></iframe>${process.argv.includes("--electron") ? "" : `<iframe id="cross-frame" src="http://localhost:${server.address().port}/frame"></iframe>`}<div id="shadow"></div>
    <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button onclick="this.textContent=\\'Shadow clicked\\'">Shadow button</button>';</script>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const command = async (args, expected = 0, identity = session) => {
  try {
    const result = await promisify(execFile)(cliHost, [cliEntry, "browser", "--session", identity, "--cdp", String(port), "--json", "--no-auto-dialog", ...args],
      { env, windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(expected, 0, "command unexpectedly succeeded");
    return parseCliResult(result.stdout);
  } catch (error) {
    if (expected !== 0 && error.code === expected) return error;
    throw new Error(`${args[0]} failed: ${error.stderr || ""}\n${error.stdout || error.message}`);
  }
};
try {
  await daemon.start();
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const register = daemon.gateway.registerBackend.bind(daemon.gateway);
  daemon.gateway.registerBackend = async input => {
    input.backend.child?.stderr?.on("data", chunk => { if (process.env.PP_ENGINE_TRACE) process.stderr.write(chunk); });
    input.backend.child?.on("exit", (code, signal) => console.log("fixture Chrome exited", code, signal));
    if (process.env.PP_ENGINE_TRACE) {
      const send = input.backend.send.bind(input.backend);
      input.backend.send = value => { const message = JSON.parse(value); console.log("CDP", message.id, message.sessionId, message.method, message.method?.startsWith("Target.") ? message.params : ""); send(value); };
      input.backend.onMessage(value => { const message = JSON.parse(value); if (message.error || /Target\.|Runtime.executionContext|Page.frameNavigated/.test(message.method || "")) console.log("CDP EVENT", value); });
    }
    return register(input);
  };
  if (process.argv.includes("--electron")) {
    const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const backendPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    const source = path.join(root, "fixture.cjs"), ready = path.join(root, "ready");
    await writeFile(source, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root, "electron"))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});await w.loadURL('about:blank');require('fs').writeFileSync(${JSON.stringify(ready)},'ready');});`);
    const childEnv = { ...process.env }; delete childEnv.ELECTRON_RUN_AS_NODE;
    electron = spawn(require("electron"), [`--remote-debugging-port=${backendPort}`, source], { env: childEnv, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    electron.stderr.on("data", chunk => { if (process.env.PP_ENGINE_TRACE) process.stderr.write(chunk); });
    for (let i = 0; ; i++) {
      if (await readFile(ready, "utf8").catch(() => "") === "ready") break;
      if (i > 150 || electron.exitCode !== null) throw new Error("Electron fixture failed to start");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await requestBrowserGateway({ action: "attach-electron", profileId: `local-app:${randomUUID()}`, profileName: "TypeScript Electron fixture", publicPort: port, backendPort }, { homeDir: home, timeoutMs: 15000 });
    chromePid = electron.pid;
  } else {
    const launched = await requestBrowserGateway({ action: "launch-profile", profileId: "ts-fixture", profileName: "TypeScript engine fixture", publicPort: port,
      executable: getDirectChromeCommand(), args: [`--user-data-dir=${path.join(root, "chrome")}`, "--headless=new", "--no-first-run", "--no-default-browser-check", ...(process.platform === "win32" ? ["--disable-features=AutoDeElevate"] : []), "about:blank"] }, { homeDir: home, timeoutMs: 15000 });
    chromePid = launched.chromePid;
  }
  console.log("registered isolated browser", chromePid, port);
  await command(["open", url]);
  const snapshot = await command(["snapshot", "-i"]);
  const serviceRecord = JSON.parse(await readFile(path.join(home, ".agent-browser", `${session}.engine.json`), "utf8"));
  const unauthorized = await fetch(`http://127.0.0.1:${serviceRecord.port}/command`, { method: "POST", body: JSON.stringify({ ping: true }) });
  assert.equal(unauthorized.status, 403);
  assert.match(snapshot.snapshot, /Increment/);
  const ref = snapshot.snapshot.match(/button "Increment".*?\[ref=(e\d+)\]/)?.[1];
  assert.ok(ref, snapshot.snapshot);
  await command(["click", `@${ref}`]);
  assert.equal((await command(["get", "text", "#count"])).text, "1");
  await command(["fill", "#name", "中文 TS --connection extension"]);
  assert.equal((await command(["get", "value", "#name"])).value, "中文 TS --connection extension");
  await command(["check", "#agree"]);
  await command(["select", "#city", "Beijing"]);
  assert.equal((await command(["is", "checked", "#agree"])).checked, true);
  await command(["find", "role", "button", "click", "--name", "Shadow button"]);
  await command(["frame", "#frame"]);
  await command(["find", "role", "button", "click", "--name", "Frame button"]);
  assert.match((await command(["snapshot"])).snapshot, /Frame clicked/);
  await command(["frame", "main"]);
  if (!process.argv.includes("--electron")) {
    await command(["frame", "#cross-frame"]);
    await command(["find", "role", "button", "click", "--name", "Frame button"]);
    assert.match((await command(["snapshot"])).snapshot, /Frame clicked/);
    await command(["frame", "main"]);
  }
  await command(["reload"]);
  const stale = await command(["click", `@${ref}`], 1);
  assert.match(stale.stdout, /BROWSER_STALE_REF/);
  console.log("PASS snapshot refs, click, fill, check, select, shadow DOM, iframe and stale refs");
  const upload = path.join(root, "upload.txt"); await writeFile(upload, "upload fixture");
  await command(["upload", "#file", upload]);
  assert.equal((await command(["eval", "document.querySelector('#file').files[0].name"])).result, "upload.txt");
  const screenshot = path.join(root, "screenshot.png"); await command(["screenshot", screenshot]);
  assert.equal((await readFile(screenshot)).subarray(1, 4).toString(), "PNG");
  const download = path.join(root, "report.txt"); await command(["download", "#download", download]);
  assert.equal(await readFile(download, "utf8"), "typescript-download");
  await command(["cookies", "set", "fixture", "ts"]);
  assert.ok((await command(["cookies"])).cookies.some(cookie => cookie.name === "fixture"));
  await command(["storage", "local", "set", "engine", "typescript"]);
  assert.equal((await command(["storage", "local", "engine"])).value, "typescript");
  await command(["network", "route", "**/api", "--body", '{"mocked":true}']);
  assert.equal((await command(["eval", "fetch('/api').then(r=>r.json())"])).result.mocked, true);
  await command(["network", "unroute", "**/api"]);
  console.log("PASS screenshot, upload/download, cookies/storage and network routing");
  const annotated = await command(["screenshot", path.join(root, "annotated.png"), "--annotate"]);
  assert.match(annotated.snapshot, /Increment/);
  assert.equal((await command(["eval", "document.querySelectorAll('[data-profilepilot-overlay=screenshot]').length"])).result, 0);
  await command(["batch", "fill '#name' 'batch 中文'", "get value '#name'"]);
  const failedBatch = await command(["batch", "--bail", "unknown-command", "fill '#name' 'must not run'"], 1);
  assert.match(failedBatch.stdout, /BROWSER_BATCH_FAILED/);
  assert.equal((await command(["get", "value", "#name"])).value, "batch 中文");
  await command(["wait", "--fn", "document.querySelector('#name').value === 'batch 中文'"]);
  await command(["trace", "start"]);
  await command(["get", "title"]);
  const trace = path.join(root, "trace.zip"); await command(["trace", "stop", trace]);
  assert.equal((await readFile(trace)).subarray(0, 2).toString(), "PK");
  await command(["focus", "#name"]); await command(["press", "End"]); await command(["keyboard", "inserttext", " End"]);
  assert.equal((await command(["get", "value", "#name"])).value, "batch 中文 End");
  await command(["set", "media", "dark"]);
  assert.equal((await command(["eval", "matchMedia('(prefers-color-scheme:dark)').matches"])).result, true);
  await command(["eval", "console.log('engine console test');setTimeout(()=>alert('engine dialog'),10);true"]);
  await command(["dialog", "dismiss"]);
  assert.ok((await command(["console"])).messages.some(message => message.text === "engine console test"));
  if (!process.argv.includes("--electron")) {
    await command(["pdf", path.join(root, "fixture.pdf")]);
    assert.equal((await readFile(path.join(root, "fixture.pdf"))).subarray(0, 4).toString(), "%PDF");
    const statePath = path.join(root, "state.json");
    await command(["state", "save", statePath]);
    await command(["storage", "local", "clear"]);
    await command(["state", "load", statePath]);
    assert.equal((await command(["storage", "local", "engine"])).value, "typescript");
    const tab = await command(["tab", "new", url]);
    await sendEngineCommand({ session, json: true, timeout: 15000, args: ["close"] }, path.join(home, ".agent-browser"));
    const reconnected = await command(["tab"]);
    assert.equal(reconnected.tabs.find(item => item.active).targetId, tab.targetId, "reconnection preserves exact selected target even when URLs match");
    const tabs = await command(["tab"]);
    assert.equal(tabs.tabs.length, 2);
    await command(["tab", "close", tab.targetId]);
    await command(["get", "title"], 1); // No silent target switch after closure.
    await command(["tab", tabs.tabs.find(item => item.targetId !== tab.targetId).id]);
  } else {
    const denied = await command(["tab", "new", url], 1);
    assert.match(denied.stdout, /denied|forbidden|Target.createTarget/i);
  }
  console.log("PASS annotations, batch failures, keyboard, wait, dialog, settings and tabs");
  const before = Number((await command(["get", "text", "#count"])).text);
  const concurrent = await Promise.all([1, 2].map(() => sendEngineCommand({ session, json: true, timeout: 15000,
    args: ["eval", "document.querySelector('#count').textContent=Number(document.querySelector('#count').textContent)+1"] }, path.join(home, ".agent-browser"))));
  assert.ok(concurrent.every(response => response.success));
  assert.equal(Number((await command(["get", "text", "#count"])).text), before + 2);
  const savedEnv = Object.fromEntries(Object.keys(env).filter(key => key in process.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    const adapter = new WrapperBrowser(path.join(root, "tasks"));
    const task = { id: "engine-fixture", sessionId: session, port, attachments: [], outputs: [] };
    const observation = await adapter.observe(task, true);
    assert.match(observation.snapshot, /Increment/);
    assert.match(observation.screenshotDataUrl, /^data:image\/png;base64,/);
    const taskRef = observation.snapshot.match(/button "Increment".*?\[ref=(e\d+)\]/)?.[1];
    assert.ok(taskRef);
    await adapter.execute(task, { kind: "click", ref: taskRef, effect: "edit", summary: "Increment isolated fixture" });
  } finally {
    for (const key of Object.keys(env)) if (key in savedEnv) process.env[key] = savedEnv[key]; else delete process.env[key];
  }
  console.log("PASS serialized concurrent commands and desktop task adapter");
  const other = await command(["snapshot"], 75, `${session}-other`);
  assert.match(other.stderr, /PROFILE_LEASE_CONFLICT|PROFILE_ALREADY_IN_USE/);
  await command(["handoff", "--reason", "isolated acceptance fixture"]);
  await command(["click", "#increment"], 75);
  await requestBrowserGateway({ action: "control", sessionId: session, command: "return" }, { homeDir: home });
  await command(["resume"]);
  await command(["snapshot"]);
  await command(["click", "#increment"]);
  await command(["complete"]);
  process.kill(chromePid, 0);
  assert.equal((await requestBrowserGateway({ action: "status" }, { homeDir: home })).state.profiles[0].ownerSessionId, undefined);
  console.log("PASS tab selection, exclusive session, takeover/return and completion preserve Chrome");
} catch (error) {
  console.error("FAIL TS engine acceptance:", error);
  const record = await readFile(path.join(home, ".agent-browser", `${session}.engine.json`), "utf8").then(JSON.parse).catch(() => null);
  if (record) console.error("engine status:", await fetch(`http://127.0.0.1:${record.port}/command`, { method: "POST", headers: { Authorization: `Bearer ${record.token}` }, body: JSON.stringify({ ping: true }), signal: AbortSignal.timeout(2000) }).then(response => response.json()).catch(String));
  console.error(await readFile(path.join(home, ".agent-browser", `${session}.engine.log`), "utf8").catch(() => ""));
  console.error("fixture root:", root);
  process.exitCode = 1;
} finally {
  retireAgentBrowserSessionSync(session, undefined, home);
  if (port) await requestBrowserGateway({ action: "unregister-profile", publicPort: port, closeChrome: true }, { homeDir: home }).catch(() => {});
  await daemon.stop();
  electron?.kill();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (!process.exitCode) await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
