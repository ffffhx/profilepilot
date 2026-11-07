const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function functionSource(name) {
  const source = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const body = source.match(new RegExp(`async function ${name}\\(\\): Promise<void> \\{[\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(body, `${name} must exist`);
  return ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

test("showMainWindow explicitly unhides and activates the macOS app", () => {
  const source = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const body = source.match(/async function showMainWindow\(\)[\s\S]*?function createProgressReporter/)?.[0] || "";

  assert.match(body, /app\.show\(\)/);
  assert.match(body, /app\.focus\(\{ steal: true \}\)/);
  assert.match(body, /mainWindow\?\.show\(\)/);
  assert.match(body, /mainWindow\?\.moveTop\(\)/);
  assert.match(body, /mainWindow\?\.focus\(\)/);
  assert.ok(body.indexOf("app.show()") < body.indexOf("mainWindow?.show()"));
});

test("main window enters Mini only through explicit user actions", () => {
  const source = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const rendererSource = readFileSync(path.join(__dirname, "../src/renderer/render/render-root.ts"), "utf8");

  assert.doesNotMatch(source, /mainWindow\.on\("blur"/);
  assert.doesNotMatch(source, /mainWindowBlurTimer/);
  assert.doesNotMatch(source, /mainWindow\.on\("minimize"/);
  assert.match(source, /IPC_CHANNELS\.showMiniWindow/);
  assert.doesNotMatch(rendererSource, /data-action="open-mini-window"/);
});

test("main window close hides to tray without quitting and still allows explicit exit", () => {
  const source = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const closeHandler = source.match(/mainWindow\.on\("close",[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(closeHandler, "main window must register a close handler");

  for (const platform of ["win32", "linux", "darwin"]) {
    for (const appQuitting of [false, true]) {
      const calls = [];
      let onClose;
      const context = {
        process: { platform },
        appQuitting,
        app: { quit: () => calls.push("quit") },
        mainWindow: {
          on: (event, handler) => { assert.equal(event, "close"); onClose = handler; },
          hide: () => calls.push("hide")
        },
        windowRef: { hide: () => calls.push("hide") }
      };
      vm.runInNewContext(closeHandler, context);
      onClose({ preventDefault: () => calls.push("preventDefault") });
      assert.deepEqual(calls, !appQuitting && platform !== "darwin" ? ["preventDefault", "hide"] : [],
        `${platform}, appQuitting=${appQuitting}`);
      assert.equal(context.appQuitting, appQuitting, "closing a window must not start application shutdown");
    }
  }
});

test("Mini close controls hide only Mini and leave the main window hidden", () => {
  const miniSource = readFileSync(path.join(__dirname, "../src/renderer/render/mini.ts"), "utf8");
  const rendererSource = readFileSync(path.join(__dirname, "../src/renderer/main.ts"), "utf8");
  const mainSource = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const hideMiniBody = mainSource.match(/function hideMiniWindow\(\)[\s\S]*?async function showMiniWindow/)?.[0] || "";

  assert.match(miniSource, /class="mini-dock-close" data-action="hide-mini-window"/);
  assert.match(miniSource, /class="mini-panel-close" data-action="hide-mini-window"/);
  assert.match(rendererSource, /action === "hide-mini-window"[\s\S]*?profileApi\(\)\.hideMiniWindow\(\)/);
  assert.match(mainSource, /IPC_CHANNELS\.hideMiniWindow/);
  assert.match(hideMiniBody, /miniWindow\.hide\(\)/);
  assert.doesNotMatch(hideMiniBody, /mainWindow/);
});

test("single-instance startup cannot create the main window before IPC is ready", () => {
  const source = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const showMainBody = source.match(/async function showMainWindow\(\)[\s\S]*?function createAppTray/)?.[0] || "";
  const startup = source.slice(source.indexOf("app.name = APP_TITLE;"), source.indexOf('app.on("window-all-closed"'));

  assert.match(
    startup,
    /if \(!app\.requestSingleInstanceLock\(\)\) \{[\s\S]*?app\.quit\(\);[\s\S]*?\} else \{[\s\S]*?app\.whenReady\(\)\.then/
  );
  assert.match(
    showMainBody,
    /if \(!appWindowRequestsReady\) \{[\s\S]*?pendingShowMainWindow = true;[\s\S]*?return;/
  );
  assert.match(startup, /app\.on\("second-instance"[\s\S]*?showMainWindow\(\)/);

  const ipcReadyIndex = startup.lastIndexOf("registerIpcHandlers();");
  const windowCreateIndex = startup.lastIndexOf("createMainWindow();");
  const requestsReadyIndex = startup.lastIndexOf("appWindowRequestsReady = true;");
  const pendingRequestIndex = startup.lastIndexOf("if (pendingShowMainWindow)");
  assert.ok(ipcReadyIndex >= 0 && ipcReadyIndex < windowCreateIndex);
  assert.ok(windowCreateIndex < requestsReadyIndex);
  assert.ok(requestsReadyIndex < pendingRequestIndex);
});

test("explicit main-window show cancels deferred auto-show before restore and focus", async () => {
  const calls = [];
  const context = { IS_BACKGROUND_E2E: false, appQuitting: false, appWindowRequestsReady: true,
    process: { platform: 'win32' }, miniWindow: null, closeMiniOutsideClickWindows() {},
    cancelMainWindowFirstPaint: reason => calls.push(reason),
    mainWindow: { isDestroyed: () => false, isMinimized: () => true,
      restore: () => calls.push('restore'), show: () => calls.push('show'),
      moveTop: () => calls.push('moveTop'), focus: () => calls.push('focus') }
  };
  vm.runInNewContext(functionSource('showMainWindow'), context);
  await context.showMainWindow();
  assert.deepEqual(calls, ['explicit-show', 'restore', 'show', 'moveTop', 'focus']);
});

test("Mini request cancels the pending main show before waiting for Mini creation", async () => {
  const calls = [];
  let resolveMini;
  const context = { cancelMainWindowFirstPaint: reason => calls.push(reason),
    createMiniWindow: () => new Promise(resolve => { resolveMini = resolve; }),
    setMiniWindowPanelOpen() {}, waitForMiniWindowFirstPaint: async () => {}, raiseMiniWindow() {},
    mainWindow: { hide: () => calls.push('hide-main') }
  };
  vm.runInNewContext(functionSource('showMiniWindow'), context);
  const pending = context.showMiniWindow();
  assert.deepEqual(calls, ['mini-request']);
  resolveMini({ show: () => calls.push('show-mini'), focus() {} });
  await pending;
  assert.deepEqual(calls, ['mini-request', 'show-mini', 'hide-main']);
});

test("closing an old main window cannot clear or cancel a replacement", () => {
  const source = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const closedHandler = source.match(/mainWindow\.on\("closed",[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(closedHandler);
  let onClosed;
  const cancellations = [];
  const old = { on: (_event, handler) => { onClosed = handler; } }, replacement = {};
  const context = { mainWindow: old, windowRef: old, cancelMainWindowFirstPaint: reason => cancellations.push(reason) };
  vm.runInNewContext(closedHandler, context);
  context.mainWindow = replacement; onClosed();
  assert.equal(context.mainWindow, replacement); assert.deepEqual(cancellations, []);
  context.mainWindow = old; onClosed();
  assert.equal(context.mainWindow, null); assert.deepEqual(cancellations, ['closed']);
});

test("before-quit revokes initial and queued explicit shows before asynchronous shutdown", () => {
  const source = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const handler = source.match(/app\.on\("before-quit",[\s\S]*?\n\}\);/)?.[0];
  assert.ok(handler);
  let beforeQuit;
  const calls = [];
  const context = { appQuitting: false, pendingShowMainWindow: true, shutdownReason: 'test',
    app: { on: (_event, callback) => { beforeQuit = callback; } },
    cancelMainWindowFirstPaint: reason => calls.push(reason),
    shutdown: { beforeQuit: () => calls.push('shutdown') }
  };
  vm.runInNewContext(handler, context); beforeQuit({});
  assert.equal(context.appQuitting, true); assert.equal(context.pendingShowMainWindow, false);
  assert.deepEqual(calls, ['quit', 'shutdown']);
});
