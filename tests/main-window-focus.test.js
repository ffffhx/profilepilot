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
  assert.match(source, /mainWindow\.on\("minimize"/);
  assert.match(source, /IPC_CHANNELS\.showMiniWindow/);
  assert.match(rendererSource, /action === "open-mini-window"/);
});

test("Mini close controls restore the main window and hide Mini", () => {
  const miniSource = readFileSync(path.join(__dirname, "../src/renderer/render/mini.ts"), "utf8");
  const rendererSource = readFileSync(path.join(__dirname, "../src/renderer/main.ts"), "utf8");
  const mainSource = readFileSync(path.join(__dirname, "../src/main/main.ts"), "utf8");
  const showMainBody = mainSource.match(/async function showMainWindow\(\)[\s\S]*?function createAppTray/)?.[0] || "";

  assert.match(miniSource, /class="mini-dock-close" data-action="show-main-window"/);
  assert.match(miniSource, /class="mini-panel-close" data-action="show-main-window"/);
  assert.match(rendererSource, /action === "show-main-window"[\s\S]*?profileApi\(\)\.showMainWindow\(\)/);
  assert.match(showMainBody, /mainWindow\?\.show\(\)/);
  assert.match(showMainBody, /miniWindow\?\.hide\(\)/);
});
