import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const { buildSync } = require("esbuild");
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
  normalizeBrowserKind,
  browserKindDisplayName,
  browserMacAppName,
  resolveBrowserExecutable,
  resolveWindowsBrowserExecutable,
  nativeBrowserUserDataDir,
  cleanStaleSingletonLocks
} = loadTs("src/main/chrome-launch.ts");

const {
  isChromiumBrowserMainProcess,
  isChromiumRendererProcess,
  parseExternalBrowserName
} = loadTs("src/main/process-scan.ts");

const {
  macOnboardingTabScript,
  windowsOnboardingTabScript,
  MAC_CHROMIUM_BROWSER_APPS,
  WINDOWS_CHROMIUM_BROWSER_PROCESSES
} = loadTs("src/main/tasks/native-onboarding-tab.ts");

const {
  canAutoLoadUnpackedExtensions,
  getMigratedExtensionLaunchPlan
} = loadTs("src/main/migrated-extension-launch.ts");

const { ProfileManager } = loadTs("src/main/profile-manager.ts");
const { ProfileStateReader } = loadTs("src/main/profile-state.ts");

test("normalizeBrowserKind, display names, and macOS app names cover Chrome, Edge, Brave, and Chromium", () => {
  for (const kind of ["chrome", "edge", "brave", "chromium"]) {
    assert.equal(normalizeBrowserKind(kind), kind);
  }
  for (const invalid of [undefined, null, "", "safari", "firefox", 42, {}]) {
    assert.equal(normalizeBrowserKind(invalid), "chrome");
  }

  assert.equal(browserKindDisplayName("chrome"), "Google Chrome");
  assert.equal(browserKindDisplayName("edge"), "Microsoft Edge");
  assert.equal(browserKindDisplayName("brave"), "Brave Browser");
  assert.equal(browserKindDisplayName("chromium"), "Chromium");

  assert.equal(browserMacAppName("edge", {}), "Microsoft Edge");
  assert.equal(browserMacAppName("brave", {}), "Brave Browser");
  assert.equal(browserMacAppName("chromium", {}), "Chromium");
  assert.equal(browserMacAppName("edge", { EDGE_APP_NAME: "Microsoft Edge Dev" }), "Microsoft Edge Dev");
});

test("resolveBrowserExecutable and resolveWindowsBrowserExecutable resolve Chrome, Edge, Brave, and Chromium across OSes", () => {
  const winEnv = {
    LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    USERPROFILE: "C:\\Users\\alice",
    PATH: "C:\\Tools\\Bin"
  };

  const winFiles = new Set([
    "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Users\\alice\\scoop\\apps\\chromium\\current\\chrome.exe"
  ]);
  const winExists = (candidate) => winFiles.has(candidate);

  assert.equal(
    resolveWindowsBrowserExecutable("chrome", winEnv, winExists),
    "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"
  );
  assert.equal(
    resolveWindowsBrowserExecutable("edge", winEnv, winExists),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  );
  assert.equal(
    resolveWindowsBrowserExecutable("brave", winEnv, winExists),
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
  );
  assert.equal(
    resolveWindowsBrowserExecutable("chromium", winEnv, winExists),
    "C:\\Users\\alice\\scoop\\apps\\chromium\\current\\chrome.exe"
  );

  // Explicit binary env overrides win
  assert.equal(
    resolveBrowserExecutable("edge", { EDGE_BINARY: "D:\\CustomEdge\\msedge.exe" }, "win32", "C:\\Users\\alice", () => false),
    "D:\\CustomEdge\\msedge.exe"
  );
  assert.equal(
    resolveBrowserExecutable("brave", { BRAVE_BINARY: "/opt/brave/brave" }, "linux", "/home/alice", () => false),
    "/opt/brave/brave"
  );

  // macOS bundle resolution (system /Applications and user ~/Applications)
  const macFiles = new Set([
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Users/alice/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ]);
  assert.equal(
    resolveBrowserExecutable("edge", {}, "darwin", "/Users/alice", (p) => macFiles.has(p)),
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  );
  assert.equal(
    resolveBrowserExecutable("brave", {}, "darwin", "/Users/alice", (p) => macFiles.has(p)),
    "/Users/alice/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  );
  assert.equal(
    resolveBrowserExecutable("chromium", {}, "darwin", "/Users/alice", (p) => macFiles.has(p)),
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  );

  // Linux PATH resolution
  const linuxFiles = new Set(["/usr/bin/microsoft-edge-stable", "/usr/local/bin/brave-browser"]);
  const linuxEnv = { PATH: "/usr/local/bin:/usr/bin" };
  assert.equal(
    resolveBrowserExecutable("edge", linuxEnv, "linux", "/home/alice", (p) => linuxFiles.has(p)),
    "/usr/bin/microsoft-edge-stable"
  );
  assert.equal(
    resolveBrowserExecutable("brave", linuxEnv, "linux", "/home/alice", (p) => linuxFiles.has(p)),
    "/usr/local/bin/brave-browser"
  );
});

test("nativeBrowserUserDataDir resolves platform-accurate User Data directories for all 4 browser kinds", () => {
  assert.equal(
    nativeBrowserUserDataDir("chrome", {}, "darwin", "/Users/alice"),
    "/Users/alice/Library/Application Support/Google/Chrome"
  );
  assert.equal(
    nativeBrowserUserDataDir("edge", {}, "darwin", "/Users/alice"),
    "/Users/alice/Library/Application Support/Microsoft Edge"
  );
  assert.equal(
    nativeBrowserUserDataDir("brave", {}, "darwin", "/Users/alice"),
    "/Users/alice/Library/Application Support/BraveSoftware/Brave-Browser"
  );
  assert.equal(
    nativeBrowserUserDataDir("chromium", {}, "darwin", "/Users/alice"),
    "/Users/alice/Library/Application Support/Chromium"
  );

  const winEnv = { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" };
  assert.equal(
    nativeBrowserUserDataDir("edge", winEnv, "win32", "C:\\Users\\alice"),
    "C:\\Users\\alice\\AppData\\Local\\Microsoft\\Edge\\User Data"
  );
  assert.equal(
    nativeBrowserUserDataDir("brave", winEnv, "win32", "C:\\Users\\alice"),
    "C:\\Users\\alice\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data"
  );
  assert.equal(
    nativeBrowserUserDataDir("chromium", winEnv, "win32", "C:\\Users\\alice"),
    "C:\\Users\\alice\\AppData\\Local\\Chromium\\User Data"
  );
});

test("cleanStaleSingletonLocks removes regular lock files and dangling symlinks while leaving profile data intact", async (t) => {
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pp-singleton-locks-"));
  t.after(() => fsp.rm(profileDir, { recursive: true, force: true }));

  await fsp.writeFile(path.join(profileDir, "Preferences"), '{"profile":{"name":"KeepMe"}}', "utf8");
  await fsp.writeFile(path.join(profileDir, "SingletonCookie"), "cookie-token", "utf8");
  await fsp.writeFile(path.join(profileDir, "SingletonSocket"), "socket-token", "utf8");

  // Create SingletonLock as a dangling symlink when permitted by OS, else regular file
  const lockPath = path.join(profileDir, "SingletonLock");
  try {
    await fsp.symlink("macbook.local-99999", lockPath);
  } catch {
    await fsp.writeFile(lockPath, "desktop-99999", "utf8");
  }

  const removed = await cleanStaleSingletonLocks(profileDir);
  assert.deepEqual(removed.sort(), ["SingletonCookie", "SingletonLock", "SingletonSocket"]);
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await assert.rejects(fsp.lstat(path.join(profileDir, name)), { code: "ENOENT" });
  }
  assert.equal(fs.existsSync(path.join(profileDir, "Preferences")), true);

  // Idempotent when already clean
  const secondRun = await cleanStaleSingletonLocks(profileDir);
  assert.deepEqual(secondRun, []);
});

test("process-scan recognizes Chrome, Edge, Brave, Chromium, Arc, and Vivaldi main processes and renderer helpers", () => {
  // Windows main processes vs helpers
  const winMains = [
    ['"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir=C:\\p', "Google Chrome"],
    ['"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --user-data-dir=C:\\p', "Microsoft Edge"],
    ['"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --user-data-dir=C:\\p', "Brave Browser"],
    ['"C:\\Users\\u\\AppData\\Local\\Chromium\\Application\\chrome.exe" --user-data-dir=C:\\p', "Chromium"],
    ['"C:\\Users\\u\\AppData\\Local\\Packages\\Arc\\arc.exe" --user-data-dir=C:\\p', "Arc"],
    ['"C:\\Users\\u\\AppData\\Local\\Vivaldi\\Application\\vivaldi.exe" --user-data-dir=C:\\p', "Vivaldi"]
  ];
  for (const [cmd, expectedName] of winMains) {
    assert.equal(isChromiumBrowserMainProcess(cmd, "win32"), true, cmd);
    assert.equal(parseExternalBrowserName(cmd, "win32"), expectedName, cmd);
    assert.equal(isChromiumRendererProcess(cmd, "win32"), false, cmd);
  }

  const winRenderer = '"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --type=renderer --lang=zh-CN';
  assert.equal(isChromiumBrowserMainProcess(winRenderer, "win32"), false);
  assert.equal(isChromiumRendererProcess(winRenderer, "win32"), true);

  // macOS main processes vs Helper (Renderer)
  const macMains = [
    ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/p", "Google Chrome"],
    ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --user-data-dir=/tmp/p", "Microsoft Edge"],
    ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser --user-data-dir=/tmp/p", "Brave Browser"],
    ["/Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/tmp/p", "Chromium"],
    ["/Applications/Arc.app/Contents/MacOS/Arc --user-data-dir=/tmp/p", "Arc"],
    ["/Applications/Vivaldi.app/Contents/MacOS/Vivaldi --user-data-dir=/tmp/p", "Vivaldi"]
  ];
  for (const [cmd, expectedName] of macMains) {
    assert.equal(isChromiumBrowserMainProcess(cmd, "darwin"), true, cmd);
    assert.equal(parseExternalBrowserName(cmd, "darwin"), expectedName, cmd);
  }

  const macRenderer =
    "/Applications/Brave Browser.app/Contents/Frameworks/Brave Browser Framework.framework/Helpers/Brave Browser Helper (Renderer).app/Contents/MacOS/Brave Browser Helper (Renderer) --type=renderer";
  assert.equal(isChromiumBrowserMainProcess(macRenderer, "darwin"), false);
  assert.equal(isChromiumRendererProcess(macRenderer, "darwin"), true);
});

test("native-onboarding-tab scripts support multi-browser on macOS and Windows while preserving security invariants", () => {
  for (const app of ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Arc", "Vivaldi"]) {
    assert.ok(MAC_CHROMIUM_BROWSER_APPS.includes(app), `missing macOS app ${app}`);
  }
  for (const proc of ["chrome", "msedge", "brave", "chromium", "arc", "vivaldi"]) {
    assert.ok(WINDOWS_CHROMIUM_BROWSER_PROCESSES.includes(proc), `missing Windows process ${proc}`);
  }

  const invite = `http://127.0.0.1:43123/profilepilot-connect/${"ab".repeat(24)}`;
  const macSingle = macOnboardingTabScript(invite, "chrome://extensions/", ["Google Chrome"]);
  assert.match(macSingle, /make new tab at after tab sourceIndex with properties \{URL:"chrome:\/\/extensions\/"\}/);
  assert.doesNotMatch(macSingle, /set URL of tab sourceIndex/);

  const macMulti = macOnboardingTabScript(invite, "chrome://extensions/", ["Google Chrome", "Microsoft Edge", "Brave Browser"]);
  assert.match(macMulti, /if application "Microsoft Edge" is running then/);
  assert.match(macMulti, /if application "Brave Browser" is running then/);

  const winScript = windowsOnboardingTabScript(invite, "chrome://extensions/");
  for (const proc of ["'chrome'", "'msedge'", "'brave'", "'chromium'", "'arc'", "'vivaldi'"]) {
    assert.ok(winScript.includes(proc), `Windows script missing ${proc}`);
  }
  assert.match(winScript, /\(chrome\|edge\|brave\|chromium\|arc\|vivaldi\):\/\/\(\.\+\)\$/);
});

test("ProfileManager.createProfile, registry reload, ProfileStateReader, and Create Modal preserve browserKind", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pp-multibrowser-pm-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const manager = new ProfileManager(root);
  const edgeProfile = await manager.createProfile({ name: "Edge Work", browserKind: "edge" });
  assert.equal(edgeProfile.browserKind, "edge");

  const braveProfile = await manager.createProfile("Brave Research", "brave");
  assert.equal(braveProfile.browserKind, "brave");

  const defaultProfile = await manager.createProfile("Default Kernel");
  assert.equal(defaultProfile.browserKind, "chrome");

  // Reload from disk via fresh ProfileManager + ProfileStateReader to ensure fs-util normalization doesn't strip browserKind
  const reloadedManager = new ProfileManager(root);
  const registry = await reloadedManager.loadRegistry();
  const storedEdge = registry.profiles.find((p) => p.name === "Edge Work");
  const storedBrave = registry.profiles.find((p) => p.name === "Brave Research");
  assert.equal(storedEdge?.browserKind, "edge");
  assert.equal(storedBrave?.browserKind, "brave");

  const reader = new ProfileStateReader({
    dataDir: root,
    profilesDir: path.join(root, "profiles"),
    loadRegistry: () => reloadedManager.loadRegistry(),
    readGatewayStatus: async () => null,
    getActivity: () => null
  });
  const publicEdge = await reader.toIsolatedPublicProfile(storedEdge, new Map());
  assert.equal(publicEdge.browserKind, "edge");

  // Migrated extension launch plan respects non-Chrome kernel
  assert.equal(await canAutoLoadUnpackedExtensions("chromium"), true);
  const extDir = path.join(root, "ext");
  await fsp.mkdir(extDir, { recursive: true });
  await fsp.writeFile(path.join(extDir, "manifest.json"), '{"manifest_version":3,"name":"Ext","version":"1.0"}', "utf8");
  const chromiumStored = await reloadedManager.createProfile({ name: "Chromium Dev", browserKind: "chromium" });
  const planWithDir = await getMigratedExtensionLaunchPlan({
    ...chromiumStored,
    migratedExtensions: [{ id: "a".repeat(32), path: extDir, name: "Ext", version: "1.0" }]
  });
  assert.deepEqual(planWithDir.launchArgs, [`--load-extension=${extDir}`]);

  // Verify Create Modal markup includes #profile-browser-kind <select> with Chrome / Edge / Brave / Chromium
  const modalsSource = await fsp.readFile(path.join(repoRoot, "src/renderer/render/modals.ts"), "utf8");
  assert.match(modalsSource, /<select[^>]*id="profile-browser-kind"[^>]*name="browserKind"/);
  for (const val of ['value="chrome"', 'value="edge"', 'value="brave"', 'value="chromium"']) {
    assert.ok(modalsSource.includes(val), `modals.ts missing option ${val}`);
  }
});
