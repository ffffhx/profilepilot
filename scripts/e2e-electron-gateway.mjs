import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { launchProfilePilotE2e, repoRoot } from "./e2e/lib/electron-driver.mjs";
const require = createRequire(import.meta.url);
const { BrowserGatewayDaemon } = require("../dist/main/browser-gateway-daemon");
const { requestBrowserGateway } = require("../dist/main/browser-gateway-client");
const electronPath = require("electron");
const wrapper = path.join(repoRoot, "dist/main/profilepilot-agent-browser-wrapper.cjs");
const real = path.join(repoRoot, "node_modules/agent-browser/bin", process.platform === "win32" ? "agent-browser-win32-x64.exe" : `agent-browser-${process.platform}-${process.arch}`);
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const backendPort = await freePort();
let agentPort = await freePort(); while (agentPort === backendPort) agentPort = await freePort();
const id = randomUUID();
const session = `cx-electron-fixture-${process.pid}`;
let daemon, target, targetStats, app, homeDir, dataDir;
async function until(run, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await run()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${label}`);
}
async function command(args, sessionId = session, expected = 0) {
  const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir, CPM_DATA_DIR: dataDir,
    AGENT_BROWSER_SOCKET_DIR: path.join(homeDir, ".agent-browser"),
    AGENT_BROWSER_SESSION: sessionId, PROFILEPILOT_AGENT_BROWSER_REAL: real };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [wrapper, ...args], { cwd: repoRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Command timed out: ${args.join(" ")}\n${output}`)); }, 35000);
    child.once("error", reject); child.once("exit", code => { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); resolve(code); });
  });
  assert.equal(code, expected, `${args.join(" ")}\n${output}`);
  return output;
}
try {
  app = await launchProfilePilotE2e({
    env: { CPM_E2E_LOCAL_APP_GATEWAY: "1" },
    prepareFixture: async fixture => {
      homeDir = fixture.homeDir; dataDir = fixture.dataDir;
      await mkdir(path.join(homeDir, ".agent-browser"), { recursive: true });
      daemon = new BrowserGatewayDaemon(homeDir, { focusProfileWindow: async () => { throw new Error("Background test must not request native activation"); } });
      await daemon.start();
      const project = path.join(fixture.fixtureRoot, "electron-app"); await mkdir(project);
      targetStats = path.join(project, "window-state.json");
      const source = path.join(project, "main.cjs");
      const html = '<h1>Electron fixture</h1><button id="increment" onclick="document.querySelector(\'#count\').textContent=String(Number(document.querySelector(\'#count\').textContent)+1)">增加计数</button><output id="count">0</output>';
      await writeFile(source, `
        const { app, BrowserWindow } = require('electron');
        const fs = require('node:fs');
        app.setPath('userData', ${JSON.stringify(path.join(project, "data"))});
        if (process.platform === 'darwin') app.setActivationPolicy('accessory');
        let focused = 0, shown = 0;
        const save = () => fs.writeFileSync(${JSON.stringify(targetStats)}, JSON.stringify({ pid:process.pid, focused, shown, windows:BrowserWindow.getAllWindows().map(w=>({visible:w.isVisible(),focused:w.isFocused()})) }));
        app.whenReady().then(async () => {
          for (let index = 0; index < 2; index++) {
            const window = new BrowserWindow({ show:false, focusable:false, webPreferences:{contextIsolation:true,nodeIntegration:false} });
            window.on('focus',()=>{focused++;save()}); window.on('show',()=>{shown++;save()});
            await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<title>Electron 窗口 '+index+'</title>'+${JSON.stringify(html)}));
          }
          save(); setInterval(save,200);
        });
      `);
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      target = spawn(electronPath, [`--remote-debugging-port=${backendPort}`, source], { env, windowsHide:true, stdio:"ignore" });
      await until(async () => { try { return JSON.parse(await readFile(targetStats, "utf8")).windows.length === 2; } catch { return false; } }, "fixture windows");
      await mkdir(path.join(dataDir, "local-apps"), { recursive: true });
      await writeFile(path.join(dataDir, "local-apps/apps.json"), JSON.stringify([{ id, name:"受保护 Electron", mode:"attach", cwd:project, command:"", environment:"", cdpPort:backendPort, inspectPort:null, agentPort, createdAt:new Date().toISOString() }]));
    }
  });
  const d = app.driver;
  await d.evaluate("location.href='./local-apps.html'");
  await d.waitFor("[data-agent-status]", state => state.text.includes("可供 Agent"));
  assert.match((await d.query(".agent-command")).text, new RegExp(`--cdp ${agentPort}`));
  assert.equal((await fetch(`http://127.0.0.1:${agentPort}/json/version`)).status, 401);
  console.log("protected Electron route connected");
  await assert.rejects(requestBrowserGateway({ action:"attach-electron", profileId:`local-app:${randomUUID()}`, profileName:"Duplicate", publicPort:await freePort(), backendPort }, {homeDir}), error => error.code === "PROFILE_LEASE_CONFLICT");
  for (const port of [agentPort, backendPort]) await assert.rejects(requestBrowserGateway({ action:"launch-profile", profileId:"fixture-browser", profileName:"Conflict", publicPort:port, executable:"must-not-launch", args:[] }, {homeDir}), error => error.code === "PROFILE_LEASE_CONFLICT");
  const snapshot = await command(["--cdp", String(agentPort), "snapshot", "-i"]);
  assert.match(snapshot, /增加计数/);
  await command(["--cdp", String(agentPort), "click", "#increment"]);
  assert.match(await command(["--cdp", String(agentPort), "get", "text", "#count"]), /1/);
  console.log("real agent-browser snapshot and background click passed");
  const tabs = await command(["--cdp", String(agentPort), "tab"]);
  const tabIds = [...tabs.matchAll(/\bt\d+\b/g)].map(match => match[0]);
  assert.ok(tabIds.length >= 2, tabs);
  await command(["--cdp", String(agentPort), "tab", tabIds[1]]);
  assert.match(await command(["--cdp", String(agentPort), "snapshot", "-i"]), /增加计数/);
  const conflict = await command(["--cdp", String(agentPort), "snapshot", "-i"], `${session}-other`, 75);
  assert.match(conflict, /PROFILE_LEASE_CONFLICT|PROFILE_ALREADY_IN_USE/);
  const raw = await command(["--cdp", String(backendPort), "snapshot", "-i"], `${session}-raw`, 75);
  assert.match(raw, /ELECTRON_USE_GATEWAY_PORT/);
  await d.waitFor("[data-agent-control=takeover]");
  await d.domClick("[data-agent-control=takeover]");
  await d.waitFor("[data-agent-control=return]", state => state.exists && !state.disabled).catch(async error => {
    console.error("takeover diagnostic", (await d.query("#app-message")).text, (await requestBrowserGateway({ action:"status" }, {homeDir})).state);
    throw error;
  });
  const blocked = await command(["--cdp", String(agentPort), "click", "#increment"], session, 75);
  assert.match(blocked, /AGENT_USER_IN_CONTROL/);
  console.log("exclusive session and user takeover passed");
  // This is a disposable protocol fixture, not a handoff of a user browser.
  // Exercise the explicit user-return IPC and re-snapshot before continuing.
  await d.domClick("[data-agent-control=return]");
  await d.waitFor("[data-agent-control=takeover]", state => state.exists && !state.disabled);
  await command(["--cdp", String(agentPort), "snapshot", "-i"]);
  await command(["--cdp", String(agentPort), "click", "#increment"]);
  await command(["profilepilot", "complete"]);
  await d.waitFor("[data-agent-status]", state => state.text.includes("可供 Agent"));
  await requestBrowserGateway({ action:"detach-electron", profileId:`local-app:${id}`, publicPort:agentPort }, {homeDir});
  assert.equal(target.exitCode, null);
  const states = JSON.parse(await readFile(targetStats, "utf8"));
  assert.equal(states.focused, 0); assert.equal(states.shown, 0);
  assert.ok(states.windows.every(window => !window.visible && !window.focused));
  assert.ok((await d.windows()).all.every(window => !window.visible && !window.focused));
  const dir = path.join(repoRoot, "test-results/electron-gateway"); await mkdir(dir, { recursive: true });
  await d.screenshot(); await new Promise(resolve => setTimeout(resolve, 250));
  await writeFile(path.join(dir, "protected-app.png"), Buffer.from((await d.screenshot()).pngBase64, "base64"));
  await writeFile(path.join(dir, "result.json"), JSON.stringify({ passed:true, agentPort, backendPort, states }, null, 2));
  console.log("PASS Electron Gateway: real agent-browser, background input and window switching, exclusive session, raw-port rejection, takeover/return/complete, and application survival");
} finally {
  if (homeDir && daemon) {
    const status = await requestBrowserGateway({ action:"status" }, { homeDir }).catch(() => null);
    for (const profile of status?.state?.profiles || []) if (profile.ownerSessionId && profile.sessionStatus === "active") {
      await command(["profilepilot","release"], profile.ownerSessionId).catch(() => {});
    }
  }
  if (app) await app.stop({ removeFixture:false });
  await daemon?.stop();
  if (target && target.exitCode === null) { target.kill(); await new Promise(resolve => { if (target.exitCode !== null) resolve(); else target.once("exit",resolve); }); }
  if (app) {
    assert.ok(path.resolve(app.fixtureRoot).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(app.fixtureRoot, {recursive:true,force:true,maxRetries:0}).catch(error => { if (!["EBUSY","EPERM","ENOTEMPTY"].includes(error.code)) throw error; });
  }
}
