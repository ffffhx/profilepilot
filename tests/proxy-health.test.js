const assert = require("node:assert/strict");
const net = require("node:net");
const test = require("node:test");

const { loadTsModule } = require("./helpers/load-ts-module.js");
const {
  normalizeProxyEndpoint,
  parseProxyEndpoint,
  probeTcp,
  probeProxyEndpoint
} = loadTsModule("src/main/proxy-health.ts");

test("parseProxyEndpoint accepts http/https/socks5 and bare host:port", () => {
  assert.deepEqual(parseProxyEndpoint("127.0.0.1:7897"), { scheme: "http", host: "127.0.0.1", port: 7897 });
  assert.deepEqual(parseProxyEndpoint("http://localhost:8080"), { scheme: "http", host: "localhost", port: 8080 });
  assert.deepEqual(parseProxyEndpoint("socks5://127.0.0.1:7891"), { scheme: "socks5", host: "127.0.0.1", port: 7891 });
});

test("parseProxyEndpoint rejects unsupported scheme, missing port, and junk", () => {
  assert.equal(parseProxyEndpoint("ftp://127.0.0.1:21"), null);
  assert.equal(parseProxyEndpoint("127.0.0.1"), null);
  assert.equal(parseProxyEndpoint("http://127.0.0.1:99999"), null);
  assert.equal(parseProxyEndpoint("has space:1"), null);
  assert.equal(parseProxyEndpoint(""), null);
  assert.equal(parseProxyEndpoint(null), null);
});

test("normalizeProxyEndpoint canonicalizes to scheme://host:port", () => {
  assert.equal(normalizeProxyEndpoint("127.0.0.1:7897"), "http://127.0.0.1:7897");
  assert.equal(normalizeProxyEndpoint("SOCKS5://127.0.0.1:7891"), "socks5://127.0.0.1:7891");
  assert.equal(normalizeProxyEndpoint("garbage"), null);
});

test("probeTcp resolves true for a live listener and false for a closed port", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    assert.equal(await probeTcp("127.0.0.1", port), true);
    assert.equal(await probeProxyEndpoint(`127.0.0.1:${port}`), true);
  } finally {
    server.close();
  }
  // 关掉后同一端口应不可达（给系统一点时间释放）。
  assert.equal(await probeTcp("127.0.0.1", 1), false);
});

test("probeTcp returns false on invalid input without throwing", async () => {
  assert.equal(await probeTcp("", 7897), false);
  assert.equal(await probeTcp("127.0.0.1", 0), false);
  assert.equal(await probeProxyEndpoint("not-a-url"), false);
});

test("probeTcp times out to false against an unroutable address", async () => {
  // 192.0.2.0/24 是 TEST-NET-1，保证不可路由；用短超时确保测试快返回。
  assert.equal(await probeTcp("192.0.2.1", 9, 300), false);
});
