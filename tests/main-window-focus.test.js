const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("showMainWindow explicitly unhides and activates the macOS app", () => {
  const source = readFileSync(path.join(__dirname, "../dist/main/main.js"), "utf8");
  const body = source.match(/async function showMainWindow\(\)[\s\S]*?function createProgressReporter/)?.[0] || "";

  assert.match(body, /electron_1\.app\.show\(\)/);
  assert.match(body, /electron_1\.app\.focus\(\{ steal: true \}\)/);
  assert.match(body, /mainWindow\?\.show\(\)/);
  assert.match(body, /mainWindow\?\.moveTop\(\)/);
  assert.match(body, /mainWindow\?\.focus\(\)/);
  assert.ok(body.indexOf("app.show()") < body.indexOf("mainWindow?.show()"));
});

test("main window enters Mini only through explicit user actions", () => {
  const source = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const rendererSource = readFileSync(path.join(__dirname, "../src/renderer/main.ts"), "utf8");

  assert.doesNotMatch(source, /mainWindow\.on\("blur"/);
  assert.doesNotMatch(source, /mainWindowBlurTimer/);
  assert.doesNotMatch(source, /mainWindow\.on\("minimize"/);
  assert.match(source, /IPC_CHANNELS\.showMiniWindow/);
  assert.match(rendererSource, /action === "open-mini-window"/);
});

test("main window close exits on Windows and Linux while preserving macOS window semantics", () => {
  const source = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const closeBody = source.match(/mainWindow\.on\("close"[\s\S]*?mainWindow\.loadFile/)?.[0] || "";

  assert.match(closeBody, /appQuitting \|\| process\.platform === "darwin"/);
  assert.match(closeBody, /event\.preventDefault\(\)/);
  assert.match(closeBody, /appQuitting = true;[\s\S]*?app\.quit\(\)/);
  assert.doesNotMatch(closeBody, /mainWindow\?\.hide\(\)/);
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
