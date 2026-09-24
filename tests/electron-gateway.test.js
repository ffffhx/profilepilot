const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ElectronCdpTransport } = require("../dist/main/electron-cdp-transport");
const { LocalAppsService } = require("../dist/main/local-apps/service");
const { ensurePersistentDriverGatewayProtocol, assertProtectedElectronPort } = require("../dist/main/browser-gateway-driver-runtime");

test("Electron discovery rejects remote hosts, credentials, other ports and main-process inspectors", async () => {
  let advertised;
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ webSocketDebuggerUrl: advertised })));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    for (const url of [`ws://example.com:${port}/devtools/browser/x`, `ws://user:secret@localhost:${port}/devtools/browser/x`, `ws://localhost:1/devtools/browser/x`, `ws://localhost:${port}/node-inspector`, `wss://localhost:${port}/devtools/browser/x`]) {
      advertised = url;
      await assert.rejects(ElectronCdpTransport.connect(port), /只允许/);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("Electron upgrade preserves existing v15 Chrome driver sessions", async () => {
  const status = { ok:true, protocolVersion:15, ports:[9223] };
  assert.equal(await ensurePersistentDriverGatewayProtocol(status, {
    homeDir:os.tmpdir(), driverLabel:"fixture",
    ensureGatewayDaemon:async () => { throw new Error("must not replace live daemon"); }
  }), status);
});

test("Electron Agent port persists while upgrade is deferred and cannot collide with other apps", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-electron-ports-"));
  const gateway = { status:async () => { throw new Error("Gateway 需升级"); }, detach:async () => {} };
  try {
    const service = new LocalAppsService(root, async () => new Set([9223]), gateway);
    const input = { name:"App", mode:"attach", cwd:"", command:"", environment:"", cdpPort:9333, inspectPort:null };
    const id = await service.save(input);
    await service.syncAgents();
    const config = service.get(id);
    assert.ok(config.agentPort >= 1024 && config.agentPort !== 9333 && config.agentPort !== 9223);
    assert.equal(new LocalAppsService(root).get(id).agentPort, config.agentPort);
    assert.match((await service.list())[0].agent.error, /需升级/);
    await assert.rejects(service.save({ ...input, cdpPort:config.agentPort }), /已分配/);
    await assert.rejects(service.save({ ...input, cdpPort:9334, agentPort:9334 }), /不能与其他/);
    await assert.rejects(service.save({ ...input, cdpPort:null, inspectPort:9230, agentPort:9444 }), /需要界面/);
    const catalog = path.join(root, ".profilepilot/gateway"); fs.mkdirSync(catalog, {recursive:true});
    fs.writeFileSync(path.join(catalog, "managed-profiles.json"), JSON.stringify({ profiles:[{ publicPort:config.agentPort, electronCdpPort:9333 }] }));
    assert.throws(() => assertProtectedElectronPort(9333, root), error => error.code === "ELECTRON_USE_GATEWAY_PORT");
    assert.doesNotThrow(() => assertProtectedElectronPort(config.agentPort, root));
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, {recursive:true,force:true});
  }
});
