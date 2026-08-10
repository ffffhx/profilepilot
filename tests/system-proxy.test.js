const assert = require("node:assert/strict");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");
const {
  parseResolvedProxy,
  resolveSystemProxySnapshot
} = loadTsModule("src/main/system-proxy.ts");

test("system proxy parser preserves proxy order and DIRECT fallback", () => {
  assert.deepEqual(
    parseResolvedProxy("https", "PROXY 127.0.0.1:9900; SOCKS5 127.0.0.1:7897; DIRECT"),
    [
      { protocol: "https", kind: "http", endpoint: "127.0.0.1:9900" },
      { protocol: "https", kind: "socks5", endpoint: "127.0.0.1:7897" },
      { protocol: "https", kind: "direct", endpoint: null }
    ]
  );
});

test("system proxy snapshot resolves HTTP and HTTPS routes", async () => {
  const snapshot = await resolveSystemProxySnapshot(async (url) =>
    url.startsWith("https:") ? "HTTPS proxy.example:8443; DIRECT" : "PROXY 127.0.0.1:9900"
  );
  assert.deepEqual(snapshot, {
    mode: "proxy",
    routes: [
      { protocol: "http", kind: "http", endpoint: "127.0.0.1:9900" },
      { protocol: "https", kind: "https", endpoint: "proxy.example:8443" },
      { protocol: "https", kind: "direct", endpoint: null }
    ]
  });
});

test("system proxy snapshot distinguishes DIRECT and partial failures", async () => {
  assert.deepEqual(
    await resolveSystemProxySnapshot(async () => "DIRECT"),
    {
      mode: "direct",
      routes: [
        { protocol: "http", kind: "direct", endpoint: null },
        { protocol: "https", kind: "direct", endpoint: null }
      ]
    }
  );

  const partial = await resolveSystemProxySnapshot(async (url) => {
    if (url.startsWith("https:")) throw new Error("unavailable");
    return "PROXY 127.0.0.1:8080";
  });
  assert.equal(partial.mode, "proxy");
  assert.deepEqual(partial.routes, [
    { protocol: "http", kind: "http", endpoint: "127.0.0.1:8080" }
  ]);
});
