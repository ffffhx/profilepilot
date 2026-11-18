import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomUUID, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const { buildSync } = require("esbuild");
const { popupFixture } = require("./helpers/native-popup-fixture.cjs");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadTs(relPath) {
  const entry = path.resolve(repoRoot, relPath);
  const out = buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    write: false,
    external: ["electron"],
    logLevel: "silent"
  });
  const mod = new Module(entry);
  mod.filename = entry;
  mod.paths = Module._nodeModulePaths(path.dirname(entry));
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { isPackaged: false, getAppPath: () => repoRoot, getPath: () => repoRoot },
        safeStorage: { isEncryptionAvailable: () => false }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    mod._compile(out.outputFiles[0].text, entry);
  } finally {
    Module._load = originalLoad;
  }
  return mod.exports;
}

const {
  parseProxyEndpoint,
  normalizeProxyEndpoint,
  redactProxyEndpoint
} = loadTs("src/shared/proxy-endpoint.ts");

const {
  PROXY_LEAK_PROTECTION_CHROME_ARGS,
  bifrostProxyChromeArgs,
  upstreamProxyChromeArgs,
  ensureUpstreamProxy,
  ensureProxyAuthForwarder,
  closeAllProxyAuthForwarders,
  resolveBifrostBinary
} = loadTs("src/main/bifrost-proxy.ts");

const {
  accountSyncCopySpecs,
  shouldCopyAccountSyncPathEntry,
  chromeCookieToCdpCookieParam,
  cdpCookieToChromeCookieDetails,
  filterCookiesByDomains,
  stagedCookiesFilePath,
  writeStagedCookies,
  readStagedCookies,
  consumeStagedCookies
} = loadTs("src/main/account-sync.ts");

const {
  hasSecurePreferencesSuperMac,
  writeProtectedExtensionInstallRecord,
  removeExtensionReferencesFromProfilePreferences
} = loadTs("src/main/extension-migration.ts");

const { ProfileManager } = loadTs("src/main/profile-manager.ts");
const { NativeControlService } = loadTs("src/main/native-control/service.ts");
const { NATIVE_REQUIRED_CAPABILITIES } = loadTs("src/main/tasks/native-compatibility.ts");
const { shouldAutoDisconnectStaleAgentBrowserClient } = loadTs("src/main/profile-connections.ts");

test("proxy endpoint credentials, leak protection args, Windows Bifrost resolution, and authenticated local forwarder work end-to-end", async (t) => {
  t.after(() => closeAllProxyAuthForwarders());

  const parsed = parseProxyEndpoint("http://user%40org:pa%3Ass@127.0.0.1:7890");
  assert.deepEqual(parsed, {
    scheme: "http",
    host: "127.0.0.1",
    port: 7890,
    username: "user@org",
    password: "pa:ss"
  });
  assert.equal(normalizeProxyEndpoint("http://user%40org:pa%3Ass@127.0.0.1:7890"), "http://user%40org:pa%3Ass@127.0.0.1:7890");
  assert.equal(redactProxyEndpoint("http://user%40org:pa%3Ass@127.0.0.1:7890"), "http://127.0.0.1:7890");

  assert.deepEqual([...PROXY_LEAK_PROTECTION_CHROME_ARGS], [
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"
  ]);
  const bifrostArgs = bifrostProxyChromeArgs({ listenerPort: 18080, rules: ["dev"], groupRules: [] });
  assert.ok(bifrostArgs.includes("--disable-quic"));
  assert.ok(bifrostArgs.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
  const upstreamArgs = upstreamProxyChromeArgs({ server: "socks5://127.0.0.1:1080", bypassList: "localhost,127.0.0.1" });
  assert.ok(upstreamArgs.includes("--proxy-server=socks5://127.0.0.1:1080"));
  assert.ok(upstreamArgs.includes("--disable-quic"));
  assert.ok(upstreamArgs.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));

  // Verify resolveBifrostBinary honors BIFROST_BINARY override
  assert.equal(resolveBifrostBinary({ BIFROST_BINARY: "C:\\Tools\\bifrost.exe" }), "C:\\Tools\\bifrost.exe");

  // Spin up a real local upstream HTTP proxy requiring Basic auth
  const expectedAuth = "Basic " + Buffer.from("proxyuser:s3cr3t!").toString("base64");
  let seenProxyAuth = "";
  const upstreamProxy = http.createServer((req, res) => {
    seenProxyAuth = String(req.headers["proxy-authorization"] || "");
    if (seenProxyAuth !== expectedAuth) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Proxy"' });
      res.end("Proxy auth required");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`proxied:${req.url}`);
  });
  await new Promise((resolve) => upstreamProxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstreamProxy.close(resolve)));

  const upstreamPort = upstreamProxy.address().port;
  const authUrl = `http://proxyuser:${encodeURIComponent("s3cr3t!")}@127.0.0.1:${upstreamPort}`;

  const launchArgs = await ensureUpstreamProxy({ server: authUrl });
  const proxyFlag = launchArgs.find((arg) => arg.startsWith("--proxy-server="));
  assert.ok(proxyFlag, "expected --proxy-server flag");
  assert.equal(proxyFlag.includes("s3cr3t"), false, "Chrome CLI args must never leak credentials");

  const forwarder = await ensureProxyAuthForwarder(authUrl);
  assert.equal(proxyFlag, `--proxy-server=127.0.0.1:${forwarder.port}`);

  // Send an HTTP proxy request through the local forwarder without credentials and verify injection
  const body = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: forwarder.port,
        method: "GET",
        path: "http://example.com/hello",
        headers: { Host: "example.com" }
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, data }));
      }
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(body.status, 200);
  assert.equal(body.data, "proxied:http://example.com/hello");
  assert.equal(seenProxyAuth, expectedAuth);
});

test("accountSyncCopySpecs excludes all *-shm mmap files, includes Web Data-wal, and converts/stages cookies securely", async (t) => {
  const specs = accountSyncCopySpecs();
  const relPaths = specs.map((s) => s.relativePath);

  assert.equal(relPaths.some((p) => p.endsWith("-shm")), false, `Found forbidden -shm in ${relPaths.join(", ")}`);
  assert.equal(relPaths.includes("Cookies-shm"), false);
  assert.equal(relPaths.includes(path.join("Network", "Cookies-shm")), false);
  assert.equal(relPaths.includes("Web Data"), true);
  assert.equal(relPaths.includes("Web Data-wal"), true);
  const fakeRoot = path.join(os.tmpdir(), "profile-default");
  assert.equal(shouldCopyAccountSyncPathEntry(fakeRoot, path.join(fakeRoot, "Local Storage", "leveldb", "index-shm")), false);
  assert.equal(shouldCopyAccountSyncPathEntry(fakeRoot, path.join(fakeRoot, "Network", "Cookies-shm")), false);
  assert.equal(shouldCopyAccountSyncPathEntry(fakeRoot, path.join(fakeRoot, "Network", "Cookies-wal")), true);

  // Cookie conversion round-trip (hostOnly, __Host-, domain, SameSite, CHIPS partitionKey)
  const rawChromeCookies = [
    {
      name: "__Host-session",
      value: "tok-123",
      domain: "app.example.com",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      session: true
    },
    {
      name: "sub_pref",
      value: "dark",
      domain: ".example.com",
      hostOnly: false,
      path: "/settings",
      secure: true,
      httpOnly: false,
      sameSite: "no_restriction",
      expirationDate: 1900000000,
      partitionKey: { topLevelSite: "https://portal.example.com", hasCrossSiteAncestors: false }
    },
    {
      name: "other_site",
      value: "skip",
      domain: ".unrelated.org",
      hostOnly: false,
      path: "/",
      secure: false,
      httpOnly: false
    }
  ];

  const filtered = filterCookiesByDomains(rawChromeCookies, ["example.com"]);
  assert.equal(filtered.length, 2);

  const cdpHostCookie = chromeCookieToCdpCookieParam(filtered[0]);
  assert.equal(cdpHostCookie.domain, undefined, "hostOnly / __Host- cookies must omit domain in CDP CookieParam");
  assert.equal(cdpHostCookie.url, "https://app.example.com/");
  assert.equal(cdpHostCookie.secure, true);
  assert.equal(cdpHostCookie.httpOnly, true);
  assert.equal(cdpHostCookie.sameSite, "Lax");
  assert.equal(cdpHostCookie.expires, undefined);

  const cdpDomainCookie = chromeCookieToCdpCookieParam(filtered[1]);
  assert.equal(cdpDomainCookie.domain, ".example.com");
  assert.equal(cdpDomainCookie.sameSite, "None");
  assert.equal(cdpDomainCookie.expires, 1900000000);
  assert.deepEqual(cdpDomainCookie.partitionKey, {
    topLevelSite: "https://portal.example.com",
    hasCrossSiteAncestors: false
  });

  const backToChrome = cdpCookieToChromeCookieDetails(cdpDomainCookie);
  assert.equal(backToChrome.domain, ".example.com");
  assert.equal(backToChrome.sameSite, "no_restriction");
  assert.equal(backToChrome.expirationDate, 1900000000);

  // Staged cookies: encrypted (safeStorage cipher) and fallback 0o600 JSON
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pp-staged-cookies-"));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const mockCipher = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain, "utf8").reverse(),
    decryptString: (buf) => Buffer.from(buf).reverse().toString("utf8")
  };

  const encFile = await writeStagedCookies(dataDir, "isolated:prof-enc", [cdpHostCookie, cdpDomainCookie], mockCipher);
  assert.equal(encFile, stagedCookiesFilePath(dataDir, "prof-enc"));
  const onDiskRaw = await fsp.readFile(encFile, "utf8");
  assert.equal(onDiskRaw.includes("tok-123"), false, "encrypted staged cookie file must not contain plaintext cookie values");
  assert.equal(JSON.parse(onDiskRaw).encrypted, true);

  const peeked = await readStagedCookies(dataDir, "prof-enc", mockCipher);
  assert.equal(peeked.length, 2);
  assert.equal(peeked[0].value, "tok-123");

  let injectedEnc = [];
  const consumed = await consumeStagedCookies(dataDir, "prof-enc", async (c) => { injectedEnc = c; }, mockCipher);
  assert.equal(consumed, 2);
  assert.equal(injectedEnc.length, 2);
  assert.equal(fs.existsSync(encFile), false, "consumeStagedCookies must delete the staged file");

  // Fallback plaintext 0o600 mode when safeStorage is unavailable
  const plainFile = await writeStagedCookies(dataDir, "prof-plain", [cdpHostCookie], {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ""
  });
  assert.equal(JSON.parse(await fsp.readFile(plainFile, "utf8")).encrypted, false);
  let injectedPlain = [];
  const consumedPlain = await consumeStagedCookies(dataDir, "prof-plain", async (c) => { injectedPlain = c; });
  assert.equal(consumedPlain, 1);
  assert.equal(injectedPlain[0].name, "__Host-session");
  assert.equal(fs.existsSync(plainFile), false);
});

test("ProfileManager supports isolated -> isolated syncAccount and protocol cookie sync (immediate CDP + staged injection)", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pp-pm-cookie-sync-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const injectedCalls = [];
  const runningPorts = new Map();
  const cipher = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (buf) => {
      const str = buf.toString("utf8");
      assert.ok(str.startsWith("enc:"));
      return str.slice(4);
    }
  };

  const pm = new ProfileManager(
    root,
    {},
    {
      cookieCipher: cipher,
      exportExtensionCookies: async (profileId) => {
        if (profileId === "native:Default") {
          return [
            {
              name: "v20_auth",
              value: "decrypted-from-extension",
              domain: ".github.com",
              hostOnly: false,
              path: "/",
              secure: true,
              httpOnly: true,
              sameSite: "lax",
              expirationDate: 1950000000
            }
          ];
        }
        return null;
      },
      exportCdpCookies: async (port) => [
        {
          name: "gateway_sid",
          value: `from-port-${port}`,
          domain: ".linear.app",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
          expires: 1950000000
        }
      ],
      injectCdpCookies: async (port, cookies) => {
        injectedCalls.push({ port, cookies });
      }
    }
  );

  const isoA = await pm.createProfile("Source Isolated");
  const isoB = await pm.createProfile("Target Isolated");
  const isoAPath = path.join(root, "profiles", isoA.dirName);
  const isoBPath = path.join(root, "profiles", isoB.dirName);

  const fakeNativeRoot = path.join(root, "fake-native-chrome");
  await fsp.mkdir(path.join(fakeNativeRoot, "Default"), { recursive: true });
  await fsp.writeFile(path.join(fakeNativeRoot, "Default", "Preferences"), JSON.stringify({ profile: { name: "Native Alice" } }), "utf8");
  const prevNativeEnv = process.env.CPM_NATIVE_CHROME_USER_DATA_DIR;
  process.env.CPM_NATIVE_CHROME_USER_DATA_DIR = fakeNativeRoot;
  t.after(() => {
    if (prevNativeEnv === undefined) delete process.env.CPM_NATIVE_CHROME_USER_DATA_DIR;
    else process.env.CPM_NATIVE_CHROME_USER_DATA_DIR = prevNativeEnv;
  });

  // Stub getState() to provide deterministic running/offline ports without touching OS process tables
  pm.getState = async () => {
    const portA = runningPorts.get(`isolated:${isoA.id}`) ?? null;
    const portB = runningPorts.get(`isolated:${isoB.id}`) ?? null;
    const makePub = (id, name, pPath, source, port) => ({
      id,
      name,
      dirName: path.basename(pPath),
      userDataDir: pPath,
      path: pPath,
      source,
      browserKind: "chrome",
      createdAt: new Date().toISOString(),
      lastLaunchedAt: null,
      running: port !== null,
      pids: port !== null ? [4242] : [],
      browserPids: port !== null ? [4242] : [],
      startedAt: port !== null ? new Date().toISOString() : null,
      cdpPort: port,
      cdpUrl: port !== null ? `http://127.0.0.1:${port}` : null,
      fixedCdpPort: null,
      listeningPorts: port !== null ? [port] : [],
      cdpClients: [],
      agentActivity: null,
      gatewayControl: null,
      agentBrowserOccupancy: null,
      hideAutomation: false,
      agentAccessDisabled: false,
      directConnection: false,
      bifrostProxy: null,
      upstreamProxy: null,
      migratedExtensions: [],
      accountUserName: null,
      avatarDataUrl: null
    });
    return {
      profilesDir: path.join(root, "profiles"),
      chromeInstalled: true,
      chromeRunning: false,
      agentOverlayEnabled: true,
      miniProfileIds: [],
      miniProfileOrder: [],
      mainProfileOrder: [],
      quickLaunchShortcuts: [],
      accountSyncRecords: [],
      takeoverHistory: [],
      externalInstances: [],
      shellIntegration: { cliInstalled: false, skillInstalled: false },
      profiles: [
        makePub("native:Default", "Default", path.join(fakeNativeRoot, "Default"), "native", null),
        makePub(`isolated:${isoA.id}`, isoA.name, isoAPath, "isolated", portA),
        makePub(`isolated:${isoB.id}`, isoB.name, isoBPath, "isolated", portB)
      ]
    };
  };

  // Populate Preferences + Local Storage in isoA Default profile and set isoA as running on Gateway port 9333
  const isoADefault = path.join(isoAPath, "Default");
  await fsp.mkdir(path.join(isoADefault, "Local Storage", "leveldb"), { recursive: true });
  await fsp.writeFile(path.join(isoADefault, "Preferences"), JSON.stringify({ profile: { name: "Alice" } }), "utf8");
  await fsp.writeFile(path.join(isoADefault, "Local Storage", "leveldb", "0001.ldb"), "storage-bytes", "utf8");
  await fsp.writeFile(path.join(isoADefault, "Cookies-shm"), "MUST-NOT-BE-COPIED", "utf8");
  runningPorts.set(`isolated:${isoA.id}`, 9333);

  // 1) isolated -> isolated sync while target is offline -> stages encrypted cookies on disk!
  const isoSyncResult = await pm.syncAccount({
    sourceProfileId: `isolated:${isoA.id}`,
    targetProfileId: `isolated:${isoB.id}`
  });
  assert.equal(isoSyncResult.sourceProfileId, `isolated:${isoA.id}`);
  assert.equal(isoSyncResult.targetProfileId, `isolated:${isoB.id}`);
  assert.equal(fs.existsSync(path.join(isoBPath, "Default", "Cookies-shm")), false, "Cookies-shm must never be copied");
  assert.equal(fs.existsSync(path.join(isoBPath, "Default", "Local Storage", "leveldb", "0001.ldb")), true);

  const stagedPath = stagedCookiesFilePath(root, isoB.id);
  assert.equal(fs.existsSync(stagedPath), true, "cookies should be staged while target is not running");

  // Simulate target Gateway launch consuming staged cookies
  const injectedCount = await pm.consumeStagedCookiesOverCdp(isoB.id, 9444);
  assert.equal(injectedCount, 1);
  assert.equal(injectedCalls.length, 1);
  assert.equal(injectedCalls[0].port, 9444);
  assert.equal(injectedCalls[0].cookies[0].name, "gateway_sid");
  assert.equal(fs.existsSync(stagedPath), false, "staged cookies file must be deleted after injection");

  // 2) Extension-connected native:Default -> running Gateway target -> immediate CDP injection!
  runningPorts.set(`isolated:${isoB.id}`, 9555);
  pm.closeProfileIfRunning = async () => {};
  await pm.syncAccount({
    sourceProfileId: "native:Default",
    targetProfileId: `isolated:${isoB.id}`
  });
  assert.equal(injectedCalls.length, 2);
  assert.equal(injectedCalls[1].port, 9555);
  assert.equal(injectedCalls[1].cookies[0].name, "v20_auth");
  assert.equal(injectedCalls[1].cookies[0].value, "decrypted-from-extension");
});

test("extension-migration never mutates Secure Preferences when protection.super_mac is present, and Chrome 137+ flag is wired", async (t) => {
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pp-supermac-"));
  t.after(() => fsp.rm(profileDir, { recursive: true, force: true }));

  const extId = "a".repeat(32);
  const profileDataDir = path.join(profileDir, "Default");
  const securePrefsPath = path.join(profileDataDir, "Secure Preferences");
  await fsp.mkdir(profileDataDir, { recursive: true });
  const originalSecurePrefs = JSON.stringify(
    {
      extensions: { settings: { [extId]: { path: "/old/ext", state: 1 } } },
      protection: { macs: { extensions: { settings: { [extId]: "HMAC123" } } }, super_mac: "SUPER_MAC_HEX_VALUE" }
    },
    null,
    2
  );
  await fsp.writeFile(securePrefsPath, originalSecurePrefs, "utf8");

  assert.equal(await hasSecurePreferencesSuperMac(profileDataDir), true);

  // writeProtectedExtensionInstallRecord must refuse to mutate Secure Preferences and return false
  const sampleInstallRecord = { setting: { path: "/new/ext", state: 1 }, settingMac: "M1", encryptedHashMac: "H1" };
  const wrote = await writeProtectedExtensionInstallRecord(profileDataDir, extId, sampleInstallRecord, null);
  assert.equal(wrote, false);
  assert.equal(await fsp.readFile(securePrefsPath, "utf8"), originalSecurePrefs);

  // removeExtensionReferencesFromProfilePreferences must also leave super_mac-protected Secure Preferences untouched
  await removeExtensionReferencesFromProfilePreferences(profileDataDir, [extId]);
  assert.equal(await fsp.readFile(securePrefsPath, "utf8"), originalSecurePrefs);

  // Without super_mac, writeProtectedExtensionInstallRecord succeeds and returns true
  const unprotectedDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pp-nosupermac-"));
  t.after(() => fsp.rm(unprotectedDir, { recursive: true, force: true }));
  assert.equal(await hasSecurePreferencesSuperMac(unprotectedDir), false);
  const wroteUnprotected = await writeProtectedExtensionInstallRecord(unprotectedDir, extId, sampleInstallRecord, null);
  assert.equal(wroteUnprotected, true);

  // Verify profile-manager.ts passes --enable-unsafe-extension-debugging when runtimeLoadPaths.length > 0
  const pmSource = await fsp.readFile(path.join(repoRoot, "src/main/profile-manager.ts"), "utf8");
  assert.match(pmSource, /launchPlan\.runtimeLoadPaths\.length\s*>\s*0[\s\S]{0,500}--enable-unsafe-extension-debugging/);
});

async function createExtensionHarness({ autoWelcome = true, timerScale = 1 } = {}) {
  const sockets = [];
  const calls = [];
  const messages = [];
  const ungrouped = [];
  const groups = new Map();
  const cookieJar = [
    { name: "sid", value: "v20-secret", domain: ".github.com", hostOnly: false, path: "/", secure: true, httpOnly: true, sameSite: "lax" },
    { name: "other", value: "123", domain: ".example.org", hostOnly: false, path: "/", secure: false, httpOnly: false }
  ];
  const setCookies = [];
  let nextTabId = 50;
  let nextGroupId = 300;
  let runtimeListener;
  const tabs = new Map([
    [7, { id: 7, windowId: 1, groupId: -1, active: true, url: "https://user-tab.test/home", title: "User Tab 7", status: "complete" }],
    [8, { id: 8, windowId: 1, groupId: -1, active: false, url: "https://second-tab.test/doc", title: "User Tab 8", status: "complete" }]
  ]);

  const event = () => ({
    fire: undefined,
    addListener(fn) {
      this.fire = fn;
    }
  });
  const area = () => ({
    data: {},
    async get(key) {
      return { [key]: this.data[key] };
    },
    async set(val) {
      Object.assign(this.data, structuredClone(val));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete this.data[k];
    }
  });

  class HarnessSocket {
    static OPEN = 1;
    readyState = 0;
    listeners = {};
    constructor(url) {
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState === 3) return;
        this.readyState = 1;
        this.onopen?.();
        this.listeners.open?.();
        if (autoWelcome) this.receive({ type: "welcome" });
      });
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    send(raw) {
      messages.push(JSON.parse(raw));
    }
    receive(payload) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
    close(code = 1006) {
      this.readyState = 3;
      this.onclose?.({ code, wasClean: code === 1000 });
      this.listeners.close?.();
    }
  }

  const chrome = {
    runtime: {
      id: "fixture",
      getURL: (f) => `chrome-extension://fixture/${f}`,
      getManifest: () => ({ version: "0.2.18" }),
      onMessage: { addListener: (fn) => (runtimeListener = fn) },
      onInstalled: event(),
      onStartup: event()
    },
    storage: { local: area(), session: area(), onChanged: event() },
    alarms: { create: async () => {}, onAlarm: event() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    cookies: {
      getAll: async () => structuredClone(cookieJar),
      set: async (details) => {
        setCookies.push(details);
        return details;
      }
    },
    tabs: {
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("No tab");
        return { ...tabs.get(id) };
      },
      query: async (q = {}) =>
        [...tabs.values()].filter(
          (t) => (q.groupId === undefined || t.groupId === q.groupId) && (q.active === undefined || t.active === q.active)
        ),
      create: async (opts) => {
        const tab = { id: nextTabId++, windowId: 1, groupId: -1, status: "complete", ...opts };
        tabs.set(tab.id, tab);
        return tab;
      },
      group: async (p) => {
        const gid = p.groupId ?? nextGroupId++;
        if (!groups.has(gid)) groups.set(gid, { id: gid, windowId: p.createProperties?.windowId ?? 1, color: "grey", title: "" });
        for (const tid of [].concat(p.tabIds)) {
          if (tabs.has(tid)) tabs.get(tid).groupId = gid;
        }
        return gid;
      },
      ungroup: async (tabIds) => {
        for (const tid of [].concat(tabIds)) {
          ungrouped.push(tid);
          if (tabs.has(tid)) tabs.get(tid).groupId = -1;
        }
      },
      update: async (id, patch) => Object.assign(tabs.get(id), patch),
      remove: async (id) => {
        tabs.delete(id);
        chrome.tabs.onRemoved.fire?.(id);
      },
      onUpdated: event(),
      onReplaced: event(),
      onCreated: event(),
      onRemoved: event()
    },
    tabGroups: {
      get: async (id) => {
        if (!groups.has(id)) throw new Error("No group");
        return { ...groups.get(id) };
      },
      update: async (id, patch) => Object.assign(groups.get(id), patch),
      onRemoved: event()
    },
    windows: { getLastFocused: async () => ({ id: 1 }), update: async () => {} },
    debugger: {
      attach: async (target) => calls.push(["attach", target.tabId]),
      detach: async (target) => calls.push(["detach", target.tabId]),
      sendCommand: async (target, method, params) => {
        calls.push([method, target.tabId, params]);
        return { ok: true };
      },
      onEvent: event(),
      onDetach: event()
    }
  };

  const scheduledTimeouts = [];
  const context = vm.createContext({
    chrome,
    crypto: webcrypto,
    WebSocket: HarnessSocket,
    URL,
    atob,
    fetch,
    setInterval,
    clearInterval,
    setTimeout: (fn, ms) => {
      scheduledTimeouts.push(ms);
      return setTimeout(fn, ms * timerScale);
    },
    clearTimeout
  });

  const bgCode = await fsp.readFile(path.join(repoRoot, "extensions/profilepilot/background.js"), "utf8");
  vm.runInContext(
    `${bgCode}\nglobalThis.harness = { handle, state, syncTaskGroups, disconnect, setConfig: (c) => { config = c; }, connect: () => connect() };`,
    context
  );
  await new Promise((r) => setImmediate(r));

  return {
    ...context.harness,
    chrome,
    tabs,
    groups,
    sockets,
    calls,
    messages,
    ungrouped,
    setCookies,
    scheduledTimeouts,
    ui: (msg) =>
      new Promise((resolve) =>
        runtimeListener(msg, { id: "fixture", url: "chrome-extension://fixture/popup.html" }, resolve)
      ),
    cleanup: async () => {
      await context.harness.disconnect(true);
    }
  };
}

test("companion extension supports cookies.export/import, default background tab + borrowed user tab ungrouping, multi-session, and JS dialogs", async (t) => {
  const manifest = JSON.parse(await fsp.readFile(path.join(repoRoot, "extensions/profilepilot/manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("cookies"), 'manifest.json must declare "cookies" permission');

  const h = await createExtensionHarness();
  t.after(() => h.cleanup());
  h.setConfig({ port: 19999, profileId: "native:Default", token: "a".repeat(64) });
  await h.connect();

  // 1) cookies.export & cookies.import
  const exported = await h.handle("cookies.export", { domains: ["github.com"] });
  assert.equal(exported.cookies.length, 1);
  assert.equal(exported.cookies[0].value, "v20-secret");

  const imported = await h.handle("cookies.import", {
    cookies: [
      { name: "__Host-token", value: "abc", domain: "app.github.com", hostOnly: true, path: "/", secure: true, httpOnly: true },
      { name: "pref", value: "1", domain: ".github.com", hostOnly: false, path: "/", secure: true, sameSite: "None", expires: 1950000000 }
    ]
  });
  assert.equal(imported.imported, 2);
  assert.equal(imported.failed, 0);
  assert.equal(h.setCookies[0].domain, undefined, "__Host- cookie must not set domain attribute");
  assert.equal(h.setCookies[1].domain, ".github.com");
  assert.equal(h.setCookies[1].sameSite, "no_restriction");

  // 2) Default background tab in ProfilePilot Tab Group when newTab is requested (as ppilot browser claim defaults to; leaves user's active tab 7 untouched!)
  await h.handle("claim", { sessionId: "bg-session", newTab: true, taskTitle: "后台任务" });
  await h.syncTaskGroups();
  const bgState = await h.state();
  assert.equal(bgState.tabId, 50, "claim without tabId must create background tab 50 instead of hijacking active tab 7");
  assert.equal(h.tabs.get(7).active, true);
  assert.equal(h.tabs.get(7).groupId, -1, "user tab 7 must remain ungrouped");
  assert.ok(h.tabs.get(50).groupId >= 300, "new background tab must be enrolled in ProfilePilot Tab Group");

  // 3) Per-tab multi-session: second session claims user tab 8 concurrently while bg-session owns tab 50!
  await h.handle("claim", { sessionId: "borrowed-session", tabId: 8, taskTitle: "借用标签" });
  await h.syncTaskGroups();
  const multiState = await h.state();
  assert.equal(multiState.sessions.length, 2);

  // Conflict on already-owned tab 50 or tab 8
  await assert.rejects(h.handle("claim", { sessionId: "intruder", tabId: 50 }), /另一个任务|占用/);
  await assert.rejects(h.handle("claim", { sessionId: "intruder", tabId: 8 }), /另一个任务|占用/);

  // 4) JS Dialog tracking and handling on tab 8 (peer session!)
  h.chrome.debugger.onEvent.fire({ tabId: 8 }, "Page.javascriptDialogOpening", {
    type: "prompt",
    message: "请输入验证码",
    defaultPrompt: "0000"
  });
  const withDialog = await h.state();
  const peerSnap = withDialog.sessions.find((s) => s.sessionId === "borrowed-session");
  assert.equal(peerSnap.dialogPending.type, "prompt");
  assert.equal(peerSnap.dialogPending.message, "请输入验证码");

  const dialogRes = await h.handle("dialog", { sessionId: "borrowed-session", action: "accept", promptText: "1234" });
  assert.equal(dialogRes.handled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.at(-1))), ["Page.handleJavaScriptDialog", 8, { accept: true, promptText: "1234" }]);
  const afterDialog = await h.state();
  assert.equal(afterDialog.sessions.find((s) => s.sessionId === "borrowed-session").dialogPending, undefined);

  // 5) Completing borrowed-session calls chrome.tabs.ungroup(8), while completing bg-session keeps created tab 50 grouped!
  await h.handle("control", { sessionId: "borrowed-session", action: "complete" });
  assert.deepEqual(h.ungrouped, [8], "borrowed user tab 8 must be ungrouped on complete");
  await h.handle("control", { sessionId: "bg-session", action: "complete" });
  assert.deepEqual(h.ungrouped, [8], "task-created tab 50 must NOT be ungrouped");
});

test("companion extension connect() waits for welcome, reconnects with exponential backoff, and keeps 15s debugger grace period", async (t) => {
  const h = await createExtensionHarness({ autoWelcome: false, timerScale: 0.01 });
  t.after(() => h.cleanup());
  h.setConfig({ port: 19998, profileId: "native:Default", token: "b".repeat(64) });

  // 1) connect() does NOT resolve on socket open until 'welcome' arrives
  let resolved = false;
  const connectingPromise = h.connect().then(() => {
    resolved = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sockets.length, 1);
  assert.equal(resolved, false, "connect() must wait for welcome before resolving");
  assert.equal((await h.state()).connected, false);

  h.sockets[0].receive({ type: "welcome" });
  await connectingPromise;
  assert.equal(resolved, true);
  assert.equal((await h.state()).connected, true);

  // Claim tab 7 so debugger is attached
  await h.handle("claim", { sessionId: "keep-alive", tabId: 7 });
  assert.deepEqual(h.calls, [["attach", 7]]);

  // 2) Transient socket close schedules 500ms backoff + 15000ms detach grace WITHOUT detaching debugger immediately!
  h.scheduledTimeouts.length = 0;
  h.sockets[0].close(1006);
  assert.equal(h.calls.some((c) => c[0] === "detach"), false, "debugger must NOT detach immediately on transient close");
  assert.ok(h.scheduledTimeouts.includes(500), "first reconnect backoff must be 500ms");
  assert.ok(h.scheduledTimeouts.includes(15000), "detach grace timer must be 15000ms");

  // Wait for reconnect socket #2 (500ms * 0.01 = 5ms) and deliver welcome within grace period!
  while (h.sockets.length < 2) await new Promise((r) => setTimeout(r, 5));
  h.sockets[1].receive({ type: "welcome" });
  await new Promise((r) => setImmediate(r));
  assert.equal((await h.state()).connected, true);
  assert.equal((await h.state()).ownership, "agent");

  // Wait past scaled 15s (150ms) and verify cancelled grace timer never detached our recovered session!
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(h.calls.some((c) => c[0] === "detach"), false, "recovered session must keep debugger attached past 15s");
  assert.equal((await h.state()).ownership, "agent");
});

test("popup and sidepanel expose takeover, return, disconnect, site-access selector, and persistent-install confirmation", async () => {
  const f = await popupFixture([], {
    state: {
      profileId: "native:Default",
      connected: true,
      sessionId: "s1",
      tabId: 7,
      tabTitle: "GitHub Settings",
      url: "https://github.com/settings/profile",
      ownership: "agent",
      installation: { type: "development", mode: "temporary", temporary: true },
      access: { blockedOrigins: [], allowedOrigins: [], confirmActions: false }
    }
  });

  // Temporary install banner & clear button visible
  assert.equal(f.element("#temp-install-notice").hidden, false);
  assert.equal(f.element("#pause-takeover-btn").hidden, false);
  assert.equal(f.element("#return-control-btn").hidden, true);
  assert.equal(f.element("#disconnect-browser-btn").hidden, false);
  assert.equal(f.element("#site-access-section").hidden, false);
  assert.equal(f.element("#site-access-origin").textContent, "github.com");
  assert.equal(f.element("#site-access-select").value, "allow");

  let livePopupState = { ...f.state };
  const patchPopupState = (patch) => {
    livePopupState = { ...livePopupState, ...patch };
    f.setState(livePopupState);
    return livePopupState;
  };

  // 1) Confirm persistent installation
  f.handlers.confirmPersistentInstallation = (msg) => {
    assert.equal(msg.confirmed, true);
    return { result: patchPopupState({ installation: { type: "development", mode: undefined, temporary: false }, installationMode: undefined }) };
  };
  await f.element("#clear-temp-install-btn").listeners.click();
  await f.flush();
  assert.equal(f.element("#temp-install-notice").hidden, true);

  // 2) Pause & takeover -> swaps to Return control button
  f.handlers.takeover = () => ({ result: patchPopupState({ ownership: "user" }) });
  await f.element("#pause-takeover-btn").listeners.click();
  await f.flush();
  assert.equal(f.element("#pause-takeover-btn").hidden, true);
  assert.equal(f.element("#return-control-btn").hidden, false);

  // 3) Return control -> swaps back to Pause & takeover
  f.handlers.return = () => ({ result: patchPopupState({ ownership: "agent" }) });
  await f.element("#return-control-btn").listeners.click();
  await f.flush();
  assert.equal(f.element("#pause-takeover-btn").hidden, false);

  // 4) Site access selector -> block current origin
  let savedAccess;
  f.handlers.setAccess = (msg) => {
    savedAccess = { blockedOrigins: msg.blockedOrigins, allowedOrigins: msg.allowedOrigins, confirmActions: msg.confirmActions };
    patchPopupState({ access: savedAccess, ownership: "user" });
    return { result: { access: savedAccess } };
  };
  f.element("#site-access-select").value = "block";
  f.element("#site-access-select").listeners.change();
  await f.flush();
  assert.deepEqual(Array.from(savedAccess.blockedOrigins), ["https://github.com"]);

  // 5) Disconnect browser
  f.handlers.disconnect = () => ({ result: patchPopupState({ profileId: undefined, connected: false, sessionId: undefined }) });
  await f.element("#disconnect-browser-btn").listeners.click();
  await f.flush();
  assert.equal(f.element("#connect").hidden, false);
  assert.equal(f.element("#security-controls").hidden, true);
});

test("NativeControlService supports LRU receipt eviction at limit and concurrent per-tab multi-session on one Profile", async (t) => {
  const sessionEntries = [];
  const profileState = {
    profileId: "native:Default",
    connected: true,
    ownership: "user",
    taskTabs: true,
    controlGeneration: "w:0",
    extensionVersion: "0.2.18",
    capabilities: [...NATIVE_REQUIRED_CAPABILITIES, "cookies", "dialogs", "multiSession"],
    sessions: sessionEntries
  };

  let listener;
  const bridgeCalls = [];
  const bridge = {
    states: () => [profileState],
    onEvent: (fn) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    request: async (_profileId, method, params) => {
      bridgeCalls.push({ method, params });
      if (method === "claim") {
        const idx = sessionEntries.findIndex((s) => s.sessionId === params.sessionId);
        const entry = {
          sessionId: params.sessionId,
          tabId: params.tabId ?? 100 + sessionEntries.length,
          tabs: [params.tabId ?? 100 + sessionEntries.length],
          ownership: "agent",
          pausedByBrowser: false,
          controlGeneration: `inst-${params.sessionId}:0`
        };
        if (idx >= 0) sessionEntries[idx] = entry;
        else sessionEntries.push(entry);
        profileState.ownership = "agent";
        profileState.ownerSessionId = sessionEntries[0].sessionId;
        listener?.({ type: "state", profileId: profileState.profileId, state: profileState });
      }
      if (method === "cookies.export") {
        return { cookies: [{ name: "c1", value: "v1" }] };
      }
      return {};
    }
  };

  let clock = 1_700_000_000_000;
  const service = new NativeControlService(bridge, os.tmpdir(), { actionReceiptLimit: 5, now: () => clock });
  t.after(() => service.close());
  service.browser.observe = async (task) => ({
    version: `obs-${task.sessionId}`,
    snapshot: `Page for ${task.sessionId}`
  });

  // Two distinct sessions claim disjoint tabs on the SAME native:Default profile concurrently
  const claimA = await service.request({ requestId: "req-claim-a", method: "claim", sessionId: "agent-a", params: { tabId: 11 } });
  const claimB = await service.request({ requestId: "req-claim-b", method: "claim", sessionId: "agent-b", params: { tabId: 22 } });
  assert.equal(claimA.state.tabId, 11);
  assert.equal(claimB.state.tabId, 22);

  // Same tabId conflict is rejected cleanly
  await assert.rejects(
    service.request({ requestId: "req-claim-c", method: "claim", sessionId: "agent-c", params: { tabId: 11 } }),
    (err) => err.code === "NATIVE_SESSION_CONFLICT"
  );

  // Both sessions observe independently without colliding
  const obsA = await service.request({ requestId: "req-obs-a", method: "observe", sessionId: "agent-a" });
  const obsB = await service.request({ requestId: "req-obs-b", method: "observe", sessionId: "agent-b" });
  assert.equal(obsA.version, "obs-agent-a");
  assert.equal(obsB.version, "obs-agent-b");

  // Advance past 15-minute TTL window: expired completed receipts evict via LRU instead of throwing NATIVE_REQUEST_CAPACITY!
  for (let i = 0; i < 8; i++) {
    clock += 16 * 60_000;
    const res = await service.request({ requestId: `cookie-exp-${i}`, method: "cookies.export", params: { domains: ["example.com"] } });
    assert.equal(res.cookies[0].name, "c1");
  }
  assert.ok(service.receipts.size <= 5, `expected receipts <= 5 after TTL/LRU eviction, got ${service.receipts.size}`);
});

test("shouldAutoDisconnectStaleAgentBrowserClient never kills external non-Claude/Codex agents or unproven missing-log clients", () => {
  const now = Date.parse("2026-11-18T10:00:00.000Z");
  const tenMinutesAgo = new Date(now - 10 * 60_000).toISOString();
  const thirtySecondsAgo = new Date(now - 30_000).toISOString();

  // 1) External non-Claude/Codex agent (Cursor, Windsurf, Playwright, custom script) with no session log -> NEVER disconnect!
  assert.equal(
    shouldAutoDisconnectStaleAgentBrowserClient(
      {
        pid: 1001,
        label: "agent-browser (external)",
        command: "agent-browser",
        driverKind: "agent-browser",
        agent: "Agent Browser",
        note: "近期无活跃会话（可能是会话结束后的残留连接）",
        lastActive: tenMinutesAgo
      },
      now
    ),
    false
  );

  // 2) Known Claude session ID (`cc-<uuid>`) with only speculative note -> NEVER disconnect!
  const claudeSession = `cc-${randomUUID()}`;
  assert.equal(
    shouldAutoDisconnectStaleAgentBrowserClient(
      {
        pid: 1002,
        label: "agent-browser",
        command: "agent-browser",
        driverKind: "agent-browser",
        session: claudeSession,
        note: "近期无活跃会话",
        lastActive: tenMinutesAgo
      },
      now
    ),
    false
  );

  // 3) Explicitly archived Codex session (`cx-<uuid>`), but still within 120s grace period -> keep!
  const codexSession = `cx-${randomUUID()}`;
  assert.equal(
    shouldAutoDisconnectStaleAgentBrowserClient(
      {
        pid: 1003,
        label: "agent-browser",
        command: "agent-browser",
        driverKind: "agent-browser",
        session: codexSession,
        note: "会话已归档",
        lastActive: thirtySecondsAgo
      },
      now
    ),
    false
  );

  // 4) Explicitly archived/terminated Claude/Codex session AND idle >= 120s -> disconnect!
  assert.equal(
    shouldAutoDisconnectStaleAgentBrowserClient(
      {
        pid: 1004,
        label: "agent-browser",
        command: "agent-browser",
        driverKind: "agent-browser",
        session: codexSession,
        note: "会话已归档",
        lastActive: tenMinutesAgo
      },
      now
    ),
    true
  );
});
