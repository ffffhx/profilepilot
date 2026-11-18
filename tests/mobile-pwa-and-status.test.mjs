import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createStatusServer,
  validateReport,
  isAllowedStatusIpv4,
  DEFAULT_CHANNEL_TTL_MS,
  DEFAULT_MAX_CHANNELS
} from "../services/phone-status/server.mjs";

const require = createRequire(import.meta.url);
const { loadTsModule } = require("./helpers/load-ts-module");
const { MobileService, isAllowedMobileIpv4 } = loadTsModule("src/main/mobile/service.ts");
const { TaskStore } = loadTsModule("src/main/tasks/store.ts");
const { TaskService } = loadTsModule("src/main/tasks/service.ts");

async function mobilePwaFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-mobile-pwa-"));
  const store = new TaskStore(path.join(root, "tasks"));
  const tasks = new TaskService(store, {
    browser: { control: async () => {}, tabs: async () => [] },
    apiKey: () => "",
    prepareProfile: async () => ({ name: "Work", port: 9223 }),
    profileName: async id => (id === "__device__" ? "不打开浏览器" : "Work"),
    changed: () => {},
    notify: () => {}
  });
  tasks.tick = async () => {};
  const service = new MobileService({
    root: path.join(root, "mobile"),
    tasks,
    computerName: "Desk Studio",
    profiles: async () => [{ id: "isolated:work", name: "Work", source: "isolated", ready: true }]
  });
  await service.configure({ enabled: true });
  const port = service.snapshot().port;
  const host = `127.0.0.1:${port}`;
  const origin = `https://${host}`;
  const tls = JSON.parse(fs.readFileSync(path.join(root, "mobile", "identity.json"), "utf8"));

  const getAsset = route =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port,
          path: route,
          method: "GET",
          ca: tls.cert,
          agent: false,
          checkServerIdentity: () => undefined,
          headers: { Host: host }
        },
        res => {
          let body = "";
          res.on("data", chunk => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }
      );
      req.on("error", reject);
      req.end();
    });

  const postJson = (route, body, { token, customOrigin = origin, secFetchSite = "same-origin" } = {}) =>
    new Promise((resolve, reject) => {
      const headers = {
        Host: host,
        "Content-Type": "application/json",
        ...(customOrigin !== null ? { Origin: customOrigin } : {}),
        ...(secFetchSite !== null ? { "Sec-Fetch-Site": secFetchSite } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      };
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port,
          path: route,
          method: "POST",
          ca: tls.cert,
          agent: false,
          checkServerIdentity: () => undefined,
          headers
        },
        res => {
          let text = "";
          res.on("data", chunk => (text += chunk));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode, json: JSON.parse(text) });
            } catch (error) {
              reject(error);
            }
          });
        }
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });

  t.after(async () => {
    await service.close();
    await tasks.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, store, tasks, service, port, origin, getAsset, postJson };
}

test("MobileService serves responsive strict-CSP PWA assets and generates webPairUrl + webQr", async t => {
  const f = await mobilePwaFixture(t);
  const pairing = await f.service.pair(f.origin);

  assert.match(pairing.uri, /^profilepilot:\/\/pair\?/);
  assert.match(pairing.webPairUrl, new RegExp(`^https://127\\.0\\.0\\.1:${f.port}/#pair=[a-f0-9]{64}&name=Desk%20Studio$`));
  assert.match(pairing.qr, /^data:image\/png;base64,/);
  assert.match(pairing.webQr, /^data:image\/png;base64,/);

  const index = await f.getAsset("/");
  assert.equal(index.status, 200);
  assert.match(String(index.headers["content-type"]), /^text\/html/);
  assert.equal(index.headers["x-content-type-options"], "nosniff");
  assert.equal(index.headers["referrer-policy"], "no-referrer");
  const csp = String(index.headers["content-security-policy"] || "");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
  assert.equal(csp.includes("unsafe-inline"), false);
  assert.equal(csp.includes("unsafe-eval"), false);

  assert.match(index.body, /prefers-color-scheme:\s*dark/);
  assert.match(index.body, /history\.replaceState/);
  assert.match(index.body, /localStorage/);
  assert.match(index.body, /__device__/);
  assert.match(index.body, /task\.create/);
  assert.match(index.body, /task\.detail/);
  assert.match(index.body, /task\.reply/);
  assert.match(index.body, /task\.control/);
  assert.match(index.body, /device\.disconnect/);

  const manifest = await f.getAsset("/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  const manifestJson = JSON.parse(manifest.body);
  assert.equal(manifestJson.display, "standalone");
  assert.equal(manifestJson.start_url, "/");

  const sw = await f.getAsset("/sw.js");
  assert.equal(sw.status, 200);
  assert.match(String(sw.headers["content-type"]), /javascript/);

  const icon = await f.getAsset("/icon.svg");
  assert.equal(icon.status, 200);
  assert.match(String(icon.headers["content-type"]), /image\/svg\+xml/);

  const missing = await f.getAsset("/unknown-route");
  assert.equal(missing.status, 404);
});

test("Browser PWA flow pairs via #pair token, creates __device__ task, approves confirmation, controls task, and enforces same-origin", async t => {
  const f = await mobilePwaFixture(t);
  const pairing = await f.service.pair(f.origin);
  const fragment = new URL(pairing.webPairUrl).hash.slice(1);
  const hashParams = new URLSearchParams(fragment);
  const pairToken = hashParams.get("pair");
  assert.match(pairToken, /^[a-f0-9]{64}$/);

  // Cross-origin browser POST must be rejected even with a valid pairing token.
  const crossOriginPair = await f.postJson(
    "/v1/pair",
    { token: pairToken, clientId: randomUUID(), name: "Safari PWA" },
    { customOrigin: "https://evil.example", secFetchSite: "cross-site" }
  );
  assert.equal(crossOriginPair.json.ok, false);

  // Same-origin browser POST succeeds and returns Bearer token.
  const paired = await f.postJson("/v1/pair", {
    token: pairToken,
    clientId: randomUUID(),
    name: "iPhone Safari"
  });
  assert.equal(paired.status, 200);
  assert.equal(paired.json.ok, true);
  const bearer = paired.json.data.token;

  const rpc = (command, route = "/v1/rpc") =>
    f.postJson(route, { requestId: randomUUID(), issuedAt: Date.now(), command }, { token: bearer });

  const sync = await rpc({ action: "sync" });
  assert.equal(sync.json.ok, true);
  assert.equal(sync.json.data.computerName, "Desk Studio");

  // Create a device/no-browser computer task from the PWA.
  const created = await rpc({
    action: "task.create",
    profile: "__device__",
    input: { prompt: "整理桌面截图并汇报摘要", mode: "acceptEdits" }
  });
  assert.equal(created.json.ok, true);
  const taskId = created.json.data.task.id;
  assert.equal(f.store.get(taskId).profileId, "__device__");

  const list = await rpc({ action: "task.list", limit: 20 });
  assert.equal(list.json.ok, true);
  assert.equal(list.json.data.tasks[0].id, taskId);

  // Attach a pending confirmation and approve it via task.reply after inspecting task.detail.
  const storedTask = f.store.get(taskId);
  storedTask.status = "waiting_user";
  storedTask.pending = {
    id: randomUUID(),
    kind: "confirmation",
    title: "确认执行命令",
    details: "将在工作目录生成汇总文本。",
    createdAt: new Date().toISOString()
  };
  f.tasks.publish(storedTask);

  const detail = await rpc({ action: "task.detail", id: taskId });
  assert.equal(detail.json.ok, true);
  assert.equal(detail.json.data.task.pending.title, "确认执行命令");

  const approved = await rpc({
    action: "task.reply",
    id: taskId,
    decisionId: storedTask.pending.id,
    approved: true,
    answer: "同意继续"
  });
  assert.equal(approved.json.ok, true);
  assert.equal(f.store.get(taskId).pending, undefined);

  // Pause / resume / cancel via task.control.
  assert.equal((await rpc({ action: "task.control", id: taskId, control: "pause" })).json.data.task.status, "paused");
  assert.equal((await rpc({ action: "task.control", id: taskId, control: "resume" })).json.data.task.status, "queued");
  assert.equal((await rpc({ action: "task.control", id: taskId, control: "cancel" })).json.data.task.status, "cancelled");

  // Disconnect revokes only this browser credential.
  const disconnected = await rpc({ action: "device.disconnect" });
  assert.equal(disconnected.json.ok, true);
  assert.equal(disconnected.json.data.disconnected, true);
  assert.equal((await rpc({ action: "sync" })).status, 401);
});

test("Tailscale / CGNAT 100.64.0.0/10 is allowed in MobileService and phone-status server", () => {
  assert.equal(isAllowedMobileIpv4("100.64.0.1"), true);
  assert.equal(isAllowedMobileIpv4("100.101.42.8"), true);
  assert.equal(isAllowedMobileIpv4("100.127.255.254"), true);
  assert.equal(isAllowedMobileIpv4("127.0.0.1"), false);
  assert.equal(isAllowedMobileIpv4("169.254.10.20"), false);

  assert.equal(isAllowedStatusIpv4("100.64.0.1"), true);
  assert.equal(isAllowedStatusIpv4("100.127.255.254"), true);
  assert.equal(isAllowedStatusIpv4("100.63.255.255"), false);
  assert.equal(isAllowedStatusIpv4("100.128.0.1"), false);
  assert.equal(isAllowedStatusIpv4("8.8.8.8"), false);

  const validReport = validateReport({
    deviceId: randomUUID(),
    name: "Pixel 9 Pro",
    permissions: { accessibility: true, overlay: true, notifications: true },
    readiness: {
      unlocked: true,
      computerConnected: false,
      usbConnected: false,
      wifiConnected: true,
      developerOptions: "enabled",
      usbDebugging: "enabled",
      wirelessDebugging: "enabled",
      accessibilityService: "running",
      network: {
        wifiIpv4: ["100.96.12.34", "192.168.1.50"],
        adbEndpoints: [{ address: "100.96.12.34:41555", ageMs: 1200 }]
      }
    }
  });
  assert.deepEqual(validReport.readiness.network.wifiIpv4, ["100.96.12.34", "192.168.1.50"]);

  assert.throws(() =>
    validateReport({
      ...validReport,
      readiness: {
        ...validReport.readiness,
        network: { wifiIpv4: ["100.128.0.1"], adbEndpoints: [] }
      }
    })
  );
});

test("phone-status server enforces sliding 30-day lastActiveAt TTL and LRU eviction at capacity instead of permanent 503", async t => {
  assert.equal(DEFAULT_CHANNEL_TTL_MS, 30 * 86400000);
  assert.equal(DEFAULT_MAX_CHANNELS, 1024);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-status-ttl-"));
  let clock = 1_700_000_000_000;
  const server = createStatusServer({
    root,
    now: () => clock,
    trustedProxy: true,
    maxChannels: 3,
    channelTtlMs: DEFAULT_CHANNEL_TTL_MS
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const post = (route, token, body, clientIp = "10.0.0.1") =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: route,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-Forwarded-For": clientIp
          }
        },
        res => {
          let text = "";
          res.on("data", c => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(text) }));
        }
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });

  const createPairedChannel = async (ipSuffix) => {
    const id = randomUUID();
    const readToken = randomBytes(32).toString("hex");
    const pairToken = randomBytes(32).toString("hex");
    const writeToken = randomBytes(32).toString("hex");
    const deviceId = randomUUID();
    const ip = `10.0.0.${ipSuffix}`;
    assert.equal((await post("/v1/create", readToken, { id, pairToken }, ip)).status, 200);
    assert.equal((await post("/v1/claim", pairToken, { id, writeToken, deviceId }, ip)).status, 200);
    return { id, readToken, writeToken, deviceId, ip };
  };

  const c1 = await createPairedChannel(1);
  clock += 1000;
  const c2 = await createPairedChannel(2);
  clock += 1000;
  const c3 = await createPairedChannel(3);

  // Touch c1 at +20 days so c1's sliding TTL refreshes and c2 becomes the oldest LRU channel!
  clock += 20 * 86400000;
  assert.equal((await post("/v1/status", c1.readToken, { id: c1.id }, c1.ip)).status, 200);

  // Advance another 15 days (+35 days total): c2 & c3 exceed 30-day inactivity TTL, while c1 (idle 15d) stays alive!
  clock += 15 * 86400000;
  assert.equal((await post("/v1/status", c1.readToken, { id: c1.id }, c1.ip)).status, 200);
  assert.equal((await post("/v1/status", c2.readToken, { id: c2.id }, c2.ip)).status, 404);
  assert.equal((await post("/v1/status", c3.readToken, { id: c3.id }, c3.ip)).status, 404);

  // Fill capacity to 3 active paired channels: c1 (oldest), c4, c5, then add c6 -> LRU evicts c1 cleanly (200, never 503!).
  clock += 1000;
  const c4 = await createPairedChannel(4);
  clock += 1000;
  const c5 = await createPairedChannel(5);
  clock += 1000;
  // Touch c1 so c4 becomes the oldest inactive paired channel:
  assert.equal((await post("/v1/status", c1.readToken, { id: c1.id }, c1.ip)).status, 200);
  clock += 1000;
  const c6 = await createPairedChannel(6);

  assert.equal((await post("/v1/status", c6.readToken, { id: c6.id }, c6.ip)).status, 200);
  assert.equal((await post("/v1/status", c1.readToken, { id: c1.id }, c1.ip)).status, 200);
  assert.equal((await post("/v1/status", c5.readToken, { id: c5.id }, c5.ip)).status, 200);
  assert.equal((await post("/v1/status", c4.readToken, { id: c4.id }, c4.ip)).status, 404, "oldest LRU paired channel c4 was evicted");
});
