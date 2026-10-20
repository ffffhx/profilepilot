// Runs the production background entrypoint, real HTTP requests and persistent
// IndexedDB semantics. Chrome permission state is simulated here; this does not
// stand in for the separate browser permission / end-to-end verification.
import "fake-indexeddb/auto";
import http from "node:http";
import { once } from "node:events";
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../artifacts/test-lib.mjs";

const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const origin = `chrome-extension://${extensionId}/`;
const optionsSender = { id: extensionId, url: origin + "options.html", tab: { id: 12 } };
const contentSender = { id: extensionId, url: "https://article.example/read", tab: { id: 19 } };
const stored = {};
let listener, granted = false, received = [], broadcasts = [], accessLevel;
let mode = "normal", failures = 0, restartCount = 0;
const request = {
  segments: [{ id: "a", text: "Read this paragraph." }, { id: "b", text: "Call ⟦BR0⟧ for data." }],
  context: "Article context", sourceLanguage: "en", targetLanguage: "zh"
};
const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  received.push({ url: req.url, authorization: req.headers.authorization, body });
  if (mode === "transient" && failures++ === 0) { res.writeHead(503); res.end("Unavailable"); return; }
  await new Promise(resolve => setTimeout(resolve, 25));
  const input = JSON.parse(body.messages.at(-1).content);
  const translations = input.segments.map(segment => ({
    id: segment.id,
    text: mode === "damaged-code" ? "译文中的代码标记丢失了。" : "译文：" + segment.text
  }));
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations }) } }] }));
});
globalThis.chrome = {
  runtime: {
    id: extensionId, getURL: path => origin + path, async openOptionsPage() {},
    onInstalled: { addListener() {} },
    onMessage: { addListener(callback) { listener = callback; } }
  },
  storage: {
    local: {
      async get(key) { return { [key]: structuredClone(stored[key]) }; },
      async set(values) { Object.assign(stored, structuredClone(values)); },
      async setAccessLevel(options) { accessLevel = options.accessLevel; }
    }
  },
  permissions: { async contains() { return granted; } },
  commands: { onCommand: { addListener() {} } },
  contextMenus: { removeAll(callback) { callback(); }, create() {}, onClicked: { addListener() {} } },
  tabs: {
    async query() { return [{ id: 19 }]; },
    async sendMessage(tab, message) { broadcasts.push({ tab, message }); }
  }
};
function call(type, payload, sender = contentSender) {
  return new Promise((resolve, reject) => {
    const keepAlive = listener({ type, payload }, sender, resolve);
    if (keepAlive !== true) reject(new Error("Background did not keep its asynchronous response channel open."));
  });
}
async function restart() {
  listener = undefined;
  await import(`../artifacts/background-test.mjs?restart=${++restartCount}`);
  assert.equal(typeof listener, "function");
}
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await restart();
});
beforeEach(async () => {
  stored.settings = {
    ...DEFAULT_SETTINGS, provider: "custom", endpoint: `http://127.0.0.1:${server.address().port}/v1`,
    model: "test-model", apiKey: "UNIT_TEST_KEY"
  };
  granted = true; mode = "normal"; failures = 0; received = []; broadcasts = [];
  assert.equal((await call("cache:clear", undefined, optionsSender)).ok, true);
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

test("options tabs are trusted; web content cannot read credentials or change privileged settings", async () => {
  assert.equal(accessLevel, "TRUSTED_CONTEXTS");
  const settings = await call("settings:get", undefined, optionsSender);
  assert.equal(settings.data.apiKey, "UNIT_TEST_KEY");
  const publicData = await call("settings:public");
  assert.equal("apiKey" in publicData.data, false);
  for (const type of ["settings:get", "settings:save", "site:update", "cache:clear", "provider:test"]) {
    assert.equal((await call(type, stored.settings)).ok, false, type);
  }
  const spoofed = { ...optionsSender, url: `chrome-extension://${extensionId}.untrusted/options.html` };
  assert.equal((await call("settings:get", undefined, spoofed)).ok, false);
  assert.equal((await call("settings:get", undefined, { ...optionsSender, id: "other" })).ok, false);
});
test("saving configuration never returns or broadcasts the API key to content scripts", async () => {
  const saved = await call("settings:save", stored.settings, optionsSender);
  assert.equal(saved.ok, true);
  assert.equal(JSON.stringify(saved).includes("UNIT_TEST_KEY"), false);
  assert.equal(JSON.stringify(broadcasts).includes("UNIT_TEST_KEY"), false);
  assert.equal(broadcasts[0].message.type, "page:settings");
  assert.equal(stored.settings.endpoint.endsWith("/v1/chat/completions"), true);
});
test("missing endpoint permission prevents all network requests", async () => {
  granted = false;
  const result = await call("translate", request);
  assert.equal(result.ok, false);
  assert.match(result.error, /授权/);
  assert.equal(received.length, 0);
});
test("background uses its configured endpoint and credentials, validates real HTTP results, then serves cached results", async () => {
  const result = await call("translate", { ...request, endpoint: "https://unapproved.example", apiKey: "UNTRUSTED" });
  assert.equal(result.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/v1/chat/completions");
  assert.equal(received[0].authorization, "Bearer UNIT_TEST_KEY");
  assert.equal(JSON.stringify(received[0].body).includes("UNIT_TEST_KEY"), false);
  assert.deepEqual(result.data.map(item => item.id), ["a", "b"]);
  const again = await call("translate", request);
  assert.equal(again.ok, true);
  assert.ok(again.data.every(item => item.cached));
  assert.equal(received.length, 1);
});
test("worker restart retains IndexedDB translations and re-registers its message handler", async () => {
  assert.equal((await call("translate", request)).ok, true);
  await restart();
  const result = await call("translate", request);
  assert.equal(result.ok, true);
  assert.ok(result.data.every(item => item.cached));
  assert.equal(received.length, 1);
});
test("identical concurrent requests share a single HTTP request", async () => {
  const results = await Promise.all([call("translate", request), call("translate", request)]);
  assert.ok(results.every(result => result.ok));
  assert.equal(received.length, 1);
});
test("glossary changes invalidate previous cached translations", async () => {
  assert.equal((await call("translate", request)).ok, true);
  const updated = { ...stored.settings, glossary: "paragraph = 段落" };
  assert.equal((await call("settings:save", updated, optionsSender)).ok, true);
  const second = await call("translate", request);
  assert.equal(second.ok, true);
  assert.ok(second.data.every(item => !item.cached));
  assert.equal(received.length, 2);
  assert.equal(JSON.parse(received[1].body.messages.at(-1).content).glossary, updated.glossary);
});
test("malformed model output never enters the cache, and a later corrected response succeeds", async () => {
  mode = "damaged-code";
  assert.equal((await call("translate", request)).ok, false);
  assert.equal((await call("cache:stats", undefined, optionsSender)).data.count, 0);
  mode = "normal";
  assert.equal((await call("translate", request)).ok, true);
  assert.equal(received.length, 2);
});
test("transient server errors retry and clearing cache forces a fresh request", async () => {
  mode = "transient";
  assert.equal((await call("translate", request)).ok, true);
  assert.equal(received.length, 2);
  assert.equal((await call("cache:clear", undefined, optionsSender)).ok, true);
  assert.equal((await call("cache:stats", undefined, optionsSender)).data.count, 0);
  mode = "normal";
  assert.equal((await call("translate", request)).ok, true);
  assert.equal(received.length, 3);
});
