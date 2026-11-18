import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { crc32, deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const plist = require("plist");
const { ZipFile } = require("yazl");
const { loadCli } = require("./cli-test-build.cjs");

const { IphonesService, iphonePredicate, compactIphoneSource } = loadCli("src/main/phones/iphone.ts");
const { iphoneEndpoint } = loadCli("src/main/phones/iphone-wda.ts");
const { IphoneUsb, parseIosVersion } = loadCli("src/main/phones/iphone-usb.ts");
const { forwardIphone } = loadCli("src/main/phones/iphone-usbmux.ts");
const { IphoneSigning, parseMacCodesignIdentities } = loadCli("src/main/phones/iphone-signing.ts");
const { phoneActionSchema } = loadCli("src/main/phones/actions.ts");
const { BasicPhoneControl } = loadCli("src/main/phones/basic.ts");
const { wirelessAddress } = loadCli("src/main/phones/wireless.ts");
const { discoveryInterfaces, discoveryReply } = loadCli("src/main/phones/lan-discovery.ts");
const { TencentEmulator, parseTencentRegistryOutput } = loadCli("src/main/phones/tencent-emulator.ts");

function makePngBase64(width, height) {
  const chunk = (type, data) => {
    const b = Buffer.alloc(data.length + 12);
    b.writeUInt32BE(data.length);
    b.write(type, 4);
    data.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4);
    return b;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    chunk("IEND", Buffer.alloc(0))
  ]).toString("base64");
}

test("compactIphoneSource prunes empty wrapper nodes, masks SecureTextField, and assigns @e1, @e2 refs", () => {
  const rawTree = {
    type: "XCUIElementTypeApplication",
    name: "DemoApp",
    children: [
      {
        type: "XCUIElementTypeWindow",
        children: [
          {
            type: "XCUIElementTypeOther",
            children: [
              {
                type: "XCUIElementTypeOther",
                isVisible: "0",
                children: [{ type: "XCUIElementTypeButton", name: "hidden_btn", label: "不可见按钮" }]
              },
              {
                type: "XCUIElementTypeGroup",
                children: [
                  {
                    type: "XCUIElementTypeTextField",
                    name: "username_input",
                    label: "用户名",
                    value: "alice",
                    isEnabled: "1",
                    rect: { x: 20, y: 120, width: 350, height: 44 }
                  },
                  {
                    type: "XCUIElementTypeSecureTextField",
                    name: "password_input",
                    label: "登录密码",
                    value: "super-secret-password",
                    isEnabled: "1",
                    rect: { x: 20, y: 180, width: 350, height: 44 },
                    children: [{ type: "XCUIElementTypeStaticText", label: "leaked" }]
                  },
                  {
                    type: "XCUIElementTypeButton",
                    name: "login_btn",
                    label: "立即登录",
                    isEnabled: "1",
                    rect: { x: 20, y: 260, width: 350, height: 48 }
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  const compacted = compactIphoneSource(rawTree);
  assert.equal(compacted.elements.length, 3);
  assert.deepEqual(
    compacted.elements.map(e => [e.ref, e.type, e.name, e.label, e.value]),
    [
      ["@e1", "TextField", "username_input", "用户名", "alice"],
      ["@e2", "SecureTextField", "password_input", "[密码]", "[密码]"],
      ["@e3", "Button", "login_btn", "立即登录", undefined]
    ]
  );
  // Wrapper Window / Other / Group nodes with no semantics were pruned directly under Application:
  assert.equal(compacted.tree.children.length, 3);
  assert.equal(compacted.tree.children[0].ref, "@e1");
  assert.equal(compacted.tree.children[1].ref, "@e2");
  assert.equal(compacted.tree.children[1].children, undefined);
  assert.equal(compacted.tree.children[2].ref, "@e3");
  assert.match(compacted.summary, /@e1 \[TextField\] "用户名"/);
  assert.match(compacted.summary, /@e3 \[Button\] "立即登录"/);
  assert.equal(compacted.summary.includes("super-secret-password"), false);
});

test("iphonePredicate preserves both resourceId (name) and description (label), and IphonesService supports @ref click/fill + single /window/size", async t => {
  const pred = iphonePredicate({ resourceId: "login_btn", description: "立即登录" });
  assert.equal(pred, 'visible == true AND name == "login_btn" AND label == "立即登录"');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-iphone-ref-"));
  const calls = [];
  const deviceUuid = randomUUID();
  let remote = null;
  const screen = makePngBase64(1170, 2532);
  const wdaTree = {
    type: "Application",
    children: [
      {
        type: "Other",
        children: [
          {
            type: "TextField",
            name: "search_box",
            label: "搜索框",
            rect: { x: 20, y: 100, width: 300, height: 40 }
          },
          {
            type: "Button",
            name: "submit_btn",
            label: "搜索",
            rect: { x: 330, y: 100, width: 50, height: 40 }
          }
        ]
      }
    ]
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    calls.push({ method: req.method, route: req.url, body });
    const reply = value => res.end(JSON.stringify({ value, sessionId: remote }));
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/status") {
      return reply({
        ready: true,
        os: { name: "iOS", version: "17.5.1" },
        device: "iphone",
        build: { productBundleIdentifier: "com.example.WebDriverAgentRunner" }
      });
    }
    if (req.url === "/wda/device/info") {
      return reply({ uuid: deviceUuid, name: "iPhone 15", model: "iPhone", isSimulator: false });
    }
    if (req.url === "/session" && req.method === "POST") {
      remote = randomUUID();
      return reply({ sessionId: remote, capabilities: { device: "iphone" } });
    }
    if (req.url === `/session/${remote}` && req.method === "DELETE") {
      remote = null;
      return reply(null);
    }
    const route = req.url.slice(`/session/${remote}`.length);
    if (route === "/window/size") return reply({ width: 390, height: 844 });
    if (route === "/screenshot") return reply(screen);
    if (route === "/source?format=json") return reply(wdaTree);
    if (route === "/elements") return reply([{ "element-6066-11e4-a52e-4f735466cecf": "elem-search" }]);
    return reply(null);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const service = new IphonesService(root, "Test Mac", () => {});
  t.after(async () => {
    await service.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const device = await service.add({ endpoint: `http://127.0.0.1:${server.address().port}`, name: "iPhone 15" });
  await service.start({ id: device.id, mode: "control", controller: "test", task: "ref test" });
  const state = () => service.devices()[0].state;
  const perform = action =>
    service.perform({
      id: device.id,
      sessionId: state().sessionId,
      generation: state().generation,
      requestId: randomUUID(),
      action,
      observeAfter: false
    });

  // Screenshot must only query /window/size ONCE (no duplicate roundtrip).
  calls.length = 0;
  await perform({ kind: "screenshot" });
  assert.equal(calls.filter(c => c.route.endsWith("/window/size")).length, 1);

  // Snapshot returns compacted @e1, @e2 elements + summary.
  const snap = await perform({ kind: "snapshot" });
  assert.equal(snap.result.elements.length, 2);
  assert.equal(snap.result.elements[0].ref, "@e1");
  assert.equal(snap.result.elements[1].ref, "@e2");

  // find / fill / click by compact @ref:
  const found = await perform({ kind: "find", selector: { ref: "@e1" } });
  assert.equal(found.result.count, 1);
  assert.equal(found.result.matches[0].name, "search_box");

  await perform({ kind: "fill", selector: { ref: "@e1" }, text: "ProfilePilot" });
  assert.equal(calls.some(c => c.route.endsWith("/element/elem-search/clear")), true);
  assert.equal(calls.some(c => c.route.endsWith("/element/elem-search/value")), true);

  await perform({ kind: "click", selector: { ref: "@e2" } });
  // @e2 rect is (330, 100, 50, 40) -> center tap at (355, 120) when resolved via rect or element click
  assert.equal(
    calls.some(c => (c.route.endsWith("/wda/tap") && c.body?.x === 355 && c.body?.y === 120) || c.route.endsWith("/click")),
    true
  );

  // Expanded key support (enter -> \n via /wda/keys):
  await perform({ kind: "key", key: "enter" });
  assert.deepEqual(calls.at(-1).body, { value: ["\n"] });
});

test("parseIosVersion and IphoneUsb support iOS 15–16 (no tunnel), 17.0–17.3 (kernel tunnel), and 17.4+/18+ (userspace tunnel)", async t => {
  assert.deepEqual(parseIosVersion("18.2"), { major: 18, minor: 2, tunnelMode: "userspace" });
  assert.deepEqual(parseIosVersion("17.4.1"), { major: 17, minor: 4, tunnelMode: "userspace" });
  assert.deepEqual(parseIosVersion("17.2"), { major: 17, minor: 2, tunnelMode: "kernel" });
  assert.deepEqual(parseIosVersion("16.7.8"), { major: 16, minor: 7, tunnelMode: "none" });
  assert.deepEqual(parseIosVersion("15.8.3"), { major: 15, minor: 8, tunnelMode: "none" });
  assert.throws(() => parseIosVersion("14.8"), /iOS 15/);

  const udid = "00008110-0011223344556677";
  const runUsbScenario = async iosVersion => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-ios-ver-"));
    const spawned = [];
    let runnerReady = false;
    const tools = {
      directory: dir,
      devices: async () => [{ udid, name: "Test iPhone", version: iosVersion }],
      run: async args => {
        if (args[0] === "apps") {
          return JSON.stringify([{ CFBundleIdentifier: "dev.test.WebDriverAgentRunner", CFBundleExecutable: "WebDriverAgentRunner-Runner" }]);
        }
        return JSON.stringify([{ udid }]);
      },
      spawn: args => {
        spawned.push(args);
        const child = new EventEmitter();
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => {
          child.signalCode = "SIGTERM";
          queueMicrotask(() => child.emit("exit", null));
          return true;
        };
        if (args[0] === "image") {
          queueMicrotask(() => {
            child.exitCode = 0;
            child.emit("exit", 0);
          });
        }
        if (args[0] === "runwda") {
          runnerReady = true;
        }
        return child;
      }
    };

    let resolveReady;
    const readyPromise = new Promise(resolve => (resolveReady = resolve));
    const usb = new IphoneUsb(
      tools,
      {
        ready: async state => {
          resolveReady(state);
          return "device-1";
        },
        ended: () => {},
        changed: () => {}
      },
      async () => ({ endpoint: "http://127.0.0.1:18100", close: async () => {} }),
      async () => {
        if (!runnerReady) throw new Error("not ready yet");
        return { value: { ready: true }, sessionId: null };
      }
    );

    usb.start({ udid });
    await readyPromise;
    await usb.close();
    fs.rmSync(dir, { recursive: true, force: true });
    return spawned;
  };

  const ios16Calls = await runUsbScenario("16.7.8");
  assert.equal(ios16Calls.some(args => args[0] === "tunnel"), false, "iOS 16 skips CoreDevice tunnel");
  assert.equal(ios16Calls.some(args => args[0] === "image" && args[1] === "auto"), true);
  assert.equal(ios16Calls.some(args => args[0] === "runwda"), true);

  const ios172Calls = await runUsbScenario("17.2");
  const tunnel172 = ios172Calls.find(args => args[0] === "tunnel");
  assert.ok(tunnel172);
  assert.equal(tunnel172.includes("--userspace"), false, "iOS 17.2 uses kernel tunnel start");

  const ios175Calls = await runUsbScenario("17.5");
  const tunnel175 = ios175Calls.find(args => args[0] === "tunnel");
  assert.ok(tunnel175);
  assert.equal(tunnel175.includes("--userspace"), true, "iOS 17.4+ uses --userspace tunnel");
});

test("forwardIphone caches usbmuxd DeviceID lookup within 5s window and re-queries after TTL expiry", async t => {
  const udid = "00008110-0011223344556677";
  let listCount = 0;
  let connectCount = 0;
  let nowMs = 1_000_000;
  const sockets = new Set();

  const muxServer = net.createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buf = Buffer.alloc(0);
    let passthrough = false;
    socket.on("data", chunk => {
      if (passthrough) {
        socket.write(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 16 || buf.length < buf.readUInt32LE(0)) return;
      const req = plist.parse(buf.subarray(16).toString("utf8"));
      let payload;
      if (req.MessageType === "ListDevices") {
        listCount++;
        payload = { DeviceList: [{ DeviceID: 7, Properties: { SerialNumber: udid, ConnectionType: "USB" } }] };
      } else {
        connectCount++;
        passthrough = true;
        payload = { Number: 0 };
      }
      const xml = Buffer.from(plist.build(payload));
      const hdr = Buffer.alloc(16);
      hdr.writeUInt32LE(16 + xml.length, 0);
      hdr.writeUInt32LE(1, 4);
      hdr.writeUInt32LE(8, 8);
      hdr.writeUInt32LE(1, 12);
      socket.write(Buffer.concat([hdr, xml]));
    });
  });
  await new Promise(resolve => muxServer.listen(0, "127.0.0.1", resolve));
  const muxPort = muxServer.address().port;

  const forward = await forwardIphone(udid, () => net.connect(muxPort, "127.0.0.1"), {
    cacheTtlMs: 5000,
    now: () => nowMs
  });
  t.after(async () => {
    await forward.close();
    for (const s of sockets) s.destroy();
    await new Promise(resolve => muxServer.close(resolve));
  });

  const roundtrip = async text => {
    const port = Number(new URL(forward.endpoint).port);
    const client = net.connect(port, "127.0.0.1");
    const echoed = new Promise((resolve, reject) => {
      client.once("data", d => resolve(d.toString("utf8")));
      client.once("error", reject);
    });
    client.write(text);
    const res = await echoed;
    client.destroy();
    return res;
  };

  assert.equal(await roundtrip("ping-1"), "ping-1");
  nowMs += 1000;
  assert.equal(await roundtrip("ping-2"), "ping-2");
  assert.equal(listCount, 1, "second connection within 5s reuses cached DeviceID");
  assert.equal(connectCount, 2);

  nowMs += 6000;
  assert.equal(await roundtrip("ping-3"), "ping-3");
  assert.equal(listCount, 2, "connection after 5s TTL refreshes ListDevices");
});

test("IphoneSigning supports native macOS local codesigning via security + codesign", async t => {
  const identities = parseMacCodesignIdentities(`
  1) AABBCCDDEEFF00112233445566778899AABBCCDD "Mac Developer: Alice (TEAM123)"
  2) 11223344556677889900AABBCCDDEEFF11223344 "Apple Development: Alice (TEAM123)"
     2 valid identities found
`);
  assert.equal(identities[0].hash, "11223344556677889900AABBCCDDEEFF11223344");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pp-mac-sign-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, "profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  const profilePath = path.join(profileDir, "test.mobileprovision");
  fs.writeFileSync(profilePath, "cms-fixture");

  const ipaPath = path.join(root, "unsigned.ipa");
  const zip = new ZipFile();
  const writing = pipeline(zip.outputStream, fs.createWriteStream(ipaPath));
  const appInfo = plist.build({ CFBundleIdentifier: "com.facebook.WebDriverAgentRunner.xctrunner", CFBundleExecutable: "WebDriverAgentRunner-Runner" });
  const xctestInfo = plist.build({ CFBundleIdentifier: "com.facebook.WebDriverAgentRunner", CFBundleExecutable: "WebDriverAgentRunner" });
  zip.addBuffer(Buffer.from("Mach-O"), "Payload/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner", { mode: 0o100755 });
  zip.addBuffer(Buffer.from(appInfo), "Payload/WebDriverAgentRunner-Runner.app/Info.plist", { mode: 0o100644 });
  zip.addBuffer(Buffer.from(xctestInfo), "Payload/WebDriverAgentRunner-Runner.app/PlugIns/WebDriverAgentRunner.xctest/Info.plist", { mode: 0o100644 });
  zip.end();
  await writing;

  const udid = "00008110-0011223344556677";
  const futureDate = new Date(Date.now() + 7 * 86400000);
  const execCalls = [];
  let installedIpa = "";

  const tools = {
    directory: path.join(root, "tools"),
    devices: async () => [{ udid, name: "iPhone 15", version: "18.1" }],
    prepareWda: async () => ({ ipa: ipaPath, version: "v8.0.0" }),
    installSigned: async (targetUdid, signedFile) => {
      assert.equal(targetUdid, udid);
      assert.equal(fs.existsSync(signedFile), true);
      installedIpa = signedFile;
    }
  };

  const runExec = async (cmd, args) => {
    execCalls.push({ cmd, args });
    if (cmd === "security" && args[0] === "find-identity") {
      return { stdout: '  1) 11223344556677889900AABBCCDDEEFF11223344 "Apple Development: Alice (TEAM123)"\n', stderr: "" };
    }
    if (cmd === "security" && args[0] === "cms") {
      return {
        stdout: plist.build({
          ExpirationDate: futureDate,
          ProvisionedDevices: [udid],
          Entitlements: {
            "application-identifier": "TEAM123456.io.profilepilot.*",
            "get-task-allow": true
          }
        }),
        stderr: ""
      };
    }
    return { stdout: "", stderr: "" };
  };

  const signing = new IphoneSigning(tools, "darwin", runExec, [profileDir]);
  assert.deepEqual(await signing.setup(), { ready: true });
  const repaired = await signing.repair(udid);
  assert.equal(repaired.bundleId, "io.profilepilot.WebDriverAgentRunner");
  assert.ok(installedIpa.endsWith("signed.ipa"));
  const codesignTargets = execCalls.filter(c => c.cmd === "codesign" && c.args.includes("--sign")).map(c => c.args.at(-1));
  assert.equal(codesignTargets.some(p => p.endsWith("WebDriverAgentRunner.xctest")), true);
  assert.equal(codesignTargets.some(p => p.endsWith("WebDriverAgentRunner-Runner.app")), true);
});

test("Android expanded keys, @ref selector, Tailscale IPs, and TencentEmulator UIPI non-elevated launch + warning work", async () => {
  // 1. Expanded keys & @ref selector in actions.ts + basic.ts:
  for (const key of ["back", "home", "recents", "enter", "search", "backspace", "delete", "tab", "escape"]) {
    assert.equal(phoneActionSchema.parse({ kind: "key", key }).key, key);
  }
  assert.equal(phoneActionSchema.parse({ kind: "click", selector: { ref: "@e12" } }).selector.ref, "@e12");

  const shellCalls = [];
  const basic = new BasicPhoneControl(
    {
      run: async args => {
        shellCalls.push(args);
        return "";
      }
    },
    "Test PC",
    () => {}
  );
  basic.start("emu-1", "control", "agent", "key test");
  const st = basic.state("emu-1");
  await basic.perform({
    id: "emu-1",
    sessionId: st.sessionId,
    generation: st.generation,
    requestId: randomUUID(),
    action: { kind: "key", key: "enter" }
  });
  await basic.perform({
    id: "emu-1",
    sessionId: st.sessionId,
    generation: st.generation,
    requestId: randomUUID(),
    action: { kind: "key", key: "backspace" }
  });
  assert.match(shellCalls[0].at(-1), /'input' 'keyevent' '66'/);
  assert.match(shellCalls[1].at(-1), /'input' 'keyevent' '67'/);

  // 2. Tailscale 100.64.0.0/10 across wireless, LAN discovery (/32 tunnel netmask), and iPhone WDA:
  assert.equal(wirelessAddress("100.88.12.34:39123"), "100.88.12.34:39123");
  assert.equal(iphoneEndpoint("http://100.88.12.34:8100"), "http://100.88.12.34:8100");
  const tailscaleAdapters = discoveryInterfaces({
    Tailscale: [{ address: "100.70.1.2", netmask: "255.255.255.255", family: "IPv4", internal: false }]
  });
  assert.equal(tailscaleAdapters.length, 1);
  const discovered = discoveryReply(
    Buffer.from(
      JSON.stringify({
        protocol: "profilepilot-discovery-v1",
        type: "phone",
        nonce: "n1",
        id: randomUUID(),
        name: "Pixel Tailscale",
        version: "1.0.0",
        variant: "debug",
        wirelessDebugging: "enabled"
      })
    ),
    "100.115.99.4",
    "n1",
    tailscaleAdapters
  );
  assert.equal(discovered?.ip, "100.115.99.4");

  // 3. TencentEmulator fast cached reg.exe parser + UIPI elevated window warning:
  assert.equal(
    parseTencentRegistryOutput("\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Tencent\\MobileGamePC\\UI\r\n    InstallPath    REG_SZ    D:\\Program Files\\TxGameAssistant\\UI\r\n"),
    "D:\\Program Files\\TxGameAssistant\\UI"
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-tx-"));
  const fakeExe = path.join(tmpDir, "AndroidEmulator.exe");
  fs.writeFileSync(fakeExe, "stub");
  try {
    let regQueries = 0;
    let psScripts = [];
    let launched = false;
    const emu = new TencentEmulator(
      "win32",
      undefined,
      async () => ({
        elevatedWindowPlacementSkipped: true,
        warning: "模拟器正以管理员权限运行，窗口已在屏幕内可见，已跳过自动缩放归位。"
      }),
      async () => ({
        processesAvailable: true,
        tcpAvailable: true,
        processes: launched ? [{ pid: 4242, executablePath: fakeExe, commandLine: `"${fakeExe}" -vm 100` }] : [],
        tcp: launched ? [{ pid: 4242, localAddress: "127.0.0.1", localPort: 5555, state: "Listen" }] : []
      }),
      async () => {},
      async () => {
        regQueries++;
        return tmpDir;
      }
    );
    // Inject powershell only for launch verification while testing cached queryRegistry first:
    assert.equal(await emu.executable(), fakeExe);
    assert.equal(await emu.executable(), fakeExe);
    assert.equal(regQueries, 1, "reg.exe lookup is cached");

    const emuWithMockLaunch = new TencentEmulator(
      "win32",
      async script => {
        psScripts.push(script);
        if (psScripts.length >= 2) launched = true;
        return tmpDir;
      },
      async () => {
        throw new Error("SetWindowPos failed: Access is denied.");
      },
      async () => ({
        processesAvailable: true,
        tcpAvailable: true,
        processes: launched ? [{ pid: 4242, executablePath: fakeExe, commandLine: `"${fakeExe}" -vm 100` }] : [],
        tcp: launched ? [{ pid: 4242, localAddress: "127.0.0.1", localPort: 5555, state: "Listen" }] : []
      }),
      async () => {}
    );
    const serial = await emuWithMockLaunch.connect();
    assert.equal(serial, "127.0.0.1:5555");
    // Verify non-elevated Start-Process appears BEFORE the 740 catch fallback to -Verb RunAs!
    const launchScript = psScripts[1];
    const normalIdx = launchScript.indexOf("-WindowStyle Hidden");
    const runAsIdx = launchScript.indexOf("-Verb RunAs");
    assert.ok(normalIdx > 0 && runAsIdx > normalIdx, "tries non-elevated Start-Process first before RunAs fallback");

    const placementWarning = emuWithMockLaunch.consumePlacementWarning();
    assert.equal(placementWarning?.elevatedWindowPlacementSkipped, true);
    assert.match(placementWarning?.warning || "", /管理员权限/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
