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
