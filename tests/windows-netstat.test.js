const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseWindowsNetstat,
  parseWindowsNetstatAddress
} = require("../dist/main/windows-platform.js");

test("parseWindowsNetstatAddress handles IPv4 and IPv6", () => {
  assert.deepEqual(parseWindowsNetstatAddress("127.0.0.1:9223"), { address: "127.0.0.1", port: 9223 });
  assert.deepEqual(parseWindowsNetstatAddress("[::1]:9223"), { address: "::1", port: 9223 });
  assert.equal(parseWindowsNetstatAddress("not-an-address"), null);
});

test("parseWindowsNetstat keeps listen and established sockets", () => {
  const connections = parseWindowsNetstat(`
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:9223         0.0.0.0:0              LISTENING       34876
  TCP    127.0.0.1:54321        127.0.0.1:9223         ESTABLISHED     22001
  TCP    [::1]:9224             [::]:0                 LISTENING       41688
  TCP    127.0.0.1:80           127.0.0.1:443          TIME_WAIT       4
`);

  assert.deepEqual(connections, [
    {
      pid: 34876,
      state: "Listen",
      localAddress: "127.0.0.1",
      localPort: 9223,
      remoteAddress: "0.0.0.0",
      remotePort: 0
    },
    {
      pid: 22001,
      state: "Established",
      localAddress: "127.0.0.1",
      localPort: 54321,
      remoteAddress: "127.0.0.1",
      remotePort: 9223
    },
    {
      pid: 41688,
      state: "Listen",
      localAddress: "::1",
      localPort: 9224,
      remoteAddress: "::",
      remotePort: 0
    }
  ]);
});
